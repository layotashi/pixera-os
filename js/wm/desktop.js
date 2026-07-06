/**
 * @module wm/desktop
 * desktop.js — デスクトップアイコン管理
 *
 * 壁紙上にアプリアイコンをグリッド配置し、
 * ダブルクリックでアプリを起動する。
 * アイコンはドラッグで移動可能 (グリッドスナップ)。
 * 複数選択アイコンの同時移動にも対応。
 *
 * ── レイアウト ──
 *   各アイコンは gridCol / gridRow のグリッド座標を持つ。
 *   初期配置は列優先 (上→下、左→右)。
 *   各セルは CELL_W × CELL_H の固定サイズ。
 *   workAreaTop 以下の領域に配置する。
 *
 * ── アイコン描画 ──
 *   全アイコンは app_icon.js の drawAppIcon (18×18, 3-level) で描画する。
 *   専用スプライトが無いアプリには "default" アイコンが自動適用される。
 *   ラベル (アプリ名) はアイコンの下に描画する。
 *
 * ── 入力 ──
 *   シングルクリック: アイコン選択 (Ctrl+Click でトグル追加)
 *   ダブルクリック: アプリ起動 (wmOpenByName)
 *   ドラッグ: 選択中アイコンを一括移動 (グリッドスナップ、衝突時交換)
 *   Ctrl+A: 全アイコン選択 (デスクトップにフォーカスがある場合のみ)
 *   デスクトップ空白クリック: 選択解除
 *   ラッソ選択: デスクトップ空白をドラッグすると marching ants 風の
 *     選択矩形が表示され、矩形内のアイコンが選択される。
 */

import { VRAM_WIDTH, VRAM_HEIGHT, onFontChange } from "../config.js";
import * as GPU from "../core/gpu.js";
import { drawAppIcon, APP_ICON_W, APP_ICON_H } from "../core/app_icon.js";
import { drawText, GLYPH_W, GLYPH_H } from "../core/font.js";
import * as Input from "../core/input.js";

// ── WM コールバック (循環依存回避) ──
let _wmSetTooltip = null;

/**
 * WM からのツールチップコールバックを注入する。
 * @param {(text: string) => void} fn
 */
export function desktopSetTooltipCallback(fn) {
  _wmSetTooltip = fn;
}

// ── 定数 ──

/** グリッドセル幅 (px)。ラベル表示幅を考慮 */
const CELL_W = 48;

/** グリッドセル高さ (px)。アプリアイコン (18px) + ラベル + 余白 */
const CELL_H = 33;

/** セル内のアイコン上部余白 */
const ICON_PAD_TOP = 3;

/** アイコンとラベルの間隔 */
const ICON_LABEL_GAP = 3;

/** グリッドの左マージン */
const GRID_MARGIN_X = 4;

/** グリッドの上マージン (workAreaTop からの相対) */
const GRID_MARGIN_Y = 4;

/** ラベルの最大文字数 (それ以上は切り捨て) */
const MAX_LABEL_CHARS = 7;

/** フォントステップ (文字幅 + 字間) */
let FONT_STEP = GLYPH_W + 1; // 6

/** ラベル行高さ (1 行の文字高 + 行間) */
let LABEL_LINE_H = GLYPH_H + 1; // 8

// ── フォント変更リスナー ──
onFontChange(() => {
  FONT_STEP = GLYPH_W + 1;
  LABEL_LINE_H = GLYPH_H + 1;
});

// ── 状態 ──

/** workArea の上端 Y (タスクバーの高さ分) */
let _workAreaTop = 0;

/** 選択中アイコンインデックスの集合 (複数選択対応) */
const selectedSet = new Set();

/**
 * デスクトップにフォーカスがあるか。
 * Ctrl+A 等のキーボードショートカットをデスクトップで処理するかの判定に使う。
 * ウィンドウクリック時に false、デスクトップクリック時に true になる。
 */
let _desktopFocused = true;

