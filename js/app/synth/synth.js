/**
 * @module app/synth/synth
 * synth.js — SYNTH ウィンドウ (ポリフォニック・ソフトシンセ)
 *
 * 音楽制作機能の再設計・第 1 弾。単体で完結するソフトシンセサイザ。
 * 音色を作り (波形 / 発音数 / ADSR / 音量)、PC キーボード・オンスクリーン鍵盤で
 * 和音を演奏する。音源は core/audio.js の PolySynth。SYNESTA には依存しない。
 *
 * ── レイアウト (横長 2 段) ──
 *   上段: OSC / ENV / AMP / PLAY を左から右へ横並び (各セクション幅の反転バンド見出し)。
 *   下段: 演奏用の鍵盤プレビュー (見出しなし、上段バンド幅に合わせた全幅)。
 *
 *     [   OSC   ] [    ENV    ] [AMP] [ PLAY ]
 *     WAVE   [▼]  ATT DEC SUS REL VOL  VEL[#]
 *     VOICES [▼]   |   |   |   |   |   OCT[#]
 *     ###################################### (鍵盤)
 *
 * ── UI 設計 (CRAP) ──
 *   Proximity : 機能で OSC / ENV / AMP / PLAY の 4 セクションに分割。
 *   Repetition: ENV(A/D/S/R) と AMP(VOL) は同型の縦フェーダー。
 *               OSC(WAVE/VOICES) は DropDown、PLAY(VEL/OCT) は NumberBox の 2 行組。
 *   Alignment : 見出し帯は各セクション幅・ラベル中央寄せ。ラベルは上段の同一行に揃え、
 *               フェーダーは 1 バンクの等間隔、鍵盤は上段バンドと中央で揃える。
 *   Contrast  : 見出しは反転帯、鍵盤の押下キーは反転で強調 (1-bit の on/off)。
 *
 * ENV / AMP フェーダーで調整中 (最後に触れた) パラメータの値はフッタ左に表示する
 * (フェーダー自身には数値を出さない)。フッタ右には現在の発音数 / 最大同時発音数
 * (VOICES) と、MIDI デバイス接続時はその台数を表示する。
 *
 * 演奏キー (フォーカス時):
 *   Z 段 = 現オクターブ, Q 段 = +1oct, I〜P = +2oct
 *   , / .  … オクターブ ∓    [ / ]  … ベロシティ ± 10    /  … 波形順送り
 *   (OCT / VEL は上段の NumberBox でも直接編集でき、値は相互に同期する)
 */

import { fillRect, isCapturing } from "../../core/gpu.js";
import { drawText, textWidth, GLYPH_H } from "../../core/font.js";
import { keyDown, keyHeld } from "../../core/input.js";
import { wmOpen, wmRegister, wmIsFocused } from "../../wm/index.js";
import { createPolySynth, midiEventAudioTime } from "../../core/audio.js";
import { initMidiInput, getMidiInputCount } from "../../core/midi_input.js";
import {
  WidgetGroup,
  DropDown,
  NumberBox,
  FOCUS_MARGIN,
  GAP,
  SECTION_PAD,
} from "../../ui/index.js";
import { Fader, FADER_W, FADER_DEFAULT_H, FADER_GAP } from "../../ui/music/index.js";
import { Keyboard } from "./keyboard.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const APP_NAME = "SYNTH";

/** 鍵盤: 白鍵ピッチ・高さ・表示白鍵数 (3 オクターブ) */
const KEY_W = 14;
const KEY_H = 42;
const NUM_WHITE = 21;
/** 鍵盤の全幅 (px)。仕切り共有のため +1 */
const KEYBOARD_W = KEY_W * NUM_WHITE + 1;
/** ENV フェーダーの高さ (可動域)。間隔は連結バンクにするため FADER_GAP (=1px) */
const FADER_H = FADER_DEFAULT_H;
/** 上段セクション間の間隔 (px)。セクション内の GAP より広げて区切りを明確にする */
const SEC_GAP = GAP * 2;

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

