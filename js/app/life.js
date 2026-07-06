/**
 * @module app/life
 * life.js — Conway's Game of Life ウィンドウ
 *
 * 可変サイズのグリッド上で Conway's Game of Life を実行する。
 *
 * 構成:
 *   - ツールバー: 再生/一時停止, ランダマイズ, クリア, グリッドサイズ, セルサイズ
 *   - グリッド: セルの描画・クリック/ドラッグ編集
 *   - ステータスバー: 世代数, 生存セル数, グリッドサイズ
 */

import { fillRect, fillRoundRect, hline, vline } from "../core/gpu.js";
import { drawText, GLYPH_W, GLYPH_H, textWidth } from "../core/font.js";
import { ICON_W, ICON_H } from "../core/icon.js";
import { wmOpen, wmRegister } from "../wm/index.js";
import * as UI from "../ui/index.js";

const APP_NAME = "LIFE";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** セル1つの描画サイズ (px) */
let cellPx = 8;
const CELL_PX_MIN = 4;
const CELL_PX_MAX = 32;
const CELL_PX_DEFAULT = 8;

/** グリッド列数 (可変) */
let cols = 32;

/** グリッド行数 (可変) */
let rows = 24;

/** グリッド列数の最小/最大/初期値 */
const COLS_MIN = 8;
const COLS_MAX = 128;
const COLS_DEFAULT = 32;

/** グリッド行数の最小/最大/初期値 */
const ROWS_MIN = 8;
const ROWS_MAX = 96;
const ROWS_DEFAULT = 24;

/** ツールバーとグリッドの間隔 (px) */
const TOOLBAR_GAP = 4;

/** 現在のグリッド描画幅 */
function gridW() {
  return cols * cellPx;
}

/** 現在のグリッド描画高さ */
function gridH() {
  return rows * cellPx;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** セル配列 (0=dead, 1=alive) */
let grid = new Uint8Array(cols * rows);

/** シミュレーション実行中か */
let running = false;

/** 世代カウンタ */
let generation = 0;

/** 生存セル数キャッシュ (世代変更時に更新) */
let cachedPopulation = 0;

/** フレームカウンタ (速度制御用) */
let frameTick = 0;

/** 何フレームごとに1ステップ進めるか */
const STEP_INTERVAL = 6;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ライフゲーム ロジック
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * グリッドをリサイズする。既存セルはコピー保持する。
 */
function resizeGrid(newCols, newRows) {
  const prev = grid;
  const prevCols = cols;
  const prevRows = rows;
  cols = newCols;
  rows = newRows;
  grid = new Uint8Array(cols * rows);
  const copyC = Math.min(prevCols, cols);
  const copyR = Math.min(prevRows, rows);
  for (let r = 0; r < copyR; r++) {
    for (let c = 0; c < copyC; c++) {
      grid[r * cols + c] = prev[r * prevCols + c];
    }
  }
}

/** ダブルバッファ用の裏バッファ */
let gridBack = new Uint8Array(cols * rows);

/** 1世代進める (トーラス境界, ダブルバッファリング) */
function step() {
  // 裏バッファのサイズが合わなければ再確保
  const len = cols * rows;
  if (gridBack.length !== len) gridBack = new Uint8Array(len);
  const next = gridBack;
  next.fill(0);
  let pop = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let neighbors = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = (r + dr + rows) % rows;
          const nc = (c + dc + cols) % cols;
          neighbors += grid[nr * cols + nc];
        }
      }
      const alive = grid[r * cols + c];
      // B3/S23: 誕生=3, 生存=2or3
      let live = 0;
      if (alive) {
        live = neighbors === 2 || neighbors === 3 ? 1 : 0;
      } else {
        live = neighbors === 3 ? 1 : 0;
      }
      next[r * cols + c] = live;
      pop += live;
    }
  }
  // バッファ交換 (確保なし)
  gridBack = grid;
  grid = next;
  cachedPopulation = pop;
}

/** 生存セル数 (キャッシュ済み) を返す */
function population() {
  return cachedPopulation;
}

/** 全セルを走査して population キャッシュを更新する */
function updatePopulationCache() {
  let count = 0;
  for (let i = 0; i < grid.length; i++) count += grid[i];
  cachedPopulation = count;
}

/** ランダマイズ: 約 25% の確率でセルを生存にする */
function randomize() {
  for (let i = 0; i < grid.length; i++) {
    grid[i] = Math.random() < 0.25 ? 1 : 0;
  }
  generation = 0;
  updatePopulationCache();
}

