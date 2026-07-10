/**
 * @module app/synth/synth
 * synth.js — SYNTH ウィンドウ (ポリフォニック・ソフトシンセ)
 *
 * 音楽制作機能の再設計・第 1 弾。単体で完結するソフトシンセサイザ。
 * 音色を作り (波形 / ADSR / 音量)、PC キーボード・オンスクリーン鍵盤で和音を演奏する。
 * 音源は core/audio.js の PolySynth。SYNESTA には依存しない完全な新規アプリ。
 *
 * ── UI 設計 (CRAP) ──
 *   Proximity : 機能で OSC / ENV / AMP / PLAY の 4 セクションに分割 (反転バンド見出し)。
 *   Repetition: 数値調整を全て同型スライダーに統一。単位 (MS/%) を一貫表示。
 *   Alignment : 単一左マージン、スライダー track の左端・幅を統一、値+単位を右揃え列に。
 *   Contrast  : 見出しは反転帯、鍵盤の押下キーは反転で強調 (1-bit の on/off)。
 *
 * 演奏キー (フォーカス時):
 *   Z 段 = 現オクターブ, Q 段 = +1oct, I〜P = +2oct
 *   , / .  … オクターブ ∓    [ / ]  … ベロシティ ± 10    /  … 波形順送り
 */

import { fillRect } from "../../core/gpu.js";
import { drawText, textWidth, GLYPH_H } from "../../core/font.js";
import { keyDown, keyHeld } from "../../core/input.js";
import { wmOpen, wmRegister, wmIsFocused } from "../../wm/index.js";
import { createPolySynth } from "../../core/audio.js";
import {
  WidgetGroup,
  Slider,
  PushButton,
  DropDown,
  FOCUS_MARGIN,
  GAP,
  SECTION_PAD,
} from "../../ui/index.js";
import { Keyboard } from "./keyboard.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const APP_NAME = "SYNTH";

/** 鍵盤: 白鍵ピッチ・高さ・表示白鍵数 (2 オクターブ) */
const KEY_W = 14;
const KEY_H = 42;
const NUM_WHITE = 14;
/** コンテンツ幅 (鍵盤幅に合わせる。仕切り共有のため +1)。全セクション共通の基準幅 */
const PANEL_W = KEY_W * NUM_WHITE + 1;
/** セクション内コントロールの左インセット */
const PAD_X = 3;

/** オクターブ / ベロシティの範囲 */
const OCTAVE_MIN = 1;
const OCTAVE_MAX = 7;
const VEL_MIN = 10;
const VEL_MAX = 127;
const VEL_STEP = 10;

