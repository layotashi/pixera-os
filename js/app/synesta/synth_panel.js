/**
 * @module app/studio/synth_panel
 * synth_panel.js — INST タブ (STUDIO ウィンドウ内)
 *
 * チップチューン風モノフォニックシンセサイザの UI。
 * PCキーボードで演奏、波形選択・ADSR・音量をコントロールする。
 */

import { pset, drawRoundRect } from "../../core/gpu.js";
import { GLYPH_W } from "../../core/font.js";
import { keyDown, keyHeld } from "../../core/input.js";
import { wmIsFocused, wmRequestCursor } from "../../wm/index.js";
import * as Audio from "../../core/audio.js";
import * as UI from "../../ui/index.js";
import { isTransportPlaying } from "../../audio/transport.js";
import { getActiveTrackChannel, getActiveTrackIndex } from "./piano_roll.js";
import { APP_NAME } from "./studio.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 波形プレビュー幅 (px) — cw=64 = 4*halfH(16) で TRI が正確に 45° */
const PREVIEW_WIDTH = 68;

/** 波形プレビュー高さ (px) */
const PREVIEW_HEIGHT = 37;

/** スライダー幅 */
const SLIDER_WIDTH = 60;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 現在のオクターブ */
let octave = 3;

/** ベロシティ (0〜127) */
let velocity = 100;

/** 現在押されているキーのノート番号 (-1 = なし) */
let activeNote = -1;

/** 現在押されているキーコード */
let activeKeyCode = null;

/** 前回 INST タブが同期したトラックインデックス (-1 = 未同期) */
let _lastSyncedTrack = -1;

/** 現在発音中のチャンネル (noteOn したチャンネルを追跡) */
let _playingChannel = null;

/** ADSR 値 (ms / %) */
let attackMs = 10;
let decayMs = 100;
let sustainPct = 80;
let releaseMs = 200;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  キーボード → ノート マッピング
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 下段: Z〜M = C〜B (octave)
 * 中段: Q〜U = C〜B (octave+1)
 * 上段: I〜P = C〜E (octave+2)
 * 値は C からの半音オフセット
 */
const KEY_MAP_LOWER = [
  { code: "KeyZ", offset: 0 }, // C
  { code: "KeyS", offset: 1 }, // C#
  { code: "KeyX", offset: 2 }, // D
  { code: "KeyD", offset: 3 }, // D#
  { code: "KeyC", offset: 4 }, // E
  { code: "KeyV", offset: 5 }, // F
  { code: "KeyG", offset: 6 }, // F#
  { code: "KeyB", offset: 7 }, // G
  { code: "KeyH", offset: 8 }, // G#
  { code: "KeyN", offset: 9 }, // A
  { code: "KeyJ", offset: 10 }, // A#
  { code: "KeyM", offset: 11 }, // B
];

const KEY_MAP_UPPER = [
  { code: "KeyQ", offset: 12 }, // C (+1 oct)
  { code: "Digit2", offset: 13 }, // C#
  { code: "KeyW", offset: 14 }, // D
  { code: "Digit3", offset: 15 }, // D#
  { code: "KeyE", offset: 16 }, // E
  { code: "KeyR", offset: 17 }, // F
  { code: "Digit5", offset: 18 }, // F#
  { code: "KeyT", offset: 19 }, // G
  { code: "Digit6", offset: 20 }, // G#
  { code: "KeyY", offset: 21 }, // A
  { code: "Digit7", offset: 22 }, // A#
  { code: "KeyU", offset: 23 }, // B
];

const KEY_MAP_UPPER2 = [
  { code: "KeyI", offset: 24 }, // C (+2 oct)
  { code: "Digit9", offset: 25 }, // C#
  { code: "KeyO", offset: 26 }, // D
  { code: "Digit0", offset: 27 }, // D#
  { code: "KeyP", offset: 28 }, // E
];

const ALL_KEYS = [...KEY_MAP_LOWER, ...KEY_MAP_UPPER, ...KEY_MAP_UPPER2];

// midiToFreq は core/audio.js からインポート済み

