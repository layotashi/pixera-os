/**
 * @module app/roll/roll
 * roll.js — ROLL ウィンドウ (ステップグリッド MIDI フレーズエディタ)
 *
 * 音楽制作機能の再設計・第 2 弾。単一パターン／単一ボイスのフレーズエディタ
 * (docs/MIDI_EDITOR_SPEC.md)。SYNESTA のモノリス的破綻への回答として「音符と時間だけ」を
 * 扱い、音色は SYNTH、複数トラックは将来のアプリに委ねる。
 *
 * ── 構成 ──
 *   ボディ = [ツールバー][ピアノロールグリッド (grid.js)]。
 *   ツールバー: PLAY トグル + BPM。グリッド: ステップ量子化のノート編集 (grid.js 参照)。
 *
 * ── v1 プロトタイプの割り切り ──
 *   ベロシティ固定 / 内蔵デフォルト音源 (音色操作なし) / 保存なし (次イテレーション)。
 *   再生はフレーム駆動 (AudioContext 時計基準)。厳密なルックアヘッド・スケジューリングは将来。
 */

import { fillRect } from "../../core/gpu.js";
import { drawText, textWidth } from "../../core/font.js";
import { wmOpen, wmRegister, wmAttachScroll } from "../../wm/index.js";
import { createPolySynth, getAudioContext, initAudio } from "../../core/audio.js";
import { WidgetGroup, ToggleButton, NumberBox, FOCUS_MARGIN, GAP } from "../../ui/index.js";
import { PIANO_ROLL_STEPS_PER_BEAT, PIANO_ROLL_STEPS_PER_BAR, DEFAULT_BPM, BPM_MIN, BPM_MAX } from "../../config.js";
import { RollGrid } from "./grid.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const APP_NAME = "ROLL";

/** 初期ボディサイズ (DOT)。fixed-size + scroll。360px 既定幅に収まる横幅 */
const ROLL_W = 316;
const ROLL_H = 250;

/** ツールバー高 (DOT)。グリッドはこの下に置く */
const TOOLBAR_H = 14;

/** 固定ベロシティ (0..1)。v1 は強弱を扱わない (SYNTH の FIX 思想) */
const VEL = 100 / 127;

/** 試聴の消音までの秒数 */
const AUDITION_SEC = 0.28;

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
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let winId = -1;
let bpm = DEFAULT_BPM;

const grid = new RollGrid({ audition: auditionNote });

// 再生 (フレーム駆動)
let playing = false;
let loopLen = PIANO_ROLL_STEPS_PER_BAR; // 実効ループ長 (ステップ)
let playStartTime = 0; // 再生開始時の AudioContext 時刻
let playStep = -1; // 直近に発火した整数ステップ
let playheadStep = -1; // 連続プレイヘッド位置 (描画用。-1 で非表示)
/** 発音中ノート: pitch → 残りステップ数 */
const playingNotes = new Map();

// ウィジェット
let toggPlay, numBpm, group;
let _ready = false;
/** ツールバーのラベル描画位置 (コンテンツ相対) */
const TB = {};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  音・再生
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 1 ステップの長さ (秒) */
function stepDur() {
  return 60 / bpm / PIANO_ROLL_STEPS_PER_BEAT;
}

/**
 * AudioContext を確実に用意して返す。getAudioContext は生成しない (既存を返すだけ) ので、
 * 未初期化なら initAudio() で生成し、suspended なら resume する (呼び出しは全てユーザー操作起点)。
 */
function ensureCtx() {
  if (!getAudioContext()) initAudio();
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") ctx.resume();
  return ctx;
}

/** ノート配置・鍵盤クリック時の試聴 (短く鳴らして自動で消音) */
function auditionNote(midi) {
  const ctx = ensureCtx();
  if (!ctx) return;
  synth().noteOn(midi, VEL, ctx.currentTime);
  synth().noteOff(midi, ctx.currentTime + AUDITION_SEC);
}

/** ループ長 = 最長ノート終端を小節単位に切り上げ (最低 1 小節) */
function computeLoopLen() {
  let maxEnd = PIANO_ROLL_STEPS_PER_BAR;
  for (const n of grid.notes) maxEnd = Math.max(maxEnd, n.start + n.len);
  return Math.ceil(maxEnd / PIANO_ROLL_STEPS_PER_BAR) * PIANO_ROLL_STEPS_PER_BAR;
}

function startPlay() {
  const ctx = ensureCtx();
  if (!ctx) return;
  playing = true;
  loopLen = computeLoopLen();
  playStartTime = ctx.currentTime;
  playStep = -1; // 次フレームでステップ 0 から発火
  playingNotes.clear();
}

function stopPlay() {
  playing = false;
  playheadStep = -1;
  if (_synth) _synth.allNotesOff();
  playingNotes.clear();
  if (toggPlay) toggPlay.value = false;
}

