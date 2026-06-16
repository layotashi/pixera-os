/**
 * @module app/genart
 * genart.js — GENART — 生成的アート
 *
 * ─── 生成的アートの本質 ───
 * 生成的アートとは、アーティストがシステム――規則・手続き――を設計し、
 * そのシステムが自律的に作品を生み出す芸術形式である。
 * その美の源泉は3つある:
 *   1. 創発 — 単純な規則の相互作用から、予測不能な複雑さが立ち現れること
 *   2. 無限の変奏 — 同じ規則が、わずかな初期条件の違いで全く異なる作品を紡ぐこと
 *   3. 秩序と混沌の狭間 — 完全な規則性でも完全な乱雑さでもない、
 *      その境界領域にこそ、最も美しい構造が宿ること
 *
 * 14のアルゴリズムが、それぞれ異なる角度から
 * この「創発」の神秘を1bitキャンバスに描き出す。
 *
 * アルゴリズム:
 *   FLOW     — ノイズ場に導かれた無数の粒子が織りなす有機的紋様
 *   REACT    — 化学反応の自己組織化が生む生命的パターン (Gray-Scott)
 *   ATTRACT  — カオス力学系の軌道が描く数理の美 (Clifford / De Jong)
 *   DLA      — ランダムウォーカーの凝集が紡ぐ樹枝状結晶
 *   LSYS     — L-System: 再帰的文法が描く植物の幾何学
 *   VORONOI  — ボロノイ割り: 空間分割が紡ぐ細胞的テッセレーション
 *   WAVE     — 波動干渉: 複数波源の干渉縞が描くモアレ
 *   SPIRAL   — 黄金螺旋: フィボナッチと黄金角が織りなす自然の幾何学
 *   AUTOMATA — セルラーオートマトン: Wolfram 1D→2D 展開の万華鏡
 *   AA_PLSM  — ASCIIプラズマ: sin/cos干渉が文字濃淡で描くサイケデリックな紋様
 *   AA_FLOW  — ASCIIフロー: ノイズ場の流れの方向を文字の形で暗示する
 *   AA_RAIN  — ASCIIレイン: 文字が降り注ぎ積もっていくデジタルの雨
 *   AA_GRID  — ASCIIグリッド: 数理パターンが決定する文字タイルのテッセレーション
 *   AA_LAND  — ASCIIランド: fbm地形の高さマップを文字濃淡で描く風景
 *
 * 構成:
 *   - ツールバー (2行): アルゴリズム, プリセット, シード, 生成ボタン, 反転, 自動送り
 *   - キャンバス: 256×192 のアートキャンバス (リアルタイム漸進描画)
 *     AA 系アルゴリズムでは文字セル単位で描画
 *   - フッター: 進捗, アルゴリズム情報
 */

import { VRAM_WIDTH, VRAM_HEIGHT } from "../config.js";
import * as GPU from "../core/gpu.js";
import { drawText, textWidth, GLYPH_H } from "../core/font.js";
import { ICON_W, ICON_H } from "../core/icon.js";
import { wmOpen, wmRegister } from "../wm/index.js";
import * as UI from "../ui/index.js";
import { writeFile } from "../core/vfs.js";
import { encodePBM } from "../core/pbm.js";
import * as AsciiArt from "../core/ascii_art.js";

const APP_NAME = "GENART";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** アートキャンバスサイズ (可変) */
let artWidth = 320; // SIZE_PRESETS[0] と一致させる
let artHeight = 192;

/** キャンバスサイズのプリセット (w=0 は画面全体、w=-1 は CUSTOM=W/H 直接入力) */
// 既定 (index 0) は 320x192: ツールバー幅とほぼ一致し、左右の死に空間が出ない。
const SIZE_PRESETS = [
  { label: "320x192", w: 320, h: 192 },
  { label: "256x192", w: 256, h: 192 },
  { label: "320x240", w: 320, h: 240 },
  { label: "400x300", w: 400, h: 300 },
  { label: "512x384", w: 512, h: 384 },
  { label: "SQUARE", w: 256, h: 256 }, // SNS 向けの正方形
  { label: "SCREEN", w: 0, h: 0 },
  { label: "CUSTOM", w: -1, h: -1 },
];
const SIZE_CUSTOM_IDX = SIZE_PRESETS.length - 1;
let currentSizeIdx = 0;

/** キャンバスサイズの許容範囲 */
const ART_W_MIN = 32,
  ART_W_MAX = 800;
const ART_H_MIN = 24,
  ART_H_MAX = 600;

/** ツールバーとキャンバスの間の間隔 */
const CANVAS_GAP = 4;

/** PNG エクスポート倍率 */
let exportScale = 2;
const EXPORT_SCALES = [1, 2, 4, 8];

