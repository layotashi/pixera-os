/**
 * @module app/paint
 * paint.js — PAINT ウィンドウ
 *
 * 1bit (2色) ピクセルペイントツール。
 * 独自のキャンバスバッファ (128×96) を持ち、
 * 各種描画ツールで編集する。
 *
 * 構成:
 *   - 左サイドバー: ツール選択ラジオボタン, サイズ, 塗り/枠トグル
 *   - 中央: 128×96 キャンバス
 *   - footer: 座標 / キャンバスサイズ / ツール名
 *
 * ツール:
 *   PEN  ペンシル (フリーハンド, 色1)
 *   ERS  消しゴム (フリーハンド, 色0)
 *   LIN  直線
 *   RCT  矩形 (枠/塗り切替)
 *   CIR  円 (枠/塗り切替)
 *   FIL  フラッドフィル
 *   INV  矩形反転
 *   SPT  スポイト
 *   SEL  範囲選択 (移動/コピー/削除)
 *
 * Undo/Redo: Ctrl+Z / Ctrl+Y (最大20ステップ)
 *
 * VFS 連携:
 *   - Alt+N: 新規作成 (未保存確認あり)
 *   - Ctrl+O: ファイルを開く (未保存確認あり)
 *   - Ctrl+S: 上書き保存 (パスが無い場合は Save As にフォールバック)
 *   - Ctrl+Shift+S: 名前を付けて保存 (FileDialog)
 *   - paintOpenFile(path): Files 等の外部モジュールからファイルを開く
 */

import * as GPU from "../core/gpu.js";
import { drawText, textWidth, GLYPH_H } from "../core/font.js";
import * as WM from "../wm/index.js";
import * as UI from "../ui/index.js";
import { ctrlDown, ctrlShiftDown, altDown, keyDown } from "../core/input.js";
import * as VFS from "../core/vfs.js";
import {
  encodePBM as _encodePBM,
  decodePBM as _decodePBM,
} from "../core/pbm.js";

const APP_NAME = "PAINT";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CANVAS_W = 128;
const CANVAS_H = 96;
const MAX_UNDO = 20;

// ツール ID
const TOOL_PEN = 0;
const TOOL_ERS = 1;
const TOOL_LIN = 2;
const TOOL_RCT = 3;
const TOOL_CIR = 4;
const TOOL_FIL = 5;
const TOOL_INV = 6;
const TOOL_SPT = 7;
const TOOL_SEL = 8;

const TOOL_LABELS = [
  "PEN",
  "ERS",
  "LIN",
  "RCT",
  "CIR",
  "FIL",
  "INV",
  "SPT",
  "SEL",
];

/** サイドバーとキャンバスの間隔 */
const SIDEBAR_GAP = 4;

/** キャンバス枠線の太さ (描画用、枠は1px) */
const CANVAS_BORDER = 1;

/** マーチングアンツのアニメーション間隔 (フレーム) */
const ANTS_INTERVAL = 8;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let currentTool = TOOL_PEN;
let brushSize = 1;
let isFillMode = false; // 矩形/円: false=枠線, true=塗りつぶし

/** キャンバスバッファ (1bit/pixel) */
let canvasBuf = new Uint8Array(CANVAS_W * CANVAS_H);

// ── ファイル状態 ──
/** 現在開いているファイルの VFS パス (null = 無題) */
let currentFilePath = null;
/** 最後に保存した時点から変更があるか */
let isDirty = false;
/** wmOpen が返したウィンドウ ID */
let paintWinId = null;

// ── Undo / Redo ──
let undoStack = [];
let redoStack = [];

// ── 描画中の状態 ──
let isDrawing = false;
let drawStartX = 0;
let drawStartY = 0;
let prevPixelX = -1;
let prevPixelY = -1;

// ── マウス位置（フッター表示用）──
let cursorPixelX = -1;
let cursorPixelY = -1;

// ── 選択ツール ──
const SEL_IDLE = 0;
const SEL_SELECTING = 1;
const SEL_SELECTED = 2;
const SEL_MOVING = 3;