/** ステップ境界に入ったとき: 持続ノートを減算・消音し、開始ノートを発音 */
function onStepEnter(step) {
  for (const [pitch, rem] of playingNotes) {
    const r = rem - 1;
    if (r <= 0) {
      synth().noteOff(pitch);
      playingNotes.delete(pitch);
    } else {
      playingNotes.set(pitch, r);
    }
  }
  for (const n of grid.notes) {
    if (n.start === step) {
      if (playingNotes.has(n.pitch)) synth().noteOff(n.pitch);
      synth().noteOn(n.pitch, VEL);
      playingNotes.set(n.pitch, n.len);
    }
  }
}

/** 毎フレームの再生更新 (AudioContext 時計を基準にプレイヘッドを進める) */
function updatePlayback() {
  if (!playing) {
    playheadStep = -1;
    return;
  }
  const ctx = getAudioContext();
  if (!ctx) return;
  const elapsed = ctx.currentTime - playStartTime;
  playheadStep = (elapsed / stepDur()) % loopLen;
  const target = Math.floor(playheadStep);
  // フレーム落ちに備え、跨いだステップを 1 つずつ発火 (ラップも 1 歩ずつ)
  while (playStep !== target) {
    playStep = (playStep + 1) % loopLen;
    onStepEnter(playStep);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィジェット / レイアウト
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _init() {
  if (_ready) return;
  _ready = true;

  toggPlay = new ToggleButton(0, 0, "PLAY", (v) => (v ? startPlay() : stopPlay()), false);
  numBpm = new NumberBox(0, 0, BPM_MIN, BPM_MAX, bpm, 1, (v) => {
    bpm = v;
  });
  group = new WidgetGroup([toggPlay, numBpm]);
  group.remeasureAll();
}

/** ツールバー内のウィジェット位置 (コンテンツ相対) を確定する */
function layoutToolbar() {
  let x = FOCUS_MARGIN;
  const y = (TOOLBAR_H - toggPlay.h) >> 1;
  toggPlay.x = x;
  toggPlay.y = y;
  x += toggPlay.w + GAP * 3;

  TB.bpmLabelX = x;
  x += textWidth("BPM") + GAP;
  numBpm.x = x;
  numBpm.y = (TOOLBAR_H - numBpm.h) >> 1;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画 / 入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDraw(cr) {
  _init();
  layoutToolbar();
  updatePlayback();

  // グリッド (ツールバーの下)
  const gcr = { x: cr.x, y: cr.y + TOOLBAR_H, w: cr.w, h: cr.h - TOOLBAR_H };
  grid.draw(gcr, { playheadStep, playing: playingNotes });

  // ツールバー (背景 + 区切り + ラベル + ウィジェット)
  fillRect(cr.x, cr.y, cr.w, TOOLBAR_H, 0);
  drawText(cr.x + TB.bpmLabelX, cr.y + ((TOOLBAR_H - 5) >> 1), "BPM", 1);
  group.draw(cr);
}

function onDrawFooter(fr) {
  _init();
  const left = "NOTES " + String(grid.notes.length).padStart(3);
  drawText(fr.x, fr.y, left, 1);

  const bars = Math.ceil(computeLoopLen() / PIANO_ROLL_STEPS_PER_BAR);
  let right = "LOOP " + bars + " BAR   ";
  right += playing ? "PLAY " + String(playStep + 1).padStart(3) : "STOP";
  drawText(fr.x + fr.w - textWidth(right), fr.y, right, 1);
}

/** グリッドへ渡す用に localY をツールバー分ずらしたイベントを作る */
function shiftEv(ev) {
  return { ...ev, localY: ev.localY - TOOLBAR_H };
}

function onInput(ev) {
  _init();
  group.update(ev); // ツールバーのウィジェット (領域外クリックは無視される)

  const inGrid = ev.localY >= TOOLBAR_H;
  if (ev.type === "wheel") {
    if (inGrid) grid.handleInput(shiftEv(ev));
    return;
  }
  // グリッド編集: グリッド領域内、またはドラッグ継続中
  if (inGrid || grid._active) grid.handleInput(shiftEv(ev));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    _init();
    winId = wmOpen(-1, -1, ROLL_W, ROLL_H, APP_NAME, onDraw, onInput, null, {
      footer: true,
      onDrawFooter,
      onBeforeClose: () => {
        stopPlay();
        winId = -1;
        return true;
      },
      about:
        "A step-grid MIDI phrase editor. Click a cell to place a note (it auditions), " +
        "click a note to remove it, drag horizontally to set its length. Click the piano " +
        "keys to audition a pitch. Press PLAY to loop the pattern with a moving playhead. " +
        "Scroll to move across pitch and time (Shift+wheel = horizontal). Fixed velocity, " +
        "built-in voice — timbre lives in SYNTH.",
    });
    // グリッドの縦(ピッチ)・横(ステップ)スクロールを WM 標準バーへ接続 (行/桁単位 = step 1)
    wmAttachScroll(winId, {
      v: grid.vScroll,
      h: grid.hScroll,
      vStep: 1,
      hStep: 1,
    });
    return winId;
  },
  { category: "CREATIVE", dev: true },
);