/**
 * デスクトップに表示するアイコンエントリ。
 * wmRegister されたアプリから自動生成される。
 * gridCol / gridRow はグリッド上の配置座標 (1 アイコン = 1 セル)。
 * @type {{ name: string, label: string, icon: string, tooltip?: string, gridCol: number, gridRow: number }[]}
 */
let iconEntries = [];

// ── ドラッグ状態 ──

/**
 * ドラッグモード:
 *   "none"     — ドラッグなし
 *   "pending"  — マウス押下中、デッドゾーン内 (まだドラッグ開始していない)
 *   "dragging" — デッドゾーンを超えた = ドラッグ中
 */
let _dragMode = "none";

/** ドラッグ操作の基準 (アンカー) アイコンインデックス */
let _dragIdx = -1;

/** ドラッグ開始時のマウスオフセット (マウス位置 − アンカーセル左上) */
let _dragOffX = 0;
let _dragOffY = 0;

/**
 * ドラッググループの各アイコンのグリッドオフセット (アンカーからの相対座標)。
 * @type {Map<number, {dCol: number, dRow: number}>}
 */
const _dragGroupOffsets = new Map();

// ── ラッソ選択状態 ──

/**
 * ラッソモード:
 *   "none"      — ラッソなし
 *   "pending"   — マウス押下中、デッドゾーン内 (まだラッソ開始していない)
 *   "selecting" — デッドゾーンを超えた = ラッソ選択中
 */
let _lassoMode = "none";

/** ラッソ開始点 (マウス押下位置) */
let _lassoX0 = 0;
let _lassoY0 = 0;

/** ラッソ終了点 (現在のマウス位置) */
let _lassoX1 = 0;
let _lassoY1 = 0;

/**
 * ラッソ開始前の選択スナップショット (Ctrl+ラッソ時の追加合成用)。
 * Ctrl 押下時はラッソ矩形内のアイコンをこの集合にマージする。
 * @type {Set<number>}
 */
const _lassoBaseSet = new Set();

/** マーチングアンツのアニメーションフレームカウンタ */
let _antsFrame = 0;

/** マーチングアンツのアニメーション間隔 (フレーム) */
const ANTS_INTERVAL = 8;

// ── 公開 API ──

/**
 * デスクトップに表示するアイコン一覧を設定する。
 * kernel.js or wm.js の初期化後に呼ぶ。
 * 列優先 (上→下、左→右) でグリッド座標を自動割り当てする。
 * @param {{ name: string, label: string, icon: string }[]} entries
 */
export function desktopSetIcons(entries) {
  const rows = maxRows();
  const cols = maxCols();
  const occupied = new Set();
  const ck = (c, r) => c * 10000 + r;

  iconEntries = [];
  let curCol = 0;
  let curRow = 0;

  for (const e of entries) {
    // 次の空きセルを列優先 (上→下) で探す
    while (curCol < cols && occupied.has(ck(curCol, curRow))) {
      curRow++;
      if (curRow >= rows) {
        curRow = 0;
        curCol++;
      }
    }
    if (curCol >= cols) break; // グリッドが満杯

    iconEntries.push({ ...e, gridCol: curCol, gridRow: curRow });
    occupied.add(ck(curCol, curRow));
    curRow++;
    if (curRow >= rows) {
      curRow = 0;
      curCol++;
    }
  }

  selectedSet.clear();
  _dragMode = "none";
  _dragIdx = -1;
  _dragGroupOffsets.clear();
  _lassoMode = "none";
  _lassoBaseSet.clear();
}

/**
 * workArea 上端を設定する。
 * wmSetWorkAreaTop と同期して呼ぶ。
 * @param {number} y
 */
export function desktopSetWorkAreaTop(y) {
  _workAreaTop = y;
}

/**
 * デスクトップのフォーカスを外す。
 * ウィンドウがクリック等でフォーカスを得たときに wm.js から呼ぶ。
 * Ctrl+A 等のキーボードショートカットがウィンドウ側と競合しないようにする。
 */
export function desktopBlur() {
  _desktopFocused = false;
}