/** 波形: 表示名 (DropDown) と内部 ID (PolySynth)。順序を対応させる */
const WAVE_ITEMS = ["SAW", "TRI", "SQ50", "SQ25", "SQ12", "SINE", "NOISE"];
const WAVE_IDS = ["saw", "tri", "sq50", "sq25", "sq12", "sine", "noise"];
const waveIndexMap = Object.fromEntries(WAVE_IDS.map((id, i) => [id, i]));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  音源 (遅延生成)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {import("../../core/audio.js").PolySynth|null} */
let _synth = null;
function synth() {
  if (!_synth) _synth = createPolySynth();
  return _synth;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  演奏状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let octave = 4;
let velocity = 100;
/** 押下中の物理キー → 発音した MIDI (押下時の音程で noteOff するため保持) */
const heldKeys = new Map();

/** オクターブ内の半音オフセット (C からの) → MIDI (C4 = 60) */
function offsetToMidi(offset) {
  return 12 + octave * 12 + offset;
}

/** PC 演奏キー配列 (Z 段 / Q 段 / I〜P) */
const KEY_MAP = [
  { code: "KeyZ", offset: 0 }, { code: "KeyS", offset: 1 },
  { code: "KeyX", offset: 2 }, { code: "KeyD", offset: 3 },
  { code: "KeyC", offset: 4 }, { code: "KeyV", offset: 5 },
  { code: "KeyG", offset: 6 }, { code: "KeyB", offset: 7 },
  { code: "KeyH", offset: 8 }, { code: "KeyN", offset: 9 },
  { code: "KeyJ", offset: 10 }, { code: "KeyM", offset: 11 },
  { code: "KeyQ", offset: 12 }, { code: "Digit2", offset: 13 },
  { code: "KeyW", offset: 14 }, { code: "Digit3", offset: 15 },
  { code: "KeyE", offset: 16 }, { code: "KeyR", offset: 17 },
  { code: "Digit5", offset: 18 }, { code: "KeyT", offset: 19 },
  { code: "Digit6", offset: 20 }, { code: "KeyY", offset: 21 },
  { code: "Digit7", offset: 22 }, { code: "KeyU", offset: 23 },
  { code: "KeyI", offset: 24 }, { code: "Digit9", offset: 25 },
  { code: "KeyO", offset: 26 }, { code: "Digit0", offset: 27 },
  { code: "KeyP", offset: 28 },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィジェット + レイアウト (遅延初期化)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let dropDownWave;
let sliderA, sliderD, sliderS, sliderR, sliderVol;
let btnOctDown, btnOctUp;
let keyboard;
let group;
let _ready = false;

/** レイアウト結果 (draw / 測定で共有する相対座標) */
const L = {};

function _initWidgets() {
  if (_ready) return;
  _ready = true;

  dropDownWave = new DropDown(0, 0, WAVE_ITEMS, 0, (idx) => {
    synth().setWaveform(WAVE_IDS[idx]);
  });

  // ENV/AMP: 全て同型スライダー。初期値は PolySynth の既定に一致させる
  sliderA = new Slider(0, 0, 0, 0, 2000, 10, (v) => applyADSR({ a: v }));
  sliderD = new Slider(0, 0, 0, 0, 2000, 100, (v) => applyADSR({ d: v }));
  sliderS = new Slider(0, 0, 0, 0, 100, 80, (v) => applyADSR({ s: v }));
  sliderR = new Slider(0, 0, 0, 0, 2000, 200, (v) => applyADSR({ r: v }));
  sliderVol = new Slider(0, 0, 0, 0, 100, 50, (v) => synth().setVolume(v));

  btnOctDown = new PushButton(0, 0, "<", () => setOctave(octave - 1));
  btnOctUp = new PushButton(0, 0, ">", () => setOctave(octave + 1));

  keyboard = new Keyboard(KEY_W, KEY_H, NUM_WHITE, {
    onNoteOn: (m) => synth().noteOn(m, velocity / 127),
    onNoteOff: (m) => synth().noteOff(m),
    isHeld: (m) => synth().isNoteHeld(m),
  });

  group = new WidgetGroup([
    dropDownWave,
    sliderA, sliderD, sliderS, sliderR, sliderVol,
    btnOctDown, btnOctUp,
    keyboard,
  ]);

  computeLayout();
}

/** ADSR の一部を更新して PolySynth に反映する */
function applyADSR({ a, d, s, r }) {
  const c = synth().getADSR();
  synth().setADSR(
    a !== undefined ? a : c.a,
    d !== undefined ? d : c.d,
    s !== undefined ? s : c.s,
    r !== undefined ? r : c.r,
  );
}

/** オクターブを設定する (クランプ)。鍵盤の表示範囲も追従する */
function setOctave(n) {
  octave = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, n));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  レイアウト計算 (相対座標。ウィンドウは固定サイズ + スクロール)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function computeLayout() {
  group.remeasureAll();

  const bandH = GLYPH_H + SECTION_PAD * 2;
  const sliderH = sliderA.h;
  const rowH = sliderH + GAP;
  const nameColW = textWidth("WAVE"); // 最長ラベルに合わせ、全コントロールの左端を揃える
  const valueW = textWidth("0000 MS");

  L.bandH = bandH;
  L.textDy = (sliderH - GLYPH_H) >> 1;
  L.trackX = PAD_X + nameColW + GAP;
  L.valueX = PANEL_W - PAD_X - valueW;
  const trackW = Math.max(20, L.valueX - GAP - L.trackX);

  const setRow = (s, y) => {
    s.x = L.trackX;
    s.w = trackW;
    s.y = y;
  };

  let y = FOCUS_MARGIN;

  // ── OSC ── WAVE ラベル + 波形 DropDown (track 列に左端を合わせる)
  L.oscBandY = y;
  y += bandH + GAP;
  L.oscRowY = y;
  L.oscTextY = y + ((dropDownWave.h - GLYPH_H) >> 1);
  dropDownWave.x = L.trackX;
  dropDownWave.y = y;
  y += dropDownWave.h + GAP;

  // ── ENV ──
  L.envBandY = y;
  y += bandH + GAP;
  L.rowAY = y; setRow(sliderA, y); y += rowH;
  L.rowDY = y; setRow(sliderD, y); y += rowH;
  L.rowSY = y; setRow(sliderS, y); y += rowH;
  L.rowRY = y; setRow(sliderR, y); y += rowH;

  // ── AMP ──
  L.ampBandY = y;
  y += bandH + GAP;
  L.rowVolY = y; setRow(sliderVol, y); y += rowH;

  // ── PLAY ──
  L.playBandY = y;
  y += bandH + GAP;
  // コントロール行: [<] OCT n [>]   VEL nnn  POLY nn
  btnOctDown.x = PAD_X;
  btnOctDown.y = y;
  L.octTextX = btnOctDown.x + btnOctDown.w + GAP;
  btnOctUp.x = L.octTextX + textWidth("OCT 8") + GAP;
  btnOctUp.y = y;
  L.vpTextX = btnOctUp.x + btnOctUp.w + GAP * 2;
  L.ctrlTextY = y + ((btnOctDown.h - GLYPH_H) >> 1);
  y += Math.max(btnOctDown.h, GLYPH_H) + GAP;
  // 鍵盤 (全幅)
  keyboard.x = 0;
  keyboard.y = y;
  keyboard.w = PANEL_W;
  keyboard.h = KEY_H;
  y += KEY_H + FOCUS_MARGIN;

  L.totalW = PANEL_W;
  L.totalH = y;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 反転バンドのセクション見出しを描く (SectionLabel と同様式) */
function drawBand(cr, label, y) {
  fillRect(cr.x, cr.y + y, PANEL_W, L.bandH, 1);
  drawText(cr.x + SECTION_PAD, cr.y + y + SECTION_PAD, label, 0);
}

/** スライダー行のラベル (左) と 値+単位 (右揃え列) を描く */
function drawRow(cr, name, y, value, unit) {
  const ty = cr.y + y + L.textDy;
  drawText(cr.x + PAD_X, ty, name, 1);
  const vs = String(value).padStart(4) + " " + unit.padEnd(2);
  drawText(cr.x + L.valueX, ty, vs, 1);
}

function drawSynth(cr) {
  _initWidgets();
  handleKeyboard();

  // セクション見出し
  drawBand(cr, "OSC", L.oscBandY);
  drawBand(cr, "ENV", L.envBandY);
  drawBand(cr, "AMP", L.ampBandY);
  drawBand(cr, "PLAY", L.playBandY);

  // OSC の WAVE ラベル (DropDown 自体は group が描画)
  drawText(cr.x + PAD_X, cr.y + L.oscTextY, "WAVE", 1);

  // ENV / AMP の値ラベル (スライダー値から毎フレーム)
  drawRow(cr, "A", L.rowAY, sliderA.value, "MS");
  drawRow(cr, "D", L.rowDY, sliderD.value, "MS");
  drawRow(cr, "S", L.rowSY, sliderS.value, "%");
  drawRow(cr, "R", L.rowRY, sliderR.value, "MS");
  drawRow(cr, "VOL", L.rowVolY, sliderVol.value, "%");

  // PLAY コントロール行のテキスト
  drawText(cr.x + L.octTextX, cr.y + L.ctrlTextY, "OCT " + octave, 1);
  drawText(
    cr.x + L.vpTextX,
    cr.y + L.ctrlTextY,
    "VEL " + String(velocity).padStart(3) + "  POLY " + String(synth().heldCount).padStart(2),
    1,
  );

  // 鍵盤の表示範囲を現オクターブの C に合わせてからウィジェット描画
  keyboard.startMidi = 12 + octave * 12;
  group.draw(cr);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PC キーボード演奏 (ポリフォニック)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function handleKeyboard() {
  if (!wmIsFocused(APP_NAME)) {
    if (heldKeys.size > 0) {
      synth().allNotesOff();
      heldKeys.clear();
    }
    return;
  }

  if (keyDown("Comma")) setOctave(octave - 1);
  if (keyDown("Period")) setOctave(octave + 1);
  if (keyDown("BracketLeft")) velocity = Math.max(VEL_MIN, velocity - VEL_STEP);
  if (keyDown("BracketRight")) velocity = Math.min(VEL_MAX, velocity + VEL_STEP);
  if (keyDown("Slash")) {
    const wf = synth().cycleWaveform();
    dropDownWave.selectedIndex = waveIndexMap[wf] ?? 0;
  }

  // 新規押下 → ノートオン (和音対応)
  for (const k of KEY_MAP) {
    if (keyDown(k.code) && !heldKeys.has(k.code)) {
      const midi = offsetToMidi(k.offset);
      synth().noteOn(midi, velocity / 127);
      heldKeys.set(k.code, midi);
    }
  }
  // 離鍵 → ノートオフ (押下時の音程で)
  for (const [code, midi] of heldKeys) {
    if (!keyHeld(code)) {
      synth().noteOff(midi);
      heldKeys.delete(code);
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力 / 測定 / リセット
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onSynthInput(ev) {
  _initWidgets();
  group.update(ev);
}

function measureSynth() {
  _initWidgets();
  return { w: L.totalW, h: L.totalH };
}

/** 発音を止め一時的な入力状態をクリアする (音作り・オクターブ等の設定は保持) */
function silence() {
  if (_synth) _synth.allNotesOff();
  if (keyboard) keyboard.reset();
  heldKeys.clear();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    _initWidgets();
    return wmOpen(-1, -1, 0, 0, APP_NAME, drawSynth, onSynthInput, measureSynth, {
      about:
        "A polyphonic software synthesizer. Pick a waveform, shape the ADSR " +
        "envelope and volume, then play chords on the on-screen keyboard or the " +
        "PC keyboard (Z row = current octave, Q row = +1, I-P = +2). Use , . to " +
        "change octave, [ ] for velocity, / to cycle the waveform.",
      onBeforeClose: () => {
        silence();
        return true;
      },
      onRelayout: () => {
        if (!group) return;
        computeLayout();
      },
    });
  },
  { category: "CREATIVE", dev: true },
);
