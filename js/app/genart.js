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
 * ─── アルゴリズム と レンダーモード ───
 * アルゴリズムは「何を生むか」、レンダーモードは「どう見せるか」を分離する。
 *   - 構造系 (線・粒子・凝集) … FLOW / ATTRACT / DLA / LSYS / SPIRAL / AUTOMATA
 *       ストロークを直接ピクセルに刻む。DOT 専用・一回生成。
 *   - 場系 (スカラー場 f(x,y) ∈ [0,1]) … REACT / VORONOI / WAVE /
 *       PLASMA / DRIFT / GRID / LAND
 *       場を fieldBuf に書き、共通レンダラが DOT (Bayer ディザ) か
 *       ASCII (tone ramp) に変換する。両モード対応。
 *   - RAIN … 文字が降り積もるデジタルの雨。文字そのものが主役ゆえ ASCII 専用。
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
 *   PLASMA   — sin/cos 干渉の多重合成が描くサイケデリックな紋様
 *   DRIFT    — パーリンノイズ密度場の漂い (時間で流れる雲)
 *   RAIN     — 文字が降り注ぎ積もっていくデジタルの雨 (ASCII 専用)
 *   GRID     — 数理パターンが決定するタイルのテッセレーション
 *   LAND     — fbm 地形の高さマップが描く風景
 *
 * 構成:
 *   - ツールバー (3行): アルゴリズム/スタイル/レンダー, シード/生成/反転, サイズ/書き出し
 *   - キャンバス: 可変サイズのアートキャンバス (リアルタイム漸進描画)
 *     ASCII レンダーでは文字セル単位で描画
 *   - フッター: 進捗, 出力解像度
 */

import { VRAM_WIDTH, VRAM_HEIGHT, palette } from "../config.js";
import * as GPU from "../core/gpu.js";
import { encodeGif } from "../core/gif.js";
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

/** アートキャンバスサイズ (可変)。既定 16:9 320x180 (ツールバー幅と一致し横長 SNS 向き) */
let artWidth = 320;
let artHeight = 180;

/**
 * アスペクト比プリセット (w:h)。サイズは「比率 → 寸法」で指定する。
 * 比率を選ぶと W/H が連動し、FREE は W/H を独立指定できる。
 * 黄金比 (PHI) / 白銀比 (SQRT2) など美的な比率も用意。
 */
const ASPECT_RATIOS = [
  { label: "1:1", w: 1, h: 1 },
  { label: "4:3", w: 4, h: 3 },
  { label: "3:4", w: 3, h: 4 },
  { label: "16:9", w: 16, h: 9 },
  { label: "9:16", w: 9, h: 16 },
  { label: "PHI", w: 1618, h: 1000 }, // 黄金比 ≈ 1.618
  { label: "SQRT2", w: 1414, h: 1000 }, // 白銀比 ≈ 1.414
  { label: "FREE", w: 0, h: 0 }, // W/H 独立
];
let currentRatioIdx = 3; // 16:9

/** キャンバスサイズの許容範囲 (ドット絵向けに小さい値も許容) */
const ART_W_MIN = 8,
  ART_W_MAX = 800;
const ART_H_MIN = 8,
  ART_H_MAX = 600;

/** ツールバーとキャンバスの間の間隔 */
const CANVAS_GAP = 4;

/** 書き出し設定: 形式 (PNG/GIF) + 倍率 (自由整数。2 のべき乗に縛らない) */
const EXPORT_FORMAT_LABELS = ["PNG", "GIF"];
let exportFormatIdx = 0; // 0=PNG, 1=GIF
let exportScale = 8; // 倍率 (小さいドット絵を SNS 解像度へ拡大)
const EXPORT_SCALE_MIN = 1,
  EXPORT_SCALE_MAX = 32;

// ── GIF 録画 (生成過程をキャプチャ) ──
const GIF_FRAME_COUNT = 30; // 生成過程を約 30 フレームでサンプル
const GIF_FPS = 12;
let gifRecording = false;
/** @type {Uint8Array[]} 生成中の artBuf スナップショット */
let gifFrames = [];
let gifNextSample = 0; // 次にサンプルする progress 閾値
let gifScale = 8;
let gifLoopFrame = 0; // アニメ算法のループ GIF 用フレームカウンタ

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
  "plasma",
  "drift",
  "rain",
  "grid",
  "land",
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
  "PLASMA",
  "DRIFT",
  "RAIN",
  "GRID",
  "LAND",
];

/**
 * 各アルゴリズムが対応するレンダーモード。
 *   "dot"   — 1bit ピクセル (Bayer ディザ)。GIF 書き出し可。
 *   "ascii" — 文字セル (tone ramp 濃淡)。
 * 構造系は DOT 専用、場系は両対応、RAIN は ASCII 専用。
 * 先頭要素が既定モード。
 */
const ALGO_MODES = {
  flow: ["dot"],
  react: ["dot", "ascii"],
  attract: ["dot"],
  dla: ["dot"],
  lsys: ["dot"],
  voronoi: ["dot", "ascii"],
  wave: ["dot", "ascii"],
  spiral: ["dot"],
  automata: ["dot"],
  plasma: ["dot", "ascii"],
  drift: ["dot", "ascii"],
  rain: ["ascii"],
  grid: ["dot", "ascii"],
  land: ["dot", "ascii"],
};