/**
 * デスクトップアイコンのホバー処理。
 * マウスがウィンドウ上にないフレームで毎回呼ばれ、
 * アイコン上であればツールチップを表示する。
 * @param {number} mx  マウス X
 * @param {number} my  マウス Y
 * @returns {boolean} アイコン上にいる場合 true
 */
export function desktopHandleHover(mx, my) {
  if (my < _workAreaTop) return false;
  const hitIdx = hitTestIcon(mx, my);
  if (hitIdx >= 0) {
    const entry = iconEntries[hitIdx];
    if (entry && entry.tooltip) {
      if (_wmSetTooltip) _wmSetTooltip(entry.tooltip);
    }
    return true;
  }
  return false;
}

/**
 * デスクトップアイコンの入力処理 (左ボタン押下時)。
 * wmUpdate() のウィンドウヒットテスト後に呼び、
 * アイコンをクリックした場合は true を返す (ウィンドウ操作を抑止)。
 * @param {number} mx  マウス X
 * @param {number} my  マウス Y
 * @param {function} openByName  wmOpenByName 関数参照
 * @returns {boolean} アイコンがクリックされた場合 true
 */
export function desktopHandleInput(mx, my, openByName) {
  if (!Input.mouseButtonDown(0)) return false;

  // 作業領域外 (タスクバー等) は無視
  if (my < _workAreaTop) return false;

  // ウィンドウヒットテストを通過した → デスクトップにフォーカスを戻す
  _desktopFocused = true;

  const hitIdx = hitTestIcon(mx, my);

  if (hitIdx >= 0) {
    // ── ダブルクリック: 選択済みアイコンを起動 ──
    if (selectedSet.has(hitIdx) && Input.hasInputEvent("dblclick", 0)) {
      const entry = iconEntries[hitIdx];
      if (entry) openByName(entry.name);
      selectedSet.clear();
      return true;
    }

    // ── Ctrl+Click: トグル選択 (ドラッグなし) ──
    if (Input.mouseHasCtrl()) {
      if (selectedSet.has(hitIdx)) {
        selectedSet.delete(hitIdx);
      } else {
        selectedSet.add(hitIdx);
      }
      return true;
    }

    // ── 通常クリック: ドラッグ待機 ──
    // 未選択アイコンをクリック → 選択をそのアイコンのみに切り替え
    if (!selectedSet.has(hitIdx)) {
      selectedSet.clear();
      selectedSet.add(hitIdx);
    }
    // ドラッグ待機状態に入る (現在の選択状態を保持)
    _dragMode = "pending";
    _dragIdx = hitIdx;
    const pos = cellToPixel(
      iconEntries[hitIdx].gridCol,
      iconEntries[hitIdx].gridRow,
    );
    _dragOffX = mx - pos.x;
    _dragOffY = my - pos.y;

    return true;
  }

  // デスクトップ空白クリック → ラッソ選択待機 (ドラッグ開始まで選択解除しない)
  // (ウィンドウ上の場合は handleLeftClick 側で処理されるので到達しない)
  _lassoBaseSet.clear();
  if (Input.mouseHasCtrl()) {
    // Ctrl+ラッソ: 既存選択をスナップショットに保存 (追加合成用)
    for (const idx of selectedSet) _lassoBaseSet.add(idx);
  } else {
    selectedSet.clear();
  }
  _lassoMode = "pending";
  _lassoX0 = mx;
  _lassoY0 = my;
  _lassoX1 = mx;
  _lassoY1 = my;
  return false;
}

/**
 * デスクトップのフレーム更新。wmUpdate() から毎フレーム呼ぶ。
 * ドラッグの継続処理・Ctrl+A ショートカットを処理する。
 * @param {number} mx  マウス X
 * @param {number} my  マウス Y
 */