let selState = SEL_IDLE;
/** 正規化された選択矩形 (キャンバス座標) */
let selX = 0;
let selY = 0;
let selW = 0;
let selH = 0;
/** 選択範囲描画開始点 */
let selStartX = 0;
let selStartY = 0;
/** 移動中の選択バッファ */
let selBuf = null;
let selBufW = 0;
let selBufH = 0;
/** 移動先のオフセット */
let selMoveX = 0;
let selMoveY = 0;
/** 移動ドラッグ開始座標 */
let selDragStartX = 0;
let selDragStartY = 0;
/** 移動ドラッグ開始時のオフセット */
let selDragOfsX = 0;
let selDragOfsY = 0;
/** コピーモード (Ctrl を押しながら移動) */
let selIsCopy = false;
/** マーチングアンツ フレームカウンタ */
let antsFrame = 0;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PBM P1 エンコード / デコード (core/pbm.js ラッパー)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * canvasBuf を PBM P1 (ASCII) テキストにエンコードする。
 * @returns {string}
 */
function encodePBM() {
  return _encodePBM(canvasBuf, CANVAS_W, CANVAS_H);
}

/**
 * PBM P1 テキストを解析して canvasBuf にロードする。
 * サイズが異なる場合はクリップ / パディングして 128×96 に収める。
 * @param {string} text  PBM P1 形式のテキスト
 * @returns {boolean} 解析成功なら true
 */
