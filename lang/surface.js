/**
 * @module lang/surface
 * surface.js — 言語ランタイムが描画する抽象「サーフェス」契約。
 *
 * 言語本体はこの契約だけに依存し、実装は注入される:
 *   - playground: canvas2D の薄いシム
 *   - SYNESTA 統合: 本物の GPU (js/ui/ports の gpu 相当)
 * これにより font/theme/GPU をコピーせず共有でき、統合時のドリフトを防ぐ。
 *
 * すべて 1-bit。色は「インク level ∈ [0,1]」のみ（テーマが level→色を解決）。
 * 座標は VRAM ピクセル (DOT)。x:0..W-1, y:0..H-1。
 *
 * 契約 (Tier0 で必須なのは width/height/blitField/present):
 *   width()  -> number
 *   height() -> number
 *   present()                         // 1フレームを確定（フラッシュ）
 *   blitField(buf, w, h)              // 値の場を表示へ（このサーフェスは 0..1 → 1-bit ディザ）
 *   // ── 描画命令（Tier1。Processing 流の命名） ──
 *   clear(level=0)
 *   stroke(level)                     // 以降の point/line の描画値 0..1
 *   point(x, y[, level])
 *   line(x0, y0, x1, y1)
 */

/**
 * 場バッファ（Float 0..1）を 4x4 Bayer でしきい値化して 1-bit に落とす純関数。
 * シム/GPU 双方が blitField 実装で使える共通ヘルパ（描画先には依存しない）。
 * @param {Float32Array|number[]} buf  長さ w*h、各 0..1
 * @returns {Uint8Array}  長さ w*h、各 0|1
 */
const BAYER4 = [
  0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5,
].map((v) => (v + 0.5) / 16);

export function ditherField(buf, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = buf[i] < 0 ? 0 : buf[i] > 1 ? 1 : buf[i];
      const th = BAYER4[(y & 3) * 4 + (x & 3)];
      out[i] = v > th ? 1 : 0;
    }
  }
  return out;
}