export function desktopUpdate(mx, my) {
  // ── マーチングアンツ アニメーションカウンタ (毎フレーム進行) ──
  _antsFrame++;

  // ── Ctrl+A: 全選択 (デスクトップにフォーカスがある場合のみ) ──
  if (_desktopFocused && Input.ctrlDown("KeyA") && iconEntries.length > 0) {
    for (let i = 0; i < iconEntries.length; i++) selectedSet.add(i);
  }

  // ── ラッソ選択処理 ──
  if (_lassoMode !== "none") {
    // pending → selecting 遷移 (デッドゾーンを超えたら)
    if (_lassoMode === "pending" && Input.isDragging(0)) {
      _lassoMode = "selecting";
    }

    if (_lassoMode === "selecting") {
      _lassoX1 = mx;
      _lassoY1 = my;
      // 矩形内のアイコンをリアルタイム選択
      updateLassoSelection();
    }

    // マウスリリース → ラッソ確定
    if (Input.mouseButtonUp(0)) {
      if (_lassoMode === "selecting") {
        _lassoX1 = mx;
        _lassoY1 = my;
        updateLassoSelection();
      }
      _lassoMode = "none";
      return;
    }

    // ボタンが既に離れている (異常状態リセット)
    if (!Input.mouseButtonHeld(0)) {
      _lassoMode = "none";
    }

    return; // ラッソ中はドラッグ処理をスキップ
  }

  // ── ドラッグ処理 ──
  if (_dragMode === "none") return;

  // pending → dragging 遷移 (input.js の DRAG_DEAD_ZONE を超えたら)
  if (_dragMode === "pending" && Input.isDragging(0)) {
    _dragMode = "dragging";
    initDragGroup();
  }

  // マウスリリース
  if (Input.mouseButtonUp(0)) {
    if (_dragMode === "dragging") {
      // ドロップ: グリッドスナップ
      dropIcons(mx, my);
    } else if (_dragMode === "pending") {
      // クリック (ドラッグなし): このアイコンのみ選択
      selectedSet.clear();
      selectedSet.add(_dragIdx);
    }
    _dragMode = "none";
    _dragIdx = -1;
    _dragGroupOffsets.clear();
    return;
  }

  // ボタンが既に離れている (異常状態リセット)
  if (!Input.mouseButtonHeld(0)) {
    _dragMode = "none";
    _dragIdx = -1;
    _dragGroupOffsets.clear();
  }
}

/**
 * デスクトップがドラッグ操作中かどうかを返す。
 * wm.js がウィンドウ操作と競合させないために使用する。
 * アイコンドラッグ中またはラッソ選択中に true を返す。
 * @returns {boolean}
 */
export function desktopIsDragging() {
  return _dragMode !== "none" || _lassoMode !== "none";
}

/**
 * デスクトップアイコンを描画する。
 * wmDraw() のウィンドウ描画前に呼ぶ。
 */
export function desktopDraw() {
  const mx = Input.mouseX();
  const my = Input.mouseY();

  // ── アイコン描画 (全アイコンを通常位置に描画) ──
  for (let i = 0; i < iconEntries.length; i++) {
    const entry = iconEntries[i];
    const pos = cellToPixel(entry.gridCol, entry.gridRow);
    drawDesktopIcon(entry, pos.x, pos.y, selectedSet.has(i));
  }

  // ── ドラッグ中: ドロップ先プレビュー枠を描画 ──
  if (_dragMode === "dragging" && _dragIdx >= 0) {
    const ghostX = mx - _dragOffX;
    const ghostY = my - _dragOffY;
    const raw = pixelToCell(ghostX + (CELL_W >> 1), ghostY + (CELL_H >> 1));
    const anchor = clampAnchor(raw.col, raw.row);

    for (const [, off] of _dragGroupOffsets) {
      const snapPos = cellToPixel(anchor.col + off.dCol, anchor.row + off.dRow);
      GPU.drawRect(snapPos.x, snapPos.y, CELL_W, CELL_H, 1);
    }
  }

  // ── ラッソ選択中: マーチングアンツ描画 ──
  if (_lassoMode === "selecting") {
    drawMarchingAnts(_lassoX0, _lassoY0, _lassoX1, _lassoY1);
  }
}

// ── グリッドレイアウト ──

