/**
 * @module app/studio/piano_roll
 * piano_roll.js — PIANO_ROLL タブ (STUDIO ウィンドウ内)
 *
 * ピアノロールエディタの全ロジック: グリッド描画、ノート編集、選択、
 * ドラッグ、クリップボード、Undo/Redo、再生ヘッド連動。
 */

import {
  PIANO_ROLL_STEPS_PER_BEAT,
  PIANO_ROLL_BEATS_PER_BAR,
  PIANO_ROLL_STEPS_PER_BAR,
  PIANO_ROLL_TOTAL_COLUMNS,
} from "../../config.js";
import * as Audio from "../../core/audio.js";
import * as GPU from "../../core/gpu.js";
import { keyHeld, keyDown, ctrlDown, ctrlShiftDown } from "../../core/input.js";
import { wmRequestCursor, wmSetTooltip, wmIsFocused } from "../../wm/index.js";
import { drawText, textWidth, GLYPH_W, GLYPH_H } from "../../core/font.js";
import {
  RadioButton,
  WidgetGroup,
  VBox,
  FOCUS_MARGIN,
  buttonAutoWidth,
} from "../../ui/index.js";
import { APP_NAME } from "./studio.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  グリッド定数・ズーム
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let prRowHeight = 14;
let prColWidth = 20;
const PR_ROW_HEIGHT_MIN = 10;
const PR_ROW_HEIGHT_MAX = 28;
const PR_COL_WIDTH_MIN = 10;
const PR_COL_WIDTH_MAX = 40;

const PR_INIT_WIDTH = 320;
const PR_INIT_HEIGHT = 280;
const PR_KEYBOARD_WIDTH = 32;
const PR_RULER_HEIGHT = 12;

/** セル・ノート描画用の内側パディング (px) */
const CELL_PADDING = 2;

/** セル・ノート描画のサイズ縮小マージン (px): 枠線分を差し引く */
const CELL_MARGIN = 3;

/** ラベル表示に必要な最小余白 (px) */
const LABEL_PADDING = 2;

/** ノート内側の枠パディング (px) */
const NOTE_INNER_PAD = 2;

// PIANO_ROLL_STEPS_PER_BAR は config.js からインポート済み

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  トラックセレクタ (ウィジェット)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** トラックセレクタ列の幅 (px) — _initTrackSelector() 後に確定 */
let prTrackSelW = 0;

/** @type {import("../../ui/index.js").RadioButton[]|null} */
let _trackRadios = null;
let _trackSelectorGroup = null;
let _trackVBox = null;

function _layoutTrackSelector() {
  // WidgetGroup の auto-layout が同じ原点を使い続けるので、ここでは radio 幅のみ更新
  prTrackSelW = _trackRadios[0].w + 2 * FOCUS_MARGIN;
}

