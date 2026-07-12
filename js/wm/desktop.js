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
 *   各アイコンは「アイコンプレート + ラベルプレート」を縦に積んだ構成。
 *   プレートは背景色の下地で、壁紙が模様でも中身が読めるよう分離する。
 *   選択時のみ周囲を角丸ボックス (枠線 + 市松ディザ) で囲い、
 *   アイコン/ラベル自体は反転せず囲みだけで選択を示す。
 *   アイコン本体は app_icon.js の drawAppIcon (18×18, 3-level) で描画し、
 *   専用スプライトが無いアプリは "default" にフォールバックする。
 *
 * ── 入力 ──
 *   シングルクリック: アイコン選択 (Ctrl+Click でトグル追加)
 *   ダブルクリック: アプリ起動 (wmOpenByName)
 *   ドラッグ: 選択中アイコンを一括移動 (グリッドスナップ、衝突時交換)
 *   Ctrl+A: 全アイコン選択 (デスクトップにフォーカスがある場合のみ)
 *   デスクトップ空白クリック: 選択解除
 *   ラッソ選択: デスクトップ空白をドラッグすると破線の選択矩形 (gpu.drawDashedRect)
 *     が表示され、矩形内のアイコンが選択される。ROLL のラバー選択と見た目を共通化。
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

// ── レイアウト定数 ──
//
// 1 アイコンは「アイコンプレート」と「ラベルプレート」を縦に積んだ構成。
// 各プレートは前景色 1px の枠 (仕様の余白B `+`) で縁取り、内側はアイコン/文字を
// 背景色の下地に載せる。壁紙が模様でも、枠と下地の二重で中身が読めるよう分離する。
// 選択時のみ、その周囲を角丸ボックス (枠線 + 市松ディザ) で囲う。
// 各寸法は仕様 ASCII に 1:1 対応する (コメントの px は 5x5 システムフォント時)。
//
// 余白は 2 種: 余白A (`_` = 背景色。ハロー/枠内側/パディング) と
// 余白B (`+` = 前景色。アイコン/ラベルの縁取り = CONTENT_BORDER)。
//
//   ┌─────────────────┐ 外周余白1 + 角丸枠1 + 内側余白1 + ディザ帯2
//   │ ┌────┐            │ ← アイコンプレート (18 + 余白1×2 = 20×20)
//   │ │icon│  ▓ディザ▓  │
//   │ └────┘            │   間隔2
//   │ ┌──────────────┐ │ ← ラベルプレート (文字幅 + 余白)
//   │ │ App Name      │ │
//   │ └──────────────┘ │
//   └─────────────────┘

/**
 * アイコン/ラベルプレート外周の前景色枠 (仕様の余白B `+`)。
 * 視認性のため外周 1px を前景色で縁取り、壁紙・ディザから中身を分離する。
 * プレート寸法はこの枠を含む (プレート = 中身 + 枠×2)。
 */
const CONTENT_BORDER = 1;

/** アイコンプレート寸法 (前景枠 + アイコン。枠内はアイコン下地の背景色) */
const ICON_PLATE_W = APP_ICON_W + CONTENT_BORDER * 2;
const ICON_PLATE_H = APP_ICON_H + CONTENT_BORDER * 2;

/** アイコンプレートとラベルプレートの縦間隔 (選択時はここもディザ) */
const ICON_LABEL_GAP = 2;

/** ラベル文字の左右パディング (前景枠の内側・背景色) */
const LABEL_PAD_X = 2;

/** ラベル文字の上下パディング (前景枠の内側・背景色) */
const LABEL_PAD_Y = 1;

/** 文字左端までの幅 = 前景枠 + 背景パディング */
const LABEL_INSET_X = CONTENT_BORDER + LABEL_PAD_X;

/** 文字上端までの高 = 前景枠 + 背景パディング */
const LABEL_INSET_Y = CONTENT_BORDER + LABEL_PAD_Y;

/** 選択ボックス: 角丸半径 */
const BOX_RADIUS = 1;

/** 選択ボックス: 枠線内側の背景余白 */
const BOX_INNER_MARGIN = 1;

