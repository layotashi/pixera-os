/**
 * @module core/font
 * font.js — ビットマップフォント管理・テキスト描画
 *
 * フォントシート PNG を読み込み、ASCII 0x20–0x7E の 95 グリフを
 * Uint8Array ルックアップテーブルに変換して保持する。
 * drawText() でテキストを VRAM に描画する。
 * switchFont() で実行時にフォントを切り替えられる。
 *
 * フォントシート仕様:
 *   - 各グリフは glyphW × glyphH ピクセル
 *   - セルピッチ: (glyphW+1) × (glyphH+1)、隣接グリフ間で 1px 余白を共有
 *   - シート先頭に offset px マージン (左上)
 *   - cols 列に左→右、上→下で ASCII 順に配置
 *   - 白ピクセル (R≥128) = 前景、黒ピクセル = 透過
 */

import { blit } from "./gpu.js";
import { getTextTransform, assetUrl } from "../config.js";

// ── フォントパラメータ ──
// PIXERA OS のシステムフォントは 5x5 単一寸法。initFont で実フォントから確定する。
// (初期値もその寸法に合わせておき、ブート前の派生定数計算がブレないようにする)

/** グリフ幅 (px) */
export let GLYPH_W = 5;

/** グリフ高さ (px) */
export let GLYPH_H = 5;

/** 最初の文字コード */
const FIRST_CHAR = 0x20;

/** 最後の文字コード */
const LAST_CHAR = 0x7e;

/** 文字数 */
const CHAR_COUNT = LAST_CHAR - FIRST_CHAR + 1;

// ── 内部状態 ──

/**
 * グリフデータのルックアップテーブル
 * glyphs[charIndex] = Uint8Array(GLYPH_W * GLYPH_H)  (0/1)
 * @type {Uint8Array[]}
 */
const glyphs = new Array(CHAR_COUNT);

/** 初期化完了フラグ (PNG ロード完了後 true) */
let ready = false;

// ── 初期化・切替 ──

/**
 * フォントPNGを読み込みグリフテーブルを構築する。
 * kernel.js のブートシーケンスで最初に呼ばれる。
 *
 * @param {string} url      フォントシートの URL
 * @param {number} [gw=5]   グリフ幅
 * @param {number} [gh=5]   グリフ高さ
 * @param {number} [cols=10] シートの列数
 * @param {number} [offset=1] シート先頭オフセット (px)
 * @returns {Promise<void>}
 */
export function initFont(url, gw = 5, gh = 5, cols = 10, offset = 1) {
  return switchFont(url, gw, gh, cols, offset);
}

/**
 * フォントを動的に切り替える。
 * 新しい PNG を読み込み、グリフテーブルを再構築し、
 * GLYPH_W / GLYPH_H をを更新する。
 *
 * @param {string} url      フォントシートの URL
 * @param {number} gw       グリフ幅
 * @param {number} gh       グリフ高さ
 * @param {number} [cols=10]   シートの列数
 * @param {number} [offset=1]  シート先頭オフセット (px)
 * @returns {Promise<void>}
 */
export function switchFont(url, gw, gh, cols = 10, offset = 1) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // オフスクリーン canvas でピクセルデータを読み取る
      const offscreen = document.createElement("canvas");
      offscreen.width = img.width;
      offscreen.height = img.height;
      const offscreenCtx = offscreen.getContext("2d");
      offscreenCtx.drawImage(img, 0, 0);
      const data = offscreenCtx.getImageData(0, 0, img.width, img.height).data;

      const cellW = gw + 1;
      const cellH = gh + 1;

      for (let i = 0; i < CHAR_COUNT; i++) {
        const col = i % cols;
        const row = (i / cols) | 0;
        const ox = offset + col * cellW;
        const oy = offset + row * cellH;
        const buf = new Uint8Array(gw * gh);

        for (let gy = 0; gy < gh; gy++) {
          for (let gx = 0; gx < gw; gx++) {
            const srcIdx = ((oy + gy) * img.width + (ox + gx)) * 4;
            // R チャネル ≥ 128 なら前景とみなす
            buf[gy * gw + gx] = data[srcIdx] >= 128 ? 1 : 0;
          }
        }
        glyphs[i] = buf;
      }

      GLYPH_W = gw;
      GLYPH_H = gh;
      ready = true;
      resolve();
    };
    img.onerror = () => reject(new Error(`Failed to load font: ${url}`));
    img.src = assetUrl(url);
  });
}

// ── 描画 API ──

