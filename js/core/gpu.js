/**
 * @module core/gpu
 * gpu.js — VRAM管理・描画プリミティブ・画面転送
 *
 * Canvas 要素と ImageData を内部で保持し、
 * フレームバッファ (vram) を通じたピクセル操作 API を提供する。
 *
 * ── 命名規則 ──
 *   マイクロ操作 : 短縮名          cls, pset, pget, hline, vline
 *   図形 (輪郭)  : drawXxx         drawRect, drawCircle, drawLine
 *   図形 (塗り)  : fillXxx         fillRect, fillCircle
 *   パターン     : 説明的名称      drawCheckerboard, bayerGradRect
 *   VRAM操作     : 説明的名称      invertRect, setClip, resetClip
 */

import * as Config from "../config.js";
import { BAYER_4x4, BAYER_8x8 } from "./dither.js";
import {
  tickDiag,
  getDiagOffset,
  ensureLut,
  applyVramRgba,
  applyVignette,
  rebuildVignetteLut,
  isVignetteEnabled,
  setVignetteEnabled,
  setVignetteStrength,
  setVignetteRadius,
  setDiagEnabled,
  setDiagDarkness,
  setDiagSpeed,
  setDiagSpacing,
  setDiagThickness,
} from "./display_fx.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  内部状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {HTMLCanvasElement} */
let canvas;

/** @type {CanvasRenderingContext2D} */
let ctx;

/** @type {ImageData} */
let imgData;

/** @type {Uint8ClampedArray} */
let pixels;

/** @type {Uint32Array} — pixels バッファの 32bit ビュー (flush LUT 用) */
let pixels32;

/** フレームバッファ (1bit/pixel): 0 = 背景, 1 = 前景
 *  最大解像度分を事前確保し、リアルタイム解像度変更に対応する。 */
export const vram = new Uint8Array(
  Config.MAX_VRAM_WIDTH * Config.MAX_VRAM_HEIGHT,
);

// ── アクティブレンダーターゲット ──
// 通常時は vram / VRAM_WIDTH / VRAM_HEIGHT を指す。
// beginCapture() で一時バッファに切り替わり、endCapture() で復元される。
let activeBuffer = vram;
let activeW = Config.VRAM_WIDTH;
let activeH = Config.VRAM_HEIGHT;

// ── クリッピング領域 ──
let clipX0 = 0;
let clipY0 = 0;
let clipX1 = Config.VRAM_WIDTH;
let clipY1 = Config.VRAM_HEIGHT;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  初期化
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * GPU を初期化する。canvas 要素の取得・サイズ設定・ImageData 生成を行う。
 * kernel.js から起動時に 1 回だけ呼ぶ。
 */