function _initTrackSelector() {
  if (_trackRadios) return;
  _trackRadios = tracks.map((_, i) =>
    new RadioButton(0, 0, String(i + 1), "PR_TRACK", () => {
      prActiveTrack = i;
      prClearSelection();
    }, i === 0),
  );
  _trackVBox = VBox(_trackRadios);
  _trackSelectorGroup = new WidgetGroup(_trackVBox, {
    x: FOCUS_MARGIN,
    y: PR_RULER_HEIGHT + FOCUS_MARGIN,
  });
  _layoutTrackSelector();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  スクロール
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let prScrollRow = 0;
let prScrollCol = 0;
const PR_TOTAL_ROWS = 128;
const PR_SCROLL_SPEED = 3;
let prLastRows = Math.ceil(PR_INIT_HEIGHT / prRowHeight);
let prLastCols = Math.ceil(PR_INIT_WIDTH / prColWidth);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ノートデータ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PR_BASE_NOTE = 0;

/** @type {{ notes: { pitch:number, start:number, duration:number }[], channel: import("../../core/audio.js").SynthChannel }[]} */
export const tracks = [
  { notes: [], channel: Audio.getDefaultChannel() },
  { notes: [], channel: Audio.createChannel() },
  { notes: [], channel: Audio.createChannel() },
  { notes: [], channel: Audio.createChannel() },
];

let prActiveTrack = 0;

function getNotes() {
  return tracks[prActiveTrack].notes;
}

function insertNoteSorted(note) {
  const notes = getNotes();
  let i = notes.length;
  while (i > 0 && notes[i - 1].start > note.start) i--;
  notes.splice(i, 0, note);
}

function enforceMonophonic(newNote) {
  const notes = getNotes();
  const newEnd = newNote.start + newNote.duration;
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    if (n === newNote) continue;
    const nEnd = n.start + n.duration;
    if (n.start < newEnd && nEnd > newNote.start) {
      if (n.start >= newNote.start) {
        notes.splice(i, 1);
      } else {
        n.duration = newNote.start - n.start;
        if (n.duration <= 0) {
          notes.splice(i, 1);
        }
      }
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Undo / Redo
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const UNDO_MAX = 50;
const undoStack = [];
const redoStack = [];

function pushUndo() {
  const notes = getNotes();
  undoStack.push(
    notes.map((n) => ({
      pitch: n.pitch,
      start: n.start,
      duration: n.duration,
    })),
  );
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
}

function undo() {
  if (undoStack.length === 0) return;
  const notes = getNotes();
  redoStack.push(
    notes.map((n) => ({
      pitch: n.pitch,
      start: n.start,
      duration: n.duration,
    })),
  );
  tracks[prActiveTrack].notes = undoStack.pop();
  prClearSelection();
}

function redo() {
  if (redoStack.length === 0) return;
  const notes = getNotes();
  undoStack.push(
    notes.map((n) => ({
      pitch: n.pitch,
      start: n.start,
      duration: n.duration,
    })),
  );
  tracks[prActiveTrack].notes = redoStack.pop();
  prClearSelection();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  プレイヘッド
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let prPlayheadPos = -1;

/**
 * プレイヘッド位置を設定する (transport.js から呼ばれる)
 * @param {number} pos  ステップ位置 (-1 で非表示)
 */
export function setPlayheadPos(pos) {
  prPlayheadPos = pos;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  選択・クリップボード
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const prSelection = new Set();
let prClipboard = [];

function prClearSelection() {
  prSelection.clear();
}

function prSelectAll() {
  for (const n of getNotes()) prSelection.add(n);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ドラッグ状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PR_DEFAULT_DURATION = 1;

let prDragIndex = -1;
let prDragMode = "none";
let prDragOrigPitch = 0;
let prDragOrigStart = 0;
let prDragOrigDuration = 0;
let prDragAnchorCol = 0;
let prDragAnchorRow = 0;

let prRubberBand = null;
let prRubberBandCtrl = false;

let prDragGroup = [];
let prDragCloned = false;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ヒットテスト
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function hitTestNote(localX, localY) {
  const gx = localX - prTrackSelW - PR_KEYBOARD_WIDTH - 2;
  const gy = localY - PR_RULER_HEIGHT;
  const _notesHit = getNotes();
  for (let i = _notesHit.length - 1; i >= 0; i--) {
    const note = _notesHit[i];
    const absRow = PR_BASE_NOTE + PR_TOTAL_ROWS - 1 - note.pitch;
    const viewRow = absRow - prScrollRow;
    const viewCol = note.start - prScrollCol;
    const ny = viewRow * prRowHeight;
    const nx = viewCol * prColWidth;
    const nw = note.duration * prColWidth;
    const nh = prRowHeight;
    if (gx >= nx && gx < nx + nw && gy >= ny && gy < ny + nh) {
      return i;
    }
  }
  return -1;
}

function hitTestNoteEdge(localX, localY) {
  const gx = localX - prTrackSelW - PR_KEYBOARD_WIDTH - 2;
  const gy = localY - PR_RULER_HEIGHT;
  const _notes2 = getNotes();
  for (let i = _notes2.length - 1; i >= 0; i--) {
    const note = _notes2[i];
    const absRow = PR_BASE_NOTE + PR_TOTAL_ROWS - 1 - note.pitch;
    const viewRow = absRow - prScrollRow;
    const viewCol = note.start - prScrollCol;
    const ny = viewRow * prRowHeight;
    const nx = viewCol * prColWidth;
    const nw = note.duration * prColWidth;
    const nh = prRowHeight;
    if (gx >= nx && gx < nx + nw && gy >= ny && gy < ny + nh) {
      const drawL = nx + 2;
      const drawR = nx + nw - 2;
      if (gx <= drawL + 1) return { idx: i, edge: "left" };
      if (gx >= drawR - 1) return { idx: i, edge: "right" };
      return { idx: i, edge: "body" };
    }
  }
  return null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  鍵盤クリック発音
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let isKeyboardSounding = false;
let keyboardMidiNote = -1;

/** 鍵盤ドラッグ選択: 開始ピッチ (-1 = 非アクティブ) */
let prKeyboardSelStartPitch = -1;
/** 鍵盤ドラッグ選択: 現在ピッチ */
let prKeyboardSelCurrentPitch = -1;

/** ドラッグ中に最後にプレビューした pitch (-1 = なし) */
let prPreviewLastPitch = -1;

/** ラバーバンド中に前フレームで範囲内だったノートの Set */
const prRubberBandPrevNotes = new Set();

/**
 * ノートの音高を短くプレビュー再生する (配置・ドラッグ移動時)。
 * アクティブトラックのチャンネル音色で発音する。
 * @param {number} pitch  MIDI ノート番号
 */
function previewPitch(pitch) {
  Audio.initAudio();
  const ctx = Audio.getAudioContext();
  if (!ctx) return;
  const ch = tracks[prActiveTrack].channel;
  if (!ch) return;
  const freq = Audio.midiToFreq(pitch);
  const now = ctx.currentTime;
  ch.scheduleVoice(freq, now, now + 0.1); // 100ms プレビュー
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  キーボードショートカット
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function updatePianoRollKeys() {
  if (!wmIsFocused(APP_NAME)) return;

  // ── Ctrl+A: 全選択 ──
  if (ctrlDown("KeyA")) {
    prSelectAll();
  }

  // ── Ctrl+Z: Undo / Ctrl+Shift+Z or Ctrl+Y: Redo ──
  if (ctrlDown("KeyZ")) {
    if (ctrlShiftDown("KeyZ")) {
      redo();
    } else {
      undo();
    }
  }
  if (ctrlDown("KeyY")) {
    redo();
  }

  // ── Ctrl+D: 選択ノートの複製 (Duplicate) — Ableton Live 準拠 ──
  if (ctrlDown("KeyD")) {
    if (prSelection.size > 0) {
      pushUndo();
      const selected = [...prSelection];
      const minStart = Math.min(...selected.map((n) => n.start));
      const maxEnd = Math.max(...selected.map((n) => n.start + n.duration));
      const spanLen = maxEnd - minStart;
      const cloned = [];
      for (const n of selected) {
        const newStart = n.start + spanLen;
        if (newStart + n.duration > PIANO_ROLL_TOTAL_COLUMNS) continue;
        const dup = { pitch: n.pitch, start: newStart, duration: n.duration };
        enforceMonophonic(dup);
        insertNoteSorted(dup);
        cloned.push(dup);
      }
      prClearSelection();
      for (const c of cloned) prSelection.add(c);
    }
  }

  // ── Ctrl+C: コピー ──
  if (ctrlDown("KeyC")) {
    if (prSelection.size > 0) {
      const selected = [...prSelection];
      const minStart = Math.min(...selected.map((n) => n.start));
      prClipboard = selected.map((n) => ({
        pitch: n.pitch,
        deltaStart: n.start - minStart,
        duration: n.duration,
      }));
    }
  }

  // ── Ctrl+X: カット (コピー + 削除) ──
  if (ctrlDown("KeyX")) {
    if (prSelection.size > 0) {
      const selected = [...prSelection];
      const minStart = Math.min(...selected.map((n) => n.start));
      prClipboard = selected.map((n) => ({
        pitch: n.pitch,
        deltaStart: n.start - minStart,
        duration: n.duration,
      }));
      pushUndo();
      const notes = getNotes();
      for (let i = notes.length - 1; i >= 0; i--) {
        if (prSelection.has(notes[i])) notes.splice(i, 1);
      }
      prClearSelection();
    }
  }

  // ── Ctrl+V: ペースト ──
  if (ctrlDown("KeyV")) {
    if (prClipboard.length > 0) {
      pushUndo();
      let pasteStart = 0;
      if (prPlayheadPos >= 0) {
        pasteStart = Math.floor(prPlayheadPos);
      } else if (prSelection.size > 0) {
        pasteStart = Math.max(
          ...[...prSelection].map((n) => n.start + n.duration),
        );
      }
      const pasted = [];
      for (const c of prClipboard) {
        const newStart = pasteStart + c.deltaStart;
        if (newStart < 0 || newStart + c.duration > PIANO_ROLL_TOTAL_COLUMNS)
          continue;
        const dup = { pitch: c.pitch, start: newStart, duration: c.duration };
        enforceMonophonic(dup);
        insertNoteSorted(dup);
        pasted.push(dup);
      }
      prClearSelection();
      for (const p of pasted) prSelection.add(p);
    }
  }

  // ── 矢印キー: 選択ノート移動 — Ableton Live 準拠 ──
  if (prSelection.size > 0) {
    let dPitch = 0;
    let dStart = 0;
    if (keyDown("ArrowUp"))
      dPitch = keyHeld("ShiftLeft") || keyHeld("ShiftRight") ? 12 : 1;
    if (keyDown("ArrowDown"))
      dPitch = keyHeld("ShiftLeft") || keyHeld("ShiftRight") ? -12 : -1;
    if (keyDown("ArrowRight"))
      dStart =
        keyHeld("ShiftLeft") || keyHeld("ShiftRight")
          ? PIANO_ROLL_STEPS_PER_BEAT * PIANO_ROLL_BEATS_PER_BAR
          : 1;
    if (keyDown("ArrowLeft"))
      dStart =
        keyHeld("ShiftLeft") || keyHeld("ShiftRight")
          ? -(PIANO_ROLL_STEPS_PER_BEAT * PIANO_ROLL_BEATS_PER_BAR)
          : -1;

    if (dPitch !== 0 || dStart !== 0) {
      const selected = [...prSelection];
      const canMove = selected.every((n) => {
        const np = n.pitch + dPitch;
        const ns = n.start + dStart;
        return (
          np >= 0 &&
          np <= 127 &&
          ns >= 0 &&
          ns + n.duration <= PIANO_ROLL_TOTAL_COLUMNS
        );
      });
      if (canMove) {
        pushUndo();
        for (const n of selected) {
          n.pitch += dPitch;
          n.start += dStart;
        }
        for (const n of selected) enforceMonophonic(n);
        getNotes().sort((a, b) => a.start - b.start);
      }
    }
  }

  // ── Esc: 全選択解除 ──
  if (keyDown("Escape")) {
    prClearSelection();
  }

  // ── Delete/Backspace: 選択ノート一括削除 ──
  if (keyDown("Delete") || keyDown("Backspace")) {
    if (prSelection.size > 0) {
      pushUndo();
      const notes = getNotes();
      for (let i = notes.length - 1; i >= 0; i--) {
        if (prSelection.has(notes[i])) notes.splice(i, 1);
      }
      prClearSelection();
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function drawPianoRoll(contentRect) {
  _initTrackSelector();
  updatePianoRollKeys();
  const kbW = PR_KEYBOARD_WIDTH;
  const rulerH = PR_RULER_HEIGHT;
  const trkSelW = prTrackSelW;
  const gridX0 = contentRect.x + trkSelW + kbW + 2;
  const gridY0 = contentRect.y + rulerH;
  const gridAvailW = Math.max(0, contentRect.w - trkSelW - kbW - 2);
  const gridAvailH = Math.max(0, contentRect.h - rulerH);
  const rows = Math.floor(gridAvailH / prRowHeight);
  const cols = Math.floor(gridAvailW / prColWidth);
  prLastRows = rows;
  prLastCols = cols;
  const gridW = cols * prColWidth;
  const gridH = rows * prRowHeight;

  const WHITE_KEYS = new Set([0, 2, 4, 5, 7, 9, 11]);

  // ── 鍵盤 + 白鍵チェッカー ──
  for (let r = 0; r < rows; r++) {
    const pitch = PR_BASE_NOTE + PR_TOTAL_ROWS - 1 - (r + prScrollRow);
    if (pitch < 0 || pitch > 127) continue;
    const ry = gridY0 + r * prRowHeight;
    const pc = ((pitch % 12) + 12) % 12;
    const isWhite = WHITE_KEYS.has(pc);

    if (isWhite) {
      GPU.fillRect(
        contentRect.x + trkSelW + CELL_PADDING,
        ry + CELL_PADDING,
        kbW - CELL_MARGIN,
        prRowHeight - CELL_MARGIN,
        1,
      );
      for (let c = 0; c < cols; c++) {
        GPU.drawCheckerboard(
          gridX0 + c * prColWidth + CELL_PADDING,
          ry + CELL_PADDING,
          prColWidth - CELL_MARGIN,
          prRowHeight - CELL_MARGIN,
          1,
        );
      }
      if (pc === 0) {
        const innerX = contentRect.x + trkSelW + CELL_PADDING;
        const innerY = ry + CELL_PADDING;
        const innerW = kbW - CELL_MARGIN;
        const innerH = prRowHeight - CELL_MARGIN;
        const octave = Math.floor(pitch / 12) - 1;
        const label = "C" + octave;
        const textW = textWidth(label);
        if (
          innerW >= textW + LABEL_PADDING * 2 &&
          innerH >= GLYPH_H + LABEL_PADDING * 2
        ) {
          const textX = innerX + LABEL_PADDING;
          const textY = innerY + innerH - GLYPH_H - LABEL_PADDING;
          drawText(textX, textY, label, 0);
        }
      }
    }
  }

  // ── 水平線 (行境界) ──
  for (let r = 0; r <= rows; r++) {
    const y = gridY0 + r * prRowHeight;
    GPU.hline(contentRect.x + trkSelW, contentRect.x + trkSelW + kbW, y, 1);
    GPU.hline(gridX0, gridX0 + gridW, y, 1);
  }

  // ── 鍵盤 左辺 + 右辺 ──
  GPU.vline(contentRect.x + trkSelW, gridY0, gridY0 + gridH, 1);
  GPU.vline(contentRect.x + trkSelW + kbW, gridY0, gridY0 + gridH, 1);

  // ── トラックセレクタ ──
  _trackSelectorGroup.draw(contentRect);

  // ── 垂直線 (列境界) ──
  for (let c = 0; c <= cols; c++) {
    const absCol = c + prScrollCol;
    const x = gridX0 + c * prColWidth;
    if (absCol % PIANO_ROLL_STEPS_PER_BAR === 0) {
      GPU.vline(x, gridY0, gridY0 + gridH, 1);
      GPU.vline(x, gridY0 - rulerH, gridY0 - 2, 1);
      const barNum = (absCol / PIANO_ROLL_STEPS_PER_BAR + 1).toString();
      const labelY = contentRect.y + ((rulerH - GLYPH_H) >> 1);
      drawText(x + 3, labelY, barNum, 1);
    } else if (absCol % PIANO_ROLL_STEPS_PER_BEAT === 0) {
      GPU.vline(x, gridY0, gridY0 + gridH, 1);
    } else {
      for (let r = 0; r < rows; r++) {
        const rowTop = gridY0 + r * prRowHeight;
        for (let dy = 2; dy < prRowHeight; dy += 2) {
          GPU.pset(x, rowTop + dy, 1);
        }
      }
    }
  }

  // ── ノート描画 ──
  for (const note of getNotes()) {
    const absRow = PR_BASE_NOTE + PR_TOTAL_ROWS - 1 - note.pitch;
    const viewRow = absRow - prScrollRow;
    const viewCol = note.start - prScrollCol;
    if (viewRow < 0 || viewRow >= rows) continue;
    if (viewCol + note.duration <= 0 || viewCol >= cols) continue;

    const clippedStart = Math.max(viewCol, 0);
    const clippedEnd = Math.min(viewCol + note.duration, cols);
    const noteCols = clippedEnd - clippedStart;

    const nx = gridX0 + clippedStart * prColWidth + CELL_PADDING;
    const ny = gridY0 + viewRow * prRowHeight + CELL_PADDING;
    const nw = noteCols * prColWidth - CELL_MARGIN;
    const nh = prRowHeight - CELL_MARGIN;
    const sel = prSelection.has(note);

    if (sel) {
      GPU.fillRoundRect(nx, ny, nw, nh, 3, 1);
      GPU.drawRoundRect(nx, ny, nw, nh, 3, 0);
      GPU.fillRect(
        nx + NOTE_INNER_PAD,
        ny + NOTE_INNER_PAD,
        nw - NOTE_INNER_PAD * 2,
        nh - NOTE_INNER_PAD * 2,
        0,
      );
    } else {
      GPU.fillRoundRect(nx, ny, nw, nh, 3, 0);
      GPU.drawRoundRect(nx, ny, nw, nh, 3, 1);
      GPU.fillRect(
        nx + NOTE_INNER_PAD,
        ny + NOTE_INNER_PAD,
        nw - NOTE_INNER_PAD * 2,
        nh - NOTE_INNER_PAD * 2,
        1,
      );
    }

    // 音名ラベル
    const innerX = nx + NOTE_INNER_PAD;
    const innerY = ny + NOTE_INNER_PAD;
    const innerW = nw - NOTE_INNER_PAD * 2;
    const innerH = nh - NOTE_INNER_PAD * 2;
    const labelColor = sel ? 1 : 0;
    const name = Audio.midiToNoteName(note.pitch);
    const textW = textWidth(name);
    if (
      innerW >= textW + LABEL_PADDING * 2 &&
      innerH >= GLYPH_H + LABEL_PADDING * 2
    ) {
      const textX = innerX + LABEL_PADDING;
      const textY = innerY + innerH - GLYPH_H - LABEL_PADDING;
      const cx0 = Math.max(innerX, contentRect.x);
      const cy0 = Math.max(innerY, contentRect.y);
      const cx1 = Math.min(innerX + innerW, contentRect.x + contentRect.w);
      const cy1 = Math.min(innerY + innerH, contentRect.y + contentRect.h);
      if (cx1 > cx0 && cy1 > cy0) {
        GPU.pushClip(cx0, cy0, cx1 - cx0, cy1 - cy0);
        drawText(textX, textY, name, labelColor);
        GPU.popClip();
      }
    }
  }

  // ── ラバーバンド描画（色反転） ──
  if (prRubberBand) {
    const rb = prRubberBand;
    const c0 = Math.min(rb.col0, rb.col1) - prScrollCol;
    const r0 = Math.min(rb.row0, rb.row1) - prScrollRow;
    const c1 = Math.max(rb.col0, rb.col1) - prScrollCol;
    const r1 = Math.max(rb.row0, rb.row1) - prScrollRow;
    const rx = gridX0 + c0 * prColWidth + 1;
    const ry = gridY0 + r0 * prRowHeight + 1;
    const rw = (c1 - c0 + 1) * prColWidth - 1;
    const rh = (r1 - r0 + 1) * prRowHeight - 1;
    GPU.invertRect(rx, ry, rw, rh);
    // 外枠罫線に明色矩形を重ねる
    const bx = gridX0 + c0 * prColWidth;
    const by = gridY0 + r0 * prRowHeight;
    const bw = (c1 - c0 + 1) * prColWidth + 1;
    const bh = (r1 - r0 + 1) * prRowHeight + 1;
    GPU.hline(bx, bx + bw - 1, by, 1);
    GPU.hline(bx, bx + bw - 1, by + bh - 1, 1);
    GPU.vline(bx, by, by + bh - 1, 1);
    GPU.vline(bx + bw - 1, by, by + bh - 1, 1);
  }

  // ── 鍵盤選択ラバーバンド描画（色反転） ──
  if (prKeyboardSelStartPitch >= 0 && prKeyboardSelCurrentPitch >= 0) {
    const loP = Math.min(prKeyboardSelStartPitch, prKeyboardSelCurrentPitch);
    const hiP = Math.max(prKeyboardSelStartPitch, prKeyboardSelCurrentPitch);
    const rowHi = PR_BASE_NOTE + PR_TOTAL_ROWS - 1 - loP;
    const rowLo = PR_BASE_NOTE + PR_TOTAL_ROWS - 1 - hiP;
    const r0 = rowLo - prScrollRow;
    const r1 = rowHi - prScrollRow;
    const rx = gridX0 + 1;
    const ry = gridY0 + r0 * prRowHeight + 1;
    const rw = gridW - 1;
    const rh = (r1 - r0 + 1) * prRowHeight - 1;
    GPU.invertRect(rx, ry, rw, rh);
    // 外枠罫線に明色矩形を重ねる
    const bx = gridX0;
    const by = gridY0 + r0 * prRowHeight;
    const bw = gridW + 1;
    const bh = (r1 - r0 + 1) * prRowHeight + 1;
    GPU.hline(bx, bx + bw - 1, by, 1);
    GPU.hline(bx, bx + bw - 1, by + bh - 1, 1);
    GPU.vline(bx, by, by + bh - 1, 1);
    GPU.vline(bx + bw - 1, by, by + bh - 1, 1);
  }

  // ── プレイヘッド描画 ──
  if (prPlayheadPos >= 0) {
    const viewCol = prPlayheadPos - prScrollCol;
    if (viewCol >= 0 && viewCol < cols) {
      const px = gridX0 + Math.floor(viewCol * prColWidth);
      GPU.vline(px - 1, gridY0, gridY0 + gridH, 0);
      GPU.vline(px, gridY0, gridY0 + gridH, 1);
      GPU.vline(px + 1, gridY0, gridY0 + gridH, 0);
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function onPianoRollInput(ev) {
  _initTrackSelector();
  const kbGap = prTrackSelW + PR_KEYBOARD_WIDTH + 2;

  const toCol = (lx) => Math.floor((lx - kbGap) / prColWidth) + prScrollCol;
  const toRow = (ly) =>
    Math.floor((ly - PR_RULER_HEIGHT) / prRowHeight) + prScrollRow;

  // ── トラックセレクタ: 標準ウィジェットに委譲 ──
  if (ev.localX < prTrackSelW) {
    _trackSelectorGroup.update(ev);
    return;
  }

  // ── 鍵盤クリック / ドラッグ: 発音 + ピッチ範囲ノート選択 (Ableton Live 準拠) ──
  const inKb =
    ev.localX >= prTrackSelW &&
    ev.localX < prTrackSelW + PR_KEYBOARD_WIDTH &&
    ev.localY >= PR_RULER_HEIGHT;
  if (ev.type === "down" && inKb) {
    const row =
      Math.floor((ev.localY - PR_RULER_HEIGHT) / prRowHeight) + prScrollRow;
    const pitch = PR_BASE_NOTE + PR_TOTAL_ROWS - 1 - row;
    if (pitch >= 0 && pitch <= 127) {
      Audio.initAudio();
      const freq = Audio.midiToFreq(pitch);
      Audio.noteOn(freq, undefined, 0.8);
      keyboardMidiNote = pitch;
      isKeyboardSounding = true;

      // ── ピッチ範囲選択: 開始 ──
      prKeyboardSelStartPitch = pitch;
      prKeyboardSelCurrentPitch = pitch;
      if (!ev.ctrl) prClearSelection();
      // 該当ピッチのノートを全選択
      for (const n of getNotes()) {
        if (n.pitch === pitch) prSelection.add(n);
      }
    }
    return;
  }
  if (ev.type === "held" && inKb && prKeyboardSelStartPitch >= 0) {
    const row =
      Math.floor((ev.localY - PR_RULER_HEIGHT) / prRowHeight) + prScrollRow;
    const pitch = PR_BASE_NOTE + PR_TOTAL_ROWS - 1 - row;
    if (pitch >= 0 && pitch <= 127 && pitch !== prKeyboardSelCurrentPitch) {
      prKeyboardSelCurrentPitch = pitch;
      // 発音プレビュー更新
      Audio.initAudio();
      Audio.noteOff();
      const freq = Audio.midiToFreq(pitch);
      Audio.noteOn(freq, undefined, 0.8);
      keyboardMidiNote = pitch;

      // ── ピッチ範囲全体を再選択 ──
      const lo = Math.min(prKeyboardSelStartPitch, pitch);
      const hi = Math.max(prKeyboardSelStartPitch, pitch);
      if (!ev.ctrl) prClearSelection();
      for (const n of getNotes()) {
        if (n.pitch >= lo && n.pitch <= hi) prSelection.add(n);
      }
    }
    return;
  }
  if (ev.type === "up" && isKeyboardSounding) {
    Audio.noteOff();
    keyboardMidiNote = -1;
    isKeyboardSounding = false;
    prKeyboardSelStartPitch = -1;
    prKeyboardSelCurrentPitch = -1;
  }

  // ── ホバー: カーソル形状更新 + ツールチップ ──
  if (ev.type === "hover") {
    if (
      ev.localX >= prTrackSelW &&
      ev.localX < prTrackSelW + PR_KEYBOARD_WIDTH &&
      ev.localY >= PR_RULER_HEIGHT
    ) {
      const row =
        Math.floor((ev.localY - PR_RULER_HEIGHT) / prRowHeight) + prScrollRow;
      const pitch = PR_BASE_NOTE + PR_TOTAL_ROWS - 1 - row;
      if (pitch >= 0 && pitch <= 127) {
        const name = Audio.midiToNoteName(pitch);
        const freq = Audio.midiToFreq(pitch);
        wmSetTooltip(`${name}\n${freq.toFixed(2)} Hz`);
      }
    } else if (ev.localX >= kbGap && ev.localY >= PR_RULER_HEIGHT) {
      const hit = hitTestNoteEdge(ev.localX, ev.localY);
      if (hit && (hit.edge === "left" || hit.edge === "right")) {
        wmRequestCursor("resize-ew");
      } else if (hit && hit.edge === "body") {
        wmRequestCursor("move");
      }
    }
    return;
  }

  // ── ドラッグ中 (held) ──
  if (ev.type === "held") {
    // --- ラバーバンド更新: リアルタイム選択 + In/Out プレビュー ---
    if (prRubberBand) {
      prRubberBand.col1 = toCol(ev.localX);
      prRubberBand.row1 = toRow(ev.localY);

      // ── ラバーバンド内のノートをリアルタイム選択 ──
      const rb = prRubberBand;
      const rbMinCol = Math.min(rb.col0, rb.col1);
      const rbMaxCol = Math.max(rb.col0, rb.col1);
      const rbMinRow = Math.min(rb.row0, rb.row1);
      const rbMaxRow = Math.max(rb.row0, rb.row1);
      if (!prRubberBandCtrl) prClearSelection();
      const curNotes = new Set();
      for (const note of getNotes()) {
        const absRow = PR_BASE_NOTE + PR_TOTAL_ROWS - 1 - note.pitch;
        const noteEnd = note.start + note.duration - 1;
        if (
          note.start <= rbMaxCol &&
          noteEnd >= rbMinCol &&
          absRow >= rbMinRow &&
          absRow <= rbMaxRow
        ) {
          prSelection.add(note);
          curNotes.add(note);
        }
      }
      // ── Ableton Live 準拠: 新たに領域に入ったノートだけプレビュー (拜けたノートは鳴らさない) ──
      for (const note of curNotes) {
        if (!prRubberBandPrevNotes.has(note)) {
          previewPitch(note.pitch);
        }
      }
      prRubberBandPrevNotes.clear();
      for (const note of curNotes) prRubberBandPrevNotes.add(note);
      return;
    }

    // --- 複数ノートドラッグ ---
    if (prDragMode !== "none" && prDragGroup.length > 0) {
      const curCol = toCol(ev.localX);
      const curRow = toRow(ev.localY);
      const dCol = curCol - prDragAnchorCol;
      const dRow = curRow - prDragAnchorRow;

      // ── Ctrl+ドラッグ: 複製移動 (move のみ、最初の移動時に1回だけ複製) ──
      if (
        ev.ctrl &&
        prDragMode === "move" &&
        !prDragCloned &&
        (dCol !== 0 || dRow !== 0)
      ) {
        prDragCloned = true;
        for (const g of prDragGroup) {
          const copy = {
            pitch: g.origPitch,
            start: g.origStart,
            duration: g.origDuration,
          };
          insertNoteSorted(copy);
        }
      }

      if (prDragMode === "resize-right") {
        wmRequestCursor("resize-ew");
        for (const g of prDragGroup) {
          const newDur = Math.max(1, g.origDuration + dCol);
          g.note.duration = Math.min(
            newDur,
            PIANO_ROLL_TOTAL_COLUMNS - g.note.start,
          );
        }
      } else if (prDragMode === "resize-left") {
        wmRequestCursor("resize-ew");
        for (const g of prDragGroup) {
          const clampedDCol = Math.max(
            -g.origStart,
            Math.min(g.origDuration - 1, dCol),
          );
          g.note.start = g.origStart + clampedDCol;
          g.note.duration = g.origDuration - clampedDCol;
        }
      } else {
        // move
        for (const g of prDragGroup) {
          g.note.start = Math.max(
            0,
            Math.min(
              PIANO_ROLL_TOTAL_COLUMNS - g.note.duration,
              g.origStart + dCol,
            ),
          );
          g.note.pitch = Math.max(0, Math.min(127, g.origPitch - dRow));
        }
        // ── ドラッグ移動中にピッチが変わったらプレビュー発音 ──
        if (prDragGroup.length > 0) {
          const leadPitch = prDragGroup[0].note.pitch;
          if (leadPitch !== prPreviewLastPitch) {
            prPreviewLastPitch = leadPitch;
            previewPitch(leadPitch);
          }
        }
      }
      return;
    }

    // --- 旧式単一ノートドラッグ (後方互換) ---
    if (prDragIndex >= 0) {
      const note = getNotes()[prDragIndex];
      if (!note) {
        prDragIndex = -1;
        return;
      }
      const curCol = toCol(ev.localX);
      const dCol = curCol - prDragAnchorCol;
      if (prDragMode === "resize-right") {
        wmRequestCursor("resize-ew");
        note.duration = Math.min(
          Math.max(1, prDragOrigDuration + dCol),
          PIANO_ROLL_TOTAL_COLUMNS - note.start,
        );
      } else if (prDragMode === "resize-left") {
        wmRequestCursor("resize-ew");
        const clampedDCol = Math.max(
          -prDragOrigStart,
          Math.min(prDragOrigDuration - 1, dCol),
        );
        note.start = prDragOrigStart + clampedDCol;
        note.duration = prDragOrigDuration - clampedDCol;
      } else {
        const curRow = toRow(ev.localY);
        const dRow = curRow - prDragAnchorRow;
        note.start = Math.max(
          0,
          Math.min(
            PIANO_ROLL_TOTAL_COLUMNS - note.duration,
            prDragOrigStart + dCol,
          ),
        );
        note.pitch = Math.max(0, Math.min(127, prDragOrigPitch - dRow));
      }
      return;
    }
    return;
  }

  // ── ドラッグ終了 / ラバーバンド確定 (up) ──
  if (ev.type === "up") {
    // ラバーバンド確定
    if (prRubberBand) {
      const rb = prRubberBand;
      const minCol = Math.min(rb.col0, rb.col1);
      const maxCol = Math.max(rb.col0, rb.col1);
      const minRow = Math.min(rb.row0, rb.row1);
      const maxRow = Math.max(rb.row0, rb.row1);
      if (!prRubberBandCtrl) prClearSelection();
      for (const note of getNotes()) {
        const absRow = PR_BASE_NOTE + PR_TOTAL_ROWS - 1 - note.pitch;
        const noteEnd = note.start + note.duration - 1;
        if (
          note.start <= maxCol &&
          noteEnd >= minCol &&
          absRow >= minRow &&
          absRow <= maxRow
        ) {
          prSelection.add(note);
        }
      }
      prRubberBand = null;
      prRubberBandPrevNotes.clear();
      return;
    }

    // ドラッグ完了時にモノフォニック制約を適用
    if (prDragGroup.length > 0) {
      for (const g of prDragGroup) enforceMonophonic(g.note);
      getNotes().sort((a, b) => a.start - b.start);
      prDragGroup = [];
      prDragCloned = false;
    }
    if (prDragIndex >= 0) {
      const draggedNote = getNotes()[prDragIndex];
      if (draggedNote) enforceMonophonic(draggedNote);
      getNotes().sort((a, b) => a.start - b.start);
    }
    prDragIndex = -1;
    prDragMode = "none";
    prDragCloned = false;
    prPreviewLastPitch = -1;
    return;
  }

  // ── クリック / ドラッグ開始 (down) ──
  if (ev.type === "down") {
    if (ev.localX >= kbGap && ev.localY >= PR_RULER_HEIGHT) {
      const hit = hitTestNoteEdge(ev.localX, ev.localY);
      if (hit) {
        const note = getNotes()[hit.idx];

        // 選択状態の更新
        if (ev.ctrl) {
          if (prSelection.has(note)) {
            prSelection.delete(note);
          } else {
            prSelection.add(note);
          }
        } else {
          if (!prSelection.has(note)) {
            prClearSelection();
            prSelection.add(note);
          }
        }

        // ドラッグ開始 — Undo スナップショット
        pushUndo();
        prDragAnchorCol = toCol(ev.localX);
        prDragAnchorRow = toRow(ev.localY);

        if (hit.edge === "left") {
          prDragMode = "resize-left";
        } else if (hit.edge === "right") {
          prDragMode = "resize-right";
        } else {
          prDragMode = "move";
        }

        // 選択ノートの元情報を保存
        prDragGroup = [];
        for (const n of prSelection) {
          prDragGroup.push({
            note: n,
            origPitch: n.pitch,
            origStart: n.start,
            origDuration: n.duration,
          });
        }

        prDragIndex = hit.idx;
        prDragOrigPitch = note.pitch;
        prDragOrigStart = note.start;
        prDragOrigDuration = note.duration;
        prPreviewLastPitch = note.pitch;
        // ── クリック時プレビュー発音 (Ableton Live 準拠) ──
        previewPitch(note.pitch);
      } else {
        // 空白クリック→選択解除 & ラバーバンド開始
        if (!ev.ctrl) prClearSelection();
        prRubberBandCtrl = !!ev.ctrl;
        const col = toCol(ev.localX);
        const row = toRow(ev.localY);
        prRubberBand = { col0: col, row0: row, col1: col, row1: row };
      }
    }
    return;
  }

  // ダブルクリック: ノート配置 / 削除 (Ableton Live 準拠)
  if (ev.type === "dblclick") {
    if (ev.localX < kbGap) return;
    if (ev.localY < PR_RULER_HEIGHT) return;
    pushUndo();
    const hitIdx = hitTestNote(ev.localX, ev.localY);
    if (hitIdx >= 0) {
      const note = getNotes()[hitIdx];
      if (prSelection.has(note) && prSelection.size > 1) {
        const notes = getNotes();
        for (let i = notes.length - 1; i >= 0; i--) {
          if (prSelection.has(notes[i])) notes.splice(i, 1);
        }
        prClearSelection();
      } else {
        prSelection.delete(note);
        getNotes().splice(hitIdx, 1);
      }
    } else {
      const col = Math.floor((ev.localX - kbGap) / prColWidth) + prScrollCol;
      const row =
        Math.floor((ev.localY - PR_RULER_HEIGHT) / prRowHeight) + prScrollRow;
      const pitch = PR_BASE_NOTE + PR_TOTAL_ROWS - 1 - row;
      if (
        pitch >= 0 &&
        pitch <= 127 &&
        col >= 0 &&
        col < PIANO_ROLL_TOTAL_COLUMNS
      ) {
        const newNote = { pitch, start: col, duration: PR_DEFAULT_DURATION };
        enforceMonophonic(newNote);
        insertNoteSorted(newNote);
        prClearSelection();
        prSelection.add(newNote);
        // ── 配置時プレビュー発音 ──
        previewPitch(pitch);
      }
    }
    return;
  }

  if (ev.type === "wheel") {
    if (ev.ctrl && ev.alt) {
      const step = ev.deltaY > 0 ? -2 : 2;
      prRowHeight = Math.max(
        PR_ROW_HEIGHT_MIN,
        Math.min(PR_ROW_HEIGHT_MAX, prRowHeight + step),
      );
      prScrollRow = Math.max(
        0,
        Math.min(PR_TOTAL_ROWS - prLastRows, prScrollRow),
      );
    } else if (ev.ctrl) {
      const step = ev.deltaY > 0 ? -2 : 2;
      prColWidth = Math.max(
        PR_COL_WIDTH_MIN,
        Math.min(PR_COL_WIDTH_MAX, prColWidth + step),
      );
      prScrollCol = Math.max(
        0,
        Math.min(PIANO_ROLL_TOTAL_COLUMNS - prLastCols, prScrollCol),
      );
    } else {
      if (ev.deltaY !== 0) {
        const dir = ev.deltaY > 0 ? PR_SCROLL_SPEED : -PR_SCROLL_SPEED;
        prScrollRow = Math.max(
          0,
          Math.min(PR_TOTAL_ROWS - prLastRows, prScrollRow + dir),
        );
      }
      if (ev.deltaX !== 0) {
        const dir = ev.deltaX > 0 ? PR_SCROLL_SPEED : -PR_SCROLL_SPEED;
        prScrollCol = Math.max(
          0,
          Math.min(PIANO_ROLL_TOTAL_COLUMNS - prLastCols, prScrollCol + dir),
        );
      }
    }
  }
}

/**
 * ピアノロールの全状態を初期値にリセットする。
 * STUDIO ウィンドウを閉じるときに呼ばれる。
 */
export function resetPianoRoll() {
  // ノートデータ + オーディオ停止
  for (const track of tracks) {
    track.notes = [];
    track.channel.stopAllScheduled();
  }
  prActiveTrack = 0;

  // Undo / Redo
  undoStack.length = 0;
  redoStack.length = 0;

  // 選択・クリップボード
  prSelection.clear();
  prClipboard = [];

  // ドラッグ
  prDragIndex = -1;
  prDragMode = "none";
  prRubberBand = null;
  prDragGroup = [];
  prDragCloned = false;

  // 鍵盤
  isKeyboardSounding = false;
  keyboardMidiNote = -1;
  prKeyboardSelStartPitch = -1;
  prKeyboardSelCurrentPitch = -1;
  prPreviewLastPitch = -1;
  prRubberBandPrevNotes.clear();

  // スクロール・ズーム
  prScrollRow = 0;
  prScrollCol = 0;
  prRowHeight = 14;
  prColWidth = 20;

  // プレイヘッド
  prPlayheadPos = -1;

  // トラックセレクタ — トラック 0 に戻す
  if (_trackRadios) {
    _trackRadios[0].value = true;
    for (let i = 1; i < _trackRadios.length; i++) _trackRadios[i].value = false;
  }
}

/** フォント変更後にトラックセレクタを再測定・再レイアウトする */
export function remeasurePianoRoll() {
  if (!_trackSelectorGroup) return;
  _trackSelectorGroup.remeasureAll();
  _layoutTrackSelector();
}

/** アクティブトラックのチャンネルを返す */
export function getActiveTrackChannel() {
  return tracks[prActiveTrack].channel;
}

/** アクティブトラックのインデックスを返す */
export function getActiveTrackIndex() {
  return prActiveTrack;
}

/** ピアノロールタブの最小コンテンツサイズを返す */
export function measurePianoRoll() {
  _initTrackSelector();
  return {
    w: PR_INIT_WIDTH + prTrackSelW + PR_KEYBOARD_WIDTH + 2 + FOCUS_MARGIN,
    h: PR_INIT_HEIGHT,
  };
}