/** 選択ボックス: コンテンツ周囲のディザ帯幅 */
const DITHER_BAND = 2;

/** 選択ボックス: 枠線外周の背景余白 (角丸四隅の透過用) */
const BOX_OUTER_MARGIN = 1;

/**
 * セル内ウィジェット原点からコンテンツ左上までのインセット。
 * = 外周余白 + 枠線(1) + 内側余白 + ディザ帯。
 * 選択・非選択でアイコン位置が動かないよう、常にこの位置に描く。
 */
const CONTENT_INSET = BOX_OUTER_MARGIN + 1 + BOX_INNER_MARGIN + DITHER_BAND;

/** 額縁の合計幅 (各軸両端分)。ウィジェット寸 = コンテンツ寸 + FRAME_TOTAL */
const FRAME_TOTAL = CONTENT_INSET * 2;

/** グリッドセルとウィジェットの隙間 (各辺) */
const GRID_PAD = 1;

/**
 * グリッドの左右マージン (セル外周)。
 *
 * 選択ボックスは各セル内で GRID_PAD(1) + BOX_OUTER_MARGIN(1) だけ内側に描かれるため、
 * 画面端から選択ボックスまでの実効余白は GRID_MARGIN_X + 2 になる。
 * 3 にすると 360px 幅で 6 列 (CELL_W=59, boxW=55) がちょうど収まり、
 * 選択ボックス基準の左右余白 5px・ボックス間の間隔 4px が対称になる:
 *   5 + 55(box) × 6 + 4(gap) × 5 + 5 = 360
 * (maxCols は VRAM_WIDTH − GRID_MARGIN_X×2 を CELL_W で割って算出する)
 */
const GRID_MARGIN_X = 3;

/** グリッドの上マージン (workAreaTop からの相対) */
const GRID_MARGIN_Y = 4;

/** ラベルの最大文字数 (それ以上は切り捨て) */
const MAX_LABEL_CHARS = 7;

// ── フォント依存メトリクス (recomputeMetrics で確定) ──

/** フォントステップ (文字幅 + 字間 1px) */
let FONT_STEP = GLYPH_W + 1;

/** ラベルプレート高さ (文字高 + 上下 inset) */
let LABEL_BG_H = GLYPH_H + LABEL_INSET_Y * 2;

/** コンテンツ縦寸 (アイコンプレート + 間隔 + ラベルプレート)。ラベル長に依らず一定 */
let CONTENT_H = ICON_PLATE_H + ICON_LABEL_GAP + LABEL_BG_H;

/** ウィジェット高さ (コンテンツ + 額縁)。一定 */
let WIDGET_H = CONTENT_H + FRAME_TOTAL;

/**
 * コンテンツ横寸 (アイコン/ラベルプレートを内包する領域)。ラベル長に依らず一定。
 * 最長ラベル (MAX_LABEL_CHARS) 基準で固定し、ラベルが短くてもボックス全体の
 * 寸法は変えない。短いラベルでは余った幅がそのまま市松ディザで埋まる。
 */
let CONTENT_W = 0;

/** グリッドセル寸法 (最長ラベルのウィジェット + 隙間) */
let CELL_W = 0;
let CELL_H = 0;

/**
 * フォント寸法から派生メトリクスを再計算する。
 * 初期化時と onFontChange で呼ぶ。
 */
function recomputeMetrics() {
  FONT_STEP = GLYPH_W + 1;
  LABEL_BG_H = GLYPH_H + LABEL_INSET_Y * 2;
  CONTENT_H = ICON_PLATE_H + ICON_LABEL_GAP + LABEL_BG_H;
  WIDGET_H = CONTENT_H + FRAME_TOTAL;

  const maxLabelW = MAX_LABEL_CHARS * FONT_STEP - 1;
  CONTENT_W = Math.max(ICON_PLATE_W, maxLabelW + LABEL_INSET_X * 2);
  CELL_W = CONTENT_W + FRAME_TOTAL + GRID_PAD * 2;
  CELL_H = WIDGET_H + GRID_PAD * 2;
}
recomputeMetrics();