/** グリッドを全消去 */
function clearGrid() {
  grid.fill(0);
  generation = 0;
  cachedPopulation = 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ツールバー ウィジェット (遅延初期化)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const BUTTON_PADDING = 8;
const BUTTON_BORDER = 4;

let toggleRun;
let btnRandomize;
let btnClear;
let labelWidth;
let numberBoxCols;
let labelHeight;
let numberBoxRows;
let labelCell;
let numberBoxCellPx;
let toolbar;
let tbLayout;
let _ready = false;

function _initWidgets() {
  if (_ready) return;
  _ready = true;

  toggleRun = new UI.ToggleButton(0, 0, "", (v) => {
    running = v;
    toggleRun.icon = v ? "pause" : "play";
  });
  toggleRun.icon = "play";
  toggleRun.w = ICON_W + BUTTON_PADDING + BUTTON_BORDER;
  toggleRun.h = ICON_H + BUTTON_PADDING + BUTTON_BORDER;
  toggleRun.tooltip = "Play / Pause";

  btnRandomize = new UI.PushButton(0, 0, "", () => randomize());
  btnRandomize.icon = "dice";
  btnRandomize.w = ICON_W + BUTTON_PADDING + BUTTON_BORDER;
  btnRandomize.h = ICON_H + BUTTON_PADDING + BUTTON_BORDER;
  btnRandomize.tooltip = "Randomize";

  btnClear = new UI.PushButton(0, 0, "", () => {
    clearGrid();
    running = false;
    toggleRun.value = false;
    toggleRun.icon = "play";
  });
  btnClear.icon = "trash";
  btnClear.w = ICON_W + BUTTON_PADDING + BUTTON_BORDER;
  btnClear.h = ICON_H + BUTTON_PADDING + BUTTON_BORDER;
  btnClear.tooltip = "Clear";

  labelWidth = new UI.Label(0, 0, "W:");
  numberBoxCols = new UI.NumberBox(0, 0, COLS_MIN, COLS_MAX, cols, 1, (v) =>
    resizeGrid(v, rows),
  );
  labelHeight = new UI.Label(0, 0, "H:");
  numberBoxRows = new UI.NumberBox(0, 0, ROWS_MIN, ROWS_MAX, rows, 1, (v) =>
    resizeGrid(cols, v),
  );
  labelCell = new UI.Label(0, 0, "Cell:");
  numberBoxCellPx = new UI.NumberBox(
    0,
    0,
    CELL_PX_MIN,
    CELL_PX_MAX,
    cellPx,
    1,
    (v) => {
      cellPx = v;
    },
  );

  toolbar = new UI.WidgetGroup([
    toggleRun,
    btnRandomize,
    btnClear,
    labelWidth,
    numberBoxCols,
    labelHeight,
    numberBoxRows,
    labelCell,
    numberBoxCellPx,
  ]);
  tbLayout = UI.HBox([
    toggleRun,
    btnRandomize,
    btnClear,
    labelWidth,
    numberBoxCols,
    labelHeight,
    numberBoxRows,
    labelCell,
    numberBoxCellPx,
  ]);
  tbLayout.layout(UI.FOCUS_MARGIN, UI.FOCUS_MARGIN);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * シミュレーション更新。描画と同タイミングで毎フレーム呼ばれる。
 */
function updateLife() {
  if (running) {
    frameTick++;
    if (frameTick >= STEP_INTERVAL) {
      frameTick = 0;
      step();
      generation++;
    }
  }
}

/**
 * コンテンツ描画コールバック。
 * @param {{ x:number, y:number, w:number, h:number }} cr  コンテンツ矩形
 */
function onDraw(contentRect) {
  const ox = contentRect.x;
  const oy = contentRect.y;

  // ── シミュレーション更新 ──
  updateLife();

  // ── ツールバー描画 ──
  toolbar.draw(contentRect);

  // ── グリッド開始 Y (ツールバーの下) ──
  const tbH = tbLayout.measure().h;
  const gridY = oy + tbH + TOOLBAR_GAP;
  const gw = gridW();
  const gh = gridH();

  // ── グリッド背景 (色 0 = 背景色) ──
  fillRect(ox, gridY, gw, gh, 0);

  // ── 生存セルの描画 ──
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r * cols + c]) {
        fillRect(
          ox + c * cellPx + 2,
          gridY + r * cellPx + 2,
          cellPx - 3,
          cellPx - 3,
          1,
        );
      }
    }
  }

  // ── グリッド線 ──
  for (let c = 0; c <= cols; c++) {
    vline(ox + c * cellPx, gridY, gridY + gh - 1, 1);
  }
  for (let r = 0; r <= rows; r++) {
    hline(ox, ox + gw, gridY + r * cellPx, 1);
  }
}