export function initGpu() {
  canvas = document.getElementById("screen");
  const s = Config.autoScale();
  // Canvas internal = VRAM 解像度 (1:1)。CSS スケールは autoScale が整数倍で適用。
  // → ブラウザ補間は常に整数倍 (= クリーン、モアレ無し)。
  canvas.width = Config.VRAM_WIDTH;
  canvas.height = Config.VRAM_HEIGHT;
  canvas.style.width = `${Config.VRAM_WIDTH * s}px`;
  canvas.style.height = `${Config.VRAM_HEIGHT * s}px`;
  ctx = canvas.getContext("2d");
  imgData = ctx.createImageData(Config.VRAM_WIDTH, Config.VRAM_HEIGHT);
  pixels = imgData.data;
  pixels32 = new Uint32Array(pixels.buffer);
  rebuildVignetteLut(Config.VRAM_WIDTH, Config.VRAM_HEIGHT);

  // 解像度変更時に canvas / ImageData を再生成し、スケールも再算出
  Config.onResize(() => {
    const s = Config.autoScale();
    canvas.width = Config.VRAM_WIDTH;
    canvas.height = Config.VRAM_HEIGHT;
    canvas.style.width = `${Config.VRAM_WIDTH * s}px`;
    canvas.style.height = `${Config.VRAM_HEIGHT * s}px`;
    imgData = ctx.createImageData(Config.VRAM_WIDTH, Config.VRAM_HEIGHT);
    pixels = imgData.data;
    pixels32 = new Uint32Array(pixels.buffer);
    rebuildVignetteLut(Config.VRAM_WIDTH, Config.VRAM_HEIGHT);
    activeW = Config.VRAM_WIDTH;
    activeH = Config.VRAM_HEIGHT;
    resetClip();
    cls();
  });

  // ブラウザリサイズ等でスケールのみ変わった場合は canvas スタイルだけ更新
  Config.onScaleChange(() => {
    const s = Config.getScale();
    canvas.style.width = `${Config.VRAM_WIDTH * s}px`;
    canvas.style.height = `${Config.VRAM_HEIGHT * s}px`;
  });

  // エフェクトパラメータ変更コールバック
  Config.onEffectChange((key, value) => {
    switch (key) {
      case "vignetteEnabled": setVignetteEnabled(value); break;
      case "vignetteStrength":
        setVignetteStrength(value / 100);
        rebuildVignetteLut(Config.VRAM_WIDTH, Config.VRAM_HEIGHT);
        break;
      case "vignetteRadius":
        setVignetteRadius(value / 100);
        rebuildVignetteLut(Config.VRAM_WIDTH, Config.VRAM_HEIGHT);
        break;
      case "diagEnabled": setDiagEnabled(value); break;
      case "diagDarkness": setDiagDarkness(value / 100); break;
      case "diagSpeed": setDiagSpeed(value); break;
      case "diagSpacing": setDiagSpacing(value); break;
      case "diagThickness": setDiagThickness(value); break;
    }
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  クリッピング
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 描画のクリッピング領域を設定する。
 * pset を含むすべての描画関数はこの領域外への書き込みを無視する。
 *
 * 注意: この関数はクリップスタックを介さずに直接クリップ領域を上書きする。
 * ウィンドウマネージャ等のトップレベルで使用する。
 * ウィジェット内部のネストされたクリップには pushClip/popClip を使用すること。
 */
export function setClip(x, y, w, h) {
  clipX0 = Math.max(0, x | 0);
  clipY0 = Math.max(0, y | 0);
  clipX1 = Math.min(activeW, (x + w) | 0);
  clipY1 = Math.min(activeH, (y + h) | 0);
}

/** クリッピング領域をアクティブバッファ全体にリセットする。 */
export function resetClip() {
  clipX0 = 0;
  clipY0 = 0;
  clipX1 = activeW;
  clipY1 = activeH;
  // スタックもクリア (resetClip は全体リセットなのでスタックを残す意味がない)
  _clipStackLen = 0;
}

// ── クリップスタック (ネストされたクリップ領域の save/restore) ──

/** スタックの最大深度 (ウィジェットのネスト深度; 通常 2〜3 で十分) */
const CLIP_STACK_MAX = 8;

/**
 * クリップスタック — 各エントリは [x0, y0, x1, y1] の 4 要素。
 * 固定長配列で事前確保し、GC を回避する。
 */
const _clipStack = new Int32Array(CLIP_STACK_MAX * 4);
let _clipStackLen = 0;

/**
 * 現在のクリップ領域をスタックに保存し、新しいクリップ領域を設定する。
 * 新しいクリップは現在のクリップとの **交差領域** になるため、
 * 親のクリップ領域を超えることはない。
 *
 * ウィジェットが内部的にクリップを設ける場合に使用する。
 * 描画完了後に必ず popClip() を呼んで復元すること。
 *
 * @param {number} x  クリップ領域の X
 * @param {number} y  クリップ領域の Y
 * @param {number} w  クリップ領域の幅
 * @param {number} h  クリップ領域の高さ
 */
export function pushClip(x, y, w, h) {
  // スタックオーバーフロー防止
  if (_clipStackLen >= CLIP_STACK_MAX) {
    console.warn("[GPU] pushClip: stack overflow — clip ignored");
    return;
  }

  // 現在のクリップ状態を保存
  const base = _clipStackLen * 4;
  _clipStack[base] = clipX0;
  _clipStack[base + 1] = clipY0;
  _clipStack[base + 2] = clipX1;
  _clipStack[base + 3] = clipY1;
  _clipStackLen++;

  // 新しいクリップ = 要求領域 ∩ 現在のクリップ (交差)
  const nx0 = Math.max(clipX0, Math.max(0, x | 0));
  const ny0 = Math.max(clipY0, Math.max(0, y | 0));
  const nx1 = Math.min(clipX1, Math.min(activeW, (x + w) | 0));
  const ny1 = Math.min(clipY1, Math.min(activeH, (y + h) | 0));
  clipX0 = nx0;
  clipY0 = ny0;
  clipX1 = Math.max(nx0, nx1); // 空領域でも x0 <= x1 を保証
  clipY1 = Math.max(ny0, ny1);
}

/**
 * クリップスタックから前のクリップ領域を復元する。
 * pushClip() と必ずペアで使用すること。
 */
export function popClip() {
  if (_clipStackLen <= 0) {
    console.warn("[GPU] popClip: stack underflow — resetClip fallback");
    clipX0 = 0;
    clipY0 = 0;
    clipX1 = activeW;
    clipY1 = activeH;
    return;
  }

  _clipStackLen--;
  const base = _clipStackLen * 4;
  clipX0 = _clipStack[base];
  clipY0 = _clipStack[base + 1];
  clipX1 = _clipStack[base + 2];
  clipY1 = _clipStack[base + 3];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  マイクロ操作
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** アクティブバッファを全消去 */
export function cls() {
  activeBuffer.fill(0);
}

/** 1ピクセル書き込み (クリッピング対応) */
export function pset(x, y, c) {
  x = x | 0;
  y = y | 0;
  if (x < clipX0 || x >= clipX1 || y < clipY0 || y >= clipY1) return;
  activeBuffer[y * activeW + x] = c ? 1 : 0;
}

/** 1ピクセル読み出し */
export function pget(x, y) {
  x = x | 0;
  y = y | 0;
  if (x < 0 || x >= activeW || y < 0 || y >= activeH) return 0;
  return activeBuffer[y * activeW + x];
}

/** 水平線 (事前クリップ + vram.fill で高速化) */
export function hline(x0, x1, y, c) {
  y = y | 0;
  if (y < clipY0 || y >= clipY1) return;
  if (x0 > x1) {
    const t = x0;
    x0 = x1;
    x1 = t;
  }
  x0 = Math.max(x0 | 0, clipX0);
  x1 = Math.min(x1 | 0, clipX1 - 1);
  if (x0 > x1) return;
  const base = y * activeW;
  activeBuffer.fill(c ? 1 : 0, base + x0, base + x1 + 1);
}

/** 垂直線 (事前クリップ + 直接書込みで高速化) */
export function vline(x, y0, y1, c) {
  x = x | 0;
  if (x < clipX0 || x >= clipX1) return;
  if (y0 > y1) {
    const t = y0;
    y0 = y1;
    y1 = t;
  }
  y0 = Math.max(y0 | 0, clipY0);
  y1 = Math.min(y1 | 0, clipY1 - 1);
  if (y0 > y1) return;
  const v = c ? 1 : 0;
  for (let y = y0; y <= y1; y++) activeBuffer[y * activeW + x] = v;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  図形 — 矩形
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 矩形の枠線のみ描画 (幅1px) */
export function drawRect(x, y, w, h, c) {
  const x1 = x + w - 1;
  const y1 = y + h - 1;
  hline(x, x1, y, c); // 上辺
  hline(x, x1, y1, c); // 下辺
  vline(x, y, y1, c); // 左辺
  vline(x1, y, y1, c); // 右辺
}

/** 矩形の塗りつぶし (事前クリップ + vram.fill で高速化) */
export function fillRect(x0, y0, w, h, c) {
  let xe = (x0 | 0) + (w | 0);
  let ye = (y0 | 0) + (h | 0);
  x0 = Math.max(x0 | 0, clipX0);
  y0 = Math.max(y0 | 0, clipY0);
  xe = Math.min(xe, clipX1);
  ye = Math.min(ye, clipY1);
  if (x0 >= xe || y0 >= ye) return;
  const v = c ? 1 : 0;
  for (let y = y0; y < ye; y++) {
    const base = y * activeW;
    activeBuffer.fill(v, base + x0, base + xe);
  }
}

/**
 * 角丸矩形の枠線のみ描画 (幅1px)。
 * r=0 は drawRect と等価。r=1 は四隅を 1px 欠く。r=2 は Midpoint 弧。
 * @param {number} r  角丸の半径 (px)。0 で通常矩形。
 */
export function drawRoundRect(x, y, w, h, r, c) {
  if (r <= 0) {
    drawRect(x, y, w, h, c);
    return;
  }
  const x1 = x + w - 1;
  const y1 = y + h - 1;
  // 上辺・下辺 (角を除く)
  hline(x + r, x1 - r, y, c);
  hline(x + r, x1 - r, y1, c);
  // 左辺・右辺 (角を除く)
  vline(x, y + r, y1 - r, c);
  vline(x1, y + r, y1 - r, c);
  // 四隅に quarter‐circle 弧
  _cornerArc(x + r, y + r, r, 0, c); // 左上
  _cornerArc(x1 - r, y + r, r, 1, c); // 右上
  _cornerArc(x + r, y1 - r, r, 2, c); // 左下
  _cornerArc(x1 - r, y1 - r, r, 3, c); // 右下
}

/**
 * 角丸矩形の塗りつぶし。
 * r=0 は fillRect と等価。r=1 は四隅を 1px 欠く。r=2 は Midpoint 弧。
 * @param {number} r  角丸の半径 (px)。0 で通常矩形。
 */
export function fillRoundRect(x0, y0, w, h, r, c) {
  if (r <= 0) {
    fillRect(x0, y0, w, h, c);
    return;
  }
  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  // 中央帯 (角丸の影響を受けない行)
  for (let row = y0 + r; row <= y1 - r; row++) {
    hline(x0, x1, row, c);
  }
  // 上下の角丸行: Midpoint circle で各行の水平幅を求める
  let cx0 = r;
  let cy0 = 0;
  let d = 1 - r;
  while (cx0 >= cy0) {
    // 上側 (y0+r-cy0 と y0+r-cx0)
    hline(x0 + r - cx0, x1 - r + cx0, y0 + r - cy0, c);
    hline(x0 + r - cy0, x1 - r + cy0, y0 + r - cx0, c);
    // 下側 (y1-r+cy0 と y1-r+cx0)
    hline(x0 + r - cx0, x1 - r + cx0, y1 - r + cy0, c);
    hline(x0 + r - cy0, x1 - r + cy0, y1 - r + cx0, c);
    cy0++;
    if (d < 0) {
      d += 2 * cy0 + 1;
    } else {
      cx0--;
      d += 2 * (cy0 - cx0) + 1;
    }
  }
}

/**
 * 四分円弧 (quarter arc) を描画する内部ヘルパー。
 * @param {number} cx   弧の中心 X
 * @param {number} cy   弧の中心 Y
 * @param {number} r    半径
 * @param {number} q    象限 (0=左上, 1=右上, 2=左下, 3=右下)
 * @param {number} c    描画色
 */
function _cornerArc(cx, cy, r, q, c) {
  let ax = r;
  let ay = 0;
  let d = 1 - r;
  while (ax >= ay) {
    _setCornerPixel(cx, cy, ax, ay, q, c);
    _setCornerPixel(cx, cy, ay, ax, q, c);
    ay++;
    if (d < 0) {
      d += 2 * ay + 1;
    } else {
      ax--;
      d += 2 * (ay - ax) + 1;
    }
  }
}

/** _cornerArc 用の 1px 描画ヘルパー。象限に応じて符号を反転。 */
function _setCornerPixel(cx, cy, dx, dy, q, c) {
  switch (q) {
    case 0:
      pset(cx - dx, cy - dy, c);
      break; // 左上
    case 1:
      pset(cx + dx, cy - dy, c);
      break; // 右上
    case 2:
      pset(cx - dx, cy + dy, c);
      break; // 左下
    case 3:
      pset(cx + dx, cy + dy, c);
      break; // 右下
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  図形 — 線
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 任意の 2 点間を結ぶ直線 (Bresenham) */
export function drawLine(x0, y0, x1, y1, c) {
  x0 = x0 | 0;
  y0 = y0 | 0;
  x1 = x1 | 0;
  y1 = y1 | 0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    pset(x0, y0, c);
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  図形 — 円
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 円の枠線 (Midpoint Circle Algorithm) */
export function drawCircle(cx, cy, r, c) {
  let x = r;
  let y = 0;
  let d = 1 - r;
  while (x >= y) {
    pset(cx + x, cy + y, c);
    pset(cx - x, cy + y, c);
    pset(cx + x, cy - y, c);
    pset(cx - x, cy - y, c);
    pset(cx + y, cy + x, c);
    pset(cx - y, cy + x, c);
    pset(cx + y, cy - x, c);
    pset(cx - y, cy - x, c);
    y++;
    if (d < 0) {
      d += 2 * y + 1;
    } else {
      x--;
      d += 2 * (y - x) + 1;
    }
  }
}

/** 塗りつぶし円 (各水平ラインを hline で描画) */
export function fillCircle(cx, cy, r, c) {
  let x = r;
  let y = 0;
  let d = 1 - r;
  while (x >= y) {
    hline(cx - x, cx + x, cy + y, c);
    hline(cx - x, cx + x, cy - y, c);
    hline(cx - y, cx + y, cy + x, c);
    hline(cx - y, cx + y, cy - x, c);
    y++;
    if (d < 0) {
      d += 2 * y + 1;
    } else {
      x--;
      d += 2 * (y - x) + 1;
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  パターン
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 市松模様（チェッカーパターン）で矩形を塗りつぶす。
 * @param {number} x0  左上 X
 * @param {number} y0  左上 Y
 * @param {number} w   幅
 * @param {number} h   高さ
 * @param {number} c   描画色 (0 or 1)
 * @param {number} [phase=0]  パターン位相: 0 = 偶数ピクセルに描画, 1 = 奇数ピクセルに描画
 */
export function drawCheckerboard(x0, y0, w, h, c, phase = 0) {
  const ox = x0 | 0,
    oy = y0 | 0;
  let xe = ox + (w | 0);
  let ye = oy + (h | 0);
  const cx0 = Math.max(ox, clipX0);
  const cy0 = Math.max(oy, clipY0);
  xe = Math.min(xe, clipX1);
  ye = Math.min(ye, clipY1);
  if (cx0 >= xe || cy0 >= ye) return;
  const v = c ? 1 : 0;
  // target parity: (x+y) & 1 === (phase + ox + oy) & 1
  const target = (phase + ox + oy) & 1;
  for (let y = cy0; y < ye; y++) {
    const base = y * activeW;
    const xParity = target ^ (y & 1);
    let sx = cx0;
    if ((sx & 1) !== xParity) sx++;
    for (let x = sx; x < xe; x += 2) activeBuffer[base + x] = v;
  }
}

/**
 * Bayerディザによるグラデーション矩形描画。
 *
 * 開始密度 d0 から終了密度 d1 へ線形補間し、各ピクセルを
 * Bayer 閾値行列と比較して 0/1 に量子化する。
 * 1-bit ディスプレイ上で擬似的な濃淡グラデーションを実現する。
 *
 * @param {number} x0    左上 X
 * @param {number} y0    左上 Y
 * @param {number} w     幅
 * @param {number} h     高さ
 * @param {number} d0    開始密度 (0.0=空白 〜 1.0=ベタ塗り)
 * @param {number} d1    終了密度 (0.0=空白 〜 1.0=ベタ塗り)
 * @param {"h"|"v"} [dir="h"]  グラデーション方向: "h"=水平, "v"=垂直
 * @param {"4"|"8"} [matrix="4"]  Bayer 行列サイズ: "4"=4×4(16階調), "8"=8×8(64階調)
 */
export function bayerGradRect(x0, y0, w, h, d0, d1, dir = "h", matrix = "4") {
  let xe = (x0 | 0) + (w | 0);
  let ye = (y0 | 0) + (h | 0);
  const ox = x0 | 0;
  const oy = y0 | 0;
  x0 = Math.max(ox, clipX0);
  y0 = Math.max(oy, clipY0);
  xe = Math.min(xe, clipX1);
  ye = Math.min(ye, clipY1);
  if (x0 >= xe || y0 >= ye) return;

  // Bayer 行列選択
  const bayer = matrix === "8" ? BAYER_8x8 : BAYER_4x4;
  const n = bayer.length; // 行列サイズ (4 or 8)
  const levels = n * n; // 階調数 (16 or 64)

  // グラデーション軸の長さ (クリップ前の元サイズ基準)
  const span = dir === "v" ? ye - oy : xe - ox;
  if (span <= 0) return;
  const invSpan = 1.0 / span;

  for (let py = y0; py < ye; py++) {
    const base = py * activeW;
    const bayerRow = bayer[(py - oy) % n];
    for (let px = x0; px < xe; px++) {
      // グラデーション軸上の正規化位置 (0.0 〜 1.0)
      const t = dir === "v" ? (py - oy) * invSpan : (px - ox) * invSpan;
      // 線形補間した密度
      const density = d0 + (d1 - d0) * t;
      // Bayer 閾値と比較 (整数比較で高速化)
      // density * levels > threshold ならピクセル ON
      const threshold = bayerRow[(px - ox) % n];
      activeBuffer[base + px] = density * levels > threshold ? 1 : 0;
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  VRAM操作
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 矩形領域内のピクセルを反転 (0↔1) する。 */
export function invertRect(x, y, w, h) {
  let xe = (x | 0) + (w | 0);
  let ye = (y | 0) + (h | 0);
  x = Math.max(x | 0, clipX0);
  y = Math.max(y | 0, clipY0);
  xe = Math.min(xe, clipX1);
  ye = Math.min(ye, clipY1);
  if (x >= xe || y >= ye) return;
  for (let py = y; py < ye; py++) {
    const base = py * activeW;
    for (let px = x; px < xe; px++) activeBuffer[base + px] ^= 1;
  }
}

/**
 * 角丸矩形領域のピクセルを反転する。角丸形状は fillRoundRect と一致する。
 * r=0 は invertRect と等価。角丸背景 (fillRoundRect) の上に選択反転を
 * かける際、四隅が浮かないよう形を揃える用途。
 * 各画素をちょうど 1 回ずつ反転する (XOR の二重適用による打ち消しを避ける)。
 * @param {number} r  角丸の半径 (px)。0 で通常矩形。
 */
export function invertRoundRect(x0, y0, w, h, r) {
  if (r <= 0) {
    invertRect(x0, y0, w, h);
    return;
  }
  const y1 = y0 + h - 1;
  // 端から ry 行目の左右インセット (欠け幅) を Midpoint circle で求める
  const inset = new Array(r).fill(r);
  let cx = r;
  let cy = 0;
  let d = 1 - r;
  while (cx >= cy) {
    if (r - cy < r) inset[r - cy] = Math.min(inset[r - cy], r - cx);
    if (r - cx < r) inset[r - cx] = Math.min(inset[r - cx], r - cy);
    cy++;
    if (d < 0) {
      d += 2 * cy + 1;
    } else {
      cx--;
      d += 2 * (cy - cx) + 1;
    }
  }
  // 中央帯 (角丸の影響を受けない行) を一括反転
  invertRect(x0, y0 + r, w, h - 2 * r);
  // 上下の角丸行 (対称)。各行を 1 回だけ反転
  for (let ry = 0; ry < r; ry++) {
    const spanW = w - 2 * inset[ry];
    if (spanW <= 0) continue;
    invertRect(x0 + inset[ry], y0 + ry, spanW, 1);
    invertRect(x0 + inset[ry], y1 - ry, spanW, 1);
  }
}

// copyRect / scroll は参照ゼロのため削除 (使われていない描画プリミティブを
// 予約として持たない方針)。必要になれば git 履歴から復元する。

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ビットマップ転写
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 1bit ビットマップを VRAM に転写する。
 * src の値が 1 のピクセルを色 c で描画し、0 のピクセルはスキップ（透過）する。
 *
 * @param {Uint8Array} src  ソースビットマップ (0/1 の配列, 長さ sw * sh)
 * @param {number} sw       ソース幅
 * @param {number} sh       ソース高さ
 * @param {number} dx       転写先 X
 * @param {number} dy       転写先 Y
 * @param {number} c        描画色 (0 or 1)
 */
export function blit(src, sw, sh, dx, dy, c) {
  const v = c ? 1 : 0;
  const r0 = Math.max(0, clipY0 - dy);
  const r1 = Math.min(sh, clipY1 - dy);
  const c0 = Math.max(0, clipX0 - dx);
  const c1 = Math.min(sw, clipX1 - dx);
  if (r0 >= r1 || c0 >= c1) return;
  for (let row = r0; row < r1; row++) {
    const srcBase = row * sw;
    const dstBase = (dy + row) * activeW + dx;
    for (let col = c0; col < c1; col++) {
      if (src[srcBase + col]) activeBuffer[dstBase + col] = v;
    }
  }
}

/**
 * 1bit ビットマップを XOR 転送する。
 * ソースが 1 のピクセルでアクティブバッファを反転する。
 * どんな背景色でもコントラストが保証される。
 */
export function blitXor(src, sw, sh, dx, dy) {
  const r0 = Math.max(0, clipY0 - dy);
  const r1 = Math.min(sh, clipY1 - dy);
  const c0 = Math.max(0, clipX0 - dx);
  const c1 = Math.min(sw, clipX1 - dx);
  if (r0 >= r1 || c0 >= c1) return;
  for (let row = r0; row < r1; row++) {
    const srcBase = row * sw;
    const dstBase = (dy + row) * activeW + dx;
    for (let col = c0; col < c1; col++) {
      if (src[srcBase + col]) activeBuffer[dstBase + col] ^= 1;
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  VRAM → Canvas 転送
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 内部 Canvas 要素を返す (スクリーンショット用)。 */
export function getCanvas() {
  return canvas;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  オフスクリーンキャプチャ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 一時バッファにオフスクリーン描画を開始する。
 * 全描画プリミティブの出力先がキャプチャバッファに切り替わる。
 * VRAM サイズに依存しない任意サイズの描画が可能になる。
 *
 * initBuf を渡すと、それをキャプチャバッファの初期内容として採用する
 * (ゼロ初期化の代わり)。CAPTURE のマット合成で、壁紙を敷いた下地の上に
 * ウィンドウを描くために使う。長さが w*h と一致しない場合は無視してゼロ初期化する。
 * initBuf はコピーせずそのまま採用するため、呼び元は使い捨ての新規バッファを渡すこと。
 * @param {number} w  キャプチャ幅 (px)
 * @param {number} h  キャプチャ高さ (px)
 * @param {Uint8Array} [initBuf]  下地バッファ (省略時はゼロ初期化)
 */
export function beginCapture(w, h, initBuf = null) {
  activeBuffer =
    initBuf && initBuf.length === w * h ? initBuf : new Uint8Array(w * h);
  activeW = w;
  activeH = h;
  clipX0 = 0;
  clipY0 = 0;
  clipX1 = w;
  clipY1 = h;
}

/** レンダーターゲットを通常の vram に戻す (各 endCapture* 共通)。 */
function _restoreRenderTarget() {
  activeBuffer = vram;
  activeW = Config.VRAM_WIDTH;
  activeH = Config.VRAM_HEIGHT;
  resetClip();
}

/**
 * キャプチャを終了し、結果をキャンバスとして返す。
 * VRAM を 1:1 で RGBA 化 + Diagonal + Vignette を適用した出力。
 * アクティブバッファを通常の vram に復元する。
 * @param {number} [scale=1]  出力倍率 (ニアレストネイバー、整数倍推奨)
 * @returns {HTMLCanvasElement}  キャプチャ結果のキャンバス
 */
export function endCapture(scale = 1) {
  const w = activeW;
  const h = activeH;
  const buf = activeBuffer;

  const img = new ImageData(w, h);
  const p32 = new Uint32Array(img.data.buffer);

  const fg = Config.palette.fg;
  const bg = Config.palette.bg;
  ensureLut(fg, bg);
  applyVramRgba(p32, buf, w, h, getDiagOffset());
  if (isVignetteEnabled()) {
    applyVignette(img.data, w, h);
  }

  const c1 = document.createElement("canvas");
  c1.width = w;
  c1.height = h;
  const ctx1 = c1.getContext("2d");
  ctx1.putImageData(img, 0, 0);

  _restoreRenderTarget();

  // 追加スケーリング (整数倍ニアレストネイバー)
  if (scale <= 1) return c1;
  const out = document.createElement("canvas");
  out.width = w * scale;
  out.height = h * scale;
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = false;
  octx.drawImage(c1, 0, 0, w * scale, h * scale);
  return out;
}

/**
 * キャプチャを終了し、生の 1-bit バッファ (Uint8Array) を返す。
 * Canvas / ImageData を生成しないため GIF フレーム蓄積用に軽量。
 * @returns {Uint8Array}  0/1 ピクセルデータのコピー
 */
export function endCaptureRaw() {
  const buf = new Uint8Array(activeW * activeH);
  buf.set(activeBuffer);

  _restoreRenderTarget();

  return buf;
}

/** vram の内容を Canvas に描画する。毎フレーム draw() の末尾で呼ぶ。
 *  display_fx モジュールで VRAM → RGBA 1:1 + Vignette を適用して putImageData。 */
export function flush() {
  const fg = Config.palette.fg;
  const bg = Config.palette.bg;
  ensureLut(fg, bg);
  tickDiag();
  applyVramRgba(pixels32, vram, Config.VRAM_WIDTH, Config.VRAM_HEIGHT, getDiagOffset());
  if (isVignetteEnabled()) {
    applyVignette(pixels, Config.VRAM_WIDTH, Config.VRAM_HEIGHT);
  }
  ctx.putImageData(imgData, 0, 0);
}