/**
 * 正規化された矩形 (左上 + 幅高さ) を返す。
 * 2 点の座標から、左上が小さい方になるように正規化する。
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
function normalizeRect(x0, y0, x1, y1) {
  const lx = Math.min(x0, x1);
  const ly = Math.min(y0, y1);
  return {
    x: lx,
    y: ly,
    w: Math.abs(x1 - x0) + 1,
    h: Math.abs(y1 - y0) + 1,
  };
}

// ── ラッソ選択 ──

/**
 * ラッソ矩形内のアイコンを selectedSet に反映する。
 * アイコンセルの中心がラッソ矩形内にあるかで判定する。
 * Ctrl+ラッソ: _lassoBaseSet (開始前の選択) に矩形内アイコンをマージする。
 */
function updateLassoSelection() {
  const r = normalizeRect(_lassoX0, _lassoY0, _lassoX1, _lassoY1);
  selectedSet.clear();
  // Ctrl+ラッソ: 事前選択を復元
  for (const idx of _lassoBaseSet) selectedSet.add(idx);
  // 矩形内のアイコンを追加
  for (let i = 0; i < iconEntries.length; i++) {
    const entry = iconEntries[i];
    const pos = cellToPixel(entry.gridCol, entry.gridRow);
    // セル中心で判定
    const cx = pos.x + (CELL_W >> 1);
    const cy = pos.y + (CELL_H >> 1);
    if (cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h) {
      selectedSet.add(i);
    }
  }
}

/**
 * マーチングアンツ (行進する蟻) 風の選択矩形を描画する。
 * 偶数/奇数フレームでドット位相を反転させ、アニメーション効果を出す。
 * paint.js の実装パターンを踏襲する。
 * @param {number} x0  始点 X
 * @param {number} y0  始点 Y
 * @param {number} x1  終点 X
 * @param {number} y1  終点 Y
 */
function drawMarchingAnts(x0, y0, x1, y1) {
  const r = normalizeRect(x0, y0, x1, y1);
  const phase = ((_antsFrame / ANTS_INTERVAL) | 0) & 1;
  const ax = r.x;
  const ay = r.y;

  // 上辺・下辺
  for (let i = 0; i < r.w; i++) {
    if (((i + phase) & 1) === 0) {
      GPU.pset(ax + i, ay, GPU.pget(ax + i, ay) ^ 1);
      GPU.pset(ax + i, ay + r.h - 1, GPU.pget(ax + i, ay + r.h - 1) ^ 1);
    }
  }
  // 左辺・右辺 (角は上辺・下辺で処理済み)
  for (let j = 1; j < r.h - 1; j++) {
    if (((j + phase) & 1) === 0) {
      GPU.pset(ax, ay + j, GPU.pget(ax, ay + j) ^ 1);
      GPU.pset(ax + r.w - 1, ay + j, GPU.pget(ax + r.w - 1, ay + j) ^ 1);
    }
  }
}

/**
 * グリッド配置可能な行数を返す。
 * @returns {number}
 */
function maxRows() {
  const availH = VRAM_HEIGHT - _workAreaTop - GRID_MARGIN_Y * 2;
  return Math.max(1, (availH / CELL_H) | 0);
}

/**
 * グリッド配置可能な列数を返す。
 * @returns {number}
 */
function maxCols() {
  const availW = VRAM_WIDTH - GRID_MARGIN_X * 2;
  return Math.max(1, (availW / CELL_W) | 0);
}

/** 列番号をクランプする */
function clampCol(col) {
  return Math.max(0, Math.min(col, maxCols() - 1));
}

/** 行番号をクランプする */
function clampRow(row) {
  return Math.max(0, Math.min(row, maxRows() - 1));
}

/**
 * グリッド座標 (col, row) からセル左上ピクセル座標を返す。
 * @param {number} col
 * @param {number} row
 * @returns {{ x: number, y: number }}
 */
function cellToPixel(col, row) {
  return {
    x: GRID_MARGIN_X + col * CELL_W,
    y: _workAreaTop + GRID_MARGIN_Y + row * CELL_H,
  };
}

/**
 * ピクセル座標からグリッド座標 (col, row) を返す (クランプなし)。
 * @param {number} px
 * @param {number} py
 * @returns {{ col: number, row: number }}
 */
