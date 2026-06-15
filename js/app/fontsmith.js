/**
 * @module app/fontsmith
 * fontsmith.js — FONTSMITH (1-bit ビットマップフォントエディタ) のプロトタイプ
 *
 * 5x7 グリッドで任意の文字をデザインし、自作の文字を画面内で確認できる。
 * 「ユーザーが作ったフォントが OS の chrome そのものになる」という究極形
 * (本格化時の方向性) への足掛かり。
 *
 * プロトタイプ仕様:
 *   - 編集対象は A / B / C / D の 4 文字に限定 (UI のシンプルさ優先)
 *   - 5x7 セル × 1 文字 (拡大 8x) のエディタ
 *   - 上部: 文字セレクタ (4 文字をクリックして切替)
 *   - 下部: 「ABCD ABCD」のプレビュー (デザインした文字を自前描画)
 *   - クリア / 反転 ボタン
 *
 * 未実装 (本格化時の検討事項):
 *   - ASCII 95 字全てに拡張
 *   - 名前付き保存 (VFS にフォントシート PNG + manifest 書き出し)
 *   - Config.FONTS への動的追加 → Settings から選択可能に
 *   - core/font.js の switchFont() でシステム全体に反映
 *   - 既存フォントのインポート (現在のデフォルト 5x7 を初期値に)
 */

import { pset, fillRect, drawRect, hline, vline } from "../core/gpu.js";
import { drawText, GLYPH_W, GLYPH_H } from "../core/font.js";
import { wmOpen, wmRegister } from "../wm/index.js";
import * as UI from "../ui/index.js";

const APP_NAME = "FONTSMITH";

const WIN_W = 260;
const WIN_H = 220;

const GLYPH_GRID_W = 5;
const GLYPH_GRID_H = 7;
const EDITOR_CELL_PX = 12; // 拡大率
const EDITOR_W = GLYPH_GRID_W * EDITOR_CELL_PX;
const EDITOR_H = GLYPH_GRID_H * EDITOR_CELL_PX;

const EDITABLE_LETTERS = ["A", "B", "C", "D"];
// セルサイズは「(SELECTOR_CELL_PX - GLYPH_W) が偶数」になるよう選ぶ。
// GLYPH_W = 5 のとき、SELECTOR_CELL_PX = 15 なら (15-5)/2 = 5 で
// 上下左右とも余白 4px で 1px 対称になる (PRODUCT_BRIEF §5.3)。
// CELL_PX = 16 だと (16-5)/2 = 5.5 となり整数 padding 不可、グリフが
// 右下に 1px 寄ってしまうため避ける。
const SELECTOR_CELL_PX = 15;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {Record<string, Uint8Array>} 各文字の 5x7 ピクセルデータ */
const glyphs = {};
for (const ch of EDITABLE_LETTERS) {
  glyphs[ch] = new Uint8Array(GLYPH_GRID_W * GLYPH_GRID_H);
}

let selectedLetter = "A";

// 初期パターン (とりあえず 'A' は それっぽい形を入れて、概念を伝えやすくする)
function _seedDefaultA() {
  // A の標準的な 5x7 形:
  //  .###.
  //  #...#
  //  #...#
  //  #####
  //  #...#
  //  #...#
  //  #...#
  const seed = [
    " ### ",
    "#   #",
    "#   #",
    "#####",
    "#   #",
    "#   #",
    "#   #",
  ];
  for (let y = 0; y < GLYPH_GRID_H; y++) {
    for (let x = 0; x < GLYPH_GRID_W; x++) {
      glyphs["A"][y * GLYPH_GRID_W + x] = seed[y][x] === "#" ? 1 : 0;
    }
  }
}
_seedDefaultA();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  座標計算
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SELECTOR_X = 4;
const SELECTOR_Y = 4;
const EDITOR_X = 4;
const EDITOR_Y = SELECTOR_Y + SELECTOR_CELL_PX + 8;
const TOOLBAR_X = EDITOR_X + EDITOR_W + 12;
const TOOLBAR_Y = EDITOR_Y;
const PREVIEW_Y = EDITOR_Y + EDITOR_H + 12;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィジェット
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let btnClear, btnInvert;
let widgetGroup;