/** 最大同時発音数 (VOICES) の選択肢。既定 16 は PolySynth の DEFAULT_MAX_VOICES に一致 */
const VOICE_VALUES = [4, 8, 16, 32];
const VOICE_ITEMS = VOICE_VALUES.map(String);
const VOICE_DEFAULT_INDEX = VOICE_VALUES.indexOf(16);

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
/** SYNTH ウィンドウが開いているか。MIDI 入力のゲート (外部デバイスはフォーカスに依らず有効) */
let winOpen = false;
/** MIDI で発音中のノート (閉じるとき止めるため保持) */
const midiHeld = new Set();

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

let dropDownWave, dropDownVoices;
let faderA, faderD, faderS, faderR, faderVol;
/** ENV フェーダーを左→右順に保持 (ENV_FADERS と添字対応) */
let envFaders = [];
let numVel, numOct;
let keyboard;
let group;
let _ready = false;

/** ENV フェーダーの定義 (順序 = 左→右)。ラベルはフェーダー上・フッタ表示に使う */
const ENV_FADERS = [
  { key: "a", label: "ATT", unit: "MS" },
  { key: "d", label: "DEC", unit: "MS" },
  { key: "s", label: "SUS", unit: "%" },
  { key: "r", label: "REL", unit: "MS" },
];

/** フッタに出す「最後に触れたアナログパラメータ (ENV / VOL)」の表示文字列 */
let paramFooterText = "";

/** レイアウト結果 (draw / 測定で共有する相対座標) */
const L = {};

function _initWidgets() {
  if (_ready) return;
  _ready = true;

  dropDownWave = new DropDown(0, 0, WAVE_ITEMS, 0, (idx) => {
    synth().setWaveform(WAVE_IDS[idx]);
  });
  dropDownVoices = new DropDown(0, 0, VOICE_ITEMS, VOICE_DEFAULT_INDEX, (idx) => {
    synth().setMaxVoices(VOICE_VALUES[idx]);
  });

  // ENV: A/D/S/R は同型の縦フェーダー。初期値は PolySynth の既定に一致させる
  faderA = new Fader(0, 0, FADER_H, 0, 2000, 10, (v) => onEnvChange(0, v));
  faderD = new Fader(0, 0, FADER_H, 0, 2000, 100, (v) => onEnvChange(1, v));
  faderS = new Fader(0, 0, FADER_H, 0, 100, 80, (v) => onEnvChange(2, v));
  faderR = new Fader(0, 0, FADER_H, 0, 2000, 200, (v) => onEnvChange(3, v));
  envFaders = [faderA, faderD, faderS, faderR];
  // フッタ初期表示 = 先頭 (ATTACK) の値
  setParamFooter("ATT", faderA.value, "MS");

  // AMP: VOL は ENV と同型の縦フェーダー (数値はフッタに表示)
  faderVol = new Fader(0, 0, FADER_H, 0, 100, 50, (v) => {
    synth().setVolume(v);
    setParamFooter("VOL", v, "%");
  });

  // PLAY: VEL / OCT は NumberBox (キーボードショートカットと相互同期する)
  numVel = new NumberBox(0, 0, VEL_MIN, VEL_MAX, velocity, VEL_STEP, (v) => {
    velocity = v;
  });
  numOct = new NumberBox(0, 0, OCTAVE_MIN, OCTAVE_MAX, octave, 1, (v) => {
    setOctave(v);
  });

  keyboard = new Keyboard(KEY_W, KEY_H, NUM_WHITE, {
    onNoteOn: (m) => synth().noteOn(m, velocity / 127),
    onNoteOff: (m) => synth().noteOff(m),
    isHeld: (m) => synth().isNoteHeld(m),
  });

  group = new WidgetGroup([
    dropDownWave, dropDownVoices,
    faderA, faderD, faderS, faderR, faderVol,
    numVel, numOct,
    keyboard,
  ]);

  computeLayout();

  // Web MIDI 入力 (非対応環境では自動で無効 → PC 鍵盤にフォールバック)。
  // フォーカスに依らず winOpen の間だけ発音する (外部 MIDI 鍵盤の自然な挙動)。
  // 発音時刻を MIDI イベントの timeStamp に固定してフレーム描画由来のジッタを吸収する
  // (midiEventAudioTime が performance.now → AudioContext 時刻へ変換)。
  initMidiInput({
    onNoteOn: (m, v, t) => {
      if (!winOpen) return;
      midiHeld.add(m);
      synth().noteOn(m, v, midiEventAudioTime(t));
    },
    onNoteOff: (m, t) => {
      if (!winOpen) return;
      midiHeld.delete(m);
      synth().noteOff(m, midiEventAudioTime(t));
    },
  });
}

