/**
 * @module app/fontsmith
 * fontsmith.js — FONTSMITH (1-bit ビットマップフォントエディタ)
 *
 * システムフォント (5x5) の全 ASCII グリフ (0x20–0x7E) を 1 文字ずつ
 * デザインし、APPLY で OS 全体のフォントに即時適用する。
 * 「ユーザーが作ったフォントが OS の chrome そのものになる」という
 * SYNESTA の個人化体験の中核。
 *
 * 仕様:
 *   - 起動時に現在のシステムフォントを取り込んで編集対象にする
 *     (白紙からではなく、実フォントを微調整する形)
 *   - 上部: キャラクタマップ (全 95 文字を現在の字形で一覧、クリックで選択)
 *   - 中央: 選択中文字の拡大エディタ (クリック/ドラッグでピクセルを塗る)
 *   - CLEAR / INVERT で編集補助
 *   - 下部: パングラムプレビュー (編集中フォントで描画)
 *   - APPLY: 編集したフォントを OS 全体に即時適用 (font.js setGlyphs)
 *   - REVERT: 起動時のシステムフォントに戻す
 *
 * 寸法はシステムフォントと同一 (5x5) を保つため、適用してもメトリクス・
 * アイコン・レイアウトは一切変わらず、純粋に字形だけが置き換わる。
 *
 *   - SAVE: 名前を付けて VFS (/Fonts/<name>.font) に保存 → Config.FONTS に
 *     登録 → Settings ドロップダウンで切替可能に。boot 時に再読込されるため
 *     リロード後も自作フォントが残る (core/user_fonts.js)。
 */

import { pset, fillRect, drawRect, hline, vline } from "../core/gpu.js";
import {
  drawText,
  GLYPH_H,
  getGlyph,
  getFontMetrics,
  setGlyphs,
} from "../core/font.js";
import { wmOpen, wmRegister } from "../wm/index.js";
import { setSystemFont } from "../config.js";
import { saveUserFont } from "../core/user_fonts.js";
import * as UI from "../ui/index.js";

const APP_NAME = "FONTSMITH";

const WIN_W = 172;
const WIN_H = 244;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  レイアウト定数 (content-relative)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PAD = 5;

// キャラクタマップ: 編集対象の文字を現フォントで一覧表示 (小文字は除外)
const CMAP_COLS = 16;
const CMAP_CELL = 9; // (CMAP_CELL - glyphW=5) = 4 → 上下左右 2px で対称配置
const CMAP_X = PAD;
const CMAP_LABEL_Y = PAD; // "GLYPHS:" ラベル
const CMAP_Y = PAD + 8; // ラベルの下にマップ

// エディタ: 選択中グリフの拡大編集グリッド
const EDIT_SCALE = 15; // 5x5 を 75px に拡大 (編集しやすさ + 幅の収まり)

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {{ glyphW:number, glyphH:number, firstChar:number, charCount:number }|null} */
let metrics = null;
/** @type {Uint8Array[]|null} 編集中の全グリフ (working copy) */
let working = null;
/** @type {Uint8Array[]|null} 起動時のスナップショット (REVERT 用) */
let seed = null;
/** 編集対象の文字インデックス (0..charCount-1、working への実インデックス) */
let selIndex = 0;
/** UI に表示・編集する文字の実インデックス一覧 (小文字 a-z を除外) */
let EDITABLE = [];

// 動的レイアウト (metrics 確定後に算出)
let CMAP_ROWS = 6;
let CMAP_H = CMAP_ROWS * CMAP_CELL;
let EDIT_LABEL_Y = 0;
let EDITOR_X = PAD;
let EDITOR_Y = 0;
let EDITOR_W = 0;
let EDITOR_H = 0;
let TOOLBAR_X = 0;
let PREVIEW_Y = 0;
let BTN_ROW_Y = 0;

function _copyBuf(b) {
  return Uint8Array.from(b);
}

/** 現在のシステムフォントを取り込んで編集対象にする (REVERT 用スナップも保存) */
function _seedFromSystem() {
  metrics = getFontMetrics();
  // 編集対象 = 小文字 a-z (0x61-0x7A) を除く全 ASCII。
  // SYNESTA は全テキストを大文字化するため小文字は表示されず、5x5 フォントでも
  // プレースホルダ (塗りつぶしブロック) のまま。UI に出しても無意味なので除外。
  EDITABLE = [];
  for (let i = 0; i < metrics.charCount; i++) {
    const code = metrics.firstChar + i;
    if (code >= 0x61 && code <= 0x7a) continue;
    EDITABLE.push(i);
  }
  const len = metrics.glyphW * metrics.glyphH;
  working = new Array(metrics.charCount);
  seed = new Array(metrics.charCount);
  for (let i = 0; i < metrics.charCount; i++) {
    const ch = String.fromCharCode(metrics.firstChar + i);
    const g = getGlyph(ch);
    const buf = g && g.length === len ? _copyBuf(g) : new Uint8Array(len);
    working[i] = buf;
    seed[i] = _copyBuf(buf);
  }
  // 'A' を初期選択 (なければ先頭)
  const aIdx = "A".charCodeAt(0) - metrics.firstChar;
  selIndex = aIdx >= 0 && aIdx < metrics.charCount ? aIdx : 0;

  _computeLayout();
}