function _initWidgets() {
  if (widgetGroup) return;
  btnClear = new UI.PushButton(TOOLBAR_X, TOOLBAR_Y, "CLEAR", () => {
    glyphs[selectedLetter].fill(0);
  });
  btnInvert = new UI.PushButton(TOOLBAR_X, TOOLBAR_Y + 20, "INVERT", () => {
    const g = glyphs[selectedLetter];
    for (let i = 0; i < g.length; i++) g[i] = g[i] ? 0 : 1;
  });
  widgetGroup = new UI.WidgetGroup([btnClear, btnInvert]);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 5x7 ピクセル glyph を任意位置に任意倍率で描く */
function drawGlyph(cx, cy, ch, scale) {
  const g = glyphs[ch];
  if (!g) return;
  for (let y = 0; y < GLYPH_GRID_H; y++) {
    for (let x = 0; x < GLYPH_GRID_W; x++) {
      if (g[y * GLYPH_GRID_W + x]) {
        if (scale === 1) {
          pset(cx + x, cy + y, 1);
        } else {
          fillRect(cx + x * scale, cy + y * scale, scale, scale, 1);
        }
      }
    }
  }
}

function drawSelector(cr) {
  const baseX = cr.x + SELECTOR_X;
  const baseY = cr.y + SELECTOR_Y;
  drawText(baseX, baseY, "LETTER:", 1);
  const startX = baseX + 50;
  // セル中央配置のオフセット (drawText は整数座標を要求するので Math.floor)
  const textOffsetX = Math.floor((SELECTOR_CELL_PX - GLYPH_W) / 2);
  const textOffsetY = Math.floor((SELECTOR_CELL_PX - GLYPH_H) / 2) - 2;
  for (let i = 0; i < EDITABLE_LETTERS.length; i++) {
    const ch = EDITABLE_LETTERS[i];
    const x = startX + i * SELECTOR_CELL_PX;
    drawRect(x, baseY - 2, SELECTOR_CELL_PX, SELECTOR_CELL_PX, 1);
    drawText(x + textOffsetX, baseY + textOffsetY, ch, 1);
    if (ch === selectedLetter) {
      // 選択中マーカー (下線、セル直下に)
      hline(x + 1, x + SELECTOR_CELL_PX - 2, baseY + SELECTOR_CELL_PX - 1, 1);
    }
  }
}

function drawEditor(cr) {
  const baseX = cr.x + EDITOR_X;
  const baseY = cr.y + EDITOR_Y;
  // セルグリッド (薄い線)
  for (let y = 0; y <= GLYPH_GRID_H; y++) {
    hline(baseX, baseX + EDITOR_W, baseY + y * EDITOR_CELL_PX, 1);
  }
  for (let x = 0; x <= GLYPH_GRID_W; x++) {
    vline(baseX + x * EDITOR_CELL_PX, baseY, baseY + EDITOR_H, 1);
  }
  // ON セル (中央を塗る)
  const g = glyphs[selectedLetter];
  for (let y = 0; y < GLYPH_GRID_H; y++) {
    for (let x = 0; x < GLYPH_GRID_W; x++) {
      if (g[y * GLYPH_GRID_W + x]) {
        fillRect(
          baseX + x * EDITOR_CELL_PX + 2,
          baseY + y * EDITOR_CELL_PX + 2,
          EDITOR_CELL_PX - 3,
          EDITOR_CELL_PX - 3,
          1,
        );
      }
    }
  }
}

function drawPreview(cr) {
  const baseX = cr.x + 4;
  const baseY = cr.y + PREVIEW_Y;
  hline(cr.x, cr.x + cr.w - 1, baseY - 4, 1);
  drawText(baseX, baseY, "PREVIEW:", 1);

  // x1 (= 自然サイズ)
  const previewY1 = baseY + 12;
  drawText(baseX, previewY1, "1x:", 1);
  let cx = baseX + 24;
  const text = "ABCD ABCD";
  for (const ch of text) {
    if (glyphs[ch]) {
      drawGlyph(cx, previewY1, ch, 1);
      cx += GLYPH_GRID_W + 1;
    } else {
      cx += GLYPH_GRID_W + 1;
    }
  }

  // x2 (= 拡大プレビュー)
  const previewY2 = previewY1 + 12;
  drawText(baseX, previewY2, "2x:", 1);
  cx = baseX + 24;
  for (const ch of text) {
    if (glyphs[ch]) {
      drawGlyph(cx, previewY2, ch, 2);
      cx += GLYPH_GRID_W * 2 + 2;
    } else {
      cx += GLYPH_GRID_W * 2 + 2;
    }
  }
}

function onDraw(cr) {
  _initWidgets();
  drawSelector(cr);
  drawEditor(cr);
  drawPreview(cr);
  widgetGroup.draw(cr);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _selectorHit(localX, localY) {
  const startX = SELECTOR_X + 50;
  const baseY = SELECTOR_Y - 2;
  if (localY < baseY || localY >= baseY + SELECTOR_CELL_PX) return null;
  const dx = localX - startX;
  if (dx < 0) return null;
  const idx = (dx / SELECTOR_CELL_PX) | 0;
  if (idx >= EDITABLE_LETTERS.length) return null;
  return EDITABLE_LETTERS[idx];
}

function _editorHit(localX, localY) {
  const dx = localX - EDITOR_X;
  const dy = localY - EDITOR_Y;
  if (dx < 0 || dy < 0 || dx >= EDITOR_W || dy >= EDITOR_H) return null;
  return {
    x: (dx / EDITOR_CELL_PX) | 0,
    y: (dy / EDITOR_CELL_PX) | 0,
  };
}

let _lastPaintedCell = null;

function onInput(ev) {
  _initWidgets();
  widgetGroup.update(ev);

  if (ev.type === "down") {
    // セレクタクリック
    const newLetter = _selectorHit(ev.localX, ev.localY);
    if (newLetter) {
      selectedLetter = newLetter;
      return;
    }
    // エディタクリックでトグル
    const cell = _editorHit(ev.localX, ev.localY);
    if (cell) {
      const g = glyphs[selectedLetter];
      const idx = cell.y * GLYPH_GRID_W + cell.x;
      g[idx] = g[idx] ? 0 : 1;
      _lastPaintedCell = `${cell.x},${cell.y},${g[idx]}`;
    }
  }
  if (ev.type === "held") {
    // ドラッグでペイント (押下時の状態と同じ値で塗り続け)
    const cell = _editorHit(ev.localX, ev.localY);
    if (cell && _lastPaintedCell) {
      const [, , v] = _lastPaintedCell.split(",").map(Number);
      const g = glyphs[selectedLetter];
      const idx = cell.y * GLYPH_GRID_W + cell.x;
      g[idx] = v;
    }
  }
  if (ev.type === "up") {
    _lastPaintedCell = null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    return wmOpen(-1, -1, WIN_W, WIN_H, APP_NAME, onDraw, onInput, null, {
      noResize: true,
      noMaximize: true,
    });
  },
  { category: "EXPERIMENT" },
);