/** ENV フェーダー変更: ADSR に反映し、フッタ表示を更新する */
function onEnvChange(i, v) {
  applyADSR({ [ENV_FADERS[i].key]: v });
  setParamFooter(ENV_FADERS[i].label, v, ENV_FADERS[i].unit);
}

/** フッタ用の「ラベル 値 単位」文字列を組み立てる (最後に触れたアナログパラメータ) */
function setParamFooter(label, v, unit) {
  paramFooterText = label + "  " + String(v).padStart(4) + " " + unit;
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
  const dropH = dropDownWave.h; // BUTTON_AUTO_HEIGHT
  const rowTextDy = (dropH - GLYPH_H) >> 1; // ラベルを行コントロールの高さ中央に置く
  const pitch = FADER_W + FADER_GAP;

  // ── 縦グリッド (上段) ── バンド → 1 行目 → 2 行目 (= フェーダー上端)
  const y0 = FOCUS_MARGIN;
  const row1Y = y0 + bandH + GAP;
  const row2Y = row1Y + dropH + GAP;
  const faderTop = row2Y;
  const contentBottom = faderTop + FADER_H;

  L.bandH = bandH;
  L.bandY = y0;
  L.row1TextY = row1Y + rowTextDy; // WAVE / ATT.. / VOL / VEL のラベル行
  L.row2TextY = row2Y + rowTextDy; // VOICES / OCT のラベル行

  // ── 各セクションの幅 ──
  const labelWOsc = Math.max(textWidth("WAVE"), textWidth("VOICES"));
  const oscW = labelWOsc + GAP + Math.max(dropDownWave.w, dropDownVoices.w);
  const envW = envFaders.length * pitch - FADER_GAP;
  const ampW = FADER_W;
  const labelWPlay = Math.max(textWidth("VEL"), textWidth("OCT"));
  const playW = labelWPlay + GAP + Math.max(numVel.w, numOct.w);

  const topW = oscW + SEC_GAP + envW + SEC_GAP + ampW + SEC_GAP + playW;
  const panelW = Math.max(topW + FOCUS_MARGIN * 2, KEYBOARD_W);

  // 上段バンドをパネル幅の中央に配置 (鍵盤幅の方が広い場合に中央で揃える)
  let x = (panelW - topW) >> 1;

  // ── OSC ── WAVE / VOICES ラベル + DropDown (ラベル列に左端を揃える)
  const oscX = x;
  const oscCtrlX = oscX + labelWOsc + GAP;
  dropDownWave.x = oscCtrlX; dropDownWave.y = row1Y;
  dropDownVoices.x = oscCtrlX; dropDownVoices.y = row2Y;
  L.oscLabelX = oscX;
  x += oscW + SEC_GAP;

  // ── ENV ── ATT/DEC/SUS/REL の縦フェーダーを 1px 間隔で連結したバンク
  const envX = x;
  L.faderLabelX = [];
  for (let i = 0; i < envFaders.length; i++) {
    const fx = envX + i * pitch;
    L.faderLabelX.push(fx);
    envFaders[i].x = fx;
    envFaders[i].y = faderTop;
    envFaders[i].h = FADER_H;
  }
  x += envW + SEC_GAP;

  // ── AMP ── VOL の縦フェーダー 1 本 (ラベルはフェーダー上に中央寄せ)
  const ampX = x;
  faderVol.x = ampX;
  faderVol.y = faderTop;
  faderVol.h = FADER_H;
  L.volLabelX = ampX + ((FADER_W - textWidth("VOL")) >> 1);
  x += ampW + SEC_GAP;

  // ── PLAY ── VEL / OCT の NumberBox (ラベル列に左端を揃える)
  const playX = x;
  const playCtrlX = playX + labelWPlay + GAP;
  numVel.x = playCtrlX; numVel.y = row1Y;
  numOct.x = playCtrlX; numOct.y = row2Y;
  L.playLabelX = playX;
  x += playW;

  // ── セクション見出しバンド (各セクション幅・ラベル中央寄せ) ──
  L.bands = [
    { label: "OSC", x: oscX, w: oscW },
    { label: "ENV", x: envX, w: envW },
    { label: "AMP", x: ampX, w: ampW },
    { label: "PLAY", x: playX, w: playW },
  ];

  // ── 下段 鍵盤 (全幅・パネル中央) ──
  keyboard.x = (panelW - KEYBOARD_W) >> 1;
  keyboard.y = contentBottom + GAP;
  keyboard.w = KEYBOARD_W;
  keyboard.h = KEY_H;

  L.totalW = panelW;
  L.totalH = keyboard.y + KEY_H + FOCUS_MARGIN;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 反転バンドのセクション見出しを描く (ラベルはバンド内で中央寄せ) */
function drawBand(cr, label, x, y, w) {
  fillRect(cr.x + x, cr.y + y, w, L.bandH, 1);
  const tx = cr.x + x + ((w - textWidth(label)) >> 1);
  drawText(tx, cr.y + y + SECTION_PAD, label, 0);
}

/** ENV フェーダーのラベル (ATT/DEC/SUS/REL) を各フェーダーの上に中央寄せで描く */
function drawFaderLabels(cr) {
  for (let i = 0; i < envFaders.length; i++) {
    const name = ENV_FADERS[i].label;
    const lx = cr.x + L.faderLabelX[i] + ((FADER_W - textWidth(name)) >> 1);
    drawText(lx, cr.y + L.row1TextY, name, 1);
  }
}

/** フッタ: 左に最後に触れたパラメータ値、右に発音数 / 最大同時発音数 (+ MIDI) を描く */
function drawSynthFooter(fr) {
  _initWidgets();
  if (paramFooterText) drawText(fr.x, fr.y, paramFooterText, 1);

  let right =
    "POLY " +
    String(synth().heldCount).padStart(2) +
    "/" +
    String(synth().getMaxVoices()).padStart(2);
  const midiN = getMidiInputCount();
  if (midiN > 0) right += "  MIDI " + midiN;
  drawText(fr.x + fr.w - textWidth(right), fr.y, right, 1);
}

function drawSynth(cr) {
  _initWidgets();
  // CAPTURE のウィンドウ単体撮影/録画は同じフレーム内で onDraw をもう一度走らせる。
  // keyDown() はフレーム単位のラッチなので、そこで演奏キーを読むと , . [ ] / が二度発火する。
  if (!isCapturing()) handleKeyboard();

  // セクション見出し (各セクション幅の反転バンド)
  for (const b of L.bands) drawBand(cr, b.label, b.x, L.bandY, b.w);

  // OSC の WAVE / VOICES ラベル (DropDown 本体は group が描画)
  drawText(cr.x + L.oscLabelX, cr.y + L.row1TextY, "WAVE", 1);
  drawText(cr.x + L.oscLabelX, cr.y + L.row2TextY, "VOICES", 1);

  // ENV フェーダーのラベル (数値は出さず、フッタに表示)
  drawFaderLabels(cr);

  // AMP の VOL ラベル (フェーダー上・中央寄せ)
  drawText(cr.x + L.volLabelX, cr.y + L.row1TextY, "VOL", 1);

  // PLAY の VEL / OCT ラベル (NumberBox 本体は group が描画)
  drawText(cr.x + L.playLabelX, cr.y + L.row1TextY, "VEL", 1);
  drawText(cr.x + L.playLabelX, cr.y + L.row2TextY, "OCT", 1);

  // NumberBox とキーボード演奏状態を同期 (, . [ ] で変えた値を表示に反映)
  if (numOct.value !== octave) numOct.value = octave;
  if (numVel.value !== velocity) numVel.value = velocity;

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
  midiHeld.clear();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    _initWidgets();
    winOpen = true;
    return wmOpen(-1, -1, 0, 0, APP_NAME, drawSynth, onSynthInput, measureSynth, {
      about:
        "A polyphonic software synthesizer. Pick a waveform and voice count, " +
        "shape the ADSR envelope and volume, then play chords on the on-screen " +
        "keyboard or the PC keyboard (Z row = current octave, Q row = +1, I-P = " +
        "+2). Use , . to change octave, [ ] for velocity, / to cycle the waveform.",
      // ENV / AMP フェーダーで調整中のパラメータ値をフッタに表示する
      footer: true,
      onDrawFooter: (fr) => drawSynthFooter(fr),
      onBeforeClose: () => {
        winOpen = false;
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