// ── footer 描画 ──
function onDrawFooter(footerRect) {
  const gen = `GEN:${generation}`;
  const pop = `POP:${population()}`;
  const dim = `${cols}x${rows}`;

  // 左寄せ: GEN と POP
  drawText(footerRect.x, footerRect.y, gen, 1);
  const genW = gen.length * (GLYPH_W + 1);
  drawText(footerRect.x + genW + 6, footerRect.y, pop, 1);

  // 右寄せ: WxH
  const dimW = textWidth(dim);
  drawText(footerRect.x + footerRect.w - dimW, footerRect.y, dim, 1);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ドラッグ描画中のペイント値 (0=消去, 1=生成, -1=非ドラッグ) */
let paintValue = -1;

/**
 * ローカル座標からグリッドのセル (col, row) を返す。
 * グリッド外なら null。
 */
function localToCell(lx, ly) {
  const tbH = tbLayout.measure().h;
  const gx = lx;
  const gy = ly - (tbH + TOOLBAR_GAP);
  if (gx < 0 || gy < 0 || gx >= gridW() || gy >= gridH()) return null;
  const c = (gx / cellPx) | 0;
  const r = (gy / cellPx) | 0;
  if (c < 0 || c >= cols || r < 0 || r >= rows) return null;
  return { c, r };
}

/**
 * 入力コールバック。
 * @param {{ localX:number, localY:number, type:string }} ev
 */
function onInput(ev) {
  toolbar.update(ev);

  // セルクリック / ドラッグトグル
  if (ev.type === "down") {
    const cell = localToCell(ev.localX, ev.localY);
    if (cell) {
      const idx = cell.r * cols + cell.c;
      grid[idx] = grid[idx] ? 0 : 1; // トグル
      paintValue = grid[idx]; // ドラッグ方向を記憶
      updatePopulationCache();
    }
  } else if (ev.type === "held" && paintValue >= 0) {
    const cell = localToCell(ev.localX, ev.localY);
    if (cell) {
      const idx = cell.r * cols + cell.c;
      if (grid[idx] !== paintValue) {
        grid[idx] = paintValue;
        updatePopulationCache();
      }
    }
  } else if (ev.type === "up") {
    paintValue = -1;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  サイズ測定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onMeasure() {
  const tbSize = tbLayout.measure();
  const w = Math.max(tbSize.w, gridW() + 1);
  const h = tbSize.h + TOOLBAR_GAP + gridH() + 1;
  return { w, h };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * onBeforeClose コールバック。
 * 全状態を初期値にリセットし、true を返して閉じを許可する。
 */
function onBeforeClose() {
  // シミュレーション停止
  running = false;
  toggleRun.value = false;
  toggleRun.icon = "play";
  frameTick = 0;

  // グリッドサイズ・セルサイズを初期値に復元
  cols = COLS_DEFAULT;
  rows = ROWS_DEFAULT;
  cellPx = CELL_PX_DEFAULT;

  // グリッド・世代をクリア
  grid = new Uint8Array(cols * rows);
  gridBack = new Uint8Array(cols * rows);
  generation = 0;
  cachedPopulation = 0;
  paintValue = -1;

  // NumberBox の値を初期値に同期
  numberBoxCols.value = COLS_DEFAULT;
  numberBoxRows.value = ROWS_DEFAULT;
  numberBoxCellPx.value = CELL_PX_DEFAULT;

  // ツールバー再レイアウト
  tbLayout.layout(UI.FOCUS_MARGIN, UI.FOCUS_MARGIN);

  return true;
}

wmRegister(
  APP_NAME,
  () => {
    _initWidgets();
    return wmOpen(-1, -1, 0, 0, APP_NAME, onDraw, onInput, onMeasure, {
      about:
        "Conway's Game of Life. Click cells to toggle them alive, then run " +
        "the simulation to watch the patterns evolve.",
      footer: true,
      onDrawFooter,
      onBeforeClose,
      onRelayout: () => {
        toolbar.remeasureAll();
        tbLayout.layout(UI.FOCUS_MARGIN, UI.FOCUS_MARGIN);
      },
    });
  },
  { category: "GAMES" },
);

