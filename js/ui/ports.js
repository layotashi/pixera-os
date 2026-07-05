/**
 * @module ui/ports
 * ports.js — UI ポートレジストリ (依存注入)
 *
 * UI ウィジェット群が必要とする外部描画・入力機能への参照を一元管理する。
 * ウィジェットはコアモジュール (gpu, font, icon, input 等) を直接 import せず、
 * このモジュールの export を使用する。
 *
 * ホスト側 (例: PIXERA OS の kernel.js) は起動時に initPorts() を呼び、
 * 実際のモジュール実装を注入する。
 * これにより UI ウィジェットライブラリを他のプロジェクトでも再利用できる。
 *
 * ── ES Module Live Bindings ──
 *   ここで宣言した export let 変数は ES Module の仕様により
 *   "live binding" となる。_initPorts() で値を代入すると、
 *   import 側にも即座に反映される。
 *
 * ── ポートカテゴリ ──
 *   gpu      : 描画プリミティブ (fillRect, hline, etc.)
 *   font     : テキスト描画・グリフ定数
 *   icon     : アイコン描画・サイズ定数
 *   input    : 入力ポーリング (ボタン, キー, マウス)
 *   textIcon : テキスト可視化記号 (スペース中点, 改行矢印 等)
 *   dither   : ディザリングマトリクス
 *
 * ── 利用方法 ──
 *   ウィジェット側:
 *     import { drawText, GLYPH_W } from "./ports.js";   // ui/ 内
 *     import { fillRect } from "../ports.js";            // widgets/ 内
 *
 *   ホスト側 (初期化):
 *     import { initPorts } from "./ui/index.js";
 *     initPorts({ gpu, font, icon, input, textIcon, dither });
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GPU ポート — 描画プリミティブ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {(x:number, y:number, w:number, h:number, c:number) => void} */
export let fillRect;

/** @type {(x:number, y:number, w:number, h:number, r:number, c:number) => void} */
export let drawRoundRect;

/** @type {(x:number, y:number, w:number, h:number, c:number) => void} */
export let drawRect;

/** @type {(x1:number, x2:number, y:number, c:number) => void} */
export let hline;

/** @type {(x:number, y1:number, y2:number, c:number) => void} */
export let vline;

/** @type {(x:number, y:number, c:number) => void} */
export let pset;

/** @type {(x:number, y:number, w:number, h:number) => void} */
export let setClip;

/** @type {() => void} */
export let resetClip;

/** @type {(x:number, y:number, w:number, h:number) => void} */
export let pushClip;

/** @type {() => void} */
export let popClip;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Font ポート — テキスト描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** グリフ幅 (px) */
export let GLYPH_W = 5;

/** グリフ高さ (px) */
export let GLYPH_H = 7;

/** @type {(x:number, y:number, str:string, c:number) => void} */
export let drawText;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Icon ポート — アイコン描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** アイコン幅 (px) */
export let ICON_W = 7;

/** アイコン高さ (px) */
export let ICON_H = 7;

/** @type {(name:string, x:number, y:number, c:number) => void} */
export let drawIcon;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Input ポート — 入力ポーリング
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {(key:string) => boolean} */
export let keyDown;

/** @type {(key:string) => boolean} */
export let keyHeld;

/** @type {() => string[]} */
export let getCharQueue;

/** @type {() => string|null} */
export let getPasteText;

/** @type {() => boolean} */
export let mouseHasShift;

/** @type {() => boolean} */
export let ctrlDown;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TextIcon ポート — テキスト可視化記号
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {(name:string, x:number, y:number, c:number) => void} */
export let drawTextIcon;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Dither ポート — ディザリングマトリクス
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {number[][]} Bayer 4×4 閾値マトリクス */
export let BAYER_4x4;

/** @type {number[][]} Bayer 8×8 閾値マトリクス */
export let BAYER_8x8;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ポート注入
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ポートの実装を注入する (内部用 — index.js の initPorts() から呼ばれる)。
 *
 * 寸法定数 (GLYPH_W, GLYPH_H, ICON_W, ICON_H) にはデフォルト値が設定
 * されているため、モジュール評価時のウィジェット構築でも正しい寸法を得られる。
 * 異なるサイズを使うホストは initPorts() でウィジェット構築前に上書きする。
 *
 * 各 key はコアモジュールの namespace オブジェクト、
 * または同じシグネチャを持つ互換実装を渡す。
 *
 * @param {{
 *   gpu:      { fillRect, drawRoundRect, drawRect, hline, vline, pset, setClip, resetClip, pushClip, popClip },
 *   font:     { GLYPH_W, GLYPH_H, drawText },
 *   icon:     { ICON_W, ICON_H, drawIcon },
 *   input:    { keyDown, keyHeld, getCharQueue, getPasteText, mouseHasShift, ctrlDown },
 *   textIcon: { drawTextIcon },
 *   dither:   { BAYER_4x4, BAYER_8x8 },
 * }} ports
 */
export function _initPorts(ports) {
  // GPU
  fillRect = ports.gpu.fillRect;
  drawRoundRect = ports.gpu.drawRoundRect;
  drawRect = ports.gpu.drawRect;
  hline = ports.gpu.hline;
  vline = ports.gpu.vline;
  pset = ports.gpu.pset;
  setClip = ports.gpu.setClip;
  resetClip = ports.gpu.resetClip;
  pushClip = ports.gpu.pushClip;
  popClip = ports.gpu.popClip;

  // Font
  GLYPH_W = ports.font.GLYPH_W;
  GLYPH_H = ports.font.GLYPH_H;
  drawText = ports.font.drawText;

  // Icon
  ICON_W = ports.icon.ICON_W;
  ICON_H = ports.icon.ICON_H;
  drawIcon = ports.icon.drawIcon;

  // Input
  keyDown = ports.input.keyDown;
  keyHeld = ports.input.keyHeld;
  getCharQueue = ports.input.getCharQueue;
  getPasteText = ports.input.getPasteText;
  mouseHasShift = ports.input.mouseHasShift;
  ctrlDown = ports.input.ctrlDown;

  // TextIcon
  drawTextIcon = ports.textIcon.drawTextIcon;

  // Dither
  BAYER_4x4 = ports.dither.BAYER_4x4;
  BAYER_8x8 = ports.dither.BAYER_8x8;
}

