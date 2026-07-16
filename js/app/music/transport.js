/**
 * @module app/music/transport
 * transport.js — グローバル・トランスポート (共有の再生時計)
 *
 * 音楽アプリが共有する 1 本の「時計」。位置はビート単位で、AudioContext のクロックを
 * 基準に進む。ループ範囲・テンポ・拍子・メトロノーム・録音状態を持つ。
 *
 * ── 責務分離 ──
 *   再生の「制御」(開始/停止/位置/テンポ/ループ/録音/メトロノーム) はここに集約する。
 *   TRANSPORT アプリはここを操作するだけでよく、ROLL 等のシーケンサはここを「読んで」
 *   自分のノートをスケジュールする。update() は誰が毎フレーム呼んでも冪等 (時刻ベース)。
 *   複数の音楽ウィンドウ (ROLL + TRANSPORT 等) が同一フレームに update() を呼んでも
 *   位置は再計算で一致し、メトロノームは「同じ拍を 2 度鳴らさない」ようガードする。
 *
 * ── 連携 (相互運用) ──
 *   - 位置 / テンポ / ループ / 拍子: 全音楽アプリの単一の出所 (SSoT)。ROLL は自前で
 *     テンポ・ループを持たず、ここを読んで再生に追従する。
 *   - 録音 (isRecording): 将来の Sampler / Arrangement が観測して取り込む連携フック。
 *     現状は状態 + 表示 + 連携 API のみ (取り込み先アプリは今後追加)。
 *   - メトロノーム: この時計自身が拍頭でクリック音を出す (どの音楽ウィンドウが update()
 *     を回していても鳴る。既定 OFF なので ROLL 単体の音は変えない)。
 */

import { getAudioContext, getMasterGain, initAudio } from "../../core/audio.js";

let _playing = false;
let _bpm = 120;
let _pos = 0; // 現在位置 (beat)。停止中も保持 (再開用)
let _startBeat = 0; // 再生開始時の位置
let _startTime = 0; // 再生開始時の ctx.currentTime
let _loopStart = 0; // beat
let _loopEnd = 16; // beat (4/4 で 4 小節)
let _loopOn = true;

/** 拍子 (1 小節あたりの拍数)。4/4 = 4。位置の bar.beat 換算とメトロノームの強拍に使う。 */
let _beatsPerBar = 4;
/** 1 拍のサブ分割数 (16 分音符解像度)。位置表示 (bar.beat.sub) の sub 桁に使う。 */
const _stepsPerBeat = 4;

/** 録音状態。再生と独立したフラグ。将来の取り込みアプリが isRecording() で観測する。 */
let _recording = false;

/** メトロノーム ON/OFF (既定 OFF: 既存アプリの単体挙動を変えない)。 */
let _metroOn = false;
/** 最後にクリックした整数ビート。多重呼び出し/毎フレーム再計算に対する冪等ガード。 */
let _metroLastBeat = -Infinity;
/** メトロノーム用ゲインノード (master gain に接続。遅延生成)。 */
let _metroGain = null;