/**
 * 1文字を描画する。
 * @param {number} x   描画先 X
 * @param {number} y   描画先 Y
 * @param {string} ch  1文字
 * @param {number} c   描画色 (0 or 1)
 */
export function drawChar(x, y, ch, c) {
  if (!ready) return;
  const code = ch.charCodeAt(0);
  if (code < FIRST_CHAR || code > LAST_CHAR) return;
  const glyph = glyphs[code - FIRST_CHAR];
  if (glyph) blit(glyph, GLYPH_W, GLYPH_H, x, y, c);
}

/**
 * 指定文字のグリフビットマップを返す。
 * ascii_art.js 等で文字の塗り面積率 (density) を算出するために使用。
 *
 * @param {string} ch  1文字
 * @returns {Uint8Array|null}  GLYPH_W × GLYPH_H の 0/1 配列。未初期化 or 範囲外なら null
 */
export function getGlyph(ch) {
  if (!ready) return null;
  const code = ch.charCodeAt(0);
  if (code < FIRST_CHAR || code > LAST_CHAR) return null;
  return glyphs[code - FIRST_CHAR] || null;
}

/**
 * 現在のグリフ寸法と文字範囲を返す。
 * GLYPHER が現在のシステムフォントを取り込んで編集する際に使う。
 * @returns {{ glyphW:number, glyphH:number, firstChar:number, charCount:number }}
 */
export function getFontMetrics() {
  return {
    glyphW: GLYPH_W,
    glyphH: GLYPH_H,
    firstChar: FIRST_CHAR,
    charCount: CHAR_COUNT,
  };
}

/**
 * 全グリフのコピーを ASCII 0x20..0x7E 順の配列で返す。
 * GLYPHER の保存や、フォント切替のためのスナップショットに使う。
 * @returns {Uint8Array[]}  CHAR_COUNT 個の GLYPH_W*GLYPH_H バッファ (コピー)
 */
export function getAllGlyphs() {
  const out = new Array(CHAR_COUNT);
  for (let i = 0; i < CHAR_COUNT; i++) {
    out[i] = glyphs[i] ? Uint8Array.from(glyphs[i]) : new Uint8Array(GLYPH_W * GLYPH_H);
  }
  return out;
}

/**
 * グリフテーブルを実行時に差し替える (PNG を介さない in-memory フォント適用)。
 * GLYPHER が編集したグリフをシステム全体へ即時反映するために使う。
 *
 * GLYPH_W / GLYPH_H は変更しない。グリフの「中身」だけを差し替えるため、
 * ラベル幅・ウィンドウ chrome・アイコンといった寸法依存のメトリクスは
 * 一切影響を受けず、次フレームの描画から新しい字形が反映される。
 * 呼び出し側は現在の GLYPH_W × GLYPH_H と同じ寸法のバッファを渡すこと
 * (寸法不一致のバッファは無視する)。
 *
 * @param {Uint8Array[]} buffers  CHAR_COUNT 個の GLYPH_W*GLYPH_H バッファ
 *                                (ASCII 0x20..0x7E 順)。要素が null の位置は据え置く。
 */
export function setGlyphs(buffers) {
  if (!ready || !buffers) return;
  const expectLen = GLYPH_W * GLYPH_H;
  const n = Math.min(buffers.length, CHAR_COUNT);
  for (let i = 0; i < n; i++) {
    const b = buffers[i];
    if (b && b.length === expectLen) glyphs[i] = b;
  }
}

/**
 * 文字列を描画する。1文字ごとに GLYPH_W+1 px ずつ右に進む (1px 字間)。
 * @param {number} x    描画先 X
 * @param {number} y    描画先 Y
 * @param {string} str  文字列
 * @param {number} c    描画色 (0 or 1)
 */
export function drawText(x, y, str, c) {
  if (!ready) return;
  const transformed =
    getTextTransform() === "uppercase" ? str.toUpperCase() : str;
  const step = GLYPH_W + 1; // 文字幅 + 字間1px
  for (let i = 0; i < transformed.length; i++) {
    drawChar(x + i * step, y, transformed[i], c);
  }
}

/**
 * 文字列のピクセル幅を返す。
 * 各グリフ GLYPH_W px + 1px 字間。末尾の字間は含まない。
 * @param {string} s  文字列
 * @returns {number}  描画幅 (px)。空文字なら 0
 */
export function textWidth(s) {
  return s.length > 0 ? s.length * (GLYPH_W + 1) - 1 : 0;
}