/** アルゴリズム定義 */
const ALGO_KEYS = [
  "flow",
  "react",
  "attract",
  "dla",
  "lsys",
  "voronoi",
  "wave",
  "spiral",
  "automata",
  "aa_plasma",
  "aa_flow",
  "aa_rain",
  "aa_grid",
  "aa_land",
];
const ALGO_NAMES = [
  "FLOW",
  "REACT",
  "ATTRACT",
  "DLA",
  "LSYS",
  "VORONOI",
  "WAVE",
  "SPIRAL",
  "AUTOMATA",
  "AA_PLSM",
  "AA_FLOW",
  "AA_RAIN",
  "AA_GRID",
  "AA_LAND",
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  プリセット定義
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PRESETS = {
  flow: [
    {
      name: "SILK",
      scale: 0.004,
      octaves: 1,
      particles: 3000,
      steps: 350,
      stepSize: 0.7,
      angleOfs: 0,
      warp: false,
      curl: false,
      density: false,
    },
    {
      name: "STORM",
      scale: 0.011,
      octaves: 4,
      particles: 2500,
      steps: 200,
      stepSize: 1.1,
      angleOfs: 0,
      warp: false,
      curl: false,
      density: false,
    },
    {
      name: "MARBLE",
      scale: 0.005,
      octaves: 3,
      particles: 3500,
      steps: 280,
      stepSize: 0.7,
      angleOfs: 0,
      warp: true,
      warpAmt: 2.5,
      curl: false,
      density: false,
    },
    {
      name: "VORTEX",
      scale: 0.005,
      octaves: 3,
      particles: 3000,
      steps: 280,
      stepSize: 1.0,
      angleOfs: 0,
      warp: false,
      curl: true,
      density: false,
    },
    {
      name: "SMOKE",
      scale: 0.006,
      octaves: 5,
      particles: 8000,
      steps: 160,
      stepSize: 0.5,
      angleOfs: 0,
      warp: true,
      warpAmt: 1.8,
      curl: false,
      density: true,
    },
    {
      name: "RIVER",
      scale: 0.003,
      octaves: 2,
      particles: 4000,
      steps: 500,
      stepSize: 1.2,
      angleOfs: Math.PI * 0.5,
      warp: false,
      curl: true,
      density: false,
    },
  ],
  react: [
    { name: "MITOSIS", f: 0.0367, k: 0.0649, iters: 4000 },
    { name: "CORAL", f: 0.0545, k: 0.062, iters: 3500 },
    { name: "WORM", f: 0.025, k: 0.06, iters: 5000 },
    { name: "MAZE", f: 0.029, k: 0.057, iters: 5000 },
    { name: "SPOTS", f: 0.014, k: 0.054, iters: 6000 },
    { name: "HOLES", f: 0.039, k: 0.058, iters: 4000 },
  ],
  attract: [
    { name: "WINGS", a: -1.4, b: 1.6, c: 1.0, d: 0.7, type: "clifford" },
    { name: "RIBBON", a: 1.7, b: 1.7, c: 0.6, d: 1.2, type: "clifford" },
    { name: "NEBULA", a: -2.0, b: -2.0, c: -1.2, d: 2.0, type: "dejong" },
    { name: "GALAXY", a: 1.5, b: -1.8, c: 1.6, d: 0.9, type: "clifford" },
    { name: "DRAGON", a: -1.2, b: -1.9, c: 1.8, d: -1.6, type: "dejong" },
    { name: "FERN", a: 1.1, b: -1.32, c: -1.03, d: 1.54, type: "clifford" },
  ],
  dla: [
    { name: "CRYSTAL", seedMode: "center", maxP: 5000, dirs: 4 },
    { name: "FROST", seedMode: "bottom", maxP: 4000, dirs: 4 },
    { name: "DENDRITE", seedMode: "center", maxP: 5000, dirs: 4 },
    { name: "CORAL", seedMode: "multi", maxP: 5000, dirs: 8 },
    { name: "STAR", seedMode: "ring", maxP: 5000, dirs: 4 },
    { name: "LICHEN", seedMode: "scatter", maxP: 4000, dirs: 8 },
  ],
  lsys: [
    {
      name: "TREE",
      axiom: "F",
      rules: { F: "FF+[+F-F-F]-[-F+F+F]" },
      angle: 22.5,
      depth: 4,
      len: 4,
      startAngle: -90,
    },
    {
      name: "BUSH",
      axiom: "F",
      rules: { F: "F[+FF][-FF]F[-F][+F]F" },
      angle: 25,
      depth: 3,
      len: 6,
      startAngle: -90,
    },
    {
      name: "FERN",
      axiom: "X",
      rules: { X: "F+[[X]-X]-F[-FX]+X", F: "FF" },
      angle: 25,
      depth: 5,
      len: 3,
      startAngle: -90,
    },
    {
      name: "KOCH",
      axiom: "F--F--F",
      rules: { F: "F+F--F+F" },
      angle: 60,
      depth: 4,
      len: 2,
      startAngle: 0,
    },
    {
      name: "DRAGON",
      axiom: "FX",
      rules: { X: "X+YF+", Y: "-FX-Y" },
      angle: 90,
      depth: 12,
      len: 3,
      startAngle: 0,
    },
    {
      name: "HILBERT",
      axiom: "A",
      rules: { A: "-BF+AFA+FB-", B: "+AF-BFB-FA+" },
      angle: 90,
      depth: 5,
      len: 3,
      startAngle: 0,
    },
  ],
  voronoi: [
    { name: "CELLS", numPoints: 80, mode: "edge", distortion: 0 },
    { name: "GLASS", numPoints: 40, mode: "dist", distortion: 0 },
    { name: "SHATTER", numPoints: 120, mode: "edge", distortion: 0.3 },
    { name: "MOSAIC", numPoints: 200, mode: "checker", distortion: 0 },
    { name: "ORGANIC", numPoints: 60, mode: "dist", distortion: 0.5 },
    { name: "QUILT", numPoints: 100, mode: "id", distortion: 0 },
  ],
  wave: [
    {
      name: "RIPPLE",
      sources: 3,
      mode: "concentric",
      freq: 0.08,
      decay: false,
    },
    { name: "MOIRE", sources: 2, mode: "linear", freq: 0.04, decay: false },
    { name: "PLAID", sources: 4, mode: "linear", freq: 0.06, decay: false },
    { name: "RAIN", sources: 12, mode: "concentric", freq: 0.12, decay: true },
    { name: "LENS", sources: 5, mode: "concentric", freq: 0.05, decay: true },
    { name: "WARP", sources: 3, mode: "spiral", freq: 0.03, decay: false },
  ],
  spiral: [
    {
      name: "SUNFLWR",
      dotMode: "circle",
      numDots: 2000,
      baseR: 1.2,
      dotScale: 0.5,
    },
    {
      name: "GALAXY",
      dotMode: "trail",
      numDots: 3000,
      baseR: 0.8,
      dotScale: 0.3,
    },
    { name: "NAUTILUS", dotMode: "log", numDots: 1, baseR: 1.0, dotScale: 1.0 },
    {
      name: "DAISY",
      dotMode: "petal",
      numDots: 800,
      baseR: 1.0,
      dotScale: 0.8,
    },
    { name: "PINE", dotMode: "cone", numDots: 1500, baseR: 0.9, dotScale: 0.6 },
    { name: "DNA", dotMode: "helix", numDots: 2000, baseR: 1.0, dotScale: 0.4 },
  ],
  automata: [
    { name: "RULE30", rule: 30, init: "center", width: artWidth },
    { name: "RULE90", rule: 90, init: "center", width: artWidth },
    { name: "RULE110", rule: 110, init: "center", width: artWidth },
    { name: "RULE150", rule: 150, init: "center", width: artWidth },
    { name: "R30-RND", rule: 30, init: "random", width: artWidth },
    { name: "R110-RND", rule: 110, init: "random", width: artWidth },
  ],
  aa_plasma: [
    {
      name: "CLASSIC",
      layers: 4,
      freqBase: 0.04,
      speed: 0,
      gamma: 1.0,
      chars: "",
    },
    {
      name: "DEEP",
      layers: 6,
      freqBase: 0.02,
      speed: 0,
      gamma: 0.7,
      chars: "",
    },
    {
      name: "DENSE",
      layers: 5,
      freqBase: 0.06,
      speed: 0,
      gamma: 1.2,
      chars: "@#%+=-.",
    },
    {
      name: "DIGITS",
      layers: 4,
      freqBase: 0.03,
      speed: 0,
      gamma: 1.0,
      chars: "0123456789",
    },
    {
      name: "MINIMAL",
      layers: 3,
      freqBase: 0.05,
      speed: 0,
      gamma: 1.0,
      chars: " .:+#",
    },
    {
      name: "PSYCHE",
      layers: 8,
      freqBase: 0.015,
      speed: 0,
      gamma: 0.6,
      chars: "",
    },
  ],
  aa_flow: [
    {
      name: "BREEZE",
      scale: 0.08,
      octaves: 2,
      gamma: 1.0,
      chars: "",
      mode: "dir",
    },
    {
      name: "TORRENT",
      scale: 0.15,
      octaves: 4,
      gamma: 0.8,
      chars: "",
      mode: "dir",
    },
    {
      name: "GENTLE",
      scale: 0.04,
      octaves: 1,
      gamma: 1.2,
      chars: "",
      mode: "dir",
    },
    {
      name: "MIX",
      scale: 0.06,
      octaves: 3,
      gamma: 1.0,
      chars: "",
      mode: "mix",
    },
    {
      name: "DIGITS",
      scale: 0.1,
      octaves: 2,
      gamma: 1.0,
      chars: "0123456789",
      mode: "density",
    },
    {
      name: "DENSE",
      scale: 0.05,
      octaves: 3,
      gamma: 0.7,
      chars: "",
      mode: "density",
    },
  ],
  aa_rain: [
    {
      name: "DRIZZLE",
      density: 0.3,
      speed: 1,
      tailLen: 4,
      chars: "",
      gamma: 1.0,
    },
    { name: "POUR", density: 0.6, speed: 2, tailLen: 6, chars: "", gamma: 0.8 },
    {
      name: "DIGITS",
      density: 0.5,
      speed: 1,
      tailLen: 5,
      chars: "0123456789",
      gamma: 1.0,
    },
    {
      name: "BINARY",
      density: 0.4,
      speed: 1,
      tailLen: 8,
      chars: "01",
      gamma: 1.0,
    },
    {
      name: "STORM",
      density: 0.8,
      speed: 3,
      tailLen: 3,
      chars: "",
      gamma: 0.6,
    },
    {
      name: "MIST",
      density: 0.2,
      speed: 1,
      tailLen: 10,
      chars: " .:+",
      gamma: 1.4,
    },
  ],
  aa_grid: [
    { name: "WAVE", patFn: "wave", freq: 0.12, gamma: 1.0, chars: "" },
    { name: "CHECKER", patFn: "checker", freq: 0.0, gamma: 1.0, chars: "" },
    { name: "DIAMOND", patFn: "diamond", freq: 0.08, gamma: 1.0, chars: "" },
    { name: "NOISE", patFn: "noise", freq: 0.06, gamma: 0.8, chars: "" },
    {
      name: "SYMBOLS",
      patFn: "wave",
      freq: 0.1,
      gamma: 1.0,
      chars: "@#$%&*+=",
    },
    {
      name: "MINIMAL",
      patFn: "diamond",
      freq: 0.05,
      gamma: 1.2,
      chars: " .oO",
    },
  ],
  aa_land: [
    {
      name: "HILLS",
      scale: 0.015,
      octaves: 4,
      gamma: 1.0,
      chars: "",
      seaLevel: 0.35,
    },
    {
      name: "MOUNT",
      scale: 0.01,
      octaves: 6,
      gamma: 0.7,
      chars: "",
      seaLevel: 0.25,
    },
    {
      name: "ISLAND",
      scale: 0.02,
      octaves: 5,
      gamma: 1.0,
      chars: "",
      seaLevel: 0.5,
    },
    {
      name: "CANYON",
      scale: 0.025,
      octaves: 3,
      gamma: 1.3,
      chars: "",
      seaLevel: 0.15,
    },
    {
      name: "TOPO",
      scale: 0.012,
      octaves: 4,
      gamma: 1.0,
      chars: " .-=~^*#@",
      seaLevel: 0.3,
    },
    {
      name: "DIGITS",
      scale: 0.018,
      octaves: 4,
      gamma: 1.0,
      chars: "0123456789",
      seaLevel: 0.2,
    },
  ],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  疑似乱数生成器 (xoshiro128**)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _s0, _s1, _s2, _s3;

function seedRng(s) {
  s = s | 0 || 1;
  function sm(v) {
    v = ((v ^ (v >>> 16)) * 0x45d9f3b) | 0;
    v = ((v ^ (v >>> 16)) * 0x45d9f3b) | 0;
    return (v ^ (v >>> 16)) >>> 0;
  }
  _s0 = sm(s);
  _s1 = sm(s + 0x9e3779b9);
  _s2 = sm(s + 0x3c6ef372);
  _s3 = sm(s + 0xdaa66d2b);
  if (!_s0 && !_s1 && !_s2 && !_s3) _s0 = 1;
}

function rng() {
  let t = _s1 << 9;
  let r = _s1 * 5;
  r = ((r << 7) | (r >>> 25)) * 9;
  _s2 ^= _s0;
  _s3 ^= _s1;
  _s1 ^= _s2;
  _s0 ^= _s3;
  _s2 ^= t;
  _s3 = (_s3 << 11) | (_s3 >>> 21);
  return (r >>> 0) / 4294967296;
}

function rngInt(a, b) {
  return (a + rng() * (b - a + 0.999)) | 0;
}

function rngGauss() {
  const u1 = rng() || 0.0001;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Perlin ノイズ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PERM = new Uint8Array(512);
const GRAD2 = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function initNoise(seed) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = seed | 0 || 1;
  for (let i = 255; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function noise2D(x, y) {
  const X = Math.floor(x) & 255,
    Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x),
    yf = y - Math.floor(y);
  const u = fade(xf),
    v = fade(yf);
  const aa = PERM[PERM[X] + Y],
    ab = PERM[PERM[X] + Y + 1];
  const ba = PERM[PERM[X + 1] + Y],
    bb = PERM[PERM[X + 1] + Y + 1];
  const g00 = GRAD2[aa & 7],
    g10 = GRAD2[ba & 7];
  const g01 = GRAD2[ab & 7],
    g11 = GRAD2[bb & 7];
  const n00 = g00[0] * xf + g00[1] * yf;
  const n10 = g10[0] * (xf - 1) + g10[1] * yf;
  const n01 = g01[0] * xf + g01[1] * (yf - 1);
  const n11 = g11[0] * (xf - 1) + g11[1] * (yf - 1);
  const lx0 = n00 + u * (n10 - n00);
  const lx1 = n01 + u * (n11 - n01);
  return lx0 + v * (lx1 - lx0);
}

function fbm(x, y, octaves) {
  let val = 0,
    amp = 1,
    freq = 1,
    maxA = 0;
  for (let i = 0; i < octaves; i++) {
    val += noise2D(x * freq, y * freq) * amp;
    maxA += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return val / maxA;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Bayer ディザリング
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/* prettier-ignore */
const BAYER4 = [
   0, 8, 2,10,
  12, 4,14, 6,
   3,11, 1, 9,
  15, 7,13, 5,
];

function bayerDither(x, y, value) {
  const threshold = (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
  return value > threshold ? 1 : 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  アートバッファ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let artBuf = new Uint8Array(artWidth * artHeight);

function clearArt() {
  artBuf.fill(0);
}

/** キャンバスサイズ変更 — バッファを再確保して再生成 */
function resizeArt(w, h) {
  artWidth = w;
  artHeight = h;
  artBuf = new Uint8Array(artWidth * artHeight);
  clearArt();
}

/**
 * キャンバスサイズを適用する。
 * AA 系アルゴリズムではセルピッチ (CELL_W × CELL_H) の倍数にスナップし、
 * 文字グリッドがキャンバス領域にぴったり収まるようにする。
 * NumberBox の表示値も同期し、ツールバーを再構築して再生成を開始する。
 */
function applyArtSize(w, h) {
  if (isAAAlgo()) {
    w = Math.max(
      AsciiArt.CELL_W,
      Math.round(w / AsciiArt.CELL_W) * AsciiArt.CELL_W,
    );
    h = Math.max(
      AsciiArt.CELL_H,
      Math.round(h / AsciiArt.CELL_H) * AsciiArt.CELL_H,
    );
  }
  w = Math.max(ART_W_MIN, Math.min(ART_W_MAX, w));
  h = Math.max(ART_H_MIN, Math.min(ART_H_MAX, h));
  resizeArt(w, h);
  if (nbArtW) nbArtW.value = w;
  if (nbArtH) nbArtH.value = h;
  startGeneration();
}

function artPset(x, y) {
  x = x | 0;
  y = y | 0;
  if (x >= 0 && x < artWidth && y >= 0 && y < artHeight)
    artBuf[y * artWidth + x] = 1;
}

function artLine(x0, y0, x1, y1) {
  x0 |= 0;
  y0 |= 0;
  x1 |= 0;
  y1 |= 0;
  const dx = Math.abs(x1 - x0),
    dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1,
    sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    artPset(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
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

function artFillCircle(cx, cy, r) {
  cx |= 0;
  cy |= 0;
  r |= 0;
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.sqrt(r * r - dy * dy) | 0;
    for (let dx = -w; dx <= w; dx++) artPset(cx + dx, cy + dy);
  }
}

function artCircle(cx, cy, r) {
  cx |= 0;
  cy |= 0;
  let x = 0,
    y = r | 0,
    d = 3 - 2 * (r | 0);
  while (y >= x) {
    artPset(cx + x, cy + y);
    artPset(cx - x, cy + y);
    artPset(cx + x, cy - y);
    artPset(cx - x, cy - y);
    artPset(cx + y, cy + x);
    artPset(cx - y, cy + x);
    artPset(cx + y, cy - x);
    artPset(cx - y, cy - x);
    x++;
    if (d > 0) {
      y--;
      d += 4 * (x - y) + 10;
    } else {
      d += 4 * x + 6;
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let currentAlgoIdx = 0;
let currentPresetIdx = 0;
let seed = (Math.random() * 10000) | 0;
let generating = false;
let progress = 0;
let statusText = "";
let invertMode = false;
let autoMode = false;
let autoTimer = 0;
const AUTO_INTERVAL = 90;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PNG 保存 / 壁紙設定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 現在のアートを PNG でダウンロード */
function saveArtAsPng() {
  const scale = exportScale;
  GPU.beginCapture(artWidth, artHeight);
  // artBuf → キャプチャバッファへ直接コピー (blit は vram/active に描くので利用)
  GPU.blit(artBuf, artWidth, artHeight, 0, 0, 1);
  if (invertMode) GPU.invertRect(0, 0, artWidth, artHeight);
  const canvas = GPU.endCapture(scale);

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const algoName = ALGO_NAMES[currentAlgoIdx];
    const presetName =
      PRESETS[ALGO_KEYS[currentAlgoIdx]][currentPresetIdx].name;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `genart_${algoName}_${presetName}_${seed}_${ts}.png`;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, "image/png");
}

/** 現在のアートを PBM として VFS に保存する (FileDialog 経由) */
function saveArtToVfs() {
  // invertMode の場合はバッファを反転してから保存
  let buf = artBuf;
  if (invertMode) {
    buf = new Uint8Array(artBuf.length);
    for (let i = 0; i < artBuf.length; i++) buf[i] = artBuf[i] ? 0 : 1;
  }
  const pbmText = encodePBM(buf, artWidth, artHeight);

  UI.openFileDialog("save", {
    title: "SAVE ART",
    defaultPath: "/Images/Wallpapers",
    defaultName: "art.pbm",
    filter: [".pbm"],
    onResult: (path) => {
      if (path) writeFile(path, pbmText);
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  FLOW — フローフィールド粒子トレース (密度蓄積モード追加)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let flowDone = 0;
let flowPreset = null;
let flowDensity = null;

function flowInit(preset, s) {
  flowPreset = preset;
  initNoise(s);
  seedRng(s);
  clearArt();
  flowDone = 0;
  generating = true;
  progress = 0;
  flowDensity = preset.density ? new Uint32Array(artWidth * artHeight) : null;
}

function flowStep() {
  const p = flowPreset;
  const batch = 30;

  for (let b = 0; b < batch && flowDone < p.particles; b++, flowDone++) {
    let x = rng() * artWidth;
    let y = rng() * artHeight;

    for (let s = 0; s < p.steps; s++) {
      const px = x | 0,
        py = y | 0;
      if (px < 0 || px >= artWidth || py < 0 || py >= artHeight) break;

      let nx = x * p.scale,
        ny = y * p.scale;

      if (p.warp) {
        const warpX = fbm(nx + 0.0, ny + 0.0, p.octaves);
        const warpY = fbm(nx + 5.2, ny + 1.3, p.octaves);
        nx += warpX * p.warpAmt;
        ny += warpY * p.warpAmt;
      }

      let angle;
      if (p.curl) {
        const eps = 0.01;
        const dndy =
          fbm(nx, ny + eps, p.octaves) - fbm(nx, ny - eps, p.octaves);
        const dndx =
          fbm(nx + eps, ny, p.octaves) - fbm(nx - eps, ny, p.octaves);
        angle = Math.atan2(-dndx, dndy);
      } else {
        angle = fbm(nx, ny, p.octaves) * Math.PI * 2.5 + p.angleOfs;
      }

      const nx2 = x + Math.cos(angle) * p.stepSize;
      const ny2 = y + Math.sin(angle) * p.stepSize;

      if (flowDensity) {
        if (px >= 0 && px < artWidth && py >= 0 && py < artHeight)
          flowDensity[py * artWidth + px]++;
      } else {
        artLine(px, py, nx2 | 0, ny2 | 0);
      }

      x = nx2;
      y = ny2;
    }
  }

  if (flowDensity) {
    let maxD = 0;
    for (let i = 0; i < flowDensity.length; i++)
      if (flowDensity[i] > maxD) maxD = flowDensity[i];
    if (maxD > 0) {
      const logMax = Math.log(1 + maxD);
      for (let y = 0; y < artHeight; y++) {
        for (let x = 0; x < artWidth; x++) {
          const d = flowDensity[y * artWidth + x];
          artBuf[y * artWidth + x] = bayerDither(
            x,
            y,
            Math.log(1 + d) / logMax,
          );
        }
      }
    }
  }

  progress = flowDone / p.particles;
  statusText = `PARTICLES: ${flowDone}/${p.particles}`;
  if (flowDone >= p.particles) {
    generating = false;
    progress = 1;
    statusText = `DONE - ${p.particles} PARTICLES`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REACT — 反応拡散系 (Gray-Scott)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// シミュレーション格子サイズをキャンバスから動的に決定する。
// 計算量を抑えるため、格子の1辺は最大 256px に制限し、
// 結果をニアレストネイバーでアートバッファに拡大する。

const RD_MAX_SIDE = 256;
const RD_DU = 0.21,
  RD_DV = 0.1;
let rdW = 128,
  rdH = 96,
  rdScale = 2;
let rdU, rdV, rdNU, rdNV;
let rdIter = 0,
  rdMaxIter = 4000,
  rdPreset = null;

function reactInit(preset, s) {
  rdPreset = preset;
  rdMaxIter = preset.iters;
  seedRng(s);

  // キャンバスサイズから格子サイズを決定 (等倍 or 1/2)
  if (artWidth <= RD_MAX_SIDE && artHeight <= RD_MAX_SIDE) {
    rdW = artWidth;
    rdH = artHeight;
    rdScale = 1;
  } else {
    rdScale = Math.ceil(Math.max(artWidth, artHeight) / RD_MAX_SIDE);
    rdW = Math.ceil(artWidth / rdScale);
    rdH = Math.ceil(artHeight / rdScale);
  }

  const len = rdW * rdH;
  rdU = new Float64Array(len);
  rdV = new Float64Array(len);
  rdNU = new Float64Array(len);
  rdNV = new Float64Array(len);
  rdU.fill(1.0);
  rdV.fill(0.0);
  const margin = Math.min(8, (rdW >> 2) | 0, (rdH >> 2) | 0) || 1;
  const nSeeds = 6 + rngInt(0, 6);
  for (let i = 0; i < nSeeds; i++) {
    const cx = rngInt(margin, rdW - margin - 1),
      cy = rngInt(margin, rdH - margin - 1),
      sz = rngInt(2, Math.min(4, margin));
    for (let dy = -sz; dy <= sz; dy++) {
      for (let dx = -sz; dx <= sz; dx++) {
        const xx = cx + dx,
          yy = cy + dy;
        if (xx >= 0 && xx < rdW && yy >= 0 && yy < rdH) {
          rdU[yy * rdW + xx] = 0.5;
          rdV[yy * rdW + xx] = 0.25 + rng() * 0.05;
        }
      }
    }
  }
  rdIter = 0;
  generating = true;
  progress = 0;
  clearArt();
}

function reactStep() {
  const f = rdPreset.f,
    k = rdPreset.k;
  // 格子が大きいほど1フレームの反復回数を減らして負荷を一定に保つ
  const baseCells = 128 * 96;
  const cells = rdW * rdH;
  const perFrame = Math.max(4, Math.round((35 * baseCells) / cells));
  for (let s = 0; s < perFrame && rdIter < rdMaxIter; s++, rdIter++) {
    for (let y = 0; y < rdH; y++) {
      for (let x = 0; x < rdW; x++) {
        const idx = y * rdW + x;
        const xp = x < rdW - 1 ? idx + 1 : idx - (rdW - 1);
        const xn = x > 0 ? idx - 1 : idx + (rdW - 1);
        const yp = y < rdH - 1 ? idx + rdW : idx - (rdH - 1) * rdW;
        const yn = y > 0 ? idx - rdW : idx + (rdH - 1) * rdW;
        const lapU = rdU[xp] + rdU[xn] + rdU[yp] + rdU[yn] - 4 * rdU[idx];
        const lapV = rdV[xp] + rdV[xn] + rdV[yp] + rdV[yn] - 4 * rdV[idx];
        const u = rdU[idx],
          v = rdV[idx],
          uvv = u * v * v;
        rdNU[idx] = u + RD_DU * lapU - uvv + f * (1 - u);
        rdNV[idx] = v + RD_DV * lapV + uvv - (f + k) * v;
      }
    }
    const tu = rdU;
    rdU = rdNU;
    rdNU = tu;
    const tv = rdV;
    rdV = rdNV;
    rdNV = tv;
  }
  // 格子 → アートバッファへニアレストネイバー拡大
  for (let gy = 0; gy < rdH; gy++) {
    for (let gx = 0; gx < rdW; gx++) {
      const density = Math.min(1.0, rdV[gy * rdW + gx] * 3.5);
      for (let dy = 0; dy < rdScale; dy++) {
        const ay = gy * rdScale + dy;
        if (ay >= artHeight) break;
        for (let dx = 0; dx < rdScale; dx++) {
          const ax = gx * rdScale + dx;
          if (ax >= artWidth) break;
          artBuf[ay * artWidth + ax] = bayerDither(ax, ay, density);
        }
      }
    }
  }
  progress = rdIter / rdMaxIter;
  statusText = `ITER: ${rdIter}/${rdMaxIter}`;
  if (rdIter >= rdMaxIter) {
    generating = false;
    progress = 1;
    statusText = `DONE - f=${rdPreset.f} k=${rdPreset.k}`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ATTRACT — 奇妙なアトラクタ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let attrDensity = null,
  attrX = 0,
  attrY = 0,
  attrIter = 0;
const ATTR_MAX_ITER = 8_000_000;
let attrPreset = null,
  attrMinX,
  attrMaxX,
  attrMinY,
  attrMaxY;

function attractInit(preset, s) {
  attrPreset = { ...preset };
  seedRng(s);

  // ── seed からパラメータに微小摂動を加える ──
  // 同じ族のアトラクタだが、毎回わずかに異なる形状になる。
  // 摂動量 ±0.02 — 構造を保ちつつ変化が目に見える範囲。
  const perturb = 0.02;
  attrPreset.a = preset.a + (rng() * 2 - 1) * perturb;
  attrPreset.b = preset.b + (rng() * 2 - 1) * perturb;
  attrPreset.c = preset.c + (rng() * 2 - 1) * perturb;
  attrPreset.d = preset.d + (rng() * 2 - 1) * perturb;

  const p = attrPreset;
  let x = rng() * 2 - 1,
    y = rng() * 2 - 1;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (let i = 0; i < 200000; i++) {
    let nx, ny;
    if (p.type === "dejong") {
      nx = Math.sin(p.a * y) - Math.cos(p.b * x);
      ny = Math.sin(p.c * x) - Math.cos(p.d * y);
    } else {
      nx = Math.sin(p.a * y) + p.c * Math.cos(p.a * x);
      ny = Math.sin(p.b * x) + p.d * Math.cos(p.b * y);
    }
    x = nx;
    y = ny;
    if (i > 200) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const mx = (maxX - minX) * 0.05,
    my = (maxY - minY) * 0.05;
  attrMinX = minX - mx;
  attrMaxX = maxX + mx;
  attrMinY = minY - my;
  attrMaxY = maxY + my;
  const rangeX = attrMaxX - attrMinX,
    rangeY = attrMaxY - attrMinY,
    aspect = artWidth / artHeight;
  if (rangeX / rangeY > aspect) {
    const nh = rangeX / aspect,
      cy2 = (attrMinY + attrMaxY) / 2;
    attrMinY = cy2 - nh / 2;
    attrMaxY = cy2 + nh / 2;
  } else {
    const nw = rangeY * aspect,
      cx2 = (attrMinX + attrMaxX) / 2;
    attrMinX = cx2 - nw / 2;
    attrMaxX = cx2 + nw / 2;
  }
  attrDensity = new Uint32Array(artWidth * artHeight);
  attrX = x;
  attrY = y;
  attrIter = 0;
  generating = true;
  progress = 0;
  clearArt();
}

function attractStep() {
  const p = attrPreset,
    batch = 60_000,
    isDJ = p.type === "dejong";
  for (let i = 0; i < batch; i++, attrIter++) {
    let nx, ny;
    if (isDJ) {
      nx = Math.sin(p.a * attrY) - Math.cos(p.b * attrX);
      ny = Math.sin(p.c * attrX) - Math.cos(p.d * attrY);
    } else {
      nx = Math.sin(p.a * attrY) + p.c * Math.cos(p.a * attrX);
      ny = Math.sin(p.b * attrX) + p.d * Math.cos(p.b * attrY);
    }
    attrX = nx;
    attrY = ny;
    const px =
      (((attrX - attrMinX) / (attrMaxX - attrMinX)) * (artWidth - 1)) | 0;
    const py =
      (((attrY - attrMinY) / (attrMaxY - attrMinY)) * (artHeight - 1)) | 0;
    if (px >= 0 && px < artWidth && py >= 0 && py < artHeight)
      attrDensity[py * artWidth + px]++;
  }
  let maxD = 0;
  for (let i = 0; i < attrDensity.length; i++)
    if (attrDensity[i] > maxD) maxD = attrDensity[i];
  if (maxD > 0) {
    const logMax = Math.log(1 + maxD);
    for (let y = 0; y < artHeight; y++)
      for (let x = 0; x < artWidth; x++) {
        artBuf[y * artWidth + x] = bayerDither(
          x,
          y,
          Math.log(1 + attrDensity[y * artWidth + x]) / logMax,
        );
      }
  }
  progress = attrIter / ATTR_MAX_ITER;
  statusText = `POINTS: ${(attrIter / 1000) | 0}K`;
  if (attrIter >= ATTR_MAX_ITER) {
    generating = false;
    progress = 1;
    statusText = `DONE - ${(ATTR_MAX_ITER / 1e6) | 0}M POINTS`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DLA — 拡散律速凝集 (新シードモード追加)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let dlaGrid = null,
  dlaCount = 0,
  dlaMaxP = 5000;
let dlaPreset = null,
  dlaRadius = 5,
  dlaTopY = 0;
let dlaStall = 0;
const DLA_STALL_LIMIT = 400;

function dlaInit(preset, s) {
  dlaPreset = preset;
  dlaMaxP = preset.maxP;
  seedRng(s);
  dlaGrid = new Uint8Array(artWidth * artHeight);
  dlaCount = 0;
  dlaRadius = 5;
  dlaTopY = artHeight;
  dlaStall = 0;
  if (preset.seedMode === "center") {
    dlaGrid[(artHeight >> 1) * artWidth + (artWidth >> 1)] = 1;
    dlaCount = 1;
    dlaTopY = artHeight >> 1;
  } else if (preset.seedMode === "bottom") {
    for (let x = 0; x < artWidth; x += 3) {
      dlaGrid[(artHeight - 1) * artWidth + x] = 1;
      dlaCount++;
    }
    dlaTopY = artHeight - 1;
  } else if (preset.seedMode === "multi") {
    const n = 4 + rngInt(0, 3);
    for (let i = 0; i < n; i++) {
      const x = rngInt((artWidth * 0.2) | 0, (artWidth * 0.8) | 0),
        y = rngInt((artHeight * 0.2) | 0, (artHeight * 0.8) | 0);
      dlaGrid[y * artWidth + x] = 1;
      dlaCount++;
      if (y < dlaTopY) dlaTopY = y;
    }
  } else if (preset.seedMode === "ring") {
    const cx = artWidth >> 1,
      cy = artHeight >> 1,
      r = 8;
    for (let a = 0; a < 360; a += 5) {
      const rad = (a * Math.PI) / 180;
      const x = (cx + Math.cos(rad) * r) | 0,
        y = (cy + Math.sin(rad) * r) | 0;
      if (x >= 0 && x < artWidth && y >= 0 && y < artHeight) {
        dlaGrid[y * artWidth + x] = 1;
        dlaCount++;
      }
    }
    dlaTopY = cy - r;
    dlaRadius = r;
  } else if (preset.seedMode === "scatter") {
    const n = 15 + rngInt(0, 10);
    for (let i = 0; i < n; i++) {
      const x = rngInt(10, artWidth - 10),
        y = rngInt(10, artHeight - 10);
      dlaGrid[y * artWidth + x] = 1;
      dlaCount++;
      if (y < dlaTopY) dlaTopY = y;
    }
  }
  generating = true;
  progress = 0;
  clearArt();
  for (let i = 0; i < dlaGrid.length; i++) artBuf[i] = dlaGrid[i];
}

const DIR4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const DIR8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

function dlaStep() {
  const dirs = dlaPreset.dirs === 8 ? DIR8 : DIR4;
  const walkersPerFrame = 80,
    maxSteps = 4000;
  const countBefore = dlaCount;
  for (let w = 0; w < walkersPerFrame && dlaCount < dlaMaxP; w++) {
    let x, y;
    if (dlaPreset.seedMode === "bottom") {
      x = rngInt(0, artWidth - 1);
      y = Math.max(0, dlaTopY - 15 - rngInt(0, 10));
    } else {
      const r = Math.min(dlaRadius + 15, Math.min(artWidth, artHeight) * 0.48);
      const angle = rng() * Math.PI * 2;
      x = ((artWidth >> 1) + Math.cos(angle) * r) | 0;
      y = ((artHeight >> 1) + Math.sin(angle) * r) | 0;
    }
    for (let step = 0; step < maxSteps; step++) {
      // neighbor check
      let hasN = false;
      for (let di = 0; di < dirs.length; di++) {
        const nx = x + dirs[di][0],
          ny = y + dirs[di][1];
        if (
          nx >= 0 &&
          nx < artWidth &&
          ny >= 0 &&
          ny < artHeight &&
          dlaGrid[ny * artWidth + nx]
        ) {
          hasN = true;
          break;
        }
      }
      if (hasN) {
        if (
          x >= 0 &&
          x < artWidth &&
          y >= 0 &&
          y < artHeight &&
          !dlaGrid[y * artWidth + x]
        ) {
          dlaGrid[y * artWidth + x] = 1;
          artBuf[y * artWidth + x] = 1;
          dlaCount++;
          if (dlaPreset.seedMode !== "bottom") {
            const dx2 = x - (artWidth >> 1),
              dy2 = y - (artHeight >> 1);
            const dist = Math.sqrt(dx2 * dx2 + dy2 * dy2);
            if (dist > dlaRadius) dlaRadius = dist;
          }
          if (y < dlaTopY) dlaTopY = y;
        }
        break;
      }
      const d = dirs[rngInt(0, dirs.length - 1)];
      x += d[0];
      y += d[1];
      if (x < 0 || x >= artWidth || y < 0 || y >= artHeight) break;
      if (dlaPreset.seedMode === "bottom") {
        if (y < dlaTopY - 30 || y >= artHeight) break;
      } else {
        const dx2 = x - (artWidth >> 1),
          dy2 = y - (artHeight >> 1);
        if (dx2 * dx2 + dy2 * dy2 > (dlaRadius + 35) * (dlaRadius + 35)) break;
      }
    }
  }
  // ストール検出: 1フレームで1個も付着しなければカウントアップ
  if (dlaCount === countBefore) dlaStall++;
  else dlaStall = 0;

  progress = dlaCount / dlaMaxP;
  statusText = `PARTICLES: ${dlaCount}/${dlaMaxP}`;
  if (dlaCount >= dlaMaxP || dlaStall >= DLA_STALL_LIMIT) {
    generating = false;
    progress = 1;
    statusText =
      dlaStall >= DLA_STALL_LIMIT
        ? `DONE - ${dlaCount} PARTICLES (SATURATED)`
        : `DONE - ${dlaMaxP} PARTICLES`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LSYS — L-System (Lindenmayer System)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 文字列書き換え規則による再帰的成長。
// たった数行の文法定義から、植物・雪片・空間充填曲線が現れる。

let lsysPreset = null;
let lsysSegments = null;
let lsysDone = 0;

function lsysInit(preset, s) {
  lsysPreset = preset;
  seedRng(s);
  clearArt();

  // ── seed 由来のジッター量 ──
  // 角度に ±8% のゆらぎ、線長に ±12% のゆらぎを seed から導入する。
  // 構造の「骨格」はプリセットが決め、seed が「個性」を与える。
  const angleJitter = 0.08; // ±8% of angle step
  const lenJitter = 0.12; // ±12% of segment length

  // L-System 文字列を展開
  let str = preset.axiom;
  for (let i = 0; i < preset.depth; i++) {
    let next = "";
    for (let j = 0; j < str.length; j++) {
      const ch = str[j];
      next += preset.rules[ch] !== undefined ? preset.rules[ch] : ch;
    }
    str = next;
  }

  // 共通ヘルパー: ジッター付きタートル1パス
  const aStepBase = (preset.angle * Math.PI) / 180;
  function turtlePass(callback) {
    let x = 0,
      y = 0,
      a = (preset.startAngle * Math.PI) / 180;
    const stack = [];
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "F") {
        const jLen = preset.len * (1 + (rng() * 2 - 1) * lenJitter);
        const nx = x + Math.cos(a) * jLen,
          ny = y + Math.sin(a) * jLen;
        callback(x, y, nx, ny);
        x = nx;
        y = ny;
      } else if (ch === "+") {
        a += aStepBase * (1 + (rng() * 2 - 1) * angleJitter);
      } else if (ch === "-") {
        a -= aStepBase * (1 + (rng() * 2 - 1) * angleJitter);
      } else if (ch === "[") stack.push({ x, y, a });
      else if (ch === "]") {
        const s2 = stack.pop();
        x = s2.x;
        y = s2.y;
        a = s2.a;
      }
    }
  }

  // Pass 1 で bounding box と座標を同時記録
  // (同じ seed・同じ rng 列を使うため、状態を保存して巻き戻す)
  const rngState = { s0: _s0, s1: _s1, s2: _s2, s3: _s3 };
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  turtlePass((x0, y0, x1, y1) => {
    if (x0 < minX) minX = x0;
    if (x0 > maxX) maxX = x0;
    if (y0 < minY) minY = y0;
    if (y0 > maxY) maxY = y0;
    if (x1 < minX) minX = x1;
    if (x1 > maxX) maxX = x1;
    if (y1 < minY) minY = y1;
    if (y1 > maxY) maxY = y1;
  });

  const bw = maxX - minX || 1,
    bh = maxY - minY || 1;
  const margin = 8;
  const sc = Math.min(
    (artWidth - margin * 2) / bw,
    (artHeight - margin * 2) / bh,
  );
  const ofsX = (artWidth - bw * sc) / 2 - minX * sc;
  const ofsY = (artHeight - bh * sc) / 2 - minY * sc;

  // Pass 2: 同じ rng 列で再計算し、セグメント座標を確定
  _s0 = rngState.s0;
  _s1 = rngState.s1;
  _s2 = rngState.s2;
  _s3 = rngState.s3;
  lsysSegments = [];
  turtlePass((x0, y0, x1, y1) => {
    lsysSegments.push([
      (x0 * sc + ofsX) | 0,
      (y0 * sc + ofsY) | 0,
      (x1 * sc + ofsX) | 0,
      (y1 * sc + ofsY) | 0,
    ]);
  });

  lsysDone = 0;
  generating = true;
  progress = 0;
}

function lsysStep() {
  const total = lsysSegments.length;
  const batch = Math.max(1, Math.ceil(total / 120));

  for (let i = 0; i < batch && lsysDone < total; i++, lsysDone++) {
    const seg = lsysSegments[lsysDone];
    artLine(seg[0], seg[1], seg[2], seg[3]);
  }

  progress = lsysDone / total;
  statusText = `SEGS: ${lsysDone}/${total}`;
  if (lsysDone >= total) {
    generating = false;
    progress = 1;
    statusText = `DONE - DEPTH ${lsysPreset.depth} (${total} segs)`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  VORONOI — ボロノイ・ダイアグラム
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 空間上にランダムに散らばった母点から最も近い点に基づいて
// 領域を分割する。細胞・亀甲・石畳・泡沫の幾何学。

let vorPoints = null,
  vorPreset = null,
  vorScanY = 0;

function voronoiInit(preset, s) {
  vorPreset = preset;
  seedRng(s);
  initNoise(s);
  clearArt();
  const n = preset.numPoints;
  vorPoints = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    let x = rng() * artWidth,
      y = rng() * artHeight;
    if (preset.distortion > 0) {
      x += rngGauss() * preset.distortion * 20;
      y += rngGauss() * preset.distortion * 20;
    }
    vorPoints[i * 2] = x;
    vorPoints[i * 2 + 1] = y;
  }
  vorScanY = 0;
  generating = true;
  progress = 0;
}

function voronoiStep() {
  const p = vorPreset,
    n = p.numPoints,
    rowsPerFrame = 2;
  for (
    let row = 0;
    row < rowsPerFrame && vorScanY < artHeight;
    row++, vorScanY++
  ) {
    const y = vorScanY;
    for (let x = 0; x < artWidth; x++) {
      let minD = Infinity,
        minI = 0,
        secD = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = x - vorPoints[i * 2],
          dy = y - vorPoints[i * 2 + 1];
        const d = dx * dx + dy * dy;
        if (d < minD) {
          secD = minD;
          minD = d;
          minI = i;
        } else if (d < secD) secD = d;
      }
      let val = 0;
      if (p.mode === "edge") {
        val = Math.sqrt(secD) - Math.sqrt(minD) < 2.5 ? 1 : 0;
      } else if (p.mode === "dist") {
        const maxR =
          Math.sqrt((artWidth * artWidth + artHeight * artHeight) / n) * 0.9;
        val = bayerDither(x, y, Math.min(1, Math.sqrt(minD) / maxR));
      } else if (p.mode === "checker") {
        val = minI & 1;
      } else if (p.mode === "id") {
        val = bayerDither(x, y, ((minI * 7 + 3) % 16) / 16);
      }
      artBuf[y * artWidth + x] = val;
    }
  }
  progress = vorScanY / artHeight;
  statusText = `SCAN: ${vorScanY}/${artHeight}`;
  if (vorScanY >= artHeight) {
    generating = false;
    progress = 1;
    statusText = `DONE - ${n} POINTS`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WAVE — 波動干渉パターン
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let waveSources = null,
  wavePreset = null,
  waveScanY = 0;

function waveInit(preset, s) {
  wavePreset = preset;
  seedRng(s);
  clearArt();
  waveSources = [];
  for (let i = 0; i < preset.sources; i++) {
    waveSources.push({
      x: rng() * artWidth,
      y: rng() * artHeight,
      phase: rng() * Math.PI * 2,
      freq: preset.freq * (0.8 + rng() * 0.4),
      angle: rng() * Math.PI * 2,
    });
  }
  waveScanY = 0;
  generating = true;
  progress = 0;
}

function waveStep() {
  const p = wavePreset,
    rowsPerFrame = 2;
  for (
    let row = 0;
    row < rowsPerFrame && waveScanY < artHeight;
    row++, waveScanY++
  ) {
    const y = waveScanY;
    for (let x = 0; x < artWidth; x++) {
      let sum = 0;
      for (let i = 0; i < waveSources.length; i++) {
        const s = waveSources[i];
        let d;
        if (p.mode === "concentric") {
          const dx = x - s.x,
            dy = y - s.y;
          d = Math.sqrt(dx * dx + dy * dy);
        } else if (p.mode === "linear") {
          d = (x - s.x) * Math.cos(s.angle) + (y - s.y) * Math.sin(s.angle);
        } else if (p.mode === "spiral") {
          const dx = x - s.x,
            dy = y - s.y;
          d = Math.sqrt(dx * dx + dy * dy) + Math.atan2(dy, dx) * 10;
        }
        let amp = 1;
        if (p.decay) {
          const dx = x - s.x,
            dy = y - s.y;
          amp = Math.max(
            0,
            1 - Math.sqrt(dx * dx + dy * dy) / Math.max(artWidth, artHeight),
          );
        }
        sum += Math.sin(d * s.freq + s.phase) * amp;
      }
      artBuf[y * artWidth + x] = bayerDither(
        x,
        y,
        (sum / waveSources.length + 1) * 0.5,
      );
    }
  }
  progress = waveScanY / artHeight;
  statusText = `SCAN: ${waveScanY}/${artHeight}`;
  if (waveScanY >= artHeight) {
    generating = false;
    progress = 1;
    statusText = `DONE - ${waveSources.length} SOURCES`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SPIRAL — 黄金螺旋 / フィボナッチ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 黄金角 (≈137.508°) に基づく点配置。
// ヒマワリの種・松ぼっくり・銀河の腕と同じ数学的構造。

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
let spiralPreset = null,
  spiralDone = 0;
let spiralSegments = null,
  spiralSegDone = 0;

/** seed 由来のゆらぎパラメータ (spiralInit で計算) */
let spiralPosJitter = 0;
let spiralSizeJitter = 0;
let spiralAngleOfs = 0;
let spiralLogTurns = 8;
let spiralLogB = 0.15;
let spiralHelixFreq = 4;

function spiralInit(preset, s) {
  spiralPreset = preset;
  seedRng(s);
  clearArt();
  spiralDone = 0;
  spiralSegments = null;
  spiralSegDone = 0;

  // ── seed から各モード共通のゆらぎを導出 ──
  spiralPosJitter = 1.0 + (rng() * 2 - 1) * 0.15; // 位置スケール ±15%
  spiralSizeJitter = 1.0 + (rng() * 2 - 1) * 0.25; // ドットサイズ ±25%
  spiralAngleOfs = (rng() * 2 - 1) * Math.PI * 0.3; // 全体回転 ±54°
  spiralLogTurns = 6 + rng() * 5; // log: 巻き数 6–11
  spiralLogB = 0.1 + rng() * 0.12; // log: 成長率
  spiralHelixFreq = 3 + rng() * 3; // helix: 周波数 3–6

  generating = true;
  progress = 0;
}

function spiralStep() {
  const p = spiralPreset;
  const cx = artWidth / 2,
    cy = artHeight / 2;
  const maxR = Math.min(artWidth, artHeight) * 0.47;

  // ── log モード: 対数螺旋を漸進描画 ──
  if (p.dotMode === "log") {
    if (!spiralSegments) {
      spiralSegments = [];
      const turns = spiralLogTurns,
        steps = 2000,
        a = 2,
        b = spiralLogB;
      const scale = maxR / (a * Math.exp(b * turns * Math.PI * 2));
      let px2 = 0,
        py2 = 0;
      for (let i = 0; i < steps; i++) {
        const theta = (i / steps) * turns * Math.PI * 2 + spiralAngleOfs;
        const r = a * Math.exp(b * theta);
        const x = cx + Math.cos(theta) * r * scale,
          y = cy + Math.sin(theta) * r * scale;
        if (i > 0) spiralSegments.push([px2, py2, x, y]);
        px2 = x;
        py2 = y;
      }
      spiralSegDone = 0;
    }
    const total = spiralSegments.length;
    const batch = Math.max(1, Math.ceil(total / 120));
    for (let i = 0; i < batch && spiralSegDone < total; i++, spiralSegDone++) {
      const seg = spiralSegments[spiralSegDone];
      artLine(seg[0], seg[1], seg[2], seg[3]);
    }
    progress = spiralSegDone / total;
    statusText = `SPIRAL: ${spiralSegDone}/${total}`;
    if (spiralSegDone >= total) {
      generating = false;
      progress = 1;
      statusText = "DONE - LOGARITHMIC SPIRAL";
      spiralSegments = null;
    }
    return;
  }

  // ── helix モード: 二重螺旋を漸進描画 ──
  if (p.dotMode === "helix") {
    if (!spiralSegments) {
      spiralSegments = [];
      const steps = 500,
        amplitude = maxR * 0.8 * spiralPosJitter,
        freq = spiralHelixFreq;
      for (let i = 0; i < steps; i++) {
        const t = i / steps,
          y2 = artHeight * 0.05 + t * artHeight * 0.9;
        const phase = t * Math.PI * 2 * freq + spiralAngleOfs;
        const sinP = Math.sin(phase),
          absHalf = Math.abs(Math.sin(phase * 0.5));
        const x1 = cx + sinP * amplitude * (0.15 + 0.85 * absHalf);
        const x2 = cx - sinP * amplitude * (0.15 + 0.85 * absHalf);
        spiralSegments.push({ x1, x2, y2, sinP, rung: i % 12 < 2 });
      }
      spiralSegDone = 0;
    }
    const total = spiralSegments.length;
    const batch = Math.max(1, Math.ceil(total / 120));
    for (let i = 0; i < batch && spiralSegDone < total; i++, spiralSegDone++) {
      const s = spiralSegments[spiralSegDone];
      const sz = spiralSizeJitter;
      artFillCircle(s.x1, s.y2, ((1 + (s.sinP + 1) * 1.5) * sz) | 0);
      artFillCircle(s.x2, s.y2, ((1 + (-s.sinP + 1) * 1.5) * sz) | 0);
      if (s.rung) artLine(s.x1, s.y2, s.x2, s.y2);
    }
    progress = spiralSegDone / total;
    statusText = `HELIX: ${spiralSegDone}/${total}`;
    if (spiralSegDone >= total) {
      generating = false;
      progress = 1;
      statusText = "DONE - DOUBLE HELIX";
      spiralSegments = null;
    }
    return;
  }

  // ── 通常モード (circle/trail/petal/cone): seed ゆらぎ付き ──
  const batch = Math.max(1, Math.ceil(p.numDots / 120));
  for (let b = 0; b < batch && spiralDone < p.numDots; b++, spiralDone++) {
    const i = spiralDone,
      theta = i * GOLDEN_ANGLE + spiralAngleOfs;
    const r = Math.sqrt(i / p.numDots) * maxR * p.baseR * spiralPosJitter;
    const x = cx + Math.cos(theta) * r,
      y = cy + Math.sin(theta) * r;
    if (p.dotMode === "circle") {
      artFillCircle(
        x,
        y,
        Math.max(1, ((r / maxR) * 4 * p.dotScale * spiralSizeJitter) | 0),
      );
    } else if (p.dotMode === "trail") {
      artPset(x, y);
      if (i > 0) {
        const pt = (i - 1) * GOLDEN_ANGLE + spiralAngleOfs,
          pr =
            Math.sqrt((i - 1) / p.numDots) * maxR * p.baseR * spiralPosJitter;
        const px = cx + Math.cos(pt) * pr,
          py = cy + Math.sin(pt) * pr;
        if ((x - px) * (x - px) + (y - py) * (y - py) < 400)
          artLine(px, py, x, y);
      }
    } else if (p.dotMode === "petal") {
      const petalR = Math.max(
        1,
        ((3 + (r / maxR) * 5) * p.dotScale * spiralSizeJitter) | 0,
      );
      for (let a = 0; a < 4; a++) {
        const pa = theta + (a * Math.PI) / 2;
        artPset(
          x + Math.cos(pa) * petalR * 0.5,
          y + Math.sin(pa) * petalR * 0.5,
        );
      }
      artCircle(x, y, petalR);
    } else if (p.dotMode === "cone") {
      artFillCircle(
        x,
        y,
        Math.max(
          1,
          ((1 - r / maxR) * 4 * p.dotScale * spiralSizeJitter + 1) | 0,
        ),
      );
    }
  }
  progress = spiralDone / p.numDots;
  statusText = `DOTS: ${spiralDone}/${p.numDots}`;
  if (spiralDone >= p.numDots) {
    generating = false;
    progress = 1;
    statusText = `DONE - ${p.numDots} DOTS`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AUTOMATA — 1D セルラーオートマトン → 2D 展開
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Wolfram の256の規則。Rule 30 (カオス), Rule 90 (フラクタル),
// Rule 110 (チューリング完全)。時間の矢が空間上に展開される。

let autoPreset = null,
  autoRow = null,
  autoScanY = 0;

function automataInit(preset, s) {
  autoPreset = preset;
  seedRng(s);
  clearArt();
  const w = artWidth; // サイズ変更に追従
  autoRow = new Uint8Array(w);
  if (preset.init === "center") {
    autoRow[w >> 1] = 1;
    // seed 由来のノイズ: 低確率で追加ビットを混入し、対称性を崩す。
    // 確率 1–3% — 構造の骨格 (center spike) は保ちつつ、
    // seed ごとに異なる枝分かれパターンが生まれる。
    const noiseProb = 0.01 + rng() * 0.02;
    for (let i = 0; i < w; i++) {
      if (i !== w >> 1 && rng() < noiseProb) autoRow[i] = 1;
    }
  } else {
    for (let i = 0; i < w; i++) autoRow[i] = rng() < 0.5 ? 1 : 0;
  }
  for (let x = 0; x < w && x < artWidth; x++) artBuf[x] = autoRow[x];
  autoScanY = 1;
  generating = true;
  progress = 0;
}

function automataStep() {
  const rule = autoPreset.rule,
    w = autoRow.length,
    rowsPerFrame = 2;
  for (
    let row = 0;
    row < rowsPerFrame && autoScanY < artHeight;
    row++, autoScanY++
  ) {
    const newRow = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      const left = x > 0 ? autoRow[x - 1] : autoRow[w - 1];
      const center = autoRow[x],
        right = x < w - 1 ? autoRow[x + 1] : autoRow[0];
      newRow[x] = (rule >> ((left << 2) | (center << 1) | right)) & 1;
    }
    autoRow = newRow;
    for (let x = 0; x < w && x < artWidth; x++)
      artBuf[autoScanY * artWidth + x] = autoRow[x];
  }
  progress = autoScanY / artHeight;
  statusText = `ROW: ${autoScanY}/${artHeight}`;
  if (autoScanY >= artHeight) {
    generating = false;
    progress = 1;
    statusText = `DONE - RULE ${autoPreset.rule}`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AA_PLASMA — ASCII Art プラズマ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// sin/cos 干渉の多重合成で生成したグレースケール値を、
// 文字の塗り面積率 (density) にマッピングして描く。
// ピクセルではなく「文字」が画素となる、もう一つの 1-bit 表現。
//
// 各レイヤーは seed 由来のランダムなパラメータ
// (周波数・位相・中心位置) を持ち、seed ごとに
// まったく異なる干渉模様が生まれる。

/** @type {string[]|null} AA 出力行 */
let aaLines = null;

/** AA キャンバスの列数・行数 */
let aaCols = 0,
  aaRows = 0;

/** レイヤーパラメータ配列 */
let plasmaLayers = null;

/** @type {{ ch: string, density: number }[]|null} 使用する tone ramp */
let plasmaRamp = null;

/** プラズマ漸進描画用 */
let plasmaScanRow = 0;
let plasmaPreset = null;
let plasmaGamma = 1.0;

/**
 * AA キャンバスの cols/rows をピクセルサイズから算出する。
 * 文字セルピッチ (CELL_W × CELL_H = 6×8) でキャンバス領域を割る。
 */
function calcAACols() {
  return Math.max(4, (artWidth / AsciiArt.CELL_W) | 0);
}
function calcAARows() {
  return Math.max(3, (artHeight / AsciiArt.CELL_H) | 0);
}

function plasmaInit(preset, s) {
  plasmaPreset = preset;
  seedRng(s);
  plasmaGamma = preset.gamma;

  aaCols = calcAACols();
  aaRows = calcAARows();
  aaLines = Array.from({ length: aaRows }, () => " ".repeat(aaCols));

  // tone ramp — カスタム文字列があればそちらを使う
  plasmaRamp = preset.chars
    ? AsciiArt.buildToneRamp(preset.chars)
    : AsciiArt.getDefaultRamp();

  // レイヤー生成: 各レイヤーに固有の周波数・位相・中心
  const nLayers = preset.layers;
  plasmaLayers = [];
  for (let i = 0; i < nLayers; i++) {
    plasmaLayers.push({
      freqX: preset.freqBase * (0.5 + rng() * 1.5),
      freqY: preset.freqBase * (0.5 + rng() * 1.5),
      phaseX: rng() * Math.PI * 2,
      phaseY: rng() * Math.PI * 2,
      cx: rng() * aaCols,
      cy: rng() * aaRows,
      radialFreq: preset.freqBase * (0.3 + rng() * 2.0),
      weight: 0.5 + rng() * 0.5,
    });
  }

  plasmaScanRow = 0;
  generating = true;
  progress = 0;
}

function plasmaStep() {
  if (!plasmaLayers || !plasmaRamp || !aaLines) return;
  const ramp = plasmaRamp;
  const invGamma = 1.0 / plasmaGamma;
  const layers = plasmaLayers;
  const nLayers = layers.length;

  // 1 フレームで数行ずつ漸進的に描画
  const rowsPerFrame = Math.max(1, Math.ceil(aaRows / 60));

  for (
    let i = 0;
    i < rowsPerFrame && plasmaScanRow < aaRows;
    i++, plasmaScanRow++
  ) {
    const r = plasmaScanRow;
    let line = "";

    for (let c = 0; c < aaCols; c++) {
      let sum = 0;
      for (let li = 0; li < nLayers; li++) {
        const L = layers[li];
        // sin/cos 干渉 + 放射成分
        const dx = c - L.cx,
          dy = r - L.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        sum +=
          L.weight *
          (Math.sin(c * L.freqX + L.phaseX) +
            Math.sin(r * L.freqY + L.phaseY) +
            Math.sin(dist * L.radialFreq));
      }

      // [-3*nLayers, +3*nLayers] → [0, 1]
      let v = (sum / (3 * nLayers) + 1) * 0.5;
      if (v < 0) v = 0;
      if (v > 1) v = 1;

      // ガンマ補正
      if (invGamma !== 1.0) v = v ** invGamma;

      line += AsciiArt.findNearest(ramp, v);
    }
    aaLines[r] = line;
  }

  progress = plasmaScanRow / aaRows;
  statusText = `ROW: ${plasmaScanRow}/${aaRows}`;
  if (plasmaScanRow >= aaRows) {
    generating = false;
    progress = 1;
    statusText = `DONE - ${aaCols}x${aaRows} CHARS`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AA_FLOW — ASCII フローフィールド
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// パーリンノイズの流れ場を文字で表現する。
// "dir" モード: 流れの角度に応じて方向性のある文字 (\ | / - 等) を選択。
// "density" モード: ノイズ値を文字の濃淡にマッピング。
// "mix" モード: 方向文字をベースに、ノイズ値で濃い/薄い文字を混ぜる。

/** 方向文字の配列 — 角度を 8 方位に量子化して選択 */
const DIR_CHARS = ["-", "\\", "|", "/", "-", "\\", "|", "/"];

let aaFlowPreset = null;
let aaFlowScanRow = 0;
let aaFlowRamp = null;

function aaFlowInit(preset, s) {
  aaFlowPreset = preset;
  seedRng(s);
  initNoise(s);

  aaCols = calcAACols();
  aaRows = calcAARows();
  aaLines = Array.from({ length: aaRows }, () => " ".repeat(aaCols));

  aaFlowRamp = preset.chars
    ? AsciiArt.buildToneRamp(preset.chars)
    : AsciiArt.getDefaultRamp();

  aaFlowScanRow = 0;
  generating = true;
  progress = 0;
}

function aaFlowStep() {
  if (!aaFlowPreset || !aaFlowRamp || !aaLines) return;
  const p = aaFlowPreset;
  const ramp = aaFlowRamp;
  const invGamma = 1.0 / p.gamma;
  const rowsPerFrame = Math.max(1, Math.ceil(aaRows / 60));

  for (
    let i = 0;
    i < rowsPerFrame && aaFlowScanRow < aaRows;
    i++, aaFlowScanRow++
  ) {
    const r = aaFlowScanRow;
    let line = "";

    for (let c = 0; c < aaCols; c++) {
      const nx = c * p.scale,
        ny = r * p.scale;
      const val = fbm(nx, ny, p.octaves); // -1..1

      if (p.mode === "dir") {
        // 角度を文字に変換
        const eps = 0.01;
        const dndx =
          fbm(nx + eps, ny, p.octaves) - fbm(nx - eps, ny, p.octaves);
        const dndy =
          fbm(nx, ny + eps, p.octaves) - fbm(nx, ny - eps, p.octaves);
        const angle = Math.atan2(dndy, dndx); // -PI..PI
        const idx = (((angle / Math.PI) * 4 + 8.5) | 0) % 8;
        line += DIR_CHARS[idx];
      } else if (p.mode === "mix") {
        // 方向文字 + ノイズ値で濃淡切替
        const eps = 0.01;
        const dndx =
          fbm(nx + eps, ny, p.octaves) - fbm(nx - eps, ny, p.octaves);
        const dndy =
          fbm(nx, ny + eps, p.octaves) - fbm(nx, ny - eps, p.octaves);
        const angle = Math.atan2(dndy, dndx);
        const mag = Math.sqrt(dndx * dndx + dndy * dndy);
        // 強い勾配 → 方向文字、弱い → density 文字
        if (mag > 0.005) {
          const idx = (((angle / Math.PI) * 4 + 8.5) | 0) % 8;
          line += DIR_CHARS[idx];
        } else {
          let v = (val + 1) * 0.5;
          if (v < 0) v = 0;
          if (v > 1) v = 1;
          if (invGamma !== 1.0) v = v ** invGamma;
          line += AsciiArt.findNearest(ramp, v);
        }
      } else {
        // density モード
        let v = (val + 1) * 0.5;
        if (v < 0) v = 0;
        if (v > 1) v = 1;
        if (invGamma !== 1.0) v = v ** invGamma;
        line += AsciiArt.findNearest(ramp, v);
      }
    }
    aaLines[r] = line;
  }

  progress = aaFlowScanRow / aaRows;
  statusText = `ROW: ${aaFlowScanRow}/${aaRows}`;
  if (aaFlowScanRow >= aaRows) {
    generating = false;
    progress = 1;
    statusText = `DONE - ${aaCols}x${aaRows} CHARS`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AA_RAIN — ASCII レイン (文字の雨)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 列ごとに独立した「雨粒」が上から下へ落ちていく。
// 各雨粒は先頭が最も濃い文字で、尾部に向かって薄くなる。
// 漸進描画: 毎フレーム雨粒が 1 ステップずつ落下し、
// 画面全体が文字で覆われたら完了。

/** 雨粒の状態 */
let rainDrops = null;
let rainPreset = null;
let rainRamp = null;
let rainGrid = null; // 2D 文字グリッド (各セルが文字)
let rainStep_count = 0;
let rainMaxSteps = 0;

function aaRainInit(preset, s) {
  rainPreset = preset;
  seedRng(s);

  aaCols = calcAACols();
  aaRows = calcAARows();
  aaLines = Array.from({ length: aaRows }, () => " ".repeat(aaCols));

  rainRamp = preset.chars
    ? AsciiArt.buildToneRamp(preset.chars)
    : AsciiArt.getDefaultRamp();

  // グリッド初期化 (0.0 = 空)
  rainGrid = new Float32Array(aaCols * aaRows);

  // 各列に雨粒を配置
  rainDrops = [];
  for (let c = 0; c < aaCols; c++) {
    if (rng() < preset.density) {
      rainDrops.push({
        col: c,
        row: -((rng() * aaRows) | 0), // 画面外上方からスタート
        speed: preset.speed * (0.5 + rng()),
        tailLen: preset.tailLen + ((rng() * 3) | 0) - 1,
        chars: _pickRainChars(rainRamp),
      });
    }
  }

  // 画面を埋め尽くすのに十分なステップ数
  rainMaxSteps = aaRows * 3 + 60;
  rainStep_count = 0;
  generating = true;
  progress = 0;
}

/** 雨粒用にランダムな文字列を生成する */
function _pickRainChars(ramp) {
  const len = 4 + ((rng() * 8) | 0);
  let s = "";
  for (let i = 0; i < len; i++) {
    const idx = (rng() * ramp.length) | 0;
    s += ramp[idx].ch;
  }
  return s;
}

function aaRainStep() {
  if (!rainDrops || !rainRamp || !rainGrid) return;
  const ramp = rainRamp;
  const p = rainPreset;
  const invGamma = 1.0 / p.gamma;
  const stepsPerFrame = 2;

  for (let step = 0; step < stepsPerFrame; step++) {
    rainStep_count++;

    // 各雨粒を更新
    for (let di = 0; di < rainDrops.length; di++) {
      const d = rainDrops[di];
      d.row += d.speed;

      // 先頭 + テールを書き込み
      for (let t = 0; t <= d.tailLen; t++) {
        const r = (d.row - t) | 0;
        if (r < 0 || r >= aaRows) continue;
        // 先頭が最も明るく (density=1)、テール端は暗い (density→0)
        const brightness = 1.0 - t / d.tailLen;
        const gi = r * aaCols + d.col;
        if (brightness > rainGrid[gi]) rainGrid[gi] = brightness;
      }

      // 画面下端を超えたら再生成 (新しい列・速度で)
      if ((d.row | 0) - d.tailLen > aaRows) {
        d.col = (rng() * aaCols) | 0;
        d.row = -((rng() * (aaRows * 0.3)) | 0);
        d.speed = p.speed * (0.5 + rng());
        d.tailLen = p.tailLen + ((rng() * 3) | 0) - 1;
        d.chars = _pickRainChars(ramp);
      }
    }

    // rainGrid → aaLines
    for (let r = 0; r < aaRows; r++) {
      let line = "";
      for (let c = 0; c < aaCols; c++) {
        let v = rainGrid[r * aaCols + c];
        if (v < 0) v = 0;
        if (v > 1) v = 1;
        if (invGamma !== 1.0 && v > 0) v = v ** invGamma;
        line += AsciiArt.findNearest(ramp, v);
      }
      aaLines[r] = line;
    }
  }

  progress = Math.min(1, rainStep_count / rainMaxSteps);
  statusText = `STEP: ${rainStep_count}`;
  if (rainStep_count >= rainMaxSteps) {
    generating = false;
    progress = 1;
    statusText = `DONE - ${aaCols}x${aaRows} CHARS`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AA_GRID — ASCII グリッドテッセレーション
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 数理パターン関数 (波動、チェッカー、ダイヤモンド、ノイズ) で
// 各セルの値を決定し、文字の濃淡にマッピングする。
// パターン関数は seed でパラメータが変わるため、
// 同じプリセットでも無限のバリエーションが生まれる。

let aaGridPreset = null;
let aaGridScanRow = 0;
let aaGridRamp = null;
/** seed 由来の乱数パラメータ */
let aaGridParams = null;

function aaGridInit(preset, s) {
  aaGridPreset = preset;
  seedRng(s);
  initNoise(s);

  aaCols = calcAACols();
  aaRows = calcAARows();
  aaLines = Array.from({ length: aaRows }, () => " ".repeat(aaCols));

  aaGridRamp = preset.chars
    ? AsciiArt.buildToneRamp(preset.chars)
    : AsciiArt.getDefaultRamp();

  // seed 由来のパラメータ
  aaGridParams = {
    phaseX: rng() * Math.PI * 2,
    phaseY: rng() * Math.PI * 2,
    freqMod: 0.5 + rng() * 1.5,
    offsetX: rng() * 100,
    offsetY: rng() * 100,
    stripeAngle: rng() * Math.PI,
  };

  aaGridScanRow = 0;
  generating = true;
  progress = 0;
}

function _gridValue(patFn, c, r, freq, params) {
  switch (patFn) {
    case "wave": {
      const v1 = Math.sin(c * freq * params.freqMod + params.phaseX);
      const v2 = Math.sin(r * freq + params.phaseY);
      const v3 = Math.sin((c + r) * freq * 0.7 + params.phaseX * 0.5);
      return ((v1 + v2 + v3) / 3) * 0.5 + 0.5;
    }
    case "checker": {
      const size = Math.max(2, (4 + rng() * 4) | 0);
      const cx = ((c + params.offsetX) / size) | 0;
      const cy = ((r + params.offsetY) / size) | 0;
      return (cx + cy) % 2 === 0 ? 0.8 : 0.2;
    }
    case "diamond": {
      const dx = Math.abs(c - aaCols / 2);
      const dy = Math.abs(r - aaRows / 2);
      const d = (dx + dy) * freq + params.phaseX;
      return Math.sin(d) * 0.5 + 0.5;
    }
    case "noise": {
      const v = fbm(
        (c + params.offsetX) * freq,
        (r + params.offsetY) * freq,
        3,
      );
      return v * 0.5 + 0.5;
    }
    default:
      return 0.5;
  }
}

function aaGridStep() {
  if (!aaGridPreset || !aaGridRamp || !aaLines) return;
  const p = aaGridPreset;
  const ramp = aaGridRamp;
  const invGamma = 1.0 / p.gamma;
  const params = aaGridParams;
  const rowsPerFrame = Math.max(1, Math.ceil(aaRows / 60));

  for (
    let i = 0;
    i < rowsPerFrame && aaGridScanRow < aaRows;
    i++, aaGridScanRow++
  ) {
    const r = aaGridScanRow;
    let line = "";

    for (let c = 0; c < aaCols; c++) {
      let v = _gridValue(p.patFn, c, r, p.freq, params);
      if (v < 0) v = 0;
      if (v > 1) v = 1;
      if (invGamma !== 1.0) v = v ** invGamma;
      line += AsciiArt.findNearest(ramp, v);
    }
    aaLines[r] = line;
  }

  progress = aaGridScanRow / aaRows;
  statusText = `ROW: ${aaGridScanRow}/${aaRows}`;
  if (aaGridScanRow >= aaRows) {
    generating = false;
    progress = 1;
    statusText = `DONE - ${aaCols}x${aaRows} CHARS`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AA_LAND — ASCII ランドスケープ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// fbm (fractal Brownian motion) で地形の高さマップを生成し、
// 標高を文字の濃淡にマッピングする。
// 海面 (seaLevel) 以下は空白にして海を表現。
// 稜線付近にコントラストが集中する地形的テクスチャ。

let aaLandPreset = null;
let aaLandScanRow = 0;
let aaLandRamp = null;
let aaLandOffX = 0,
  aaLandOffY = 0;

function aaLandInit(preset, s) {
  aaLandPreset = preset;
  seedRng(s);
  initNoise(s);

  aaCols = calcAACols();
  aaRows = calcAARows();
  aaLines = Array.from({ length: aaRows }, () => " ".repeat(aaCols));

  aaLandRamp = preset.chars
    ? AsciiArt.buildToneRamp(preset.chars)
    : AsciiArt.getDefaultRamp();

  // seed 由来のオフセット — 同じ地形を二度と見ない
  aaLandOffX = rng() * 1000;
  aaLandOffY = rng() * 1000;

  aaLandScanRow = 0;
  generating = true;
  progress = 0;
}

function aaLandStep() {
  if (!aaLandPreset || !aaLandRamp || !aaLines) return;
  const p = aaLandPreset;
  const ramp = aaLandRamp;
  const invGamma = 1.0 / p.gamma;
  const rowsPerFrame = Math.max(1, Math.ceil(aaRows / 60));

  for (
    let i = 0;
    i < rowsPerFrame && aaLandScanRow < aaRows;
    i++, aaLandScanRow++
  ) {
    const r = aaLandScanRow;
    let line = "";

    for (let c = 0; c < aaCols; c++) {
      const nx = (c + aaLandOffX) * p.scale;
      const ny = (r + aaLandOffY) * p.scale;
      const raw = fbm(nx, ny, p.octaves); // -1..1
      let h = (raw + 1) * 0.5; // 0..1

      if (h < p.seaLevel) {
        // 海面以下 — ランプの最も明るい (density 最小の) 文字
        line += ramp[0].ch;
      } else {
        // 標高を seaLevel..1 → 0..1 に再マッピング
        let v = (h - p.seaLevel) / (1 - p.seaLevel);
        if (v > 1) v = 1;
        if (invGamma !== 1.0) v = v ** invGamma;
        line += AsciiArt.findNearest(ramp, v);
      }
    }
    aaLines[r] = line;
  }

  progress = aaLandScanRow / aaRows;
  statusText = `ROW: ${aaLandScanRow}/${aaRows}`;
  if (aaLandScanRow >= aaRows) {
    generating = false;
    progress = 1;
    statusText = `DONE - ${aaCols}x${aaRows} CHARS`;
  }
}

/** 現在のアルゴリズムが AA 系かどうかを返す */
function isAAAlgo() {
  return ALGO_KEYS[currentAlgoIdx].startsWith("aa_");
}

function startGeneration() {
  const algoKey = ALGO_KEYS[currentAlgoIdx];
  const preset = PRESETS[algoKey][currentPresetIdx];
  generating = false;
  progress = 0;
  switch (algoKey) {
    case "flow":
      flowInit(preset, seed);
      break;
    case "react":
      reactInit(preset, seed);
      break;
    case "attract":
      attractInit(preset, seed);
      break;
    case "dla":
      dlaInit(preset, seed);
      break;
    case "lsys":
      lsysInit(preset, seed);
      break;
    case "voronoi":
      voronoiInit(preset, seed);
      break;
    case "wave":
      waveInit(preset, seed);
      break;
    case "spiral":
      spiralInit(preset, seed);
      break;
    case "automata":
      automataInit(preset, seed);
      break;
    case "aa_plasma":
      plasmaInit(preset, seed);
      break;
    case "aa_flow":
      aaFlowInit(preset, seed);
      break;
    case "aa_rain":
      aaRainInit(preset, seed);
      break;
    case "aa_grid":
      aaGridInit(preset, seed);
      break;
    case "aa_land":
      aaLandInit(preset, seed);
      break;
  }
}

function stepGeneration() {
  if (!generating) return;
  switch (ALGO_KEYS[currentAlgoIdx]) {
    case "flow":
      flowStep();
      break;
    case "react":
      reactStep();
      break;
    case "attract":
      attractStep();
      break;
    case "dla":
      dlaStep();
      break;
    case "lsys":
      lsysStep();
      break;
    case "voronoi":
      voronoiStep();
      break;
    case "wave":
      waveStep();
      break;
    case "spiral":
      spiralStep();
      break;
    case "automata":
      automataStep();
      break;
    case "aa_plasma":
      plasmaStep();
      break;
    case "aa_flow":
      aaFlowStep();
      break;
    case "aa_rain":
      aaRainStep();
      break;
    case "aa_grid":
      aaGridStep();
      break;
    case "aa_land":
      aaLandStep();
      break;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  自動シャッフル
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function autoNext() {
  seed = (Math.random() * 10000) | 0;
  if (nbSeed) nbSeed.value = seed;
  seedRng(seed + 7777);
  currentAlgoIdx = rngInt(0, ALGO_KEYS.length - 1);
  currentPresetIdx = rngInt(0, PRESETS[ALGO_KEYS[currentAlgoIdx]].length - 1);
  buildToolbar();
  startGeneration();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ツールバー (2行構成)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {UI.WidgetGroup} */
let toolbar;
let toolbarRoot;
let ddAlgo, ddPreset, lblSeed, nbSeed, btnDice, btnGen, tglInvert, tglAuto;
let ddSize, nbArtW, nbArtH, ddScale, btnSave, btnFile;
let toolbarH = 0;

const BTN_PAD = 8,
  BTN_BORDER = 4;

function buildToolbar() {
  const presetNames = PRESETS[ALGO_KEYS[currentAlgoIdx]].map((p) => p.name);

  ddAlgo = new UI.DropDown(0, 0, ALGO_NAMES, currentAlgoIdx, (i) => {
    currentAlgoIdx = i;
    currentPresetIdx = 0;
    // AA 系に切り替わったらセル倍数にスナップ
    applyArtSize(artWidth, artHeight);
    buildToolbar();
  });

  ddPreset = new UI.DropDown(0, 0, presetNames, currentPresetIdx, (i) => {
    currentPresetIdx = i;
    startGeneration();
  });

  lblSeed = new UI.Label(0, 0, "SEED:");
  nbSeed = new UI.NumberBox(0, 0, 0, 9999, seed, 1);

  btnDice = new UI.PushButton(0, 0, "", () => {
    seed = (Math.random() * 10000) | 0;
    nbSeed.value = seed;
    startGeneration();
  });
  btnDice.icon = "dice";
  btnDice.w = ICON_W + BTN_PAD + BTN_BORDER;
  btnDice.h = ICON_H + BTN_PAD + BTN_BORDER;
  btnDice.tooltip = "Random seed";

  btnGen = new UI.PushButton(0, 0, "GEN", () => {
    seed = nbSeed.value;
    startGeneration();
  });
  btnGen.tooltip = "Generate";

  tglInvert = new UI.ToggleButton(
    0,
    0,
    "INV",
    (v) => {
      invertMode = v;
    },
    invertMode,
  );
  tglInvert.tooltip = "Invert colors";

  // AUTO シャッフル: STUDIO/LIFE と同じ play/pause アイコンのトランスポート流儀。
  tglAuto = new UI.ToggleButton(
    0,
    0,
    "",
    (v) => {
      autoMode = v;
      tglAuto.icon = v ? "pause" : "play";
      autoTimer = 0;
    },
    autoMode,
  );
  tglAuto.icon = autoMode ? "pause" : "play";
  tglAuto.w = ICON_W + BTN_PAD + BTN_BORDER;
  tglAuto.h = ICON_H + BTN_PAD + BTN_BORDER;
  tglAuto.tooltip = "Auto shuffle (play/pause)";

  // ── サイズ ──
  const sizeLabels = SIZE_PRESETS.map((s) => s.label);
  ddSize = new UI.DropDown(0, 0, sizeLabels, currentSizeIdx, (i) => {
    currentSizeIdx = i;
    const sp = SIZE_PRESETS[i];
    if (sp.w > 0) {
      applyArtSize(sp.w, sp.h);
    } else if (sp.w === 0) {
      applyArtSize(VRAM_WIDTH, VRAM_HEIGHT); // SCREEN
    }
    // CUSTOM (w=-1) 選択時は W/H NumberBox の現在値をそのまま使用
  });
  ddSize.tooltip = "Canvas size preset";

  // CUSTOM サイズ用の W/H 直接入力 (SNS 向け正方形など任意寸法)。
  nbArtW = new UI.NumberBox(0, 0, ART_W_MIN, ART_W_MAX, artWidth, 1, (v) => {
    currentSizeIdx = SIZE_CUSTOM_IDX;
    ddSize.selectedIndex = SIZE_CUSTOM_IDX;
    applyArtSize(v, nbArtH.value);
  });
  nbArtW.tooltip = "Canvas width";
  nbArtH = new UI.NumberBox(0, 0, ART_H_MIN, ART_H_MAX, artHeight, 1, (v) => {
    currentSizeIdx = SIZE_CUSTOM_IDX;
    ddSize.selectedIndex = SIZE_CUSTOM_IDX;
    applyArtSize(nbArtW.value, v);
  });
  nbArtH.tooltip = "Canvas height";

  const scaleLabels = EXPORT_SCALES.map((s) => `x${s}`);
  ddScale = new UI.DropDown(
    0,
    0,
    scaleLabels,
    EXPORT_SCALES.indexOf(exportScale),
    (i) => {
      exportScale = EXPORT_SCALES[i];
    },
  );
  ddScale.tooltip = "Export scale";

  // PC へ書き出す (PNG) = DOWNLOAD / SYNESTA 内に保存 (PBM→VFS) = SAVE。
  // 旧 "SAVE"/"FILE" は違いが分かりにくかったため明確化。
  btnSave = new UI.PushButton(0, 0, "DOWNLOAD", () => {
    saveArtAsPng();
  });
  btnSave.tooltip = "Download as PNG to your computer";

  btnFile = new UI.PushButton(0, 0, "SAVE", () => {
    saveArtToVfs();
  });
  btnFile.tooltip = "Save as PBM to the SYNESTA disk (VFS)";

  // ── レイアウト ──
  // 無ラベルだと FLOW/SILK/256X192 が何の設定か初見で分からないため、各グループに
  // ラベルを付けて整理する (近接: ラベル + 行で機能をまとめる)。
  const lblAlgo = new UI.Label(0, 0, "ALGO:");
  const lblStyle = new UI.Label(0, 0, "STYLE:");
  const lblSize = new UI.Label(0, 0, "SIZE:");
  const lblWH = new UI.Label(0, 0, "X");
  // 1行目: 何を作るか
  const row1 = UI.HBox([lblAlgo, ddAlgo, lblStyle, ddPreset]);
  // 2行目: 生成 (seed + トランスポート auto/GEN + 反転)
  const row2 = UI.HBox([lblSeed, nbSeed, btnDice, tglAuto, btnGen, tglInvert]);
  // 3行目: サイズ (preset + W×H) + 書き出し (倍率 + DOWNLOAD/SAVE)
  const row3 = UI.HBox([
    lblSize,
    ddSize,
    nbArtW,
    lblWH,
    nbArtH,
    ddScale,
    btnSave,
    btnFile,
  ]);
  toolbarRoot = UI.VBox([row1, row2, row3]);
  toolbar = new UI.WidgetGroup(toolbarRoot);
  toolbarH = toolbarRoot.y + toolbarRoot.h;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WM コールバック
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDraw(contentRect) {
  if (generating) stepGeneration();

  // 自動送り
  if (autoMode && !generating) {
    autoTimer++;
    if (autoTimer >= AUTO_INTERVAL) {
      autoTimer = 0;
      autoNext();
    }
  }

  toolbar.draw(contentRect);

  // キャンバスの左端をツールバー (FOCUS_MARGIN 起点) に揃える。
  // 以前は contentRect.x 起点で、ツールバーより FOCUS_MARGIN px 左にずれていた。
  const ax = contentRect.x + UI.FOCUS_MARGIN;
  const cx = ax + 1,
    cy = contentRect.y + toolbarH + CANVAS_GAP + 1;
  GPU.drawRect(
    ax,
    contentRect.y + toolbarH + CANVAS_GAP,
    artWidth + 2,
    artHeight + 2,
    1,
  );
  GPU.fillRect(cx, cy, artWidth, artHeight, 0);

  if (isAAAlgo() && aaLines) {
    // AA 描画パス: 文字列配列を直接描画
    const color = invertMode ? 0 : 1;
    if (invertMode) GPU.fillRect(cx, cy, artWidth, artHeight, 1);
    AsciiArt.drawAsciiArt(aaLines, cx, cy, color);
  } else {
    // ピクセル描画パス
    GPU.blit(artBuf, artWidth, artHeight, cx, cy, 1);
    if (invertMode) GPU.invertRect(cx, cy, artWidth, artHeight);
  }

  if (generating) {
    const barW = artWidth + 2,
      barH = 3,
      barX = ax,
      barY = cy + artHeight + 2;
    GPU.fillRect(barX, barY, barW, barH, 0);
    GPU.drawRect(barX, barY, barW, barH, 1);
    const filled = ((barW - 2) * progress) | 0;
    if (filled > 0) GPU.fillRect(barX + 1, barY + 1, filled, barH - 2, 1);
  }

  if (autoMode && !generating) {
    const secs = ((AUTO_INTERVAL - autoTimer) / 60).toFixed(1);
    const txt = `NEXT: ${secs}s`;
    const tw = textWidth(txt);
    const ty = cy + artHeight - GLYPH_H - 2,
      tx = cx + artWidth - tw - 2;
    // 背景を描いてからテキスト
    GPU.fillRect(tx - 1, ty - 1, tw + 2, GLYPH_H + 2, invertMode ? 1 : 0);
    drawText(tx, ty, txt, invertMode ? 0 : 1);
  }
}

function onInput(ev) {
  toolbar.update(ev);
}

function onMeasure() {
  const tbSize = toolbar.measure();
  return {
    w: Math.max(tbSize.w, UI.FOCUS_MARGIN + artWidth + 2),
    h: toolbarH + CANVAS_GAP + artHeight + 2 + 6,
  };
}

function onDrawFooter(footerRect) {
  drawText(footerRect.x, footerRect.y, statusText, 1);
  const res = isAAAlgo()
    ? aaCols + "x" + aaRows + "CH"
    : artWidth + "x" + artHeight;
  const algoLabel =
    ALGO_NAMES[currentAlgoIdx] +
    ":" +
    PRESETS[ALGO_KEYS[currentAlgoIdx]][currentPresetIdx].name +
    " " +
    res;
  const rw = textWidth(algoLabel);
  drawText(footerRect.x + footerRect.w - rw, footerRect.y, algoLabel, 1);
}

function onBeforeClose() {
  generating = false;
  progress = 0;
  statusText = "";
  currentAlgoIdx = 0;
  currentPresetIdx = 0;
  seed = (Math.random() * 10000) | 0;
  invertMode = false;
  autoMode = false;
  autoTimer = 0;
  currentSizeIdx = 0;
  exportScale = 2;
  resizeArt(SIZE_PRESETS[0].w, SIZE_PRESETS[0].h);
  rdU = rdV = rdNU = rdNV = null;
  attrDensity = null;
  dlaGrid = null;
  vorPoints = null;
  waveSources = null;
  flowDensity = null;
  lsysSegments = null;
  spiralSegments = null;
  aaLines = null;
  plasmaLayers = null;
  plasmaRamp = null;
  aaFlowPreset = null;
  aaFlowRamp = null;
  rainDrops = null;
  rainPreset = null;
  rainRamp = null;
  rainGrid = null;
  aaGridPreset = null;
  aaGridRamp = null;
  aaGridParams = null;
  aaLandPreset = null;
  aaLandRamp = null;
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    buildToolbar();
    seed = nbSeed.value;
    const id = wmOpen(-1, -1, 0, 0, APP_NAME, onDraw, onInput, onMeasure, {
      about:
        "Generative art. Choose an algorithm and preset, set a seed, and " +
        "generate — the same rules yield endless variations.",
      footer: true,
      onDrawFooter,
      onBeforeClose,
      onRelayout: () => {
        toolbar.remeasureAll();
        toolbarRoot.layout(UI.FOCUS_MARGIN, UI.FOCUS_MARGIN);
      },
    });
    startGeneration();
    return id;
  },
  { category: "CREATIVE" },
);