function pixelToCell(px, py) {
  return {
    col: ((px - GRID_MARGIN_X) / CELL_W) | 0,
    row: ((py - _workAreaTop - GRID_MARGIN_Y) / CELL_H) | 0,
  };
}

/**
 * アンカー座標をクランプする。
 * ドラッググループ全体がグリッド内に収まるように制約する。
 * @param {number} rawCol  クランプ前アンカー列
 * @param {number} rawRow  クランプ前アンカー行
 * @returns {{ col: number, row: number }}
 */
function clampAnchor(rawCol, rawRow) {
  let minDC = 0;
  let maxDC = 0;
  let minDR = 0;
  let maxDR = 0;
  for (const [, off] of _dragGroupOffsets) {
    if (off.dCol < minDC) minDC = off.dCol;
    if (off.dCol > maxDC) maxDC = off.dCol;
    if (off.dRow < minDR) minDR = off.dRow;
    if (off.dRow > maxDR) maxDR = off.dRow;
  }
  return {
    col: Math.max(-minDC, Math.min(maxCols() - 1 - maxDC, clampCol(rawCol))),
    row: Math.max(-minDR, Math.min(maxRows() - 1 - maxDR, clampRow(rawRow))),
  };
}

/**
 * マウス座標がどのアイコンのセルに当たるかを返す。
 * @param {number} mx
 * @param {number} my
 * @returns {number} アイコンインデックス (-1 = ヒットなし)
 */
function hitTestIcon(mx, my) {
  for (let i = 0; i < iconEntries.length; i++) {
    const entry = iconEntries[i];
    const pos = cellToPixel(entry.gridCol, entry.gridRow);
    if (mx >= pos.x && mx < pos.x + CELL_W && my >= pos.y && my < pos.y + CELL_H) {
      return i;
    }
  }
  return -1;
}

/**
 * マウス座標上のアイコンのアプリ名を返す (アイコン別コンテキストメニュー用)。
 * wm.js が右クリック時に呼び、ヒットしたアプリの iconMenu を開くのに使う。
 * @param {number} mx
 * @param {number} my
 * @returns {string|null} アプリ名 (ヒットなしは null)
 */
export function hitTestIconName(mx, my) {
  const idx = hitTestIcon(mx, my);
  return idx >= 0 ? iconEntries[idx].name : null;
}

// ── ドラッグ＆ドロップ ──

/**
 * ドラッグ開始時に選択中アイコンのグループオフセットを初期化する。
 */
function initDragGroup() {
  _dragGroupOffsets.clear();
  const anchor = iconEntries[_dragIdx];
  for (const idx of selectedSet) {
    const e = iconEntries[idx];
    _dragGroupOffsets.set(idx, {
      dCol: e.gridCol - anchor.gridCol,
      dRow: e.gridRow - anchor.gridRow,
    });
  }
}

/**
 * ドラッグ中の選択アイコン群をグリッドにドロップする。
 * 衝突時は交換で解決する (非選択アイコンを空いたソースセルへ移動)。
 * @param {number} mx  マウス X
 * @param {number} my  マウス Y
 */
