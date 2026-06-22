/**
 * @module lang/stdlib
 * stdlib.js — 場のボキャブラリ（純関数のみ。surface には依存しない）。
 *
 * スモールスタートの最小コア。追加は非破壊なので随時。
 * 値域は [0,1]（0=背景 / 1=前景）。振動は wave() が [0,1] を返すのでオフセット不要。
 * 乱数/ノイズは seed を内部に取り込む（setSeed）。同じ入力＋同じ seed → 同じ値。
 */

/** 現在の seed（runtime が毎評価前に設定）。rnd/noise/fbm が取り込む。 */
let _seed = 0;
export function setSeed(s) {
  _seed = s | 0;
}

/** 定数 */
export const CONSTS = {
  PI: Math.PI,
  TAU: Math.PI * 2,
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const fract = (x) => x - Math.floor(x);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};

// ── ハッシュ & ノイズ（決定論・seed 連動） ──
function hash21(x, y) {
  // 2D(+seed) → [0,1) の擬似乱数（ステートレス）。
  let h = Math.sin(x * 127.1 + y * 311.7 + _seed * 53.13) * 43758.5453;
  return h - Math.floor(h);
}

/** 2D 値ノイズ → [0,1]（双線形 + smoothstep 補間） */
function noise2(x, y) {
  const xi = Math.floor(x),
    yi = Math.floor(y);
  const xf = x - xi,
    yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash21(xi, yi);
  const b = hash21(xi + 1, yi);
  const c = hash21(xi, yi + 1);
  const d = hash21(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** fbm（オクターブ和）→ おおむね [0,1] */
function fbm2(x, y, oct = 4) {
  let f = 0,
    amp = 0.5,
    sum = 0;
  oct = Math.max(1, Math.min(8, oct | 0));
  for (let o = 0; o < oct; o++) {
    f += amp * noise2(x, y);
    sum += amp;
    x *= 2;
    y *= 2;
    amp *= 0.5;
  }
  return f / sum;
}

/** 関数表（最小コア。すべて数値 → 数値） */
export const FUNCS = {
  // 三角（角度はラジアン。座標の数学に使う）
  sin: Math.sin,
  cos: Math.cos,
  atan2: Math.atan2,
  // 数値
  abs: Math.abs,
  floor: Math.floor,
  fract,
  sqrt: (x) => Math.sqrt(Math.max(0, x)),
  mod: (a, b) => ((a % b) + b) % b,
  // 混合・しきい値
  min: Math.min,
  max: Math.max,
  clamp,
  mix,
  step: (edge, x) => (x < edge ? 0 : 1),
  smoothstep,
  // 場
  dist: (x0, y0, x1, y1) => Math.hypot(x1 - x0, y1 - y0),
  noise: noise2,
  fbm: fbm2,
  rnd: hash21,
  // 振動（[0,1] を返す → オフセット不要）
  wave: (a) => (Math.sin(a) + 1) * 0.5,
};