/** 場 (fieldBuf) パイプラインを使うアルゴリズム (RAIN は文字を直接書くため除外) */
const FIELD_ALGOS = new Set([
  "react",
  "voronoi",
  "wave",
  "plasma",
  "drift",
  "grid",
  "land",
]);

/** 現在のレンダーモード ("dot" | "ascii")。ALGO_MODES の制約下で選択される。 */
let renderMode = "dot";

const RENDER_LABELS = { dot: "DOT", ascii: "ASCII" };

/**
 * 連続アニメ (時間発展) する場アルゴリズム。
 * 場を時刻 t∈[0,2π) で毎フレーム再計算し、常に動き続ける「生きたキャンバス」。
 * 位相を進める (plasma/grid/wave) か、ノイズ標本点を円運動させる (drift/land) ことで
 * t が一周すると元に戻る ＝ 周期的 ＝ シームレスにループする (GIF ループの素地)。
 * 構造系・VORONOI・REACT・RAIN は一回生成 (時間発展しない)。
 */
const ANIM_ALGOS = new Set(["plasma", "drift", "grid", "land", "wave"]);
/** アニメ 1 周期のフレーム数 (≈3秒@60fps)。GIF ループもこの周期で撮る。 */
const ANIM_PERIOD = 180;
const ANIM_DT = (Math.PI * 2) / ANIM_PERIOD;
/** drift/land のノイズ標本点を円運動させる半径 (セル単位) — 場がゆっくり漂う */
const DRIFT_ANIM_RADIUS = 6;
const LAND_ANIM_RADIUS = 5;
/** アニメの現在時刻 t∈[0,2π) */
let animTime = 0;

