/**
 * @module core/chip
 * chip.js — チップ音源エンジンのメインスレッド facade
 *
 * AudioWorklet (chip_worklet.js) を読み込み、マスターチェーンへ配線し、port 経由で音色・発音
 * イベントを送る。発音の実体はオーディオスレッドのワークレットが担うため、メインスレッドの
 * 描画ジャンク (TESSERA 背景等) や GC の影響を受けない。
 *
 * ── 提供物 ──
 *   - initChipEngine()  … ワークレット読込・ノード生成・masterGain 配線・波形メモリ送出 (冪等)
 *   - createInstrument() … 発音先を 1 つ作る。ワークレット対応環境では ChipSynth (チップ音源)、
 *     非対応/テスト環境では PolySynth (audio.js の従来オシレータ) にフォールバックする。
 *   - ChipSynth        … PolySynth と同一シグネチャの発音ハンドル。1 インスタンス = 1 チャンネル
 *     (音色パラメータ独立)。SYNTH / ROLL 内蔵音源 / 将来のマルチトラックがそれぞれ 1 つ持つ。
 *
 * 発音先を tracks レジストリへ載せる形は従来どおり (music-app-integration)。ROLL は per-frame の
 * ノート発火 (Phase 1 時点) をこのハンドル経由で行い、Phase 2 でワークレット内シーケンサへ移す。
 */

import {
  initAudio,
  getAudioContext,
  getMasterGain,
  WAVEFORM_LIST,
  createPolySynth,
  registerPanicSource,
} from "./audio.js";
import { buildWavetables, TABLE_SIZE, quantizeVolume16 } from "./chip_dsp.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  エンジン (シングルトン)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {AudioWorkletNode|null} チップ音源ノード */
let _node = null;
/** @type {Promise<boolean>|null} 初期化の一度きり Promise */
let _initPromise = null;
/** ノード生成前に発行されたメッセージのバッファ (ready で flush) */
let _pending = [];
/** ChipSynth へ配る次のチャンネル番号 */
let _nextChannel = 0;

/** AudioWorklet が使えるか (audio.isPcmCaptureSupported と同じ判定)。 */
export function isChipSupported() {
  return (
    typeof AudioWorkletNode === "function" &&
    typeof AudioContext !== "undefined" &&
    "audioWorklet" in AudioContext.prototype
  );
}

/** ワークレットへメッセージを送る (未 ready ならバッファ)。 */
function post(msg) {
  if (_node) _node.port.postMessage(msg);
  else _pending.push(msg);
}

/**
 * チップ音源エンジンを初期化する (冪等)。AudioContext とマスターチェーンを用意し、ワークレット
 * モジュールを読み込んでノードを masterGain に接続、波形メモリを送る。ユーザー操作起点で呼ぶこと。
 * @returns {Promise<boolean>} 使用可能になったら true (非対応/失敗は false)
 */