function decodePBM(text) {
  const result = _decodePBM(text);
  if (!result) return false;
  const { w, h, buf } = result;
  const newBuf = new Uint8Array(CANVAS_W * CANVAS_H);
  for (let y = 0; y < h && y < CANVAS_H; y++) {
    for (let x = 0; x < w && x < CANVAS_W; x++) {
      newBuf[y * CANVAS_W + x] = buf[y * w + x];
    }
  }
  canvasBuf = newBuf;
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ファイル操作
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** タイトルバー更新 */
function refreshPaintTitle() {
  if (paintWinId === null) return;
  const name = currentFilePath ? VFS.basename(currentFilePath) : "UNTITLED";
  const dirty = isDirty ? "* " : "";
  WM.wmSetTitle(paintWinId, `${dirty}${name} - ${APP_NAME}`);
}

/** 全状態リセット */
function resetPaintState() {
  canvasBuf.fill(0);
  undoStack = [];
  redoStack = [];
  isDrawing = false;
  prevPixelX = -1;
  prevPixelY = -1;
  cursorPixelX = -1;
  cursorPixelY = -1;
  currentTool = TOOL_PEN;
  brushSize = 1;
  isFillMode = false;
  toolButtons.forEach((b, i) => {
    b.value = i === 0;
  });
  numberBoxSize.value = 1;
  toggleFill.value = false;
  toggleFill.label = "OL";
  clearSelection();
  currentFilePath = null;
  isDirty = false;
  refreshPaintTitle();
}

/** 未保存確認 → コールバック実行 */
function confirmDiscard(callback) {
  if (!isDirty) {
    callback();
    return;
  }
  UI.openConfirmDialog("DISCARD UNSAVED CHANGES?", {
    variant: "danger",
    onOk: callback,
  });
}

/** 名前を付けて保存 */
function saveFileAs() {
  const dir = currentFilePath
    ? VFS.parentPath(currentFilePath)
    : "/Pictures";
  const name = currentFilePath
    ? VFS.basename(currentFilePath)
    : "untitled.pbm";

  UI.openFileDialog("save", {
    title: "SAVE AS",
    defaultPath: dir,
    defaultName: name,
    filter: [".pbm"],
    onResult: (path) => {
      if (!path) return;
      currentFilePath = path;
      VFS.writeFile(currentFilePath, encodePBM());
      isDirty = false;
      refreshPaintTitle();
    },
  });
}

/** 上書き保存 */
function savePaintFile() {
  if (!currentFilePath) {
    saveFileAs();
    return;
  }
  VFS.writeFile(currentFilePath, encodePBM());
  isDirty = false;
  refreshPaintTitle();
}

/** ファイルを開く */
function openPaintFileDialog() {
  confirmDiscard(() => {
    UI.openFileDialog("open", {
      title: "OPEN",
      filter: [".pbm"],
      onResult: (path) => {
        if (!path) return;
        const content = VFS.readFile(path);
        if (content === null) return;
        if (!decodePBM(content)) return;
        undoStack = [];
        redoStack = [];
        isDrawing = false;
        clearSelection();
        currentFilePath = path;
        isDirty = false;
        refreshPaintTitle();
      },
    });
  });
}

/** 新規作成 */
function newPaintFile() {
  confirmDiscard(() => {
    canvasBuf.fill(0);
    undoStack = [];
    redoStack = [];
    isDrawing = false;
    clearSelection();
    currentFilePath = null;
    isDirty = false;
    refreshPaintTitle();
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Undo / Redo
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function pushUndo() {
  undoStack.push(new Uint8Array(canvasBuf));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  isDirty = true;
  refreshPaintTitle();
}

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(new Uint8Array(canvasBuf));
  canvasBuf = undoStack.pop();
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(new Uint8Array(canvasBuf));
  canvasBuf = redoStack.pop();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  キャンバスバッファ操作
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function bufPset(x, y, c) {
  x = x | 0;
  y = y | 0;
  if (x < 0 || x >= CANVAS_W || y < 0 || y >= CANVAS_H) return;
  canvasBuf[y * CANVAS_W + x] = c ? 1 : 0;
}

function bufPget(x, y) {
  x = x | 0;
  y = y | 0;
  if (x < 0 || x >= CANVAS_W || y < 0 || y >= CANVAS_H) return 0;
  return canvasBuf[y * CANVAS_W + x];
}

/** ブラシ描画 (サイズ1=1px, サイズ>1=塗りつぶし円) */
function bufBrush(cx, cy, c) {
  if (brushSize <= 1) {
    bufPset(cx, cy, c);
    return;
  }
  const r = ((brushSize - 1) / 2) | 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) {
        bufPset(cx + dx, cy + dy, c);
      }
    }
  }
}

/** バッファ上にブレゼンハム直線 (ブラシ付き) */
function bufLine(x0, y0, x1, y1, c) {
  x0 = x0 | 0;
  y0 = y0 | 0;
  x1 = x1 | 0;
  y1 = y1 | 0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    bufBrush(x0, y0, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = err << 1;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** バッファ上に矩形枠線 */
function bufRect(x0, y0, w, h, c) {
  for (let i = x0; i < x0 + w; i++) {
    bufPset(i, y0, c);
    bufPset(i, y0 + h - 1, c);
  }
  for (let j = y0; j < y0 + h; j++) {
    bufPset(x0, j, c);
    bufPset(x0 + w - 1, j, c);
  }
}

/** バッファ上に矩形塗りつぶし */
function bufFillRect(x0, y0, w, h, c) {
  for (let j = y0; j < y0 + h; j++) {
    for (let i = x0; i < x0 + w; i++) {
      bufPset(i, j, c);
    }
  }
}

/** バッファ上に円枠線 (Midpoint) */
function bufCircle(cx, cy, r, c) {
  let x = r;
  let y = 0;
  let d = 1 - r;
  while (x >= y) {
    bufPset(cx + x, cy + y, c);
    bufPset(cx - x, cy + y, c);
    bufPset(cx + x, cy - y, c);
    bufPset(cx - x, cy - y, c);
    bufPset(cx + y, cy + x, c);
    bufPset(cx - y, cy + x, c);
    bufPset(cx + y, cy - x, c);
    bufPset(cx - y, cy - x, c);
    y++;
    if (d < 0) {
      d += 2 * y + 1;
    } else {
      x--;
      d += 2 * (y - x) + 1;
    }
  }
}

/** バッファ上に塗りつぶし円 */
function bufFillCircle(cx, cy, r, c) {
  let x = r;
  let y = 0;
  let d = 1 - r;
  while (x >= y) {
    for (let i = cx - x; i <= cx + x; i++) {
      bufPset(i, cy + y, c);
      bufPset(i, cy - y, c);
    }
    for (let i = cx - y; i <= cx + y; i++) {
      bufPset(i, cy + x, c);
      bufPset(i, cy - x, c);
    }
    y++;
    if (d < 0) {
      d += 2 * y + 1;
    } else {
      x--;
      d += 2 * (y - x) + 1;
    }
  }
}

/** フラッドフィル (4方向 BFS) */
function bufFloodFill(sx, sy, c) {
  sx = sx | 0;
  sy = sy | 0;
  if (sx < 0 || sx >= CANVAS_W || sy < 0 || sy >= CANVAS_H) return;
  const target = bufPget(sx, sy);
  const fill = c ? 1 : 0;
  if (target === fill) return;
  const stack = [sx, sy];
  while (stack.length > 0) {
    const py = stack.pop();
    const px = stack.pop();
    if (px < 0 || px >= CANVAS_W || py < 0 || py >= CANVAS_H) continue;
    if (canvasBuf[py * CANVAS_W + px] !== target) continue;
    canvasBuf[py * CANVAS_W + px] = fill;
    stack.push(px + 1, py);
    stack.push(px - 1, py);
    stack.push(px, py + 1);
    stack.push(px, py - 1);
  }
}

/** バッファ上の矩形反転 */
function bufInvertRect(x0, y0, w, h) {
  for (let j = y0; j < y0 + h; j++) {
    for (let i = x0; i < x0 + w; i++) {
      if (i >= 0 && i < CANVAS_W && j >= 0 && j < CANVAS_H) {
        canvasBuf[j * CANVAS_W + i] ^= 1;
      }
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  選択ツール ヘルパー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 2点から正規化された矩形を返す */
function normalizeRect(x0, y0, x1, y1) {
  const nx = Math.min(x0, x1);
  const ny = Math.min(y0, y1);
  const nw = Math.abs(x1 - x0) + 1;
  const nh = Math.abs(y1 - y0) + 1;
  return { x: nx, y: ny, w: nw, h: nh };
}

/** 座標が選択矩形内にあるか */
function isInSelection(px, py) {
  return px >= selX && px < selX + selW && py >= selY && py < selY + selH;
}

/** 選択範囲からピクセルを抽出 */
function extractSelection() {
  selBufW = selW;
  selBufH = selH;
  selBuf = new Uint8Array(selBufW * selBufH);
  for (let j = 0; j < selBufH; j++) {
    for (let i = 0; i < selBufW; i++) {
      selBuf[j * selBufW + i] = bufPget(selX + i, selY + j);
    }
  }
}

/** 選択バッファをキャンバスに書き込む */
function stampSelection(dx, dy) {
  for (let j = 0; j < selBufH; j++) {
    for (let i = 0; i < selBufW; i++) {
      bufPset(dx + i, dy + j, selBuf[j * selBufW + i]);
    }
  }
}

/** 選択状態をリセット */
function clearSelection() {
  selState = SEL_IDLE;
  selBuf = null;
  selBufW = 0;
  selBufH = 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  VRAM 描画ヘルパー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * キャンバスバッファを VRAM に転写する。
 * fillRect で背景クリア → blit で前景ピクセル描画
 */
function blitCanvas(ox, oy) {
  GPU.fillRect(ox, oy, CANVAS_W, CANVAS_H, 0);
  GPU.blit(canvasBuf, CANVAS_W, CANVAS_H, ox, oy, 1);
}

/**
 * プレビュー用の形状をVRAM上に直接描画する。
 * フレームごとにキャンバスが再描画されるので VRAM への直接描画は一時的。
 */
function drawPreview(ox, oy, px, py) {
  if (!isDrawing) return;
  const sx = ox + drawStartX;
  const sy = oy + drawStartY;
  const ex = ox + px;
  const ey = oy + py;

  switch (currentTool) {
    case TOOL_LIN:
      GPU.drawLine(sx, sy, ex, ey, 1);
      break;
    case TOOL_RCT: {
      const r = normalizeRect(drawStartX, drawStartY, px, py);
      if (isFillMode) {
        GPU.fillRect(ox + r.x, oy + r.y, r.w, r.h, 1);
      } else {
        GPU.drawRect(ox + r.x, oy + r.y, r.w, r.h, 1);
      }
      break;
    }
    case TOOL_CIR: {
      const dx = px - drawStartX;
      const dy = py - drawStartY;
      const radius = Math.round(Math.sqrt(dx * dx + dy * dy));
      if (isFillMode) {
        GPU.fillCircle(sx, sy, radius, 1);
      } else {
        GPU.drawCircle(sx, sy, radius, 1);
      }
      break;
    }
    case TOOL_INV: {
      const r = normalizeRect(drawStartX, drawStartY, px, py);
      GPU.invertRect(ox + r.x, oy + r.y, r.w, r.h);
      break;
    }
  }
}

/**
 * 選択矩形をVRAM上にマーチングアンツで描画する。
 */
function drawSelectionOverlay(ox, oy) {
  if (selState === SEL_IDLE) return;

  let rx, ry, rw, rh;
  if (selState === SEL_SELECTING) {
    // 選択中: 現在のドラッグ範囲
    const r = normalizeRect(selStartX, selStartY, cursorPixelX, cursorPixelY);
    rx = r.x;
    ry = r.y;
    rw = r.w;
    rh = r.h;
  } else if (selState === SEL_MOVING) {
    // 移動中: 移動先
    rx = selMoveX;
    ry = selMoveY;
    rw = selBufW;
    rh = selBufH;
  } else {
    // SEL_SELECTED
    rx = selX;
    ry = selY;
    rw = selW;
    rh = selH;
  }

  // マーチングアンツ: 偶数/奇数フレームでインバート位相を変える
  const phase = ((antsFrame / ANTS_INTERVAL) | 0) & 1;

  const ax = ox + rx;
  const ay = oy + ry;

  // 上辺・下辺
  for (let i = 0; i < rw; i++) {
    if (((i + phase) & 1) === 0) {
      GPU.pset(ax + i, ay, bufPget(rx + i, ry) ^ 1);
      GPU.pset(ax + i, ay + rh - 1, bufPget(rx + i, ry + rh - 1) ^ 1);
    }
  }
  // 左辺・右辺
  for (let j = 1; j < rh - 1; j++) {
    if (((j + phase) & 1) === 0) {
      GPU.pset(ax, ay + j, bufPget(rx, ry + j) ^ 1);
      GPU.pset(ax + rw - 1, ay + j, bufPget(rx + rw - 1, ry + j) ^ 1);
    }
  }

  // 移動中の選択バッファのプレビュー
  if (selState === SEL_MOVING && selBuf) {
    GPU.blit(selBuf, selBufW, selBufH, ox + selMoveX, oy + selMoveY, 1);
    // 色0のピクセルも描画（上書き）
    for (let j = 0; j < selBufH; j++) {
      for (let i = 0; i < selBufW; i++) {
        if (!selBuf[j * selBufW + i]) {
          GPU.pset(ox + selMoveX + i, oy + selMoveY + j, 0);
        }
      }
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィジェット
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const TOOL_GROUP = "paintTool";

function onToolChange(toolIdx) {
  return (v) => {
    if (v) {
      // 別ツールに切替え → 選択解除
      if (currentTool === TOOL_SEL && toolIdx !== TOOL_SEL) {
        clearSelection();
      }
      currentTool = toolIdx;
      isDrawing = false;
    }
  };
}

// ── ツール選択ラジオボタン ──
const TOOL_TOOLTIPS = [
  "Pencil",
  "Eraser",
  "Line",
  "Rectangle",
  "Circle",
  "Flood Fill",
  "Invert Rect",
  "Color Pick",
  "Select",
];

let toolButtons;
let separatorTools, labelSize, numberBoxSize, separatorSize, toggleFill;
let sidebarWidgets;
let sidebarRoot;
let sidebarWidth = 0;
let _ready = false;

function _initWidgets() {
  if (_ready) return;
  _ready = true;

  toolButtons = TOOL_LABELS.map((label, idx) => {
    const btn = new UI.RadioButton(
      0,
      0,
      label,
      TOOL_GROUP,
      onToolChange(idx),
      idx === 0,
    );
    btn.tooltip = TOOL_TOOLTIPS[idx];
    return btn;
  });

  // ── セパレータ1 ──
  separatorTools = new UI.HSep(0, 0, 0); // 幅は layout 後に決定

  // ── ブラシサイズ ──
  labelSize = new UI.Label(0, 0, "Sz:");
  labelSize.tooltip = "Brush Size";
  numberBoxSize = new UI.NumberBox(0, 0, 1, 7, 1, 2, (v) => {
    brushSize = v;
  });
  numberBoxSize.tooltip = "Brush Size";

  // ── セパレータ2 ──
  separatorSize = new UI.HSep(0, 0, 0); // 幅は layout 後に決定

  // ── 塗り/枠 トグル ──
  toggleFill = new UI.ToggleButton(0, 0, "OL", (v) => {
    isFillMode = v;
    toggleFill.label = v ? "FL" : "OL";
  });
  toggleFill.tooltip = "Outline / Filled";

  // ── Box レイアウト ──
  const sizeRow = UI.HBox([labelSize, numberBoxSize]);
  sidebarRoot = UI.VBox([
    ...toolButtons,
    separatorTools,
    sizeRow,
    separatorSize,
    toggleFill,
  ]);

  // WidgetGroup(root) は初期 layout + auto-layout を実行
  sidebarWidgets = new UI.WidgetGroup(sidebarRoot);

  // サイドバー幅を算出
  const sidebarSize = sidebarWidgets.measure();
  sidebarWidth = sidebarSize.w;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  レイアウト計算
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** コンテンツ領域内でのキャンバス左上 X */
function canvasLocalX() {
  return UI.FOCUS_MARGIN + sidebarWidth + SIDEBAR_GAP;
}

/** コンテンツ領域内でのキャンバス左上 Y */
function canvasLocalY() {
  return UI.FOCUS_MARGIN;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ローカル座標 → キャンバスピクセル変換
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ev.localX/Y → キャンバスバッファ上のピクセル座標。
 * キャンバス外なら null。
 */
function localToPixel(lx, ly) {
  const cx = canvasLocalX() + CANVAS_BORDER;
  const cy = canvasLocalY() + CANVAS_BORDER;
  const px = lx - cx;
  const py = ly - cy;
  if (px < 0 || px >= CANVAS_W || py < 0 || py >= CANVAS_H) return null;
  return { x: px | 0, y: py | 0 };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  onInput
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onInput(ev) {
  // ── ウィジェット更新 ──
  sidebarWidgets.update(ev);

  // ── キャンバスピクセル座標計算 ──
  const pixel = localToPixel(ev.localX, ev.localY);
  if (pixel) {
    cursorPixelX = pixel.x;
    cursorPixelY = pixel.y;
  }

  // ── キャンバス外のマウスイベントは無視 ──
  if (!pixel && ev.type !== "up" && ev.type !== "hover") return;
  if (!pixel && ev.type === "hover") {
    cursorPixelX = -1;
    cursorPixelY = -1;
    return;
  }

  const px = pixel ? pixel.x : 0;
  const py = pixel ? pixel.y : 0;

  switch (currentTool) {
    // ── ペンシル / 消しゴム ──
    case TOOL_PEN:
    case TOOL_ERS: {
      const c = currentTool === TOOL_PEN ? 1 : 0;
      if (ev.type === "down" && pixel) {
        pushUndo();
        isDrawing = true;
        bufBrush(px, py, c);
        prevPixelX = px;
        prevPixelY = py;
      } else if (ev.type === "held" && isDrawing) {
        if (pixel) {
          // 前フレーム位置から直線補間
          if (prevPixelX >= 0) {
            bufLine(prevPixelX, prevPixelY, px, py, c);
          } else {
            bufBrush(px, py, c);
          }
          prevPixelX = px;
          prevPixelY = py;
        }
      } else if (ev.type === "up") {
        isDrawing = false;
        prevPixelX = -1;
        prevPixelY = -1;
      }
      break;
    }

    // ── 直線 ──
    case TOOL_LIN: {
      if (ev.type === "down" && pixel) {
        pushUndo();
        isDrawing = true;
        drawStartX = px;
        drawStartY = py;
      } else if (ev.type === "up" && isDrawing) {
        if (pixel) {
          bufLine(drawStartX, drawStartY, px, py, 1);
        }
        isDrawing = false;
      }
      break;
    }

    // ── 矩形 ──
    case TOOL_RCT: {
      if (ev.type === "down" && pixel) {
        pushUndo();
        isDrawing = true;
        drawStartX = px;
        drawStartY = py;
      } else if (ev.type === "up" && isDrawing) {
        if (pixel) {
          const r = normalizeRect(drawStartX, drawStartY, px, py);
          if (isFillMode) {
            bufFillRect(r.x, r.y, r.w, r.h, 1);
          } else {
            bufRect(r.x, r.y, r.w, r.h, 1);
          }
        }
        isDrawing = false;
      }
      break;
    }

    // ── 円 ──
    case TOOL_CIR: {
      if (ev.type === "down" && pixel) {
        pushUndo();
        isDrawing = true;
        drawStartX = px;
        drawStartY = py;
      } else if (ev.type === "up" && isDrawing) {
        if (pixel) {
          const dx = px - drawStartX;
          const dy = py - drawStartY;
          const radius = Math.round(Math.sqrt(dx * dx + dy * dy));
          if (isFillMode) {
            bufFillCircle(drawStartX, drawStartY, radius, 1);
          } else {
            bufCircle(drawStartX, drawStartY, radius, 1);
          }
        }
        isDrawing = false;
      }
      break;
    }

    // ── フラッドフィル ──
    case TOOL_FIL: {
      if (ev.type === "down" && pixel) {
        pushUndo();
        bufFloodFill(px, py, 1);
      }
      break;
    }

    // ── 矩形反転 ──
    case TOOL_INV: {
      if (ev.type === "down" && pixel) {
        pushUndo();
        isDrawing = true;
        drawStartX = px;
        drawStartY = py;
      } else if (ev.type === "up" && isDrawing) {
        if (pixel) {
          const r = normalizeRect(drawStartX, drawStartY, px, py);
          bufInvertRect(r.x, r.y, r.w, r.h);
        }
        isDrawing = false;
      }
      break;
    }

    // ── スポイト ──
    case TOOL_SPT: {
      if (ev.type === "down" && pixel) {
        const picked = bufPget(px, py);
        // 色0 → 消しゴム, 色1 → ペンシル に切替え
        if (picked === 0) {
          currentTool = TOOL_ERS;
          // ラジオボタンを同期
          toolButtons.forEach((b, i) => {
            b.value = i === TOOL_ERS;
          });
        } else {
          currentTool = TOOL_PEN;
          toolButtons.forEach((b, i) => {
            b.value = i === TOOL_PEN;
          });
        }
      }
      break;
    }

    // ── 選択 ──
    case TOOL_SEL: {
      handleSelectionInput(ev, px, py, pixel);
      break;
    }
  }
}

/**
 * 選択ツールの入力処理
 */
function handleSelectionInput(ev, px, py, pixel) {
  switch (selState) {
    case SEL_IDLE: {
      if (ev.type === "down" && pixel) {
        // 選択開始
        selState = SEL_SELECTING;
        selStartX = px;
        selStartY = py;
      }
      break;
    }

    case SEL_SELECTING: {
      if (ev.type === "up") {
        if (pixel) {
          const r = normalizeRect(selStartX, selStartY, px, py);
          if (r.w > 1 || r.h > 1) {
            selX = r.x;
            selY = r.y;
            selW = r.w;
            selH = r.h;
            selState = SEL_SELECTED;
          } else {
            selState = SEL_IDLE;
          }
        } else {
          selState = SEL_IDLE;
        }
      }
      break;
    }

    case SEL_SELECTED: {
      if (ev.type === "down" && pixel) {
        if (isInSelection(px, py)) {
          // 選択範囲内クリック → 移動開始
          pushUndo();
          extractSelection();
          selIsCopy = !!ev.ctrl;
          if (!selIsCopy) {
            // 元の場所をクリア
            bufFillRect(selX, selY, selW, selH, 0);
          }
          selMoveX = selX;
          selMoveY = selY;
          selDragStartX = px;
          selDragStartY = py;
          selDragOfsX = selMoveX;
          selDragOfsY = selMoveY;
          selState = SEL_MOVING;
        } else {
          // 選択範囲外クリック → 選択解除、新たに選択開始
          selState = SEL_SELECTING;
          selStartX = px;
          selStartY = py;
        }
      }
      break;
    }

    case SEL_MOVING: {
      if (ev.type === "held") {
        const dx = px - selDragStartX;
        const dy = py - selDragStartY;
        selMoveX = selDragOfsX + dx;
        selMoveY = selDragOfsY + dy;
      } else if (ev.type === "up") {
        // 確定: バッファに書き込み
        if (selBuf) {
          stampSelection(selMoveX, selMoveY);
        }
        if (selIsCopy) {
          // コピーモード → 選択を維持 (移動先を新しい選択範囲にする)
          selX = selMoveX;
          selY = selMoveY;
          selW = selBufW;
          selH = selBufH;
          selBuf = null;
          selBufW = 0;
          selBufH = 0;
          selState = SEL_SELECTED;
        } else {
          clearSelection();
        }
      }
      break;
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  onDraw
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDraw(contentRect) {
  const ox = contentRect.x;
  const oy = contentRect.y;

  // ── キーボードショートカット (フォーカス中のみ) ──
  if (WM.wmIsFocused(paintWinId)) {
    if (ctrlDown("KeyZ")) undo();
    if (ctrlDown("KeyY")) redo();
    if (ctrlShiftDown("KeyS")) {
      saveFileAs();
    } else if (ctrlDown("KeyS")) {
      savePaintFile();
    }
    if (ctrlDown("KeyO")) openPaintFileDialog();
    if (altDown("KeyN")) newPaintFile();
    // Delete → 選択範囲クリア
    if (keyDown("Delete") && selState === SEL_SELECTED) {
      pushUndo();
      bufFillRect(selX, selY, selW, selH, 0);
      clearSelection();
    }
    // Ctrl+A → 全選択
    if (ctrlDown("KeyA")) {
      currentTool = TOOL_SEL;
      toolButtons.forEach((b, i) => {
        b.value = i === TOOL_SEL;
      });
      selX = 0;
      selY = 0;
      selW = CANVAS_W;
      selH = CANVAS_H;
      selState = SEL_SELECTED;
    }
  }

  // ── マーチングアンツ タイマー ──
  antsFrame++;

  // ── サイドバー描画 ──
  sidebarWidgets.draw(contentRect);

  // ── キャンバス枠線 ──
  const cOx = ox + canvasLocalX();
  const cOy = oy + canvasLocalY();
  GPU.drawRect(
    cOx,
    cOy,
    CANVAS_W + CANVAS_BORDER * 2,
    CANVAS_H + CANVAS_BORDER * 2,
    1,
  );

  // ── キャンバス描画 ──
  const pixOx = cOx + CANVAS_BORDER;
  const pixOy = cOy + CANVAS_BORDER;

  // クリップをキャンバス領域に制限
  GPU.pushClip(pixOx, pixOy, CANVAS_W, CANVAS_H);

  blitCanvas(pixOx, pixOy);

  // ── プレビュー描画 (ドラッグ中の図形) ──
  if (isDrawing && cursorPixelX >= 0) {
    drawPreview(pixOx, pixOy, cursorPixelX, cursorPixelY);
  }

  // ── 選択オーバーレイ ──
  drawSelectionOverlay(pixOx, pixOy);

  GPU.popClip();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  onDrawFooter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDrawFooter(footerRect) {
  const coordStr =
    cursorPixelX >= 0
      ? `X:${String(cursorPixelX).padStart(3)} Y:${String(cursorPixelY).padStart(3)}`
      : "X:--- Y:---";
  const sizeStr = `${CANVAS_W}x${CANVAS_H}`;
  const toolStr = TOOL_LABELS[currentTool];

  drawText(footerRect.x, footerRect.y, coordStr, 1);

  // 右寄せ: サイズ + ツール名
  const right = `${sizeStr}  ${toolStr}`;
  const rw = textWidth(right);
  drawText(footerRect.x + footerRect.w - rw, footerRect.y, right, 1);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  onMeasure
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onMeasure() {
  const sbSize = sidebarWidgets.measure();
  const canvasOuterW = CANVAS_W + CANVAS_BORDER * 2;
  const canvasOuterH = CANVAS_H + CANVAS_BORDER * 2;
  return {
    w:
      UI.FOCUS_MARGIN +
      sidebarWidth +
      SIDEBAR_GAP +
      canvasOuterW +
      UI.FOCUS_MARGIN,
    h: UI.FOCUS_MARGIN + Math.max(sbSize.h, canvasOuterH) + UI.FOCUS_MARGIN,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  onBeforeClose (未保存確認)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onBeforeClose() {
  if (isDirty) {
    UI.openConfirmDialog("DISCARD UNSAVED CHANGES?", {
      variant: "danger",
      onOk: () => {
        resetPaintState();
        WM.wmClose(paintWinId);
      },
    });
    return false;
  }
  resetPaintState();
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WM.wmRegister(
  APP_NAME,
  () => {
    _initWidgets();
    paintWinId = WM.wmOpen(-1, -1, 0, 0, APP_NAME, onDraw, onInput, onMeasure, {
      about:
        "A 1-bit pixel paint tool. Pick a tool from the sidebar and draw " +
        "on the canvas, then save your image to the filesystem.",
      footer: true,
      onDrawFooter,
      onBeforeClose,
      onRelayout: () => {
        sidebarWidgets.remeasureAll();
        // measure() が _ensureLayout() を内部で呼ぶため明示 layout 不要
        const sbSize = sidebarWidgets.measure();
        sidebarWidth = sbSize.w;
      },
    });
    return paintWinId;
  },
  { category: "CREATIVE" },
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  公開 API: 外部からファイルを開く
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 指定パスの PBM ファイルを Paint で開く。
 * ウィンドウが閉じていれば自動的に開き、最前面に持ってくる。
 * @param {string} path  VFS 上のファイルパス (.pbm)
 * @returns {boolean} 読み込み成功なら true
 */
export function paintOpenFile(path) {
  const content = VFS.readFile(path);
  if (content === null) return false;

  // ウィンドウを開く / 最前面に出す
  WM.wmOpenOrFocus(APP_NAME);

  // PBM デコード
  if (!decodePBM(content)) return false;

  // 状態リセット
  undoStack = [];
  redoStack = [];
  isDrawing = false;
  clearSelection();

  currentFilePath = path;
  isDirty = false;
  refreshPaintTitle();
  return true;
}