/** metrics 確定後にレイアウト座標を算出する */
function _computeLayout() {
  const gw = metrics.glyphW;
  const gh = metrics.glyphH;
  CMAP_ROWS = Math.ceil(EDITABLE.length / CMAP_COLS);
  CMAP_H = CMAP_ROWS * CMAP_CELL;
  // EDIT ラベルは editor のすぐ上に寄せる (近接: editor を指すと明確に)
  EDIT_LABEL_Y = CMAP_Y + CMAP_H + 7;
  EDITOR_X = PAD;
  EDITOR_Y = EDIT_LABEL_Y + 8;
  EDITOR_W = gw * EDIT_SCALE;
  EDITOR_H = gh * EDIT_SCALE;
  TOOLBAR_X = EDITOR_X + EDITOR_W + 12;
  PREVIEW_Y = EDITOR_Y + EDITOR_H + 8;
  // プレビュー: hline + "PREVIEW:" + パングラム 2 行
  const LH = gh + 2;
  BTN_ROW_Y = PREVIEW_Y + GLYPH_H + 4 + LH * 2 + 6;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  グリフ操作
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _clearGlyph() {
  if (working) working[selIndex].fill(0);
}

function _invertGlyph() {
  if (!working) return;
  const g = working[selIndex];
  for (let i = 0; i < g.length; i++) g[i] = g[i] ? 0 : 1;
}

/** 編集したフォントを OS 全体に即時適用する */
function _applyToSystem() {
  if (!working) return;
  setGlyphs(working.map(_copyBuf));
}

/** 起動時のシステムフォントに戻す (エディタもスナップショットへ復帰) */
function _revert() {
  if (!seed) return;
  setGlyphs(seed.map(_copyBuf));
  working = seed.map(_copyBuf);
}

/** 名前を付けて VFS に保存 → レジストリ登録 → システムフォントに設定 */
function _save() {
  if (!working) return;
  UI.openPromptDialog("FONT NAME:", {
    title: "SAVE FONT",
    defaultValue: "MYFONT",
    maxLength: 16,
    onResult: (name) => {
      if (!name) return;
      // ファイル名に使えない文字を除去
      const clean = name.replace(/[/\\:*?"<>|]/g, "").trim() || "MYFONT";
      const id = saveUserFont(clean, working);
      // 保存したフォントをシステムに適用 + 選択を永続化
      setSystemFont(id);
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィジェット
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let btnClear, btnInvert, btnApply, btnRevert, btnSave;
let widgetGroup;

function _initWidgets() {
  if (widgetGroup) return;
  // レイアウトは _seedFromSystem 内で確定済み (factory で seed → init の順)
  // 右カラム: グリフ単位の編集ツール (現在の文字に作用)
  btnClear = new UI.PushButton(TOOLBAR_X, EDITOR_Y, "CLEAR", _clearGlyph);
  btnInvert = new UI.PushButton(
    TOOLBAR_X,
    EDITOR_Y + 18,
    "INVERT",
    _invertGlyph,
  );
  // 下段: フォント単位のアクション (APPLY / REVERT / SAVE)
  btnApply = new UI.PushButton(PAD, BTN_ROW_Y, "APPLY", _applyToSystem);
  btnRevert = new UI.PushButton(
    PAD + btnApply.w + 6,
    BTN_ROW_Y,
    "REVERT",
    _revert,
  );
  btnSave = new UI.PushButton(
    PAD + btnApply.w + 6 + btnRevert.w + 6,
    BTN_ROW_Y,
    "SAVE",
    _save,
  );
  widgetGroup = new UI.WidgetGroup([
    btnClear,
    btnInvert,
    btnApply,
    btnRevert,
    btnSave,
  ]);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** グリフバッファを任意位置・倍率・色で描く */
function drawGlyphBuf(buf, gw, gh, cx, cy, scale, color) {
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (buf[y * gw + x]) {
        if (scale === 1) pset(cx + x, cy + y, color);
        else fillRect(cx + x * scale, cy + y * scale, scale, scale, color);
      }
    }
  }
}

function drawCharMap(cr) {
  const gw = metrics.glyphW;
  const gh = metrics.glyphH;
  drawText(cr.x + PAD, cr.y + CMAP_LABEL_Y, "GLYPHS:", 1);
  const baseX = cr.x + CMAP_X;
  const baseY = cr.y + CMAP_Y;
  const gx = Math.floor((CMAP_CELL - gw) / 2);
  const gy = Math.floor((CMAP_CELL - gh) / 2);
  // 外枠 (グループ化: 近接の原則)
  drawRect(baseX - 1, baseY - 1, CMAP_COLS * CMAP_CELL + 2, CMAP_H + 2, 1);
  for (let k = 0; k < EDITABLE.length; k++) {
    const gi = EDITABLE[k];
    const col = k % CMAP_COLS;
    const row = (k / CMAP_COLS) | 0;
    const cx = baseX + col * CMAP_CELL;
    const cy = baseY + row * CMAP_CELL;
    if (gi === selIndex) {
      // 選択セルは反転 (塗りつぶし背景 + 前景 0 でグリフを彫る)
      fillRect(cx, cy, CMAP_CELL, CMAP_CELL, 1);
      drawGlyphBuf(working[gi], gw, gh, cx + gx, cy + gy, 1, 0);
    } else {
      drawGlyphBuf(working[gi], gw, gh, cx + gx, cy + gy, 1, 1);
    }
  }
}

function drawEditor(cr) {
  const gw = metrics.glyphW;
  const gh = metrics.glyphH;
  // EDIT ラベル
  const label = `EDIT '${String.fromCharCode(metrics.firstChar + selIndex)}'`;
  drawText(cr.x + PAD, cr.y + EDIT_LABEL_Y, label, 1);

  const baseX = cr.x + EDITOR_X;
  const baseY = cr.y + EDITOR_Y;
  // グリッド線
  for (let y = 0; y <= gh; y++) {
    hline(baseX, baseX + EDITOR_W, baseY + y * EDIT_SCALE, 1);
  }
  for (let x = 0; x <= gw; x++) {
    vline(baseX + x * EDIT_SCALE, baseY, baseY + EDITOR_H, 1);
  }
  // ON セル (グリッド線の内側を 1px 対称マージンで塗る)
  const g = working[selIndex];
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (g[y * gw + x]) {
        fillRect(
          baseX + x * EDIT_SCALE + 1,
          baseY + y * EDIT_SCALE + 1,
          EDIT_SCALE - 1,
          EDIT_SCALE - 1,
          1,
        );
      }
    }
  }
}

// パングラム (全アルファベットを含む英文): フォントプレビューの定番。
const PANGRAM_LINES = ["THE QUICK BROWN FOX", "JUMPS OVER THE LAZY DOG"];

function drawPreview(cr) {
  const gw = metrics.glyphW;
  const gh = metrics.glyphH;
  const baseX = cr.x + PAD;
  const baseY = cr.y + PREVIEW_Y;
  hline(cr.x, cr.x + cr.w - 1, baseY - 4, 1);
  drawText(baseX, baseY, "PREVIEW:", 1);

  const STEP = gw + 1;
  const LH = gh + 2;
  let ly = baseY + GLYPH_H + 4;
  for (const line of PANGRAM_LINES) {
    let cx = baseX;
    for (const ch of line) {
      const idx = ch.charCodeAt(0) - metrics.firstChar;
      if (ch !== " " && idx >= 0 && idx < metrics.charCount) {
        drawGlyphBuf(working[idx], gw, gh, cx, ly, 1, 1);
      }
      cx += STEP;
    }
    ly += LH;
  }
}

function onDraw(cr) {
  if (!working) _seedFromSystem();
  _initWidgets();
  drawCharMap(cr);
  drawEditor(cr);
  drawPreview(cr);
  widgetGroup.draw(cr);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** キャラクタマップのヒットテスト → 文字インデックス or null */
function _charMapHit(localX, localY) {
  const dx = localX - CMAP_X;
  const dy = localY - CMAP_Y;
  if (dx < 0 || dy < 0) return null;
  const col = (dx / CMAP_CELL) | 0;
  const row = (dy / CMAP_CELL) | 0;
  if (col >= CMAP_COLS || row >= CMAP_ROWS) return null;
  const k = row * CMAP_COLS + col;
  if (k < 0 || k >= EDITABLE.length) return null;
  return EDITABLE[k]; // セル位置 → working への実インデックス
}

/** エディタグリッドのヒットテスト → {x,y} or null */
function _editorHit(localX, localY) {
  const dx = localX - EDITOR_X;
  const dy = localY - EDITOR_Y;
  if (dx < 0 || dy < 0 || dx >= EDITOR_W || dy >= EDITOR_H) return null;
  return { x: (dx / EDIT_SCALE) | 0, y: (dy / EDIT_SCALE) | 0 };
}

let _lastPaintValue = null;

function onInput(ev) {
  if (!working) _seedFromSystem();
  _initWidgets();
  widgetGroup.update(ev);

  if (ev.type === "down") {
    const ci = _charMapHit(ev.localX, ev.localY);
    if (ci !== null) {
      selIndex = ci;
      return;
    }
    const cell = _editorHit(ev.localX, ev.localY);
    if (cell) {
      const g = working[selIndex];
      const idx = cell.y * metrics.glyphW + cell.x;
      g[idx] = g[idx] ? 0 : 1;
      _lastPaintValue = g[idx];
    }
  }
  if (ev.type === "held" && _lastPaintValue !== null) {
    const cell = _editorHit(ev.localX, ev.localY);
    if (cell) {
      const g = working[selIndex];
      g[cell.y * metrics.glyphW + cell.x] = _lastPaintValue;
    }
  }
  if (ev.type === "up") {
    _lastPaintValue = null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    _seedFromSystem();
    _initWidgets();
    return wmOpen(-1, -1, WIN_W, WIN_H, APP_NAME, onDraw, onInput, null, {
      noResize: true,
      noMaximize: true,
    });
  },
  { category: "EXPERIMENT" },
);