export function initChipEngine() {
  if (_initPromise) return _initPromise;
  if (!isChipSupported()) {
    _initPromise = Promise.resolve(false);
    return _initPromise;
  }
  _initPromise = (async () => {
    initAudio();
    const ctx = getAudioContext();
    const master = getMasterGain();
    if (!ctx || !master) return false;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (_) {
        /* resume はユーザー操作が要る環境がある。失敗しても後続の操作で再試行される */
      }
    }
    await ctx.audioWorklet.addModule(
      new URL("./chip_worklet.js", import.meta.url).href,
    );
    const node = new AudioWorkletNode(ctx, "chip-synth", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.connect(master);
    _node = node;
    // 波形メモリ (調性波形。noise はワークレットで実時間生成) を送る
    node.port.postMessage({ type: "tables", tables: buildWavetables(), tableSize: TABLE_SIZE });
    // ノード生成前に積まれた params/note を送る (tables の後)
    for (const msg of _pending) node.port.postMessage(msg);
    _pending = [];
    return true;
  })().catch((e) => {
    console.error("[chip] init failed:", e);
    _node = null;
    return false;
  });
  return _initPromise;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ChipSynth — PolySynth 互換の発音ハンドル (1 チャンネル)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * チップ音源の 1 チャンネル。PolySynth と同じ公開 API を持ち、発音を AudioWorklet に委譲する。
 * 音色パラメータはメイン側にも保持し (getter 用)、変更のたびにワークレットへ送る。押鍵中ノートは
 * オンスクリーン鍵盤のハイライト用にメイン側でミラーする。
 */
export class ChipSynth {
  constructor(channel) {
    this._ch = channel;
    /** ワークレット上のチャンネル番号。ROLL のシーケンサが発音先として参照する。 */
    this.channel = channel;
    // 既定は PolySynth のクラス既定に合わせる (a10ms/d100ms/s80%/r200ms, saw, vol50, 16 voices)。
    // SYNTH は生成後に自前の既定 (sq50 等) を setWaveform 等で上書きする。
    this._waveform = "saw";
    this._adsrA = 10; // ms
    this._adsrD = 100; // ms
    this._adsrS = 80; // %
    this._adsrR = 200; // ms
    this._volume = 50; // 0..100
    this._maxVoices = 16;
    this._held = new Set();
    initChipEngine();
    this._pushParams();
    registerPanicSource(this); // タブ非表示時のパニック消音 (押しっぱなしのライブ音を止める)
  }

  /** パニック消音 (タブ非表示時)。ライブ発音だけ止め、自走シーケンサ (ROLL 再生) は乱さない。 */
  panic() {
    this._held.clear();
    post({ type: "allNotesOff", channel: this._ch, liveOnly: true });
  }

  /** 現在の音色パラメータをワークレットへ送る (秒 / 0..1 に換算)。 */
  _pushParams() {
    post({
      type: "params",
      channel: this._ch,
      waveform: this._waveform,
      a: this._adsrA / 1000,
      d: this._adsrD / 1000,
      s: this._adsrS / 100,
      r: this._adsrR / 1000,
      volume: this._volume / 100,
      maxVoices: this._maxVoices,
    });
  }

  // ── ノートオン / オフ ──

  /** @param {number} midi @param {number} [vel=1] 0..1 @param {number} [time] 秒(ctx基準) */
  noteOn(midi, vel, time) {
    const v = vel !== undefined ? Math.max(0, Math.min(1, vel)) : 1;
    this._held.add(midi);
    post({ type: "noteOn", channel: this._ch, id: midi, midi, vel: v, time });
  }

  /** @param {number} midi @param {number} [time] 秒(ctx基準) */
  noteOff(midi, time) {
    this._held.delete(midi);
    post({ type: "noteOff", channel: this._ch, id: midi, time });
  }

  allNotesOff() {
    this._held.clear();
    post({ type: "allNotesOff", channel: this._ch });
  }

  // ── 押鍵状態 (オンスクリーン鍵盤用) ──

  getHeldNotes() {
    return [...this._held].sort((a, b) => a - b);
  }
  isNoteHeld(midi) {
    return this._held.has(midi);
  }
  get heldCount() {
    return this._held.size;
  }

  // ── パラメータ (PolySynth と同一シグネチャ) ──

  setWaveform(type) {
    this._waveform = type;
    this._pushParams();
  }
  getWaveform() {
    return this._waveform;
  }
  cycleWaveform() {
    const idx = WAVEFORM_LIST.indexOf(this._waveform);
    this._waveform = WAVEFORM_LIST[(idx + 1) % WAVEFORM_LIST.length];
    this._pushParams();
    return this._waveform;
  }

  /** ADSR を設定 (a/d/r=ms, s=0..100%)。 */
  setADSR(a, d, s, r) {
    this._adsrA = a;
    this._adsrD = d;
    this._adsrS = s;
    this._adsrR = r;
    this._pushParams();
  }
  getADSR() {
    return { a: this._adsrA, d: this._adsrD, s: this._adsrS, r: this._adsrR };
  }

  /** @param {number} vol 0..100 */
  setVolume(vol) {
    this._volume = vol;
    this._pushParams();
  }
  getVolume() {
    return this._volume;
  }

  setMaxVoices(n) {
    this._maxVoices = Math.max(1, n | 0);
    this._pushParams();
  }
  getMaxVoices() {
    return this._maxVoices;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ワークレット内シーケンサ制御 (ROLL の再生を駆動)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// ワークレットは 1 つの自走シーケンサを持ち、パターン (ノート列) とトランスポート時計を
// 与えると、自前のサンプル時計で発火する。発音時刻はメインスレッドの描画ジャンクから独立し、
// サンプル精度に固定される (frame-quantize なテンポ揺れが原理的に消える)。

/**
 * シーケンサのパターンを差し替える。再生中の編集で呼ぶと未来のオンセットに即反映される。
 * @param {{midi:number,startStep:number,lenSteps:number,vel:number}[]} notes  vel は 0..1
 * @param {number} stepsPerBeat
 */
export function chipSetPattern(notes, stepsPerBeat) {
  post({ type: "pattern", notes, stepsPerBeat });
}

/**
 * トランスポート時計 (アンカー) と発音先チャンネルをシーケンサへ送る。開始/停止/シーク/
 * テンポ・ループ変更のたびに呼ぶ。playing:false で発音中のシーケンス音を止める。
 * @param {{playing:boolean,bpm:number,startBeat:number,startTime:number,loopStart:number,loopEnd:number,loopOn:boolean}} clock
 * @param {number} channel  発音先チャンネル (ChipSynth.channel)
 */
export function chipSetTransport(clock, channel) {
  post({
    type: "transport",
    channel,
    playing: clock.playing,
    bpm: clock.bpm,
    startBeat: clock.startBeat,
    startTime: clock.startTime,
    loopStart: clock.loopStart,
    loopEnd: clock.loopEnd,
    loopOn: clock.loopOn,
  });
}

/**
 * 発音先を 1 つ生成する。ワークレット対応環境では ChipSynth (チップ波形メモリ音源)、
 * 非対応/テスト環境では PolySynth (audio.js の従来オシレータ) を返す。いずれも同じ公開 API。
 * @returns {ChipSynth|import("./audio.js").PolySynth}
 */
export function createInstrument() {
  if (isChipSupported()) return new ChipSynth(_nextChannel++);
  return createPolySynth();
}

// quantizeVolume16 を re-export (エンジン利用側が音量段を参照する用の入口を 1 つに)
export { quantizeVolume16 };