/** オフセット + オクターブから MIDI ノート番号を計算する */
function offsetToMidi(offset) {
  // C1 = MIDI 24, C2 = 36, C3 = 48 ...
  return 12 + octave * 12 + offset;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィジェット定義 (遅延初期化)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── 波形選択ドロップダウン ──
const WAVE_ITEMS = ["SAW", "TRI", "SQ50", "SQ25", "SQ12", "SINE", "NOISE"];
const WAVE_IDS = ["saw", "tri", "sq50", "sq25", "sq12", "sine", "noise"];

let dropDownWave;
let labelWaveform;
let labelAttack, numberBoxAttack, labelAttackUnit;
let labelDecay, numberBoxDecay, labelDecayUnit;
let labelSustain, numberBoxSustain, labelSustainUnit;
let labelRelease, numberBoxRelease, labelReleaseUnit;
let labelVolume, labelVolumeValue, sliderVolume;
let labelPhase, labelPhaseValue, sliderPhase;
let allWidgets;
let synthRoot;
let _ready = false;

// ── 値フォーマット ──
function formatPercent(v) {
  return String(v).padStart(4) + "%";
}

function formatDegrees(v) {
  return String(v).padStart(4) + "DEG";
}

function _initWidgets() {
  if (_ready) return;
  _ready = true;

  dropDownWave = new UI.DropDown(0, 0, WAVE_ITEMS, 0, (idx) => {
    getActiveTrackChannel().setWaveform(WAVE_IDS[idx]);
  });
  labelWaveform = new UI.Label(0, 0, "WAVEFORM:");

  // ── ADSR NumberBox (1行表示) ──
  labelAttack = new UI.Label(0, 0, "A:");
  numberBoxAttack = new UI.NumberBox(
    0,
    0,
    0,
    2000,
    attackMs,
    1,
    (v) => {
      attackMs = v;
      getActiveTrackChannel().setADSR(attackMs, decayMs, sustainPct, releaseMs);
    },
    { digits: 4 },
  );
  labelAttackUnit = new UI.Label(0, 0, "MS");

  labelDecay = new UI.Label(0, 0, "D:");
  numberBoxDecay = new UI.NumberBox(
    0,
    0,
    0,
    2000,
    decayMs,
    1,
    (v) => {
      decayMs = v;
      getActiveTrackChannel().setADSR(attackMs, decayMs, sustainPct, releaseMs);
    },
    { digits: 4 },
  );
  labelDecayUnit = new UI.Label(0, 0, "MS");

  labelSustain = new UI.Label(0, 0, "S:");
  numberBoxSustain = new UI.NumberBox(
    0,
    0,
    0,
    100,
    sustainPct,
    1,
    (v) => {
      sustainPct = v;
      getActiveTrackChannel().setADSR(attackMs, decayMs, sustainPct, releaseMs);
    },
    { digits: 3 },
  );
  labelSustainUnit = new UI.Label(0, 0, "%");

  labelRelease = new UI.Label(0, 0, "R:");
  numberBoxRelease = new UI.NumberBox(
    0,
    0,
    0,
    2000,
    releaseMs,
    1,
    (v) => {
      releaseMs = v;
      getActiveTrackChannel().setADSR(attackMs, decayMs, sustainPct, releaseMs);
    },
    { digits: 4 },
  );
  labelReleaseUnit = new UI.Label(0, 0, "MS");

  // ── Volume スライダー ──
  labelVolume = new UI.Label(0, 0, "VOL:");
  labelVolumeValue = new UI.Label(0, 0, formatPercent(50));
  sliderVolume = new UI.Slider(0, 0, SLIDER_WIDTH, 0, 100, 50, (v) => {
    labelVolumeValue.text = formatPercent(v);
    getActiveTrackChannel().setVolume(v);
  });

  // ── 位相スライダー ──
  labelPhase = new UI.Label(0, 0, "PHS:");
  labelPhaseValue = new UI.Label(0, 0, formatDegrees(0));
  sliderPhase = new UI.Slider(0, 0, SLIDER_WIDTH, 0, 359, 0, (v) => {
    labelPhaseValue.text = formatDegrees(v);
    getActiveTrackChannel().setStartPhase(v / 360);
  });
  sliderPhase.wheelStep = 5; // 1ノッチ = 5°

  // ── 全ウィジェット配列 + Box レイアウト ──

  // ADSR を 4列グリッド (ラベル上 / NB+単位下) として構成
  const adsrGrid = UI.HBox([
    UI.VBox([labelAttack, UI.HBox([numberBoxAttack, labelAttackUnit])]),
    UI.VBox([labelDecay, UI.HBox([numberBoxDecay, labelDecayUnit])]),
    UI.VBox([labelSustain, UI.HBox([numberBoxSustain, labelSustainUnit])]),
    UI.VBox([labelRelease, UI.HBox([numberBoxRelease, labelReleaseUnit])]),
  ]);

  synthRoot = UI.VBox([
    UI.HBox([labelWaveform, dropDownWave]),
    adsrGrid,
    UI.HBox([labelVolume, sliderVolume, labelVolumeValue]),
    UI.HBox([labelPhase, sliderPhase, labelPhaseValue]),
  ]);

  // PREVIEW_HEIGHT 分のオフセットを y に指定。auto-layout がこの原点を使い続ける
  allWidgets = new UI.WidgetGroup(synthRoot, {
    x: UI.FOCUS_MARGIN,
    y: UI.FOCUS_MARGIN + PREVIEW_HEIGHT + UI.GAP,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  トラック同期
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** アクティブトラックのチャンネル設定を INST UI に反映する */
function _syncFromChannel() {
  const ch = getActiveTrackChannel();

  // 波形
  const wf = ch.getWaveform();
  const wfIdx = waveIndexMap[wf] ?? 0;
  dropDownWave.selectedIndex = wfIdx;

  // ADSR
  const adsr = ch.getADSR();
  attackMs = Math.round(adsr.a);
  decayMs = Math.round(adsr.d);
  sustainPct = Math.round(adsr.s);
  releaseMs = Math.round(adsr.r);
  numberBoxAttack.value = attackMs;
  numberBoxDecay.value = decayMs;
  numberBoxSustain.value = sustainPct;
  numberBoxRelease.value = releaseMs;

  // 音量
  const vol = Math.round(ch.getVolume());
  sliderVolume.value = vol;
  labelVolumeValue.text = formatPercent(vol);

  // 位相
  const phaseDeg = Math.round(ch.getStartPhase() * 360);
  sliderPhase.value = phaseDeg;
  labelPhaseValue.text = formatDegrees(phaseDeg);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  レイアウト計算
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ウィジェットの Y 位置を再計算する */
function relayout() {
  synthRoot.layout(UI.FOCUS_MARGIN, UI.FOCUS_MARGIN + PREVIEW_HEIGHT + UI.GAP);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  波形プレビュー ドラッグ / ホイール操作
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ドラッグ中のアンカー位相 */
let dragPhaseAnchor = 0;
/** ドラッグ開始時のマウス X */
let dragStartX = 0;
/** ドラッグ中フラグ */
let draggingPhase = false;

/** 位相値を synth + スライダー + ラベルに同期する */
function applyPhaseDeg(deg) {
  deg = ((deg % 360) + 360) % 360; // 0〜359 に正規化
  getActiveTrackChannel().setStartPhase(deg / 360);
  sliderPhase.value = deg;
  labelPhaseValue.text = formatDegrees(deg);
}

/** プレビュー領域のヒットテスト (コンテンツ領域ローカル座標) */
function hitPreview(lx, ly) {
  const px = UI.FOCUS_MARGIN;
  const py = UI.FOCUS_MARGIN;
  return (
    lx >= px && lx < px + PREVIEW_WIDTH && ly >= py && ly < py + PREVIEW_HEIGHT
  );
}

/** プレビュー描画幅 (ドラッグ計算用) */
let previewW = PREVIEW_WIDTH;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function drawSynth(contentRect) {
  _initWidgets();

  // トラック切り替え検出: アクティブトラックが変わったら UI を同期
  const activeIdx = getActiveTrackIndex();
  if (activeIdx !== _lastSyncedTrack) {
    _lastSyncedTrack = activeIdx;
    _syncFromChannel();
  }

  const ox = contentRect.x;
  const oy = contentRect.y;
  previewW = PREVIEW_WIDTH;

  // ── キーボード入力処理 (毎フレーム) ──
  handleKeyboard();

  // ── 波形プレビュー ──
  drawWaveformPreview(
    ox + UI.FOCUS_MARGIN,
    oy + UI.FOCUS_MARGIN,
    PREVIEW_WIDTH,
  );

  // ── ウィジェット描画 ──
  allWidgets.draw(contentRect);
}

/** 波形プレビューを描画する */
function drawWaveformPreview(ox, oy, w) {
  const pw = w;
  const ph = PREVIEW_HEIGHT;

  // 角丸枠 (1px radius)
  drawRoundRect(ox, oy, pw, ph, 1, 1);

  // コンテンツ領域 (枠1px + 余白1px = 2px インセット)
  const cx1 = ox + 2;
  const cy1 = oy + 2;
  const cw = pw - 4;
  const ch = ph - 4; // 33 - 4 = 29 (奇数 → 中心が正確)

  // 水平中心線 (y=0) — 破線 (1on 1off)
  const mid = cy1 + (ch >> 1);
  for (let x = cx1; x < cx1 + cw; x += 2) {
    pset(x, mid, 1);
  }

  // 垂直中心線 (位相0 = 再生開始位置) — 破線 (1on 1off)
  const centerX = cx1 + (cw >> 1);
  for (let y = cy1; y < cy1 + ch; y += 2) {
    pset(centerX, y, 1);
  }

  // 波形サンプル (位相0 が中央になるよう半周期ずらして取得)
  const halfH = ch >> 1;
  const samples = getActiveTrackChannel().getWaveformSamples(cw);
  const half = cw >> 1;
  for (let i = 0; i < cw; i++) {
    // samples は位相0始まりなので、描画位置を半分ずらす
    const si = (i + half) % cw;
    const sx = cx1 + i;
    const sy = mid - Math.round(samples[si] * halfH);
    pset(sx, sy, 1);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function onSynthInput(ev) {
  const lx = ev.localX;
  const ly = ev.localY;

  // ── プレビュー領域のドラッグ / ホイール操作 ──
  if (ev.type === "hover" && hitPreview(lx, ly)) {
    wmRequestCursor("move");
  }
  if (ev.type === "down" && hitPreview(lx, ly)) {
    draggingPhase = true;
    dragPhaseAnchor = Audio.getStartPhase() * 360;
    dragStartX = lx;
    return; // ウィジェットに伝播しない
  }
  if (ev.type === "held" && draggingPhase) {
    wmRequestCursor("move");
    const dx = lx - dragStartX;
    // プレビュー幅1周 = 360°、Shift で 1/10 微調整
    const pw = previewW - 4; // コンテンツ幅
    const scale = ev.shift ? 0.1 : 1;
    const degPerPx = (360 / pw) * scale;
    applyPhaseDeg(Math.round(dragPhaseAnchor - dx * degPerPx));
    return;
  }
  if (ev.type === "up" && draggingPhase) {
    draggingPhase = false;
  }
  // ダブルクリック: 位相をデフォルト (0°) にリセット
  if (ev.type === "dblclick" && hitPreview(lx, ly)) {
    draggingPhase = false;
    applyPhaseDeg(0);
    return;
  }
  if (ev.type === "wheel" && hitPreview(lx, ly)) {
    const cur = Math.round(getActiveTrackChannel().getStartPhase() * 360);
    const dir = Math.sign(ev.deltaY); // ピクセル値ではなく方向だけ使う
    applyPhaseDeg(cur + dir * 5); // 1 ノッチ = 5°
    return;
  }

  allWidgets.update(ev);
}

/** 波形名からドロップダウンのインデックスを引くマップ */
const waveIndexMap = Object.fromEntries(WAVE_IDS.map((id, i) => [id, i]));

/** PCキーボードの演奏入力を処理する */
function handleKeyboard() {
  if (!wmIsFocused(APP_NAME) || isTransportPlaying()) {
    // フォーカスを失った or 再生中はノートオフ
    if (activeNote >= 0) {
      if (_playingChannel) { _playingChannel.noteOff(); _playingChannel = null; }
      activeNote = -1;
      activeKeyCode = null;
    }
    return;
  }

  // ── オクターブ切替 (,  .) ──
  if (keyDown("Comma")) {
    octave = Math.max(1, octave - 1);
  }
  if (keyDown("Period")) {
    octave = Math.min(7, octave + 1);
  }

  // ── ベロシティ切替 ([ ]) ──
  if (keyDown("BracketLeft")) {
    velocity = Math.max(0, velocity - 10);
  }
  if (keyDown("BracketRight")) {
    velocity = Math.min(127, velocity + 10);
  }

  // ── 波形順送り (/) ──
  if (keyDown("Slash")) {
    const newWf = getActiveTrackChannel().cycleWaveform();
    // ドロップダウンの選択状態を同期
    const idx = waveIndexMap[newWf];
    if (idx !== undefined) dropDownWave.selectedIndex = idx;
  }

  // 新規キー押下を検出
  for (const k of ALL_KEYS) {
    if (keyDown(k.code)) {
      Audio.initAudio();
      const midi = offsetToMidi(k.offset);
      const freq = Audio.midiToFreq(midi);
      _playingChannel = getActiveTrackChannel();
      _playingChannel.noteOn(freq, undefined, velocity / 127);
      activeNote = midi;
      activeKeyCode = k.code;
      return;
    }
  }

  // 現在のキーが離されたら → 他に押下中のノートキーがあれば復帰、なければノートオフ
  if (activeNote >= 0 && activeKeyCode && !keyHeld(activeKeyCode)) {
    // 他に押下中のキーを探す (後方優先 = 最後に配置されたキーが優先)
    let found = false;
    for (let i = ALL_KEYS.length - 1; i >= 0; i--) {
      const k = ALL_KEYS[i];
      if (k.code !== activeKeyCode && keyHeld(k.code)) {
        // 押下中のキーに復帰 (re-trigger)
        const midi = offsetToMidi(k.offset);
        const freq = Audio.midiToFreq(midi);
        _playingChannel = getActiveTrackChannel();
        _playingChannel.noteOn(freq, undefined, velocity / 127);
        activeNote = midi;
        activeKeyCode = k.code;
        found = true;
        break;
      }
    }
    if (!found) {
      if (_playingChannel) { _playingChannel.noteOff(); _playingChannel = null; }
      activeNote = -1;
      activeKeyCode = null;
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  測定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function measureSynth() {
  _initWidgets();
  relayout();
  const m = synthRoot.measure();
  return {
    w: Math.max(m.w, PREVIEW_WIDTH + UI.FOCUS_MARGIN * 2),
    h: m.h,
  };
}

/**
 * シンセ UI のウィジェットを再計測・再配置する (フォント変更時)。
 */
export function remeasureSynth() {
  if (!allWidgets) return;
  allWidgets.remeasureAll();
  relayout();
}

/**
 * シンセ UI の全状態を初期値にリセットする。
 * STUDIO ウィンドウを閉じるときに呼ばれる。
 */
export function resetSynth() {
  // キーボード入力
  activeNote = -1;
  activeKeyCode = null;

  // パラメータ
  octave = 3;
  velocity = 100;
  attackMs = 10;
  decayMs = 100;
  sustainPct = 80;
  releaseMs = 200;
  draggingPhase = false;

  // トラック同期状態
  _lastSyncedTrack = -1;
  _playingChannel = null;

  // ウィジェット
  dropDownWave.selectedIndex = 0;
  numberBoxAttack.value = 10;
  numberBoxDecay.value = 100;
  numberBoxSustain.value = 80;
  numberBoxRelease.value = 200;
  sliderVolume.value = 50;
  sliderPhase.value = 0;
}

