/**
 * @module lang/playground/canvas-surface
 * canvas-surface.js — surface 契約の canvas2D 実装（開発ハーネス用シム）。
 *
 * 低解像度の 1-bit フレームバッファ (W×H) を持ち、整数倍に拡大して描く。
 * SYNESTA 統合時はこのシムを本物 GPU に差し替えるだけ（言語本体は無改変）。
 */
import { ditherField } from "../surface.js";

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} W 低解像度の幅（場の列数）
 * @param {number} H 低解像度の高さ
 * @param {number} scale 整数拡大率
 * @param {[number,number,number]} fg 前景色 RGB
 * @param {[number,number,number]} bg 背景色 RGB
 */
export function makeCanvasSurface(canvas, W, H, scale, fg, bg) {
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  // 低解像度オフスクリーン（1px = 1 セル）。ここに 1-bit を置いて拡大描画する。
  const off = document.createElement("canvas");
  off.width = W;
  off.height = H;
  const offCtx = off.getContext("2d");
  const img = offCtx.createImageData(W, H);
  const fb = new Uint8Array(W * H); // 1-bit フレームバッファ

  function flush() {
    const d = img.data;
    for (let i = 0; i < W * H; i++) {
      const on = fb[i];
      const r = on ? fg[0] : bg[0];
      const g = on ? fg[1] : bg[1];
      const b = on ? fg[2] : bg[2];
      d[i * 4] = r;
      d[i * 4 + 1] = g;
      d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;
    }
    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, W, H, 0, 0, canvas.width, canvas.height);
  }

  return {
    width: () => W,
    height: () => H,
    present: () => flush(),
    blitField(buf, w, h) {
      const bits = ditherField(buf, w, h);
      fb.set(bits.subarray(0, W * H));
    },
  };
}