function dropIcons(mx, my) {
  const anchor = iconEntries[_dragIdx];
  if (!anchor) return;

  // アンカーの目標セル
  const ghostX = mx - _dragOffX;
  const ghostY = my - _dragOffY;
  const raw = pixelToCell(ghostX + (CELL_W >> 1), ghostY + (CELL_H >> 1));
  const clamped = clampAnchor(raw.col, raw.row);

  // 移動なし
  if (clamped.col === anchor.gridCol && clamped.row === anchor.gridRow) return;

  // 各アイコンの目標座標を計算
  /** @type {Map<number, {col: number, row: number}>} */
  const targets = new Map();
  for (const [idx, off] of _dragGroupOffsets) {
    targets.set(idx, {
      col: clamped.col + off.dCol,
      row: clamped.row + off.dRow,
    });
  }

  // 空きセル (ドラッグ元セルのうち、目標セットに含まれないもの)
  const cellKey = (c, r) => c * 10000 + r;
  const targetCellSet = new Set();
  for (const [, t] of targets) {
    targetCellSet.add(cellKey(t.col, t.row));
  }

  const freeSources = [];
  for (const idx of selectedSet) {
    const e = iconEntries[idx];
    if (!targetCellSet.has(cellKey(e.gridCol, e.gridRow))) {
      freeSources.push({ col: e.gridCol, row: e.gridRow });
    }
  }

  // 目標セルに居る非選択アイコンを空きセルへ退避
  const draggedSet = new Set(selectedSet);
  const displaced = new Set();
  for (const [, t] of targets) {
    for (let i = 0; i < iconEntries.length; i++) {
      if (draggedSet.has(i) || displaced.has(i)) continue;
      const e = iconEntries[i];
      // 同一セルに居る非選択アイコンを退避
      if (e.gridCol === t.col && e.gridRow === t.row) {
        if (freeSources.length > 0) {
          const dest = freeSources.pop();
          e.gridCol = dest.col;
          e.gridRow = dest.row;
          displaced.add(i);
        }
      }
    }
  }

  // ドラッグアイコンを目標へ移動
  for (const [idx, t] of targets) {
    iconEntries[idx].gridCol = t.col;
    iconEntries[idx].gridRow = t.row;
  }
}

// ── 描画 ──

/**
 * 1 つのデスクトップアイコン (スプライト + ラベル) を描画する。
 * 3-level エンコーディングにより bg→fg の 2 パスで描画されるため、
 * fillRect による背景クリアは不要。
 * @param {{ name: string, label: string, icon: string }} entry
 * @param {number} cx  セル左上 X
 * @param {number} cy  セル左上 Y
 * @param {boolean} selected  選択状態
 */
function drawDesktopIcon(entry, cx, cy, selected) {
  // ── アイコン描画 (3-level スプライト、未登録名は default にフォールバック) ──
  const iconX = cx + ((CELL_W - APP_ICON_W) >> 1);
  const iconY = cy + ICON_PAD_TOP;
  // 選択時はアイコン自身を反転描画する (外周に箱を作らない)
  drawAppIcon(entry.icon, iconX, iconY, selected);

  // ── ラベル描画 (単一行・アイコン下部中央寄せ) ──
  const line = truncateLabel(entry.label);
  const ly = cy + ICON_PAD_TOP + APP_ICON_H + ICON_LABEL_GAP;
  const labelW = line.length * FONT_STEP - 1;
  const labelX = cx + ((CELL_W - labelW) >> 1);
  GPU.fillRoundRect(labelX - 2, ly - 2, labelW + 4, GLYPH_H + 4, 1, 0);
  drawText(labelX, ly, line, 1);
  if (selected) {
    // ラベル背景チップと同じ角丸形状で反転 (四隅が浮かないよう形を揃える)
    GPU.invertRoundRect(labelX - 2, ly - 2, labelW + 4, GLYPH_H + 4, 1);
  }
}

/**
 * ラベル文字列を単一行に切り詰める (MAX_LABEL_CHARS を超えたら切り捨て)。
 * @param {string} label
 * @returns {string}
 */
function truncateLabel(label) {
  return label.length > MAX_LABEL_CHARS
    ? label.slice(0, MAX_LABEL_CHARS)
    : label;
}

// ── テスト用内部アクセス ──

/**
 * テスト専用: 内部状態への参照を公開する。
 * プロダクションコードでは使用しないこと。
 * @type {{ selectedSet: Set<number>, CELL_W: number, CELL_H: number, GRID_MARGIN_X: number, GRID_MARGIN_Y: number }}
 */
export const _testing = {
  get selectedSet() {
    return selectedSet;
  },
  get lassoBaseSet() {
    return _lassoBaseSet;
  },
  get dragMode() {
    return _dragMode;
  },
  get lassoMode() {
    return _lassoMode;
  },
  get iconEntries() {
    return iconEntries;
  },
  CELL_W,
  CELL_H,
  GRID_MARGIN_X,
  GRID_MARGIN_Y,
  get LABEL_LINE_H() {
    return LABEL_LINE_H;
  },
};

