/**
 * @module audio/playback_engine
 * playback_engine.js — 再生エンジン (純粋オーディオロジック)
 *
 * ピアノロールのノートデータを再生する look-ahead スケジューラ。
 * UI 関連のインポートを一切持たず、core/audio.js と config のみに依存する。
 *
 * transport.js (UI 層) がこのエンジンをインポートして制御する。
 */

import * as Config from "../config.js";
import * as Audio from "../core/audio.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ピアノロールコールバック (層逆転回避)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {(() => Array<{notes: Array, channel: object}>)} */
let _getTracks = () => [];
/** @type {((pos: number) => void)} */
let _setPlayheadPos = () => {};

/**
 * ピアノロールとの接続コールバックを注入する。kernel.js が初期化時に呼ぶ。
 * @param {{ getTracks: function, setPlayheadPos: function }} cbs
 */
export function transportSetPianoRollCallbacks(cbs) {
  _getTracks = cbs.getTracks;
  _setPlayheadPos = cbs.setPlayheadPos;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  再生エンジン状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 再生状態 */
let isPlaying = false;

/** 一時停止状態 (再生位置を保持) */
let isPaused = false;

/** ループ再生 */
let isLooping = true;

/** テンポ (BPM) */
let bpm = Config.DEFAULT_BPM;

/** 再生開始時の AudioContext.currentTime */
let playStartTime = 0;

/** 再生開始時のステップオフセット (一時停止からの再開用) */
let playStartStep = 0;

/** スケジューラが最後にスケジュール済みのステップ位置 */
let scheduledUpTo = 0;

/** スケジューラ setTimeout ID */
let schedulerTimerId = null;

// ── 状態ゲッター ──

export function playbackIsPlaying() {
  return isPlaying;
}
export function playbackIsPaused() {
  return isPaused;
}
export function playbackIsLooping() {
  return isLooping;
}
export function playbackSetLooping(v) {
  isLooping = v;
}
export function playbackGetBpm() {
  return bpm;
}
export function playbackGetPlayStartStep() {
  return playStartStep;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  メトロノーム
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** メトロノーム ON/OFF */
let metronomeEnabled = true;

/** メトロノーム音量 (0.0〜1.0) */
let metronomeVolume = 0.5;

/** メトロノーム用ゲインノード (masterGain に接続) */
let metronomeGain = null;

/** メトロノームが最後にスケジュール済みのビート位置 (ステップ単位) */
let metroScheduledUpTo = 0;

export function playbackIsMetronomeEnabled() {
  return metronomeEnabled;
}
export function playbackSetMetronomeEnabled(v) {
  metronomeEnabled = v;
}

/** メトロノーム用ゲインノードを遅延生成する */
function ensureMetronomeGain() {
  if (metronomeGain) return;
  const master = Audio.getMasterGain();
  if (!master) return;
  const ctx = Audio.getAudioContext();
  metronomeGain = ctx.createGain();
  metronomeGain.gain.value = metronomeVolume;
  metronomeGain.connect(master);
}

/**
 * メトロノームクリック音を Web Audio でスケジュールする。
 * @param {number} time      AudioContext.currentTime ベースの発音時刻
 * @param {boolean} isDownbeat  小節先頭 (beat 1) なら true
 */
function scheduleMetronomeClick(time, isDownbeat) {
  const ctx = Audio.getAudioContext();
  if (!ctx) return;
  ensureMetronomeGain();

  const freq = isDownbeat ? 1500 : 1000;
  const duration = 0.03;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;

  const env = ctx.createGain();
  env.gain.setValueAtTime(1, time);
  env.gain.exponentialRampToValueAtTime(0.001, time + duration);

  osc.connect(env);
  env.connect(metronomeGain);
  osc.start(time);
  osc.stop(time + duration + 0.01);

  osc.onended = () => {
    try {
      osc.disconnect();
      env.disconnect();
    } catch (_) {}
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ユーティリティ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ステップ数から秒数に変換 */
function stepsToSeconds(steps) {
  return (steps / Config.PIANO_ROLL_STEPS_PER_BEAT) * (60 / bpm);
}

/** 秒数からステップ数に変換 */
function secondsToSteps(seconds) {
  return (seconds / (60 / bpm)) * Config.PIANO_ROLL_STEPS_PER_BEAT;
}

/** 指定ステップの絶対時刻を返す */
function stepToTime(step) {
  return playStartTime + stepsToSeconds(step - playStartStep);
}

/** 現在のステップ位置を返す (ループ時はループ範囲内にラップ) */
export function getCurrentStep() {
  if (!isPlaying) return playStartStep;
  const ctx = Audio.getAudioContext();
  if (!ctx) return playStartStep;
  const elapsed = ctx.currentTime - playStartTime;
  let step = playStartStep + secondsToSteps(elapsed);

  if (isLooping && step >= loopEndStep) {
    const loopLen = loopEndStep - loopStartStep;
    if (loopLen > 0) {
      step = loopStartStep + ((step - loopStartStep) % loopLen);
    }
  }

  return step;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  位置ヘルパー / ループ範囲
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PIANO_ROLL_BEATS_PER_BAR =
  Config.PIANO_ROLL_STEPS_PER_BAR / Config.PIANO_ROLL_STEPS_PER_BEAT;
const PIANO_ROLL_TOTAL_BARS =
  Config.PIANO_ROLL_TOTAL_COLUMNS / Config.PIANO_ROLL_STEPS_PER_BAR;

export { PIANO_ROLL_BEATS_PER_BAR, PIANO_ROLL_TOTAL_BARS };

/** ステップ数を { bar, beat, sub } (1-based) に変換 */
export function stepToPos(step) {
  step = Math.max(0, step);
  const bar = Math.floor(step / Config.PIANO_ROLL_STEPS_PER_BAR) + 1;
  const remain = step % Config.PIANO_ROLL_STEPS_PER_BAR;
  const beat = Math.floor(remain / Config.PIANO_ROLL_STEPS_PER_BEAT) + 1;
  const sub = Math.floor(remain % Config.PIANO_ROLL_STEPS_PER_BEAT) + 1;
  return { bar, beat, sub };
}

/** { bar, beat, sub } (1-based) をステップ数に変換 */
export function posToStep(bar, beat, sub) {
  return (
    (bar - 1) * Config.PIANO_ROLL_STEPS_PER_BAR +
    (beat - 1) * Config.PIANO_ROLL_STEPS_PER_BEAT +
    (sub - 1)
  );
}

/** ステップ数を "bar.beat.sub" 文字列に変換 */
export function formatPos(step) {
  const { bar, beat, sub } = stepToPos(step);
  return `${bar}.${beat}.${sub}`;
}

/** ループ開始ステップ */
let loopStartStep = 0;

/** ループ終了ステップ */
let loopEndStep = Config.PIANO_ROLL_TOTAL_COLUMNS;

export function getLoopStart() {
  return loopStartStep;
}
export function getLoopEnd() {
  return loopEndStep;
}

/**
 * ループ開始位置を設定する。終了位置との整合を保証する。
 * @param {number} step  ステップ位置
 * @returns {{ start: number, end: number }}  確定後の開始・終了
 */
export function setLoopStart(step) {
  step = Math.max(0, Math.min(Config.PIANO_ROLL_TOTAL_COLUMNS - 1, step));
  loopStartStep = step;
  if (loopStartStep >= loopEndStep) {
    loopEndStep = Math.min(
      Config.PIANO_ROLL_TOTAL_COLUMNS,
      loopStartStep + Config.PIANO_ROLL_STEPS_PER_BEAT,
    );
  }
  return { start: loopStartStep, end: loopEndStep };
}

/**
 * ループ終了位置を設定する。開始位置との整合を保証する。
 * @param {number} step  ステップ位置
 * @returns {{ start: number, end: number }}  確定後の開始・終了
 */
export function setLoopEnd(step) {
  step = Math.max(1, Math.min(Config.PIANO_ROLL_TOTAL_COLUMNS, step));
  loopEndStep = step;
  if (loopEndStep <= loopStartStep) {
    loopStartStep = Math.max(0, loopEndStep - Config.PIANO_ROLL_STEPS_PER_BEAT);
  }
  return { start: loopStartStep, end: loopEndStep };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  スケジューラ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Look-ahead スケジューラ。
 * SCHEDULE_INTERVAL ms ごとに呼ばれ、
 * 現在時刻 + SCHEDULE_AHEAD 秒までのノートをスケジュールする。
 */
function scheduler() {
  const ctx = Audio.getAudioContext();
  if (!ctx || !isPlaying) return;

  const aheadTime = ctx.currentTime + Config.SCHEDULE_AHEAD;
  const rangeEnd = isLooping ? loopEndStep : Config.PIANO_ROLL_TOTAL_COLUMNS;
  let aheadStep = playStartStep + secondsToSteps(aheadTime - playStartTime);

  let safety = 10;
  while (safety-- > 0) {
    const effectiveAhead = isLooping
      ? Math.min(aheadStep, loopEndStep)
      : Math.min(aheadStep, Config.PIANO_ROLL_TOTAL_COLUMNS);

    for (const track of _getTracks()) {
      scheduleNotesInRange(
        track.notes,
        scheduledUpTo,
        effectiveAhead,
        rangeEnd,
        track.channel,
      );
    }

    if (metronomeEnabled) {
      scheduleMetronomeInRange(metroScheduledUpTo, effectiveAhead);
      metroScheduledUpTo = effectiveAhead;
    }

    scheduledUpTo = effectiveAhead;

    if (!isLooping || aheadStep <= loopEndStep) break;

    const loopEndTime = stepToTime(loopEndStep);
    playStartTime = loopEndTime;
    playStartStep = loopStartStep;
    scheduledUpTo = loopStartStep;
    metroScheduledUpTo = loopStartStep;
    aheadStep = playStartStep + secondsToSteps(aheadTime - playStartTime);
  }

  if (!isLooping && getCurrentStep() >= Config.PIANO_ROLL_TOTAL_COLUMNS) {
    stopPlayback();
  }
}

/** 再帰 setTimeout によるスケジューラループ */
function scheduleLoop() {
  if (!isPlaying) return;
  schedulerTimerId = setTimeout(() => {
    scheduler();
    scheduleLoop();
  }, Config.SCHEDULE_INTERVAL);
}

/**
 * [fromStep, toStep) 範囲内のノートをスケジュールする。
 */
function scheduleNotesInRange(notes, fromStep, toStep, rangeEnd, channel) {
  for (const note of notes) {
    if (note.start >= toStep) break;
    if (note.start >= fromStep) {
      const noteEnd = Math.min(note.start + note.duration, rangeEnd);
      if (noteEnd <= note.start) continue;

      const onTime = stepToTime(note.start);
      const offTime = stepToTime(noteEnd);
      const freq = Audio.midiToFreq(note.pitch);
      channel.scheduleVoice(freq, onTime, offTime);
    }
  }
}

/**
 * [fromStep, toStep) 範囲内のビート境界でメトロノームクリックをスケジュールする。
 */
function scheduleMetronomeInRange(fromStep, toStep) {
  let beatStep =
    Math.ceil(fromStep / Config.PIANO_ROLL_STEPS_PER_BEAT) *
    Config.PIANO_ROLL_STEPS_PER_BEAT;
  while (beatStep < toStep) {
    const time = stepToTime(beatStep);
    const isDownbeat = beatStep % Config.PIANO_ROLL_STEPS_PER_BAR === 0;
    scheduleMetronomeClick(time, isDownbeat);
    beatStep += Config.PIANO_ROLL_STEPS_PER_BEAT;
  }
}

/** 全トラックのスケジュール済みボイスを停止する */
function stopAllTrackVoices() {
  for (const track of _getTracks()) {
    if (track.channel) track.channel.stopAllScheduled();
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  再生制御
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 再生開始 / 一時停止再開 */
export function startPlayback() {
  if (isPlaying) return;

  Audio.initAudio();
  const ctx = Audio.getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume();

  isPlaying = true;
  isPaused = false;

  playStartTime = ctx.currentTime;
  scheduledUpTo = playStartStep;
  metroScheduledUpTo = playStartStep;

  scheduler();
  scheduleLoop();
}

/** 一時停止 */
export function pausePlayback() {
  if (!isPlaying) return;

  const currentPos = getCurrentStep();

  isPlaying = false;
  isPaused = true;

  if (schedulerTimerId !== null) {
    clearTimeout(schedulerTimerId);
    schedulerTimerId = null;
  }

  playStartStep = Math.floor(currentPos);
  stopAllTrackVoices();
}

/** 停止 (先頭に戻る) */
export function stopPlayback() {
  const wasPlaying = isPlaying;

  isPlaying = false;
  isPaused = false;

  if (schedulerTimerId !== null) {
    clearTimeout(schedulerTimerId);
    schedulerTimerId = null;
  }

  playStartStep = 0;
  scheduledUpTo = 0;
  metroScheduledUpTo = 0;

  if (wasPlaying) {
    stopAllTrackVoices();
  }

  _setPlayheadPos(-1);
}

/** BPM を変更する。再生中は時刻基準をリセットして連続性を保つ。 */
export function setBpm(newBpm) {
  if (isPlaying) {
    const currentStep = getCurrentStep();
    stopAllTrackVoices();
    bpm = newBpm;
    const ctx = Audio.getAudioContext();
    playStartTime = ctx.currentTime;
    playStartStep = currentStep;
    scheduledUpTo = currentStep;
    metroScheduledUpTo = currentStep;
  } else {
    bpm = newBpm;
  }
}

/** Play/Pause トグル */
export function togglePlayPause() {
  if (isPlaying) {
    pausePlayback();
  } else {
    startPlayback();
  }
}

/**
 * 再生エンジンの全状態を初期値にリセットする。
 * SYNESTA ウィンドウを閉じるときに呼ばれる。
 */
export function resetPlaybackEngine() {
  stopPlayback();
  bpm = Config.DEFAULT_BPM;
  isLooping = true;
  metronomeEnabled = true;
  loopStartStep = 0;
  loopEndStep = Config.PIANO_ROLL_TOTAL_COLUMNS;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  毎フレーム更新 (プレイヘッド位置)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 毎フレーム呼ばれ、プレイヘッド位置を更新する */
export function updatePlayhead() {
  if (isPlaying) {
    const step = getCurrentStep();
    _setPlayheadPos(Math.floor(step));
  } else if (isPaused) {
    _setPlayheadPos(playStartStep);
  }
  // 停止中は _setPlayheadPos(-1) 済み
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  オフラインレンダリング (WAV Export)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** WAV エクスポート用 band-limited cycle wavetable のサンプル数 */
const BL_CYCLE_SIZE = 4096;

/**
 * 1 周期分の band-limited 波形を Fourier 級数で事前合成する。
 *
 * 倍音は Nyquist (sr/2) 以下の n*freq だけを足し込むため、出力された
 * cycle テーブルを freq Hz でループ再生してもエイリアシングが発生しない。
 * SynthChannel の PeriodicWave + OscillatorNode と数学的に等価。
 *
 * @param {string} waveform
 * @param {number} freq        基本周波数 (Hz)
 * @param {number} startPhase  発音開始位相 (0〜1) — wavetable に焼き込む
 * @param {number} sampleRate  出力 sample rate (Hz)
 * @returns {Float32Array}     長さ BL_CYCLE_SIZE の 1 周期
 */
function _buildBandLimitedCycle(waveform, freq, startPhase, sampleRate) {
  const nyquist = sampleRate / 2;
  const maxN = Math.max(1, Math.floor(nyquist / freq));

  // 非零の Fourier 係数だけを集めて per-sample ループを軽くする
  const coeffs = [];
  for (let n = 1; n <= maxN; n++) {
    const { a, b } = Audio.fourierCoeff(waveform, n);
    if (a !== 0 || b !== 0) coeffs.push(n, a, b);
  }
  const num = coeffs.length / 3;

  const cycle = new Float32Array(BL_CYCLE_SIZE);
  for (let i = 0; i < BL_CYCLE_SIZE; i++) {
    const t = i / BL_CYCLE_SIZE + startPhase;
    let s = 0;
    for (let k = 0; k < num; k++) {
      const n = coeffs[k * 3];
      const a = coeffs[k * 3 + 1];
      const b = coeffs[k * 3 + 2];
      const phi = 2 * Math.PI * n * t;
      if (a !== 0) s += a * Math.cos(phi);
      if (b !== 0) s += b * Math.sin(phi);
    }
    cycle[i] = s;
  }
  return cycle;
}

/**
 * ピアノロールのノートデータをオフラインで PCM にレンダリングする。
 * Web Audio API を使わず、band-limited cycle wavetable + ADSR エンベロープを
 * サンプル単位で算術的に合成する純粋関数。
 *
 * 帯域制限: ノート毎に Nyquist 以下の倍音だけを足し込んだ 1 周期 wavetable を
 * 事前合成し、サンプルループでは linear 補間して参照する。SynthChannel の
 * PeriodicWave + OscillatorNode と等価な音質 (高音域でもエイリアシングなし)。
 *
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=44100]  サンプリングレート (Hz)
 * @param {number} [opts.startStep]         開始ステップ (デフォルト: loopStartStep)
 * @param {number} [opts.endStep]           終了ステップ (デフォルト: loopEndStep)
 * @returns {{ samples: Float32Array, sampleRate: number, duration: number }}
 */
export function renderToBuffer(opts = {}) {
  const sr = opts.sampleRate || 44100;
  const start = opts.startStep !== undefined ? opts.startStep : loopStartStep;
  const end = opts.endStep !== undefined ? opts.endStep : loopEndStep;
  const tracks = _getTracks();

  // ステップ→秒変換 (BPM ベース)
  const secPerStep = 60 / bpm / Config.PIANO_ROLL_STEPS_PER_BEAT;
  const totalSec = (end - start) * secPerStep;
  const totalSamples = Math.ceil(totalSec * sr);

  if (totalSamples <= 0) {
    return { samples: new Float32Array(0), sampleRate: sr, duration: 0 };
  }

  const mix = new Float32Array(totalSamples);

  for (const track of tracks) {
    const ch = track.channel;
    if (!ch) continue;

    // チャンネルパラメータ取得
    const waveform = ch._waveform;
    const startPhase = ch._startPhase;
    const adsrA = ch._adsrA; // 秒
    const adsrD = ch._adsrD; // 秒
    const adsrS = ch._adsrS; // 0.0~1.0
    const adsrR = ch._adsrR; // 秒
    const volume = ch._volume; // 0.0~1.0

    // ループ範囲内のノートを収集
    for (const note of track.notes) {
      const noteEnd = note.start + note.duration;
      // 範囲外のノートはスキップ
      if (noteEnd <= start || note.start >= end) continue;

      const freq = Audio.midiToFreq(note.pitch);
      const noteOnSec = (Math.max(note.start, start) - start) * secPerStep;
      const noteOffSec = (Math.min(noteEnd, end) - start) * secPerStep;
      // リリース終了 (ただしバッファ末尾を超えない)
      const releaseEndSec = Math.min(noteOffSec + adsrR, totalSec);

      const sampleStart = Math.floor(noteOnSec * sr);
      const sampleEnd = Math.min(Math.ceil(releaseEndSec * sr), totalSamples);

      // ノイズ波形用のシード (再現可能にするため note ごとに固定シード)
      let noiseSeed = (note.pitch * 7919 + note.start * 104729 + 1) >>> 0;

      // 非ノイズ波形は事前に band-limited cycle wavetable を合成
      // (startPhase はテーブルに焼き込み済み)
      const blCycle =
        waveform === "noise"
          ? null
          : _buildBandLimitedCycle(waveform, freq, startPhase, sr);

      for (let i = sampleStart; i < sampleEnd; i++) {
        const t = i / sr; // バッファ内時刻 (秒)
        const noteT = t - noteOnSec; // ノート開始からの経過秒
        const noteOffT = noteOffSec - noteOnSec; // ノート持続時間 (秒)

        // ── ADSR エンベロープ ──
        let env;
        if (noteT < 0) {
          env = 0;
        } else if (noteT <= noteOffT) {
          // Note-On フェーズ: Attack → Decay → Sustain
          if (noteT < adsrA) {
            // Attack (リニア上昇)
            env = adsrA > 0 ? noteT / adsrA : 1;
          } else {
            // Decay → Sustain (指数減衰、setTargetAtTime 近似)
            const decayT = noteT - adsrA;
            const tau = Math.max(adsrD * 0.33, 0.001);
            env = adsrS + (1 - adsrS) * Math.exp(-decayT / tau);
          }
        } else {
          // Release フェーズ (指数減衰)
          const relT = noteT - noteOffT;
          const tau = Math.max(adsrR * 0.33, 0.001);
          // リリース開始時のエンベロープ値を計算
          let envAtOff;
          if (noteOffT < adsrA) {
            envAtOff = adsrA > 0 ? noteOffT / adsrA : 1;
          } else {
            const decayT = noteOffT - adsrA;
            const dtau = Math.max(adsrD * 0.33, 0.001);
            envAtOff = adsrS + (1 - adsrS) * Math.exp(-decayT / dtau);
          }
          env = envAtOff * Math.exp(-relT / tau);
        }

        // ── 波形サンプル ──
        let sample;
        if (waveform === "noise") {
          // 決定的ノイズ (xorshift32)
          noiseSeed ^= noiseSeed << 13;
          noiseSeed ^= noiseSeed >>> 17;
          noiseSeed ^= noiseSeed << 5;
          sample = ((noiseSeed >>> 0) / 0xffffffff) * 2 - 1;
        } else {
          // band-limited cycle wavetable から linear 補間で参照
          // (startPhase はテーブルに焼き込み済みなので freq*noteT のみで OK)
          const phase = ((freq * noteT) % 1 + 1) % 1;
          const fIdx = phase * BL_CYCLE_SIZE;
          const lo = fIdx | 0;
          const hi = lo + 1 === BL_CYCLE_SIZE ? 0 : lo + 1;
          const fr = fIdx - lo;
          sample = blCycle[lo] * (1 - fr) + blCycle[hi] * fr;
        }

        mix[i] += sample * env * volume;
      }
    }
  }

  // ── リミッター (ソフトクリップ) ──
  for (let i = 0; i < totalSamples; i++) {
    const x = mix[i];
    if (x > 1) mix[i] = 1;
    else if (x < -1) mix[i] = -1;
  }

  return { samples: mix, sampleRate: sr, duration: totalSec };
}