function isAnimated() {
  return ANIM_ALGOS.has(ALGO_KEYS[currentAlgoIdx]);
}

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
  plasma: [
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
  drift: [
    { name: "CLOUD", scale: 0.05, octaves: 3, gamma: 1.0, chars: "" },
    { name: "BREEZE", scale: 0.08, octaves: 2, gamma: 1.1, chars: "" },
    { name: "TORRENT", scale: 0.15, octaves: 4, gamma: 0.8, chars: "" },
    { name: "VEIL", scale: 0.03, octaves: 2, gamma: 1.3, chars: " .:-=+" },
    { name: "DIGITS", scale: 0.1, octaves: 2, gamma: 1.0, chars: "0123456789" },
    { name: "DENSE", scale: 0.06, octaves: 5, gamma: 0.7, chars: "" },
  ],
  rain: [
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
  grid: [
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
  land: [
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
 * ASCII レンダー時はセルピッチ (CELL_W × CELL_H) の倍数にスナップし、
 * 文字グリッドがキャンバス領域にぴったり収まるようにする。
 * NumberBox の表示値も同期し、ツールバーを再構築して再生成を開始する。
 */
function applyArtSize(w, h) {
  if (renderMode === "ascii") {
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

// ── アスペクト比 → 寸法 ──
// 比率を選ぶと W/H が連動する。FREE (w=0) は W/H を独立指定。

/** 比率変更時: 現在の幅を基準に高さを合わせる */
function applyRatio() {
  const r = ASPECT_RATIOS[currentRatioIdx];
  if (r.w === 0) return; // FREE: 現状維持
  applyArtSize(artWidth, Math.round((artWidth * r.h) / r.w));
}

/** 幅変更時: 比率に従って高さを算出 (FREE なら高さ据え置き) */
function applyRatioFromWidth(w) {
  const r = ASPECT_RATIOS[currentRatioIdx];
  if (r.w === 0) applyArtSize(w, nbArtH.value);
  else applyArtSize(w, Math.round((w * r.h) / r.w));
}

/** 高さ変更時: 比率に従って幅を算出 (FREE なら幅据え置き) */
function applyRatioFromHeight(h) {
  const r = ASPECT_RATIOS[currentRatioIdx];
  if (r.w === 0) applyArtSize(nbArtW.value, h);
  else applyArtSize(Math.round((h * r.w) / r.h), h);
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
//  場 (field) フレームワーク
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 場系アルゴリズムは fieldBuf (0..1 のスカラー値) を「描画対象の解像度」で埋め、
// 共通レンダラ commitField() が DOT (Bayer ディザ) か ASCII (tone ramp) に変換する。
// 座標系はアルゴリズムのネイティブ空間を保つことで、DOT/ASCII どちらでも
// 模様の細かさ (周波数) が一致する:
//   - セル座標ネイティブ (plasma/drift/grid/land) … fieldCellX/Y を使う
//   - ピクセル座標ネイティブ (wave/voronoi)        … fieldPixelX/Y を使う
//   - シミュ格子 (react)                          … 格子を fieldBuf に再標本化

/** @type {Float32Array|null} 場のスカラー値 (描画対象解像度) */
let fieldBuf = null;
/** 場の解像度。DOT は artWidth×artHeight、ASCII は aaCols×aaRows。 */
let fieldCols = 0,
  fieldRows = 0;
/** ASCII レンダー用の現在の tone ramp */
let currentRamp = null;

/** 現在のモードに応じて場の寸法を決め、fieldBuf (と ASCII なら aaLines/ramp) を確保 */
function allocField(rampChars) {
  if (renderMode === "ascii") {
    aaCols = calcAACols();
    aaRows = calcAARows();
    fieldCols = aaCols;
    fieldRows = aaRows;
    aaLines = Array.from({ length: aaRows }, () => " ".repeat(aaCols));
    currentRamp = rampChars
      ? AsciiArt.buildToneRamp(rampChars)
      : AsciiArt.getDefaultRamp();
  } else {
    fieldCols = artWidth;
    fieldRows = artHeight;
    currentRamp = null;
  }
  fieldBuf = new Float32Array(fieldCols * fieldRows);
}

// セル座標ネイティブ: fieldBuf の列/行インデックス → 連続セル座標。
// ASCII では 1 セル = 1 文字、DOT では 1 セル = CELL_W×CELL_H ピクセル。
function fieldCellX(c) {
  return renderMode === "ascii" ? c : c / AsciiArt.CELL_W;
}
function fieldCellY(r) {
  return renderMode === "ascii" ? r : r / AsciiArt.CELL_H;
}
// ピクセル座標ネイティブ: 源・母点は常にピクセル空間 [0,artWidth]×[0,artHeight]。
// ASCII ではセル中心のピクセル座標で標本化する。
function fieldPixelX(c) {
  return renderMode === "ascii" ? (c + 0.5) * AsciiArt.CELL_W : c;
}
function fieldPixelY(r) {
  return renderMode === "ascii" ? (r + 0.5) * AsciiArt.CELL_H : r;
}

/** fieldBuf → 出力 (DOT:artBuf / ASCII:aaLines)。場系の各ステップ末尾で呼ぶ。 */
function commitField() {
  if (!fieldBuf) return;
  if (renderMode === "ascii") {
    const ramp = currentRamp || AsciiArt.getDefaultRamp();
    for (let r = 0; r < fieldRows; r++) {
      let line = "";
      const base = r * fieldCols;
      for (let c = 0; c < fieldCols; c++) {
        let v = fieldBuf[base + c];
        if (v < 0) v = 0;
        else if (v > 1) v = 1;
        line += AsciiArt.findNearest(ramp, v);
      }
      aaLines[r] = line;
    }
  } else {
    for (let y = 0; y < fieldRows; y++) {
      const base = y * fieldCols;
      for (let x = 0; x < fieldCols; x++) {
        artBuf[base + x] = bayerDither(x, y, fieldBuf[base + x]);
      }
    }
  }
}

/** 場系アルゴリズムか (fieldBuf パイプラインを使うか) */
function usesField() {
  return FIELD_ALGOS.has(ALGO_KEYS[currentAlgoIdx]);
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

/**
 * GIF の実効倍率。GIF は フレーム数 × 面積 で巨大化するため、出力の長辺が
 * ~512px に収まるよう倍率の上限を抑える (PNG は exportScale をそのまま使う)。
 */
function gifEffectiveScale() {
  const maxDim = Math.max(artWidth, artHeight);
  return Math.max(1, Math.min(exportScale, Math.floor(512 / maxDim)));
}

/** ダウンロードボタン: 選択中の形式 (PNG/GIF) × 倍率で出力する */
function downloadArt() {
  if (exportFormatIdx === 1) {
    startGifRecording();
  } else {
    saveArtAsPng(); // exportScale を参照
  }
}

/**
 * GIF 録画を開始する。
 *   - アニメ系: 現在の場のまま 1 周期 (2π) を撮ってシームレスループ GIF にする。
 *   - 一回生成系: 現在の設定で再生成し、その生成過程を撮る。
 */
function startGifRecording() {
  if (gifRecording) return;
  if (renderMode === "ascii") {
    // ASCII レンダーは artBuf を使わない (文字描画) ため GIF 未対応。DOT を案内。
    statusText = "GIF: DOT MODE ONLY";
    return;
  }
  gifRecording = true;
  gifScale = gifEffectiveScale();
  gifFrames = [];
  if (isAnimated()) {
    // 現在の場パラメータを保ったまま 1 周期をループ撮影 (再生成しない)
    gifLoopFrame = 0;
    statusText = "RECORDING LOOP...";
  } else {
    gifNextSample = 0;
    statusText = "RECORDING GIF...";
    seed = nbSeed.value;
    startGeneration();
  }
}

/** 録画した GIF をエンコードしてダウンロードする */
function finishGifRecording() {
  gifRecording = false;
  if (gifFrames.length === 0) {
    statusText = "";
    return;
  }
  statusText = "ENCODING GIF...";
  // エンコードを次フレームに遅延して "ENCODING" 表示を反映させる
  setTimeout(() => {
    let bg = palette.bg;
    let fg = palette.fg;
    if (invertMode) {
      const t = bg;
      bg = fg;
      fg = t;
    }
    const blob = encodeGif(
      gifFrames,
      artWidth,
      artHeight,
      bg,
      fg,
      GIF_FPS,
      gifScale,
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const algoName = ALGO_NAMES[currentAlgoIdx];
    const presetName =
      PRESETS[ALGO_KEYS[currentAlgoIdx]][currentPresetIdx].name;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `genart_${algoName}_${presetName}_${seed}_${ts}.gif`;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    gifFrames = [];
    statusText = "";
  }, 30);
}

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
  allocField();
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
  // シミュ格子 (rdW×rdH) → fieldBuf (描画対象解像度) へ正規化再標本化。
  // commitField が DOT (Bayer) / ASCII (ramp) に変換する。
  for (let fr = 0; fr < fieldRows; fr++) {
    const gy = Math.min(rdH - 1, (((fr + 0.5) / fieldRows) * rdH) | 0);
    const fbase = fr * fieldCols;
    const gbase = gy * rdW;
    for (let fc = 0; fc < fieldCols; fc++) {
      const gx = Math.min(rdW - 1, (((fc + 0.5) / fieldCols) * rdW) | 0);
      fieldBuf[fbase + fc] = Math.min(1.0, rdV[gbase + gx] * 3.5);
    }
  }
  commitField();
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
  allocField();
  // 母点はピクセル空間に配置 (モードに依らず一定の絶対位置)
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
    n = p.numPoints;
  const rowsPerFrame = Math.max(1, Math.ceil(fieldRows / 120));
  const maxR =
    Math.sqrt((artWidth * artWidth + artHeight * artHeight) / n) * 0.9;
  for (
    let row = 0;
    row < rowsPerFrame && vorScanY < fieldRows;
    row++, vorScanY++
  ) {
    const py = fieldPixelY(vorScanY);
    const base = vorScanY * fieldCols;
    for (let c = 0; c < fieldCols; c++) {
      const px = fieldPixelX(c);
      let minD = Infinity,
        minI = 0,
        secD = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = px - vorPoints[i * 2],
          dy = py - vorPoints[i * 2 + 1];
        const d = dx * dx + dy * dy;
        if (d < minD) {
          secD = minD;
          minD = d;
          minI = i;
        } else if (d < secD) secD = d;
      }
      // 各モードはディザ前のスカラー値を返す (commitField が DOT/ASCII へ変換)
      let val = 0;
      if (p.mode === "edge") {
        val = Math.sqrt(secD) - Math.sqrt(minD) < 2.5 ? 1 : 0;
      } else if (p.mode === "dist") {
        val = Math.min(1, Math.sqrt(minD) / maxR);
      } else if (p.mode === "checker") {
        val = minI & 1;
      } else if (p.mode === "id") {
        val = ((minI * 7 + 3) % 16) / 16;
      }
      fieldBuf[base + c] = val;
    }
  }
  commitField();
  progress = vorScanY / fieldRows;
  statusText = `SCAN: ${vorScanY}/${fieldRows}`;
  if (vorScanY >= fieldRows) {
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
  allocField();
  // 波源はピクセル空間に配置 (モードに依らず一定の絶対位置)
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
  animTime = 0;
  generating = false; // 即時生成 → 連続アニメへ
  progress = 1;
  waveFill(0);
}

/**
 * 波動干渉場を時刻 t で全面再計算する。
 * 各波源の位相を t だけ進めると、干渉縞 (波面) が伝播し続ける (周期 2π)。
 */
function waveFill(t) {
  if (!waveSources || !fieldBuf) return;
  const p = wavePreset;
  const maxDim = Math.max(artWidth, artHeight);
  for (let r = 0; r < fieldRows; r++) {
    const py = fieldPixelY(r);
    const base = r * fieldCols;
    for (let c = 0; c < fieldCols; c++) {
      const px = fieldPixelX(c);
      let sum = 0;
      for (let i = 0; i < waveSources.length; i++) {
        const s = waveSources[i];
        let d;
        if (p.mode === "concentric") {
          const dx = px - s.x,
            dy = py - s.y;
          d = Math.sqrt(dx * dx + dy * dy);
        } else if (p.mode === "linear") {
          d = (px - s.x) * Math.cos(s.angle) + (py - s.y) * Math.sin(s.angle);
        } else if (p.mode === "spiral") {
          const dx = px - s.x,
            dy = py - s.y;
          d = Math.sqrt(dx * dx + dy * dy) + Math.atan2(dy, dx) * 10;
        }
        let amp = 1;
        if (p.decay) {
          const dx = px - s.x,
            dy = py - s.y;
          amp = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / maxDim);
        }
        sum += Math.sin(d * s.freq + s.phase + t) * amp;
      }
      fieldBuf[base + c] = (sum / waveSources.length + 1) * 0.5;
    }
  }
  commitField();
  statusText = `WAVE ${waveSources.length} SOURCES`;
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
//  PLASMA — sin/cos 干渉プラズマ場 (アニメ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// sin/cos 干渉の多重合成でスカラー場を生む。各レイヤーは seed 由来の
// 周波数・位相・中心を持ち、seed ごとに別の干渉模様になる。
// 時刻 t で各レイヤーの位相を進めると、模様がうねり続ける (周期 2π)。

/** @type {string[]|null} ASCII 出力行 */
let aaLines = null;

/** AA キャンバスの列数・行数 */
let aaCols = 0,
  aaRows = 0;

/** レイヤーパラメータ配列 */
let plasmaLayers = null;

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

  allocField(preset.chars);

  // レイヤー中心はセル座標空間に置く (モードに依らず一定)
  const cellCols = calcAACols(),
    cellRows = calcAARows();
  const nLayers = preset.layers;
  plasmaLayers = [];
  for (let i = 0; i < nLayers; i++) {
    plasmaLayers.push({
      freqX: preset.freqBase * (0.5 + rng() * 1.5),
      freqY: preset.freqBase * (0.5 + rng() * 1.5),
      phaseX: rng() * Math.PI * 2,
      phaseY: rng() * Math.PI * 2,
      cx: rng() * cellCols,
      cy: rng() * cellRows,
      radialFreq: preset.freqBase * (0.3 + rng() * 2.0),
      weight: 0.5 + rng() * 0.5,
    });
  }

  animTime = 0;
  generating = false; // 場は即時生成 → 連続アニメへ
  progress = 1;
  plasmaFill(0);
}

/** プラズマ場を時刻 t で全面再計算する (t で位相が進み、模様がうねる) */
function plasmaFill(t) {
  if (!plasmaLayers || !fieldBuf) return;
  const invGamma = 1.0 / plasmaGamma;
  const layers = plasmaLayers;
  const nLayers = layers.length;

  for (let r = 0; r < fieldRows; r++) {
    const cy = fieldCellY(r);
    const base = r * fieldCols;

    for (let c = 0; c < fieldCols; c++) {
      const cx = fieldCellX(c);
      let sum = 0;
      for (let li = 0; li < nLayers; li++) {
        const L = layers[li];
        // sin/cos 干渉 + 放射成分。位相に t を加えると場全体が時間発展する。
        const dx = cx - L.cx,
          dy = cy - L.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        sum +=
          L.weight *
          (Math.sin(cx * L.freqX + L.phaseX + t) +
            Math.sin(cy * L.freqY + L.phaseY + t) +
            Math.sin(dist * L.radialFreq - t));
      }

      // [-3*nLayers, +3*nLayers] → [0, 1]
      let v = (sum / (3 * nLayers) + 1) * 0.5;
      if (v < 0) v = 0;
      if (v > 1) v = 1;

      // ガンマ補正
      if (invGamma !== 1.0) v = v ** invGamma;

      fieldBuf[base + c] = v;
    }
  }
  commitField();
  statusText = `PLASMA ${fieldCols}x${fieldRows}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DRIFT — パーリンノイズ密度場
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// fbm ノイズの値をそのまま濃淡 (密度) にマッピングするスカラー場。
// 漂う雲・霧・煙のような有機的な階調を生む。
// seed 由来のオフセットで二度と同じ模様は現れない。
// (Phase 3 ではオフセットを時間で動かし、場が「流れる」)

let driftPreset = null;
let driftScanRow = 0;
let driftOffX = 0,
  driftOffY = 0;

function driftInit(preset, s) {
  driftPreset = preset;
  seedRng(s);
  initNoise(s);
  allocField(preset.chars);
  // seed 由来オフセット
  driftOffX = rng() * 1000;
  driftOffY = rng() * 1000;
  animTime = 0;
  generating = false; // 即時生成 → 連続アニメへ
  progress = 1;
  driftFill(0);
}

/**
 * ノイズ密度場を時刻 t で全面再計算する。
 * ノイズ標本点を半径 DRIFT_ANIM_RADIUS の円で動かすことで、場が漂い続け、
 * t が一周 (2π) すると元に戻る ＝ シームレスループする。
 */
function driftFill(t) {
  if (!driftPreset || !fieldBuf) return;
  const p = driftPreset;
  const invGamma = 1.0 / p.gamma;
  const ox = driftOffX + DRIFT_ANIM_RADIUS * Math.cos(t);
  const oy = driftOffY + DRIFT_ANIM_RADIUS * Math.sin(t);

  for (let r = 0; r < fieldRows; r++) {
    const cy = fieldCellY(r);
    const base = r * fieldCols;

    for (let c = 0; c < fieldCols; c++) {
      const cx = fieldCellX(c);
      const nx = (cx + ox) * p.scale;
      const ny = (cy + oy) * p.scale;
      let v = (fbm(nx, ny, p.octaves) + 1) * 0.5; // -1..1 → 0..1
      if (v < 0) v = 0;
      else if (v > 1) v = 1;
      if (invGamma !== 1.0) v = v ** invGamma;
      fieldBuf[base + c] = v;
    }
  }
  commitField();
  statusText = `DRIFT ${fieldCols}x${fieldRows}`;
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
/** seed 由来の乱数パラメータ */
let aaGridParams = null;

function aaGridInit(preset, s) {
  aaGridPreset = preset;
  seedRng(s);
  initNoise(s);

  allocField(preset.chars);

  // seed 由来のパラメータ (アニメ中に rng を消費しないよう、ここで確定させる)
  aaGridParams = {
    phaseX: rng() * Math.PI * 2,
    phaseY: rng() * Math.PI * 2,
    freqMod: 0.5 + rng() * 1.5,
    offsetX: rng() * 100,
    offsetY: rng() * 100,
    stripeAngle: rng() * Math.PI,
    checkerSize: Math.max(2, (4 + rng() * 4) | 0),
  };

  animTime = 0;
  generating = false; // 即時生成 → 連続アニメへ
  progress = 1;
  gridFill(0);
}

// 各パターンに時刻 t を与えて時間発展させる (位相を進める / 標本点を円運動)。
function _gridValue(patFn, c, r, freq, params, cellCols, cellRows, t) {
  switch (patFn) {
    case "wave": {
      const v1 = Math.sin(c * freq * params.freqMod + params.phaseX + t);
      const v2 = Math.sin(r * freq + params.phaseY + t);
      const v3 = Math.sin((c + r) * freq * 0.7 + params.phaseX * 0.5 - t);
      return ((v1 + v2 + v3) / 3) * 0.5 + 0.5;
    }
    case "checker": {
      const size = params.checkerSize;
      // オフセットを小さく揺らすと市松がゆっくり揺れる (sin/cos で周期的)
      const cx = ((c + params.offsetX + 2 * Math.sin(t)) / size) | 0;
      const cy = ((r + params.offsetY + 2 * Math.cos(t)) / size) | 0;
      return (cx + cy) % 2 === 0 ? 0.8 : 0.2;
    }
    case "diamond": {
      const dx = Math.abs(c - cellCols / 2);
      const dy = Math.abs(r - cellRows / 2);
      const d = (dx + dy) * freq + params.phaseX + t; // 同心菱形が脈動
      return Math.sin(d) * 0.5 + 0.5;
    }
    case "noise": {
      const ox = params.offsetX + DRIFT_ANIM_RADIUS * Math.cos(t);
      const oy = params.offsetY + DRIFT_ANIM_RADIUS * Math.sin(t);
      const v = fbm((c + ox) * freq, (r + oy) * freq, 3);
      return v * 0.5 + 0.5;
    }
    default:
      return 0.5;
  }
}

/** グリッド場を時刻 t で全面再計算する */
function gridFill(t) {
  if (!aaGridPreset || !fieldBuf) return;
  const p = aaGridPreset;
  const invGamma = 1.0 / p.gamma;
  const params = aaGridParams;
  const cellCols = calcAACols(),
    cellRows = calcAARows();

  for (let r = 0; r < fieldRows; r++) {
    const cy = fieldCellY(r);
    const base = r * fieldCols;

    for (let c = 0; c < fieldCols; c++) {
      const cx = fieldCellX(c);
      let v = _gridValue(p.patFn, cx, cy, p.freq, params, cellCols, cellRows, t);
      if (v < 0) v = 0;
      if (v > 1) v = 1;
      if (invGamma !== 1.0) v = v ** invGamma;
      fieldBuf[base + c] = v;
    }
  }
  commitField();
  statusText = `GRID ${fieldCols}x${fieldRows}`;
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
let aaLandOffX = 0,
  aaLandOffY = 0;

function aaLandInit(preset, s) {
  aaLandPreset = preset;
  seedRng(s);
  initNoise(s);

  allocField(preset.chars);

  // seed 由来のオフセット — 同じ地形を二度と見ない
  aaLandOffX = rng() * 1000;
  aaLandOffY = rng() * 1000;

  animTime = 0;
  generating = false; // 即時生成 → 連続アニメへ
  progress = 1;
  landFill(0);
}

/**
 * 地形場を時刻 t で全面再計算する。
 * ノイズ標本点を半径 LAND_ANIM_RADIUS の円で動かし、地形がゆっくり流れる
 * (上空をゆっくり旋回するイメージ)。t 一周で元に戻る ＝ ループする。
 */
function landFill(t) {
  if (!aaLandPreset || !fieldBuf) return;
  const p = aaLandPreset;
  const invGamma = 1.0 / p.gamma;
  const ox = aaLandOffX + LAND_ANIM_RADIUS * Math.cos(t);
  const oy = aaLandOffY + LAND_ANIM_RADIUS * Math.sin(t);

  for (let r = 0; r < fieldRows; r++) {
    const cy = fieldCellY(r);
    const base = r * fieldCols;

    for (let c = 0; c < fieldCols; c++) {
      const cx = fieldCellX(c);
      const nx = (cx + ox) * p.scale;
      const ny = (cy + oy) * p.scale;
      const raw = fbm(nx, ny, p.octaves); // -1..1
      const h = (raw + 1) * 0.5; // 0..1

      let v;
      if (h < p.seaLevel) {
        // 海面以下 — 最も明るい (密度最小) ＝ 値 0
        v = 0;
      } else {
        // 標高を seaLevel..1 → 0..1 に再マッピング
        v = (h - p.seaLevel) / (1 - p.seaLevel);
        if (v > 1) v = 1;
        if (invGamma !== 1.0) v = v ** invGamma;
      }
      fieldBuf[base + c] = v;
    }
  }
  commitField();
  statusText = `LAND ${fieldCols}x${fieldRows}`;
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
    case "plasma":
      plasmaInit(preset, seed);
      break;
    case "drift":
      driftInit(preset, seed);
      break;
    case "rain":
      aaRainInit(preset, seed);
      break;
    case "grid":
      aaGridInit(preset, seed);
      break;
    case "land":
      aaLandInit(preset, seed);
      break;
  }
}

// 一回生成 (漸進描画) 系のステップ。アニメ系 (plasma/drift/grid/land/wave) は
// stepGeneration を通らず、onDraw が animateFill() で毎フレーム更新する。
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
    case "spiral":
      spiralStep();
      break;
    case "automata":
      automataStep();
      break;
    case "rain":
      aaRainStep();
      break;
  }
}

/** アニメ系の場を現在の animTime で全面更新する (onDraw / ループ GIF から呼ぶ) */
function animateFill() {
  switch (ALGO_KEYS[currentAlgoIdx]) {
    case "plasma":
      plasmaFill(animTime);
      break;
    case "drift":
      driftFill(animTime);
      break;
    case "grid":
      gridFill(animTime);
      break;
    case "land":
      landFill(animTime);
      break;
    case "wave":
      waveFill(animTime);
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
  // 対応モードの中からランダムに選び、DOT/ASCII の表情も自動で混ぜる
  const modes = ALGO_MODES[ALGO_KEYS[currentAlgoIdx]];
  renderMode = modes[rngInt(0, modes.length - 1)];
  buildToolbar();
  startGeneration();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ツールバー (2行構成)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {UI.WidgetGroup} */
let toolbar;
let toolbarRoot;
let ddAlgo, ddPreset, ddRender, lblSeed, nbSeed, btnDice, btnGen;
let tglInvert, tglAuto;
let ddRatio, nbArtW, nbArtH, ddFormat, nbScale, btnSave, btnFile;
let toolbarH = 0;

const BTN_PAD = 8,
  BTN_BORDER = 4;

function buildToolbar() {
  const presetNames = PRESETS[ALGO_KEYS[currentAlgoIdx]].map((p) => p.name);

  ddAlgo = new UI.DropDown(0, 0, ALGO_NAMES, currentAlgoIdx, (i) => {
    currentAlgoIdx = i;
    currentPresetIdx = 0;
    // 新アルゴリズムが現在のレンダーモードに非対応なら既定モードへ
    const modes = ALGO_MODES[ALGO_KEYS[i]];
    if (!modes.includes(renderMode)) renderMode = modes[0];
    // ASCII ならセル倍数にスナップして再生成
    applyArtSize(artWidth, artHeight);
    buildToolbar();
  });

  ddPreset = new UI.DropDown(0, 0, presetNames, currentPresetIdx, (i) => {
    currentPresetIdx = i;
    startGeneration();
  });

  // ── レンダーモード: アルゴリズムが対応するモードのみ提示 ──
  const renderModes = ALGO_MODES[ALGO_KEYS[currentAlgoIdx]];
  const renderLabels = renderModes.map((m) => RENDER_LABELS[m]);
  let renderSel = renderModes.indexOf(renderMode);
  if (renderSel < 0) renderSel = 0;
  ddRender = new UI.DropDown(0, 0, renderLabels, renderSel, (i) => {
    renderMode = renderModes[i];
    // ASCII ならセル倍数にスナップ + バッファ再確保 + 再生成
    applyArtSize(artWidth, artHeight);
  });
  ddRender.tooltip =
    "Render: DOT = 1-bit pixels (GIF-able), ASCII = character cells";

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

  // ── サイズ: アスペクト比 → 寸法 ──
  const ratioLabels = ASPECT_RATIOS.map((r) => r.label);
  ddRatio = new UI.DropDown(0, 0, ratioLabels, currentRatioIdx, (i) => {
    currentRatioIdx = i;
    applyRatio();
  });
  ddRatio.tooltip = "Aspect ratio (W/H follow it; FREE = independent W/H)";

  // W/H 直接入力。比率が選択されていれば連動、FREE なら独立。
  nbArtW = new UI.NumberBox(0, 0, ART_W_MIN, ART_W_MAX, artWidth, 1, (v) => {
    applyRatioFromWidth(v);
  });
  nbArtW.tooltip = "Canvas width";
  nbArtH = new UI.NumberBox(0, 0, ART_H_MIN, ART_H_MAX, artHeight, 1, (v) => {
    applyRatioFromHeight(v);
  });
  nbArtH.tooltip = "Canvas height";

  // ── 書き出し: 形式 (PNG/GIF) + 自由倍率 ──
  ddFormat = new UI.DropDown(
    0,
    0,
    EXPORT_FORMAT_LABELS,
    exportFormatIdx,
    (i) => {
      exportFormatIdx = i;
    },
  );
  ddFormat.tooltip = "Export format: PNG = still, GIF = generation animation";

  nbScale = new UI.NumberBox(
    0,
    0,
    EXPORT_SCALE_MIN,
    EXPORT_SCALE_MAX,
    exportScale,
    1,
    (v) => {
      exportScale = v;
    },
  );
  nbScale.tooltip = "Export scale (free integer; 1-bit art enlarges crisply for SNS)";

  // PC へ書き出す = DOWNLOAD / SYNESTA 内に保存 (PBM→VFS) = SAVE。
  btnSave = new UI.PushButton(0, 0, "DOWNLOAD", () => {
    downloadArt();
  });
  btnSave.tooltip = "Download to your computer (PNG or GIF × scale)";

  btnFile = new UI.PushButton(0, 0, "SAVE", () => {
    saveArtToVfs();
  });
  btnFile.tooltip = "Save as PBM to the SYNESTA disk (VFS)";

  // ── レイアウト (3 行。出力解像度はフッターに表示) ──
  const lblAlgo = new UI.Label(0, 0, "ALGO:");
  const lblStyle = new UI.Label(0, 0, "STYLE:");
  const lblRender = new UI.Label(0, 0, "AS:");
  const lblWH = new UI.Label(0, 0, "X"); // W × H
  const lblMul = new UI.Label(0, 0, "X"); // × scale
  // 1行目: 何を (ALGO) どんなスタイルで (STYLE) どう見せるか (AS = DOT/ASCII)
  const row1 = UI.HBox([lblAlgo, ddAlgo, lblStyle, ddPreset, lblRender, ddRender]);
  // 2行目: 生成 (seed + トランスポート auto/GEN + 反転)
  const row2 = UI.HBox([lblSeed, nbSeed, btnDice, tglAuto, btnGen, tglInvert]);
  // 3行目: サイズ (比率 + W×H) + 書き出し (形式 ×倍率 + DOWNLOAD/SAVE)
  const row3 = UI.HBox([
    ddRatio,
    nbArtW,
    lblWH,
    nbArtH,
    ddFormat,
    lblMul,
    nbScale,
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
  if (gifRecording && isAnimated()) {
    // ── ループ GIF: 1 周期 (2π) を GIF_FRAME_COUNT 等分でサンプル → シームレスループ ──
    animTime = (gifLoopFrame / GIF_FRAME_COUNT) * Math.PI * 2;
    animateFill();
    gifFrames.push(artBuf.slice());
    gifLoopFrame++;
    statusText = `RECORDING LOOP ${gifLoopFrame}/${GIF_FRAME_COUNT}`;
    if (gifLoopFrame >= GIF_FRAME_COUNT) finishGifRecording();
  } else if (isAnimated()) {
    // ── 連続アニメ (常時)。場を毎フレーム再計算し、t をシームレスに周回 ──
    animTime += ANIM_DT;
    if (animTime >= Math.PI * 2) animTime -= Math.PI * 2;
    animateFill();
  } else {
    // ── 一回生成系 (漸進描画) ──
    if (generating) stepGeneration();

    // GIF 録画: 生成過程を progress 閾値ごとに artBuf スナップショットでサンプル。
    // 完了したら最終形を数フレーム保持してエンコード → ダウンロード。
    if (gifRecording) {
      if (generating) {
        if (progress >= gifNextSample) {
          gifFrames.push(artBuf.slice());
          gifNextSample += 1 / GIF_FRAME_COUNT;
        }
      } else {
        const final = artBuf.slice();
        for (let k = 0; k < 5; k++) gifFrames.push(final); // 完成形を少しホールド
        finishGifRecording();
      }
    }
  }

  // 自動送り (GIF 録画中は抑止)
  if (autoMode && !generating && !gifRecording) {
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

  if (renderMode === "ascii" && aaLines) {
    // ASCII レンダーパス: 文字列配列を直接描画
    const color = invertMode ? 0 : 1;
    if (invertMode) GPU.fillRect(cx, cy, artWidth, artHeight, 1);
    AsciiArt.drawAsciiArt(aaLines, cx, cy, color);
  } else {
    // DOT (ピクセル) レンダーパス
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
  // 右側: キャンバス寸法 → 書き出し解像度 (倍率込み)。頭で計算せずに済むよう常時表示。
  // GIF は実効倍率 (上限つき) を反映する。
  const isGif = exportFormatIdx === 1;
  const eScale = isGif ? gifEffectiveScale() : exportScale;
  const outW = artWidth * eScale;
  const outH = artHeight * eScale;
  const fmt = EXPORT_FORMAT_LABELS[exportFormatIdx];
  const info = `${artWidth}x${artHeight} ->${fmt} ${outW}x${outH}`;
  const rw = textWidth(info);
  drawText(footerRect.x + footerRect.w - rw, footerRect.y, info, 1);
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
  currentRatioIdx = 3; // 16:9
  renderMode = "dot";
  animTime = 0;
  gifRecording = false;
  gifLoopFrame = 0;
  exportFormatIdx = 0; // PNG
  exportScale = 8;
  resizeArt(320, 180); // 既定 16:9 320x180
  fieldBuf = null;
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
  driftPreset = null;
  rainDrops = null;
  rainPreset = null;
  rainRamp = null;
  rainGrid = null;
  aaGridPreset = null;
  aaGridParams = null;
  aaLandPreset = null;
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

