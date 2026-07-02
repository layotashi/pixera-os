/**
 * @module lang/stdlib
 * stdlib.js — 場のボキャブラリ（純関数のみ。surface には依存しない）。
 *
 * スモールスタートの最小コア。GLSL/Processing/数学の慣習に従う（造語を避ける）。
 * 関数は値域非依存（例: sin は [-1,1]）。表示の都合（0..1 へ正規化）はサーフェス側の責務。
 * 乱数/ノイズは seed を内部に取り込む（setSeed）。同じ入力＋同じ seed → 同じ値。
 */

/** 現在の seed（runtime が毎評価前に設定）。rnd/noise/fbm/nz が取り込む。 */
let _seed = 0;
export function setSeed(s) {
  _seed = s | 0;
}

/**
 * 現在の音クロック（runtime が毎サンプル設定）。オシレータ(pulse/tri/saw/nz)と
 * 拍(beat/step)が暗黙に取り込む＝音は「時間の場 a(t)」で、視覚が座標を受け取るのと同様に
 * 時間を受け取る。_at=音の時刻(秒), _aperiod=ループ周期(秒)。
 */
let _at = 0;
let _aperiod = Math.PI * 2;
export function setAudioClock(t, period) {
  _at = t;
  _aperiod = period > 0 ? period : 1;
}

/** 定数（言語は大小文字を区別しないため、レキサが畳む小文字キーで持つ） */
export const CONSTS = {
  pi: Math.PI,
  tau: Math.PI * 2,
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

/**
 * Worley（セルラー）ノイズ → 最近傍の特徴点までの距離（おおむね [0,1]）。
 * 各セルに seed 連動の特徴点を 1 つ置き、3x3 近傍で最近傍距離を取る。
 * voronoi / stone / crack 風の細胞模様。GLSL の cellular noise 慣習。
 */
function worley2(x, y) {
  const xi = Math.floor(x),
    yi = Math.floor(y);
  const fx0 = x - xi,
    fy0 = y - yi;
  let minD = 8;
  for (let gy = -1; gy <= 1; gy++) {
    for (let gx = -1; gx <= 1; gx++) {
      const cx = xi + gx,
        cy = yi + gy;
      const px = gx + hash21(cx, cy); // 近傍セル内の特徴点 x
      const py = gy + hash21(cx + 71.3, cy + 9.1); // 〃 y（別ハッシュ）
      const dx = px - fx0,
        dy = py - fy0;
      const d = dx * dx + dy * dy;
      if (d < minD) minD = d;
    }
  }
  return Math.min(1, Math.sqrt(minD));
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
  worley: worley2,
  rnd: hash21,

  // ── 音（チップチューン。時間の場 a(t)。離散的・デジタルに割り切る） ──
  // オシレータは音クロック _at を暗黙に読む（位相 = fract(_at * freq)）。出力 [-1,1]。
  hz: (semi) => 440 * Math.pow(2, (semi - 69) / 12), // 半音番号→Hz（A4=69=440）
  pulse: (freq, duty) => (fract(_at * freq) < (duty === undefined ? 0.5 : duty) ? 1 : -1),
  tri: (freq) => 4 * Math.abs(fract(_at * freq) - 0.5) - 1,
  saw: (freq) => 2 * fract(_at * freq) - 1,
  // サンプル&ホールド白色ノイズ（rate Hz で更新・seed 連動＝再現可能）
  nz: (rate) => hash21(Math.floor(_at * (rate || 1000)), 0.7) * 2 - 1,
  // 拍: サイクル位相（_aperiod 秒で 1 周）。beat(n)=1 周期に n 回リセットする鋸位相 0..1
  beat: (n) => fract((_at / _aperiod) * (n || 1)),
  // step(n)=1 周期を n 分割した整数インデックス 0..n-1（旋律の刻み）
  step: (n) => Math.max(0, Math.floor(fract(_at / _aperiod) * (n || 1))),
  // seq(i, ...xs)=xs[i mod len]（音程・値の並び。可変長＝配列リテラル不要）
  seq: (i, ...xs) => (xs.length ? xs[((Math.floor(i) % xs.length) + xs.length) % xs.length] : 0),
  // decay(p)=拍位相 p を 1→0 の減衰包絡へ（p は beat(n) を渡す）
  decay: (p) => 1 - fract(p),
};