// ── フォント変更リスナー ──
onFontChange(recomputeMetrics);

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
 * キーボード操作の「カーソル」アイコンインデックス (-1 = 未確定)。
 * 上下左右キー / 頭文字入力の移動起点。クリック選択とは keyboardCursor() で整合させる。
 */
let _focusIdx = -1;

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
  _focusIdx = -1;
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
 * ドラッグの継続処理・Ctrl+A ショートカット・キーボード操作を処理する。
 * @param {number} mx  マウス X
 * @param {number} my  マウス Y
 * @param {function} [openByName]  wmOpenByName 関数参照 (Enter によるアプリ起動用)
 */
export function desktopUpdate(mx, my, openByName) {
  // ── Ctrl+A: 全選択 (デスクトップにフォーカスがある場合のみ) ──
  if (_desktopFocused && Input.ctrlDown("KeyA") && iconEntries.length > 0) {
    for (let i = 0; i < iconEntries.length; i++) selectedSet.add(i);
  }

  // ── キーボード操作 (矢印/Enter/頭文字入力)。ドラッグ・ラッソ中は無効 ──
  if (_dragMode === "none" && _lassoMode === "none") {
    handleDesktopKeys(openByName);
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

// ── キーボード操作 ──

/**
 * デスクトップアイコンのキーボード操作を処理する。
 * デスクトップにフォーカスがあるときのみ動作する (Ctrl+A と同じフォーカス条件)。
 *   - 上下左右 : 選択アイコンを見た目の並びに沿って隣へ移動 (単一選択に切替)
 *   - Enter    : 選択中アイコンを起動
 *   - 英数字   : その頭文字を持つアイコンへ移動 (同頭文字が複数ならラウンドロビン)
 * @param {function} [openByName]  wmOpenByName 関数参照 (Enter 起動用)
 */
function handleDesktopKeys(openByName) {
  if (!_desktopFocused || iconEntries.length === 0) return;

  const cur = keyboardCursor();

  // ── Enter: 選択中アイコンを起動 ──
  if (Input.keyDown("Enter")) {
    if (cur >= 0 && openByName) openByName(iconEntries[cur].name);
    return;
  }

  // ── 上下左右: 空間的な隣のアイコンへ移動 ──
  let dir = null;
  if (Input.keyDown("ArrowLeft")) dir = "left";
  else if (Input.keyDown("ArrowRight")) dir = "right";
  else if (Input.keyDown("ArrowUp")) dir = "up";
  else if (Input.keyDown("ArrowDown")) dir = "down";
  if (dir) {
    // 未選択なら最初 (左上) のアイコンを選ぶ。選択済みなら方向に応じた隣へ。
    const next = cur < 0 ? firstIconIndex() : neighborIndex(cur, dir);
    if (next >= 0) selectSingleIcon(next);
    return;
  }

  // ── 頭文字入力: 一致するアイコンへ移動 (ラウンドロビン) ──
  const ch = firstTypedLetter();
  if (ch) {
    const next = typeaheadIndex(ch, cur);
    if (next >= 0) selectSingleIcon(next);
  }
}

/**
 * キーボード操作の起点となる「カーソル」アイコンインデックスを返す。
 * _focusIdx が有効かつ現在の選択に含まれていればそれを、
 * そうでなくとも単一選択ならそのアイコンを返す (クリック直後の選択と整合)。
 * 複数選択・未選択では -1 (未確定)。
 * @returns {number}
 */
function keyboardCursor() {
  if (
    _focusIdx >= 0 &&
    _focusIdx < iconEntries.length &&
    selectedSet.has(_focusIdx)
  ) {
    return _focusIdx;
  }
  if (selectedSet.size === 1) return selectedSet.values().next().value;
  return -1;
}

/**
 * 単一アイコンだけを選択し、キーボードカーソルをそこへ合わせる。
 * @param {number} idx  アイコンインデックス
 */
function selectSingleIcon(idx) {
  selectedSet.clear();
  selectedSet.add(idx);
  _focusIdx = idx;
}

/**
 * 左上 (グリッド列優先で最小) のアイコンインデックスを返す。
 * @returns {number} アイコンインデックス (アイコンが無ければ -1)
 */
function firstIconIndex() {
  let best = -1;
  let bestCol = Infinity;
  let bestRow = Infinity;
  for (let i = 0; i < iconEntries.length; i++) {
    const e = iconEntries[i];
    if (e.gridCol < bestCol || (e.gridCol === bestCol && e.gridRow < bestRow)) {
      bestCol = e.gridCol;
      bestRow = e.gridRow;
      best = i;
    }
  }
  return best;
}

/**
 * cur のアイコンから指定方向の隣接アイコンインデックスを返す (無ければ -1)。
 *   左右: 隣接する列のうち最も近い列で、行が最も近いアイコン (部分列でも自然に着地)。
 *   上下: 同一列で行が隣のアイコン (列の端では移動しない)。
 * すべてグリッド座標ベースなので、見た目の並びからそのまま遷移先を予測できる。
 * @param {number} cur  起点アイコンインデックス
 * @param {"left"|"right"|"up"|"down"} dir  移動方向
 * @returns {number}
 */
function neighborIndex(cur, dir) {
  const c = iconEntries[cur];
  let best = -1;
  let bestPrimary = Infinity;
  let bestSecondary = Infinity;
  let bestRow = Infinity;
  for (let i = 0; i < iconEntries.length; i++) {
    if (i === cur) continue;
    const e = iconEntries[i];
    const dCol = e.gridCol - c.gridCol;
    const dRow = e.gridRow - c.gridRow;
    let primary;
    let secondary;
    if (dir === "right") {
      if (dCol <= 0) continue;
      primary = dCol; // 列が近いほど優先
      secondary = Math.abs(dRow); // 同点なら行が近いほど優先
    } else if (dir === "left") {
      if (dCol >= 0) continue;
      primary = -dCol;
      secondary = Math.abs(dRow);
    } else if (dir === "down") {
      if (dCol !== 0 || dRow <= 0) continue;
      primary = dRow;
      secondary = 0;
    } else {
      // up
      if (dCol !== 0 || dRow >= 0) continue;
      primary = -dRow;
      secondary = 0;
    }
    if (
      primary < bestPrimary ||
      (primary === bestPrimary && secondary < bestSecondary) ||
      (primary === bestPrimary &&
        secondary === bestSecondary &&
        e.gridRow < bestRow)
    ) {
      bestPrimary = primary;
      bestSecondary = secondary;
      bestRow = e.gridRow;
      best = i;
    }
  }
  return best;
}

/**
 * そのフレームに入力された最初の英数字を大文字で返す (無ければ null)。
 * 矢印などは e.key が 1 文字でないため対象外。
 * @returns {string|null}
 */
function firstTypedLetter() {
  for (const ch of Input.getCharQueue()) {
    if (ch.length === 1 && /[a-z0-9]/i.test(ch)) return ch.toUpperCase();
  }
  return null;
}

/**
 * 頭文字 ch を持つアイコンへの移動先インデックスを返す (無ければ -1)。
 * 一致アイコンを現在のグリッド配置順 (列優先) に並べ、
 * カーソルが一致集合内なら次の要素へ、そうでなければ先頭へ遷移する (ラウンドロビン)。
 * @param {string} ch   大文字化した頭文字
 * @param {number} cur  現在のカーソルインデックス (-1 = 未確定)
 * @returns {number}
 */
function typeaheadIndex(ch, cur) {
  const matches = [];
  for (let i = 0; i < iconEntries.length; i++) {
    const label = iconEntries[i].label || "";
    if (label && label[0].toUpperCase() === ch) matches.push(i);
  }
  if (matches.length === 0) return -1;
  matches.sort((a, b) => {
    const ea = iconEntries[a];
    const eb = iconEntries[b];
    return ea.gridCol - eb.gridCol || ea.gridRow - eb.gridRow;
  });
  const pos = matches.indexOf(cur);
  return pos >= 0 ? matches[(pos + 1) % matches.length] : matches[0];
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

  // ── ラッソ選択中: 破線の選択矩形 (ROLL と共通の見た目) ──
  if (_lassoMode === "selecting") {
    GPU.drawDashedRect(_lassoX0, _lassoY0, _lassoX1, _lassoY1);
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
 * 右クリック対象アイコンを選択し、そのアプリ名を返す (共通コンテキストメニュー用)。
 * wm.js が右クリック時に呼ぶ。ヒットしたアイコンを選択状態にしてから開くことで、
 * 「右クリックしても選択されない」違和感を解消する。
 *   - 未選択のアイコン → 単一選択に切替 (左クリックと同じ規則)。
 *   - 既に複数選択の一員 → その選択集合を保持 (まとめて操作できるように)。
 * いずれもキーボードカーソルを対象へ合わせ、デスクトップにフォーカスを移す。
 * @param {number} mx
 * @param {number} my
 * @returns {string|null} アプリ名 (作業領域外・ヒットなしは null)
 */
export function desktopRightClickSelect(mx, my) {
  if (my < _workAreaTop) return null;
  _desktopFocused = true;
  const idx = hitTestIcon(mx, my);
  if (idx < 0) return null;
  if (!selectedSet.has(idx)) {
    selectedSet.clear();
    selectedSet.add(idx);
  }
  _focusIdx = idx;
  return iconEntries[idx].name;
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
 * 1 アイコン分のピクセル座標を算出する。
 * ウィジェットはセル内で水平左寄せ (アイコン列を揃える)・垂直中央に置く。
 * ボックス全幅 (CONTENT_W) はラベル長に依らず最長ラベル基準で一定。
 * ラベルプレート幅 (labelBgW) だけが文字数で縮み、余白はディザで埋まる。
 * アイコン/ラベルとも左端を揃えて配置する (contentX 基準)。
 * @param {number} cx          セル左上 X
 * @param {number} cy          セル左上 Y
 * @param {number} glyphCount  ラベルのグリフ数 (文字 + 省略マーク)
 */
function computeIconLayout(cx, cy, glyphCount) {
  const textW = glyphCount > 0 ? glyphCount * FONT_STEP - 1 : 0;
  const labelBgW = textW + LABEL_INSET_X * 2;
  const contentW = CONTENT_W;

  // ウィジェット原点 (高さ一定なので垂直中央、水平は左寄せで列を揃える)
  const wx = cx + GRID_PAD;
  const wy = cy + ((CELL_H - WIDGET_H) >> 1);

  // コンテンツ (プレート群) 左上
  const contentX = wx + CONTENT_INSET;
  const contentY = wy + CONTENT_INSET;

  // ラベルプレート上端 (アイコンプレート + 間隔の下)
  const labelBgY = contentY + ICON_PLATE_H + ICON_LABEL_GAP;

  return {
    // 選択ボックス (角丸枠) とその背景ハロー
    boxX: wx + BOX_OUTER_MARGIN,
    boxY: wy + BOX_OUTER_MARGIN,
    boxW: contentW + (CONTENT_INSET - BOX_OUTER_MARGIN) * 2,
    boxH: CONTENT_H + (CONTENT_INSET - BOX_OUTER_MARGIN) * 2,
    haloX: wx,
    haloY: wy,
    haloW: contentW + FRAME_TOTAL,
    haloH: CONTENT_H + FRAME_TOTAL,
    // アイコンプレート & アイコン本体
    iconPlateX: contentX,
    iconPlateY: contentY,
    iconX: contentX + CONTENT_BORDER,
    iconY: contentY + CONTENT_BORDER,
    // ラベルプレート & 文字
    labelBgX: contentX,
    labelBgY,
    labelBgW,
    textX: contentX + LABEL_INSET_X,
    textY: labelBgY + LABEL_INSET_Y,
  };
}

/**
 * 1 つのデスクトップアイコン (アイコンプレート + ラベルプレート) を描画する。
 * 選択時は周囲に角丸ボックス (枠線 + 市松ディザ) を追加するのみで、
 * アイコン/ラベル自体は選択状態に依らず不変。
 * @param {{ name: string, label: string, icon: string }} entry
 * @param {number} cx  セル左上 X
 * @param {number} cy  セル左上 Y
 * @param {boolean} selected  選択状態
 */
function drawDesktopIcon(entry, cx, cy, selected) {
  const { text, ellipsis } = truncateLabel(entry.label);
  // グリフ数 = 文字数 + 省略マーク (1 グリフ分)
  const glyphCount = text.length + (ellipsis ? 1 : 0);
  const L = computeIconLayout(cx, cy, glyphCount);

  if (selected) {
    // 選択ボックス: 背景ハロー → 角丸枠 → 市松ディザ地。
    // (スナッププレビュー / ウィンドウ枠と同じ 1-bit 意匠)
    GPU.fillRoundRect(L.haloX, L.haloY, L.haloW, L.haloH, BOX_RADIUS, 0);
    GPU.drawRoundRect(L.boxX, L.boxY, L.boxW, L.boxH, BOX_RADIUS, 1);
    const inset = 1 + BOX_INNER_MARGIN;
    GPU.drawCheckerboard(
      L.boxX + inset,
      L.boxY + inset,
      L.boxW - inset * 2,
      L.boxH - inset * 2,
      1,
    );
  }

  // アイコン/ラベルプレート: 背景色の下地 (アイコン透過部/文字余白を埋める) +
  // 前景色 1px の枠 (仕様の余白B `+`)。下地と枠の二重で壁紙・ディザから分離する
  // (選択・非選択で不変)。
  GPU.fillRect(L.iconPlateX, L.iconPlateY, ICON_PLATE_W, ICON_PLATE_H, 0);
  GPU.drawRect(L.iconPlateX, L.iconPlateY, ICON_PLATE_W, ICON_PLATE_H, 1);
  GPU.fillRect(L.labelBgX, L.labelBgY, L.labelBgW, LABEL_BG_H, 0);
  GPU.drawRect(L.labelBgX, L.labelBgY, L.labelBgW, LABEL_BG_H, 1);

  // 前景コンテンツ (選択状態に依らず不変)
  drawAppIcon(entry.icon, L.iconX, L.iconY, false);
  drawText(L.textX, L.textY, text, 1);
  // 省略ラベル: 文字列の直後のグリフセルに三点リーダを打つ
  if (ellipsis) {
    drawEllipsisMark(L.textX + text.length * FONT_STEP, L.textY, 1);
  }
}

/**
 * ラベル文字列を 7 文字幅に収める。
 * MAX_LABEL_CHARS 以内はそのまま。超える場合は先頭 (MAX_LABEL_CHARS - 1) 文字に
 * 切り詰め、末尾に省略マーク (三点リーダ) を付ける前提で ellipsis フラグを立てる。
 * 例: "AMETHYST" → { text: "AMETHY", ellipsis: true } → 描画は "AMETHY…"。
 * @param {string} label
 * @returns {{ text: string, ellipsis: boolean }}
 */
function truncateLabel(label) {
  if (label.length > MAX_LABEL_CHARS) {
    return { text: label.slice(0, MAX_LABEL_CHARS - 1), ellipsis: true };
  }
  return { text: label, ellipsis: false };
}

/**
 * 省略マーク (三点リーダ) を 1 グリフ分の位置に描く。
 * 専用グリフを font に持たないため、グリフ最下行に 3 点 (列 0/2/4) を打つ。
 *   .....
 *   .....
 *   .....
 *   .....
 *   #.#.#
 * @param {number} x  グリフセル左端 X (drawText のグリフ原点と同じ基準)
 * @param {number} y  グリフセル上端 Y
 * @param {number} c  色
 */
function drawEllipsisMark(x, y, c) {
  const yb = y + GLYPH_H - 1;
  GPU.pset(x, yb, c);
  GPU.pset(x + 2, yb, c);
  GPU.pset(x + 4, yb, c);
}

// ── テスト用内部アクセス ──

/**
 * テスト専用: 内部状態への参照を公開する。
 * プロダクションコードでは使用しないこと。
 * CELL_W / CELL_H はフォント依存で再計算されるため getter で公開する。
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
  get CELL_W() {
    return CELL_W;
  },
  get CELL_H() {
    return CELL_H;
  },
  GRID_MARGIN_X,
  GRID_MARGIN_Y,
  get maxRows() {
    return maxRows();
  },
  get maxCols() {
    return maxCols();
  },
  computeIconLayout,
  truncateLabel,
};