/** ユーザー操作起点で AudioContext を確実に用意する。 */
function ensureCtx() {
  if (!getAudioContext()) initAudio();
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function isPlaying() {
  return _playing;
}
export function getTempo() {
  return _bpm;
}
export function setTempo(bpm) {
  if (bpm > 0) _bpm = bpm;
}

/** 拍子 (1 小節の拍数) を取得する。 */
export function getBeatsPerBar() {
  return _beatsPerBar;
}
/** 拍子 (1 小節の拍数) を設定する。 */
export function setBeatsPerBar(n) {
  if (n > 0) _beatsPerBar = n | 0;
}
/** 1 拍のサブ分割数 (位置表示の sub 桁) を取得する。 */
export function getStepsPerBeat() {
  return _stepsPerBeat;
}

/** 現在位置 (beat)。 */
export function getPosition() {
  return _pos;
}

/**
 * 保存用スナップショット (.song に含める全トランスポート状態)。位置・テンポ・ループ・拍子・
 * メトロノームをまとめて返す。再生状態は保存しない (読み込み後は停止から始める)。
 * @returns {{bpm:number,beatsPerBar:number,loopStart:number,loopEnd:number,loopOn:boolean,metronome:boolean,position:number}}
 */
export function snapshot() {
  return {
    bpm: _bpm,
    beatsPerBar: _beatsPerBar,
    loopStart: _loopStart,
    loopEnd: _loopEnd,
    loopOn: _loopOn,
    metronome: _metroOn,
    position: _pos,
  };
}

/**
 * スナップショットを適用する (.song 読み込み)。読み込み後は必ず停止状態にする。
 * 各フィールドは防御的に扱い、欠けていれば現状を保つ。
 * @param {object} s snapshot() 形式
 */
export function apply(s) {
  if (!s || typeof s !== "object") return;
  stop();
  if (s.bpm > 0) _bpm = s.bpm;
  if (s.beatsPerBar > 0) _beatsPerBar = s.beatsPerBar | 0;
  if (Number.isFinite(s.loopStart) && Number.isFinite(s.loopEnd)) {
    setLoop(s.loopStart, s.loopEnd, !!s.loopOn);
  }
  _metroOn = !!s.metronome;
  if (Number.isFinite(s.position)) setPosition(s.position);
}
/** 位置を beat で設定する (再生中でも再アンカーする)。 */
export function setPosition(beat) {
  _pos = beat;
  _startBeat = beat;
  const ctx = getAudioContext();
  _startTime = ctx ? ctx.currentTime : 0;
  // 位置ジャンプ後、次の update() で移動先の拍を正しく判定できるようメトロノームを再アンカー。
  const onBeat = beat === Math.floor(beat);
  _metroLastBeat = onBeat ? Math.floor(beat) - 1 : Math.floor(beat);
}

/** ループ範囲 (beat) と有効/無効を設定する。 */
export function setLoop(startBeat, endBeat, on = true) {
  _loopStart = startBeat;
  _loopEnd = endBeat;
  _loopOn = on;
}
export function getLoop() {
  return { start: _loopStart, end: _loopEnd, on: _loopOn };
}

/**
 * ワークレット内シーケンサへ渡す時計アンカー一式を返す。位置はこのアンカーから
 * pos = startBeat + (ctx.currentTime − startTime) × bpm/60 で復元でき、ループで折り返す。
 * ROLL はこれをオーディオスレッドのシーケンサへ送り、発音時刻をサンプル精度に固定する。
 * @returns {{playing:boolean,bpm:number,startBeat:number,startTime:number,loopStart:number,loopEnd:number,loopOn:boolean}}
 */
export function getClock() {
  return {
    playing: _playing,
    bpm: _bpm,
    startBeat: _startBeat,
    startTime: _startTime,
    loopStart: _loopStart,
    loopEnd: _loopEnd,
    loopOn: _loopOn,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  位置の bar.beat.sub 換算 (拍子ベース)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** beat 位置を { bar, beat, sub } (すべて 1 始まり) に分解する。 */
export function beatToParts(posBeat) {
  const total = Math.max(0, posBeat);
  const whole = Math.floor(total);
  const bar = Math.floor(whole / _beatsPerBar) + 1;
  const beat = (((whole % _beatsPerBar) + _beatsPerBar) % _beatsPerBar) + 1;
  const sub = Math.floor((total - whole) * _stepsPerBeat) + 1;
  return { bar, beat, sub };
}
/** 現在位置を { bar, beat, sub } で返す。 */
export function getPositionParts() {
  return beatToParts(_pos);
}
/** beat 位置を "bar.beat.sub" 文字列にする (既定は現在位置)。 */
export function formatPosition(posBeat = _pos) {
  const p = beatToParts(posBeat);
  return `${p.bar}.${p.beat}.${p.sub}`;
}
/** 小節番号 (1 始まり) → その先頭の beat。 */
export function barToBeat(bar) {
  return (bar - 1) * _beatsPerBar;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  メトロノーム
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function isMetronomeEnabled() {
  return _metroOn;
}
export function setMetronomeEnabled(v) {
  _metroOn = !!v;
  // OFF にしたら、次に ON へ戻したとき「現在いる拍」で即クリックし直せるよう解除する。
  if (!_metroOn) _metroLastBeat = -Infinity;
}

/** メトロノーム用ゲインを遅延生成する (master gain へ受動接続)。 */
function ensureMetroGain(ctx) {
  if (_metroGain) return _metroGain;
  const master = getMasterGain();
  if (!master) return null;
  _metroGain = ctx.createGain();
  _metroGain.gain.value = 0.5;
  _metroGain.connect(master);
  return _metroGain;
}

/** クリック音を「今」(ctx.currentTime) に鳴らす。強拍 (小節頭) は高め。 */
function clickMetronome(ctx, isDownbeat) {
  const g = ensureMetroGain(ctx);
  if (!g) return;
  const t = ctx.currentTime;
  const dur = 0.03;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = isDownbeat ? 1500 : 1000;
  const env = ctx.createGain();
  env.gain.setValueAtTime(1, t);
  env.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(env);
  env.connect(g);
  osc.start(t);
  osc.stop(t + dur + 0.01);
  osc.onended = () => {
    try {
      osc.disconnect();
      env.disconnect();
    } catch (_) {
      /* already disconnected */
    }
  };
}

/**
 * 拍境界を跨いだフレームで 1 回だけクリックする (冪等)。位置がループで折り返すと整数拍が
 * 減る (例 15→0) が、「直前と違う拍に入った」と見なして先頭拍を強拍で鳴らす。
 */
function tickMetronome(ctx, pos) {
  const beat = Math.floor(pos);
  if (beat === _metroLastBeat) return; // 同一拍は 1 回だけ (同フレーム多重呼び出しにも冪等)
  _metroLastBeat = beat;
  const isDownbeat = (((beat % _beatsPerBar) + _beatsPerBar) % _beatsPerBar) === 0;
  clickMetronome(ctx, isDownbeat);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  録音
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function isRecording() {
  return _recording;
}
/**
 * 録音開始。停止していれば再生も開始する。録音の「取り込み先」(Sampler / Arrangement)
 * は未実装のため、現状は状態フラグ + 表示のみ。取り込み対応アプリはここを観測して繋ぐ。
 * @param {number} [fromBeat] 省略時は現在位置から
 */
export function startRecording(fromBeat) {
  _recording = true;
  if (!_playing) play(fromBeat);
}
/** 録音停止 (パンチアウト)。再生は継続する。 */
export function stopRecording() {
  _recording = false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  再生制御
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 再生開始。fromBeat 省略 (null) なら現在位置から (= 停止位置からの再開)。 */
export function play(fromBeat) {
  const ctx = ensureCtx();
  if (!ctx) return;
  _startBeat = fromBeat != null ? fromBeat : _pos;
  _pos = _startBeat;
  _startTime = ctx.currentTime;
  _playing = true;
  // メトロノーム: 拍頭で始めたらその拍を鳴らし、拍の途中で始めたら次の拍まで鳴らさない。
  const onBeat = _startBeat === Math.floor(_startBeat);
  _metroLastBeat = onBeat ? Math.floor(_startBeat) - 1 : Math.floor(_startBeat);
}

/** 停止。位置は保持する (Shift 再生で再開できるよう)。録音も止める。 */
export function stop() {
  _playing = false;
  _recording = false;
}

/**
 * Space キーの共有トグル (ROLL / TRANSPORT が同一挙動になるよう一本化する単一の出所)。
 * 再生中なら停止 (位置は保持)。停止中なら fromCurrent=false で先頭 (1.1.1 = beat 0) から、
 * true (Shift+Space) で現在位置から再生する。TRANSPORT の ▶ ボタン (常に現在位置から) とは
 * 別に、Space は「素で最初から / Shift で続きから」という仕様を持つ。
 * @param {boolean} fromCurrent Shift 押下中か (現在位置から再開)
 */
export function toggleFromSpace(fromCurrent) {
  if (_playing) stop();
  else play(fromCurrent ? null : 0);
}

/** 停止して先頭へ戻す (DAW の STOP)。ループ ON ならループ先頭、OFF なら 0 へ。 */
export function rewind() {
  stop();
  setPosition(_loopOn ? _loopStart : 0);
}

/** 全トランスポート状態を既定へ戻す (SYNESTA を新規起動したときの初期化)。停止・先頭・120BPM・
 *  4/4・ループ 0..16 ON・メトロノーム OFF へ。読み込み (apply) とは別に「まっさら」へ戻す入口。 */
export function reset() {
  stop();
  _bpm = 120;
  _beatsPerBar = 4;
  _loopStart = 0;
  _loopEnd = 16;
  _loopOn = true;
  _metroOn = false;
  _metroLastBeat = -Infinity;
  setPosition(0);
}

/** 毎フレーム呼ぶ。位置を進め、ループが有効なら折り返す。冪等 (時刻ベース)。 */
export function update() {
  if (!_playing) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  let pos = _startBeat + (ctx.currentTime - _startTime) * (_bpm / 60);
  if (_loopOn && _loopEnd > _loopStart) {
    const len = _loopEnd - _loopStart;
    pos = _loopStart + ((((pos - _loopStart) % len) + len) % len);
  }
  _pos = pos;
  if (_metroOn) tickMetronome(ctx, pos);
}
