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
 * 8つのアルゴリズムが、それぞれ異なる角度から
 * この「創発」の神秘を1bitキャンバスに描き出す。
 *
 * ─── アルゴリズム と レンダーモード ───
 * アルゴリズムは「何を生むか」、レンダーモードは「どう見せるか」を分離する。
 * 1bit・低解像度で映えるのは「面の質量と中間調テクスチャ」を持つ場 (スカラー場)
 * 系のみ。線・点の構造系はディザ/ASCII で質量が乗らず映えないため、GENART は
 * 場のパラダイムに統一している。
 *   - 場系 (スカラー場 f(x,y) ∈ [0,1]) … REACT / VORONOI / WAVE /
 *       PLASMA / DRIFT / GRID / LAND
 *       場を fieldBuf に書き、共通レンダラが DOT (Bayer ディザ) か
 *       ASCII (tone ramp) に変換する。両モード対応。
 *   - RAIN … 文字が降り積もるデジタルの雨。文字そのものが主役ゆえ ASCII 専用。
 *
 * アルゴリズム:
 *   REACT    — 化学反応の自己組織化が生む生命的パターン (Gray-Scott)
 *   VORONOI  — ボロノイ割り: 空間分割が紡ぐ細胞的テッセレーション
 *   WAVE     — 波動干渉: 複数波源の干渉縞が描くモアレ
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
import { encodeMp4, isMp4Supported } from "../core/mp4.js";
import { drawText, getGlyph, textWidth, GLYPH_W, GLYPH_H } from "../core/font.js";
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

// ── サイズモデル ──
// 最終出力外寸を OUTPUT プリセットから選ぶ。プレビュー (画面・基準解像度) は
// 出力を OUTPUT_SCALE で割った baseW×baseH。書き出しは base を整数 ×OUTPUT_SCALE
// するだけなので「1 ドット = 物理 OUTPUT_SCALE ピクセル」が厳密に保たれ、かつ
// 1920×1080 等の丸いサイズちょうどになる (均一ドット & 正確サイズの両立)。
// プレビューが小さいので画面外にはみ出す問題も解消する。
const OUTPUT_SCALE = 8;
const OUTPUT_PRESETS = [
  { label: "1920x1080", baseW: 240, baseH: 135 }, // 16:9
  { label: "1080x1920", baseW: 135, baseH: 240 }, // 9:16
  { label: "1440x1080", baseW: 180, baseH: 135 }, // 4:3
  { label: "1080x1440", baseW: 135, baseH: 180 }, // 3:4
  { label: "1080x1080", baseW: 135, baseH: 135 }, // 1:1
];
let currentOutIdx = 0;
let baseW = 240, // プレビュー/基準解像度 (出力 = base × OUTPUT_SCALE)
  baseH = 135;

// アート (場/グリフ) の描画領域。PAD で base から上下左右対称に削った内側。
// DOT はこの解像度で場を描き、PAD マットを付けて base に合成 → ×8。
// 既定 PAD=8 なので 240/135 から各辺 8px 削った 224×119。
let artWidth = 224;
let artHeight = 119;

/** ツールバーとキャンバスの間の間隔 */
const CANVAS_GAP = 4;

/**
 * 書き出し設定: 形式 (PNG / GIF / MP4) + 倍率 (自由整数。2 のべき乗に縛らない)。
 * 静止画 = PNG、動画 = GIF (全環境・画質忠実) / MP4 (WebCodecs 必須・SNS ネイティブ)。
 * MP4 は WebCodecs 非対応ブラウザでは選択肢に出さない (availableFormats)。
 */
const EXPORT_FORMATS = [
  { key: "png", label: "PNG" },
  { key: "gif", label: "GIF" },
  { key: "mp4", label: "MP4" },
];
let exportFormatIdx = 0; // availableFormats() のインデックス

/**
 * 額縁 (マット): アート内容と枠線の間に置く背景余白 (px)。DOT/ASCII 共通で、
 * 表示・書き出しの両方に含まれる (作品として「額装」される)。0 で枠線に密着。
 */
let outerMargin = 8; // 既定 PAD=8 (額縁)
const MARGIN_MIN = 0,
  MARGIN_MAX = 16;
/**
 * ASCII の字間 (px)。文字数は変えず、文字どうしの間隔だけ調整する。
 * 既定 1 で従来どおり。0 で密着、大きくすると空間的な ASCII になる。
 */
let charSpacing = 1;
const SPACING_MIN = 0,
  SPACING_MAX = 6;

/**
 * 方式 (レンダーモード) 専用パラメータ。DITHER(DOT/BRAILLE)・GAP(ASCII)と同様、
 * 各方式に固有の調整値を 1 行目に出す。変更時は現在の場を再レンダーする。
 */
let hatchPitch = 4; // HATCH 線間隔
const HATCH_MIN = 2,
  HATCH_MAX = 8;
let screenCell = 6; // SCREEN 網点セル
const SCREEN_MIN = 3,
  SCREEN_MAX = 12;
let contourLevels = 7; // CONTOUR 等高線レベル数
const CONTOUR_MIN = 2,
  CONTOUR_MAX = 16;
let scanStep = 4; // SCAN 走査間隔 (線密度・振幅)
const SCAN_MIN = 2,
  SCAN_MAX = 10;

/**
 * グリッド・シミュレーション系 (REACT / BZ) の境界条件。
 *   "wrap" — トーラス (上下端・左右端がループ)。既定。
 *   "wall" — 壁 (無流束/反射境界)。端で構造が終端・反射し、別の創発になる。
 * 境界は発展の最初から効くため、変更時はシミュを生成し直す。
 */
let edgeMode = "wrap";

/** 現在のアルゴリズムが境界条件 (EDGE) の選択に対応するか */
function algoSupportsEdge() {
  const k = ALGO_KEYS[currentAlgoIdx];
  return k === "react" || k === "bz";
}

/** この環境で選べる書き出し形式 (MP4 は WebCodecs 対応時のみ) */
function availableFormats() {
  // DOT/ASCII とも録画可能 (ASCII はグリフをラスタライズして捕捉)。
  return EXPORT_FORMATS.filter((f) => f.key !== "mp4" || isMp4Supported());
}
/** 現在選択中の形式キー */
function currentFormatKey() {
  const a = availableFormats();
  return (a[exportFormatIdx] || a[0]).key;
}

// ── 動画録画 (GIF / MP4 で共有。生成過程 or アニメ 1 周期をフレーム捕捉) ──
// 録画はプレビューと完全一致: アニメは LOOP_FRAMES を選択 fps (loopFps) で再生、
// 一回生成系は生成過程を ONESHOT_FRAMES サンプル。GIF/MP4 とも同じ loopFps。
const ONESHOT_FRAMES = 36; // 一回生成系の生成過程サンプル数
let gifFrameTotal = 60; // 録画ごとに設定 (= LOOP_FRAMES または ONESHOT_FRAMES)
let videoFormat = "gif"; // 録画中の出力形式 ("gif" | "mp4")
let videoEncoding = false; // MP4 の非同期エンコード中フラグ
let gifRecording = false; // フレーム捕捉中フラグ (GIF/MP4 共通)
/** @type {Uint8Array[]} 捕捉した artBuf スナップショット */
let gifFrames = [];
let gifNextSample = 0; // 次にサンプルする progress 閾値
let gifLoopFrame = 0; // アニメ算法のループ用フレームカウンタ

/** アルゴリズム定義 */
const ALGO_KEYS = [
  "react",
  "voronoi",
  "wave",
  "plasma",
  "drift",
  "rain",
  "grid",
  "land",
  "metaball",
  "moire",
  "caustic",
  "quasic",
  "julia",
  "curl",
  "bz",
  "worley",
];
const ALGO_NAMES = [
  "REACT",
  "VORONOI",
  "WAVE",
  "PLASMA",
  "DRIFT",
  "RAIN",
  "GRID",
  "LAND",
  "METABALL",
  "MOIRE",
  "CAUSTIC",
  "QUASIC",
  "JULIA",
  "CURL",
  "BZ",
  "WORLEY",
];

/**
 * 各アルゴリズムが対応するレンダーモード。
 *   "dot"   — 1bit ピクセル (Bayer ディザ)。GIF 書き出し可。
 *   "ascii" — 文字セル (tone ramp 濃淡)。
 * 場系は両対応、RAIN は ASCII 専用。先頭要素が既定モード。
 */
// 場系すべてで使えるレンダーモード (方式)。fieldBuf を消費する点は共通で、
// ASCII 以外は fieldBuf→artBuf の 1bit レンダラ (合成・書き出し・サイズは DOT と共有)。
const FIELD_MODES = [
  "dot",
  "ascii",
  "hatch",
  "screen",
  "braille",
  "contour",
  "scanline",
];
const ALGO_MODES = {
  react: FIELD_MODES,
  voronoi: FIELD_MODES,
  wave: FIELD_MODES,
  plasma: FIELD_MODES,
  drift: FIELD_MODES,
  rain: ["ascii"], // 文字を直接書くため ASCII 専用
  grid: FIELD_MODES,
  land: FIELD_MODES,
  metaball: FIELD_MODES,
  moire: FIELD_MODES,
  caustic: FIELD_MODES,
  quasic: FIELD_MODES,
  julia: FIELD_MODES,
  curl: FIELD_MODES,
  bz: FIELD_MODES,
  worley: FIELD_MODES,
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
  "metaball",
  "moire",
  "caustic",
  "quasic",
  "julia",
  "curl",
  "bz",
  "worley",
]);

/** 現在のレンダーモード ("dot" | "ascii")。ALGO_MODES の制約下で選択される。 */
let renderMode = "dot";

const RENDER_LABELS = {
  dot: "DOT",
  ascii: "ASCII",
  hatch: "HATCH",
  screen: "SCREEN",
  braille: "BRAILLE",
  contour: "CONTOUR",
  scanline: "SCAN",
};

/**
 * 連続アニメ (時間発展) する場アルゴリズム。
 * 場を時刻 t∈[0,2π) で毎フレーム再計算し、常に動き続ける「生きたキャンバス」。
 * 位相を進める (plasma/grid/wave) か、ノイズ標本点を円運動させる (drift/land) ことで
 * t が一周すると元に戻る ＝ 周期的 ＝ シームレスにループする (GIF ループの素地)。
 * VORONOI・REACT・RAIN は一回生成 (時間発展しない)。
 */
const ANIM_ALGOS = new Set([
  "plasma",
  "drift",
  "grid",
  "land",
  "wave",
  "metaball",
  "moire",
  "caustic",
  "quasic",
  "julia",
  "curl",
  "worley",
]);
/**
 * アニメ 1 周期のフレーム数 (ループの時間解像度)。プレビューも書き出しもこの
 * 60 フレームを再生 fps で回す。ループ長 = LOOP_FRAMES / loopFps (秒)。
 */
const LOOP_FRAMES = 60;
/**
 * 再生 fps。GIF はフレーム遅延がセンチ秒 (1/100s) 単位なので、100 の約数の
 * fps だけが綺麗に出せる (10→10cs, 20→5cs, 25→4cs, 50→2cs)。MP4 も同値を使う。
 */
let loopFps = 20;
const FPS_OPTIONS = [5, 10, 20, 25, 50, 100];
/** drift/land のノイズ標本点を円運動させる半径 (セル単位) — 場がゆっくり漂う */
const DRIFT_ANIM_RADIUS = 6;
const LAND_ANIM_RADIUS = 5;
/** アニメの現在時刻 t∈[0,2π) と、プレビューで実時間再生中の表示フレーム */
let animTime = 0;
let animFrame = -1;

function isAnimated() {
  return ANIM_ALGOS.has(ALGO_KEYS[currentAlgoIdx]);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  プリセット定義
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PRESETS = {
  react: [
    { name: "MITOSIS", f: 0.0367, k: 0.0649, iters: 4000 },
    { name: "CORAL", f: 0.0545, k: 0.062, iters: 3500 },
    { name: "WORM", f: 0.025, k: 0.06, iters: 5000 },
    { name: "MAZE", f: 0.029, k: 0.057, iters: 5000 },
    { name: "SPOTS", f: 0.014, k: 0.054, iters: 6000 },
    { name: "HOLES", f: 0.039, k: 0.058, iters: 4000 },
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
      chars: " .:O",
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
  metaball: [
    { name: "LAVA", count: 5, gamma: 0.7, chars: "" },
    { name: "DROPS", count: 9, gamma: 1.3, chars: "" },
    { name: "MERGE", count: 3, gamma: 0.55, chars: "" },
    { name: "SWARM", count: 14, gamma: 1.0, chars: "" },
    { name: "ORBIT", count: 6, gamma: 0.9, chars: " .:O0@" },
  ],
  moire: [
    { name: "LINES", layers: 2, freq: 0.5, curve: false, gamma: 1.0, chars: "" },
    { name: "RADIAL", layers: 2, freq: 0.4, curve: true, gamma: 1.0, chars: "" },
    { name: "WEAVE", layers: 3, freq: 0.45, curve: false, gamma: 1.3, chars: "" },
    { name: "VORTEX", layers: 3, freq: 0.34, curve: true, gamma: 0.9, chars: "" },
    { name: "BEAT", layers: 2, freq: 0.6, curve: false, gamma: 0.8, chars: "" },
  ],
  caustic: [
    { name: "POOL", waves: 4, freq: 0.5, sharp: 4, chars: "" },
    { name: "DEEP", waves: 6, freq: 0.34, sharp: 5, chars: "" },
    { name: "SHALLOW", waves: 3, freq: 0.7, sharp: 3, chars: "" },
    { name: "NET", waves: 5, freq: 0.5, sharp: 6, chars: "" },
    { name: "SHIMMER", waves: 7, freq: 0.42, sharp: 4, chars: "" },
  ],
  quasic: [
    { name: "PENROSE", symmetry: 5, freq: 0.5, gamma: 1.0, chars: "" },
    { name: "STAR7", symmetry: 7, freq: 0.45, gamma: 1.0, chars: "" },
    { name: "OCTAGON", symmetry: 8, freq: 0.5, gamma: 1.0, chars: "" },
    { name: "DECAGON", symmetry: 10, freq: 0.4, gamma: 1.1, chars: "" },
    { name: "TRIAD", symmetry: 3, freq: 0.6, gamma: 1.0, chars: "" },
  ],
  julia: [
    { name: "DENDRITE", cre: -0.7, cim: 0.27, crad: 0.05, span: 3.0, iters: 48, gamma: 1.0, invert: false, chars: "" },
    { name: "SPIRAL", cre: -0.4, cim: 0.6, crad: 0.08, span: 3.0, iters: 48, gamma: 1.0, invert: false, chars: "" },
    { name: "RABBIT", cre: -0.123, cim: 0.745, crad: 0.04, span: 3.0, iters: 64, gamma: 1.0, invert: false, chars: "" },
    { name: "DUST", cre: 0.285, cim: 0.01, crad: 0.06, span: 3.0, iters: 48, gamma: 1.0, invert: true, chars: "" },
    { name: "FROST", cre: -0.8, cim: 0.156, crad: 0.05, span: 3.0, iters: 56, gamma: 1.0, invert: false, chars: "" },
  ],
  curl: [
    { name: "MARBLE", scale: 0.03, octaves: 4, warp: 2.5, warpAmt: 3, veinFreq: 0.6, flow: 4, gamma: 1.0, chars: "" },
    { name: "INK", scale: 0.05, octaves: 3, warp: 3, warpAmt: 4, veinFreq: 0.4, flow: 6, gamma: 0.9, chars: "" },
    { name: "WOOD", scale: 0.02, octaves: 2, warp: 1.5, warpAmt: 5, veinFreq: 0.9, flow: 3, gamma: 1.1, chars: "" },
    { name: "SWIRL", scale: 0.04, octaves: 5, warp: 4, warpAmt: 3, veinFreq: 0.5, flow: 5, gamma: 1.0, chars: "" },
  ],
  bz: [
    { name: "SPIRAL", states: 8, maxSteps: 280, seedMode: "spiral", chars: "" },
    { name: "TARGET", states: 10, maxSteps: 240, seedMode: "center", chars: "" },
    { name: "TURBULENT", states: 6, maxSteps: 320, seedMode: "random", chars: "" },
    { name: "PULSE", states: 12, maxSteps: 200, seedMode: "spiral", chars: "" },
  ],
  worley: [
    { name: "CELLS", points: 24, mode: "cell", scale: 1.0, gamma: 1.0, chars: "" },
    { name: "STONE", points: 16, mode: "ridge", scale: 1.2, gamma: 1.0, chars: "" },
    { name: "FOAM", points: 36, mode: "cell", scale: 1.1, gamma: 0.9, chars: "" },
    { name: "CRACKLE", points: 20, mode: "ridge", scale: 1.4, gamma: 1.2, chars: "" },
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
const BAYER2 = [
  0, 2,
  3, 1,
];

/* prettier-ignore */
const BAYER4 = [
   0, 8, 2,10,
  12, 4,14, 6,
   3,11, 1, 9,
  15, 7,13, 5,
];

/* prettier-ignore */
const BAYER8 = [
   0,32, 8,40, 2,34,10,42,
  48,16,56,24,50,18,58,26,
  12,44, 4,36,14,46, 6,38,
  60,28,52,20,62,30,54,22,
   3,35,11,43, 1,33, 9,41,
  51,19,59,27,49,17,57,25,
  15,47, 7,39,13,45, 5,37,
  63,31,55,23,61,29,53,21,
];

/**
 * Bayer 順序ディザの行列サイズ (2 / 4 / 8)。大きいほど階調が細かく滑らか、
 * 小さいほど格子模様が粗く「レトロ」になる。DOT レンダー専用の表現選択。
 * (x,y) だけで決まる順序ディザなのでフレーム間で安定 = アニメ/ループに安全。
 */
let ditherSize = 2; // 既定 2x2 (粗い格子が映える)
let ditherMat = BAYER2;
let ditherMask = 1; // size - 1 (インデックス用ビットマスク)
let ditherDiv = 4; // size * size (正規化用)

function setDitherSize(n) {
  ditherSize = n;
  if (n === 2) {
    ditherMat = BAYER2;
    ditherMask = 1;
    ditherDiv = 4;
  } else if (n === 8) {
    ditherMat = BAYER8;
    ditherMask = 7;
    ditherDiv = 64;
  } else {
    ditherSize = 4;
    ditherMat = BAYER4;
    ditherMask = 3;
    ditherDiv = 16;
  }
}

function bayerDither(x, y, value) {
  const dim = ditherMask + 1;
  const threshold =
    (ditherMat[(y & ditherMask) * dim + (x & ditherMask)] + 0.5) / ditherDiv;
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
 * base から PAD を上下左右対称に削った内側をアート描画領域として確定し、
 * その解像度でアートバッファを取り直して再生成する。
 * DOT はこの解像度で場を描き、PAD マットを付けて base に合成 → ×OUTPUT_SCALE。
 */
function applySize() {
  artWidth = Math.max(8, baseW - 2 * outerMargin);
  artHeight = Math.max(8, baseH - 2 * outerMargin);
  resizeArt(artWidth, artHeight);
  startGeneration();
}

/** OUTPUT プリセット (最終外寸) を適用する */
function applyOutputPreset(idx) {
  currentOutIdx = idx;
  baseW = OUTPUT_PRESETS[idx].baseW;
  baseH = OUTPUT_PRESETS[idx].baseH;
  applySize();
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

/**
 * 場系 ASCII の既定 tone ramp 文字セット。
 * SYNESTA フォントの定義済みグリフのみで構成し、密度が単調に増えるよう
 * 一段ごとに 1 文字を手選びしている (密度衝突による ASCII のチラつき防止)。
 * preset が chars を明示しない場合 (chars:"") にこれを使う。
 * 最暗部は最も密な定義済みグリフ `#` (density 0.64) で止まる — 1bit ASCII の質感。
 */
const FIELD_RAMP_CHARS = " .-:;+=*&%@$#";

/** 現在のモードに応じて場の寸法を決め、fieldBuf (と ASCII なら aaLines/ramp) を確保 */
function allocField(rampChars) {
  if (renderMode === "ascii") {
    aaCols = calcAACols();
    aaRows = calcAARows();
    fieldCols = aaCols;
    fieldRows = aaRows;
    aaLines = Array.from({ length: aaRows }, () => " ".repeat(aaCols));
    currentRamp = AsciiArt.buildToneRamp(rampChars || FIELD_RAMP_CHARS);
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

/** fieldBuf → 出力 (ASCII:aaLines / その他:artBuf を方式別レンダラで描く)。 */
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
    renderPixelMode(renderMode);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  レンダー方式 (fieldBuf → artBuf の 1bit レンダラ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// すべて fieldBuf (W=fieldCols × H=fieldRows = artWidth×artHeight, 0..1) を読み、
// artBuf (同寸, 0/1) を描く。座標・合成・書き出し・サイズは DOT と共有する。

/** fieldBuf 値 (境界クランプ) */
function _F(x, y, W, H) {
  if (x < 0) x = 0;
  else if (x >= W) x = W - 1;
  if (y < 0) y = 0;
  else if (y >= H) y = H - 1;
  return fieldBuf[y * W + x];
}

function renderPixelMode(mode) {
  const W = fieldCols,
    H = fieldRows;
  const f = fieldBuf,
    a = artBuf;
  if (mode === "dot") {
    for (let y = 0; y < H; y++) {
      const base = y * W;
      for (let x = 0; x < W; x++) a[base + x] = bayerDither(x, y, f[base + x]);
    }
    return;
  }
  a.fill(0);
  switch (mode) {
    case "contour": { // 等高線: 量子化レベルの境界を線で
      const L = contourLevels;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const l = (f[y * W + x] * L) | 0;
          if (l !== ((_F(x + 1, y, W, H) * L) | 0) ||
              l !== ((_F(x, y + 1, W, H) * L) | 0))
            a[y * W + x] = 1;
        }
      break;
    }
    case "hatch": { // 版画: 濃さを斜線クロスハッチの密度で
      const P = hatchPitch;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const v = f[y * W + x];
          let on = 0;
          if (v > 0.12 && (x + y) % P === 0) on = 1; // /
          if (v > 0.45 && (x - y + 4000) % P === 0) on = 1; // \
          if (v > 0.72 && x % P === 0) on = 1; // |
          if (v > 0.9 && y % P === 0) on = 1; // —
          a[y * W + x] = on;
        }
      break;
    }
    case "screen": { // 網点: 濃さで成長する円ドット
      const cell = screenCell;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const cx = ((x / cell) | 0) * cell + (cell >> 1);
          const cy = ((y / cell) | 0) * cell + (cell >> 1);
          const v = _F(cx, cy, W, H);
          const dx = x - cx,
            dy = y - cy;
          const R = v * cell * 0.72;
          if (dx * dx + dy * dy <= R * R) a[y * W + x] = 1;
        }
      break;
    }
    case "braille": { // 点字: 2×4 サブドットセル (サブドットを Bayer ディザで階調表現)
      const CW = 4,
        CH = 8;
      const dots = [0, 2]; // x オフセット
      const dotsY = [0, 2, 4, 6];
      for (let cy = 0; cy * CH < H; cy++)
        for (let cx = 0; cx * CW < W; cx++)
          for (const ddx of dots)
            for (const ddy of dotsY) {
              const px = cx * CW + ddx,
                py = cy * CH + ddy;
              if (
                px < W &&
                py < H &&
                bayerDither(px >> 1, py >> 1, _F(px, py, W, H))
              )
                a[py * W + px] = 1;
            }
      break;
    }
    case "scanline": { // 波形 (Joy Division): 場で上下に変位した横線を積む
      const step = scanStep;
      const amp = step * 2.4;
      const top = new Int32Array(W).fill(H + amp); // 列ごとの最前面 (最小 y)
      // 前 (下) から後ろ (上) へ。手前の稜線が奥を隠す
      for (let R = H - 1; R >= 0; R -= step) {
        let py = -1;
        for (let x = 0; x < W; x++) {
          let yy = (R - _F(x, R, W, H) * amp) | 0;
          if (yy < 0) yy = 0;
          if (yy < top[x]) {
            top[x] = yy;
            if (yy < H) a[yy * W + x] = 1;
            if (py >= 0) {
              // 隣と縦に繋ぐ
              const lo = Math.min(py, yy),
                hi = Math.max(py, yy);
              for (let v = lo; v <= hi; v++) if (v >= 0 && v < H) a[v * W + x] = 1;
            }
            py = yy;
          } else py = -1;
        }
      }
      break;
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

/** ダウンロードボタン: 選択中の形式 (PNG / GIF / MP4) を base ×OUTPUT_SCALE で出力 */
function downloadArt() {
  const key = currentFormatKey();
  if (key === "png") {
    saveArtAsPng(); // base ×OUTPUT_SCALE
  } else {
    startVideoRecording(key); // "gif" | "mp4"
  }
}

/**
 * 進行中のフレーム捕捉 (GIF/MP4 録画) を中断して状態をリセットする。
 * アルゴリズム・レンダーモード変更などで録画が無意味になる場面で呼ぶ。
 * これを呼ばないと、録画が完了せず gifRecording が立ったままになり
 * DOWNLOAD が無反応になりうる (SAVE は別経路なので生き続ける)。
 */
function cancelRecording() {
  if (!gifRecording) return;
  gifRecording = false;
  gifFrames = [];
  gifLoopFrame = 0;
  if (statusText.startsWith("RECORDING")) statusText = "";
}

/**
 * 動画録画 (フレーム捕捉) を開始する。GIF / MP4 共通。
 *   - アニメ系: 現在の場のまま 1 周期 (2π) を撮ってシームレスループにする。
 *   - 一回生成系: 現在の設定で再生成し、その生成過程を撮る。
 */
function startVideoRecording(format) {
  if (gifRecording || videoEncoding) return;
  videoFormat = format;
  gifRecording = true;
  gifFrames = [];
  const tag = format.toUpperCase();
  if (isAnimated()) {
    // 現在の場パラメータを保ったまま 1 周期をループ撮影 (再生成しない)。
    // プレビューと完全一致: LOOP_FRAMES を選択 fps (loopFps) で再生。
    gifLoopFrame = 0;
    gifFrameTotal = LOOP_FRAMES;
    statusText = `RECORDING ${tag} LOOP...`;
  } else {
    gifNextSample = 0;
    gifFrameTotal = ONESHOT_FRAMES;
    statusText = `RECORDING ${tag}...`;
    seed = nbSeed.value;
    startGeneration();
  }
}

/** 捕捉したフレームを GIF/MP4 にエンコードしてダウンロードする */
function finishVideoRecording() {
  gifRecording = false;
  if (gifFrames.length === 0) {
    statusText = "";
    return;
  }
  let bg = palette.bg;
  let fg = palette.fg;
  if (invertMode) {
    const t = bg;
    bg = fg;
    fg = t;
  }

  // 書き出しフレームと寸法・倍率をモード別に用意する。
  //   DOT  : base 合成バッファ → encode が整数 ×OUTPUT_SCALE 拡大 (均一)。
  //   ASCII: 各フレームの aaLines を出力解像度でラスタライズ → ×8 で厳密対称。
  const ascii = renderMode === "ascii";
  const encW = ascii ? baseW * OUTPUT_SCALE : baseW;
  const encH = ascii ? baseH * OUTPUT_SCALE : baseH;
  const encScale = ascii ? 1 : OUTPUT_SCALE;
  const prepFrames = () =>
    ascii
      ? gifFrames.map((lines) => composeAsciiBuffer(OUTPUT_SCALE, lines).buf)
      : gifFrames;

  if (videoFormat === "mp4") {
    // MP4: WebCodecs で非同期エンコード。
    // 万一エンコーダの flush が解決しなくても videoEncoding が立ったまま
    // DOWNLOAD を永久に塞がないよう、タイムアウトで必ず決着させる。
    statusText = "ENCODING MP4...";
    videoEncoding = true;
    const frames = prepFrames();
    gifFrames = [];
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("MP4 encode timeout")), 30000),
    );
    Promise.race([
      encodeMp4(frames, encW, encH, bg, fg, loopFps, encScale),
      timeout,
    ])
      .then((blob) => {
        downloadVideoBlob(blob, "mp4");
        statusText = "";
      })
      .catch((err) => {
        console.error("[GENART] MP4 encode failed:", err);
        statusText = "MP4 ENCODE ERROR";
      })
      .finally(() => {
        videoEncoding = false;
      });
    return;
  }

  // GIF: 自前エンコーダで同期エンコード (次フレームに遅延して "ENCODING" を表示)
  statusText = "ENCODING GIF...";
  setTimeout(() => {
    const frames = prepFrames();
    const blob = encodeGif(frames, encW, encH, bg, fg, loopFps, encScale);
    downloadVideoBlob(blob, "gif");
    gifFrames = [];
    statusText = "";
  }, 30);
}

/** Blob を genart_<ALGO>_<PRESET>_<seed>_<ts>.<ext> としてダウンロードする */
function downloadVideoBlob(blob, ext) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const algoName = ALGO_NAMES[currentAlgoIdx];
  const presetName = PRESETS[ALGO_KEYS[currentAlgoIdx]][currentPresetIdx].name;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.download = `genart_${algoName}_${presetName}_${seed}_${ts}.${ext}`;
  a.href = url;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function saveArtAsPng() {
  // DOT: base を整数 ×OUTPUT_SCALE で拡大 (均一ドット)。
  // ASCII: 出力解像度で直接ラスタライズ (×8 で外側マージン厳密対称)。
  const ascii = renderMode === "ascii";
  const { buf, w, h } = ascii
    ? composeAsciiBuffer(OUTPUT_SCALE)
    : composeDotBuffer(artBuf);
  const capScale = ascii ? 1 : OUTPUT_SCALE;
  GPU.beginCapture(w, h);
  GPU.blit(buf, w, h, 0, 0, 1);
  if (invertMode) GPU.invertRect(0, 0, w, h);
  const canvas = GPU.endCapture(capScale);

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
  const wrap = edgeMode === "wrap";
  for (let s = 0; s < perFrame && rdIter < rdMaxIter; s++, rdIter++) {
    for (let y = 0; y < rdH; y++) {
      for (let x = 0; x < rdW; x++) {
        const idx = y * rdW + x;
        // wrap: トーラス (端を巻き戻す)。wall: 無流束 (端は自分自身に clamp = 勾配0)
        const xp =
          x < rdW - 1 ? idx + 1 : wrap ? idx - (rdW - 1) : idx;
        const xn = x > 0 ? idx - 1 : wrap ? idx + (rdW - 1) : idx;
        const yp =
          y < rdH - 1 ? idx + rdW : wrap ? idx - (rdH - 1) * rdW : idx;
        const yn = y > 0 ? idx - rdW : wrap ? idx + (rdH - 1) * rdW : idx;
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
 * ASCII の文字数 (cols/rows) を算出する。base から PAD を引いた描画領域に
 * 中心対称に並ぶグリフ数 (asciiLayout)。base/PAD/字間に追従する。
 */
function calcAACols() {
  return Math.max(4, asciiLayout(baseW, outerMargin, GLYPH_W, charSpacing).n);
}
function calcAARows() {
  return Math.max(3, asciiLayout(baseH, outerMargin, GLYPH_H, charSpacing).n);
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  METABALL — 移動中心の等値面ブロブ (アニメ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 複数の中心からの放射減衰 (r²/dist²) の和を等値面場にする。
// 中心を整数角速度で円軌道させると t∈[0,2π) で一周しシームレスループ。
// 近づいた球同士が融合する「ラバランプ」的な有機運動。

let metaPreset = null;
let metaBalls = null;

function metaballInit(preset, s) {
  metaPreset = preset;
  seedRng(s);
  allocField(preset.chars);
  const cols = calcAACols(),
    rows = calcAARows();
  const minDim = Math.min(cols, rows);
  metaBalls = [];
  for (let i = 0; i < preset.count; i++) {
    metaBalls.push({
      bx: (0.2 + rng() * 0.6) * cols,
      by: (0.2 + rng() * 0.6) * rows,
      orbit: (0.05 + rng() * 0.18) * minDim,
      ang: rng() * Math.PI * 2,
      spin: (rng() < 0.5 ? 1 : -1) * (1 + rngInt(0, 2)), // 整数 → 周期的
      r: (0.08 + rng() * 0.1) * minDim,
    });
  }
  animTime = 0;
  generating = false;
  progress = 1;
  metaballFill(0);
}

function metaballFill(t) {
  if (!metaBalls || !fieldBuf) return;
  const invGamma = 1.0 / metaPreset.gamma;
  const balls = metaBalls;
  const n = balls.length;
  for (let i = 0; i < n; i++) {
    const b = balls[i];
    b.x = b.bx + Math.cos(b.ang + b.spin * t) * b.orbit;
    b.y = b.by + Math.sin(b.ang + b.spin * t) * b.orbit;
    b.r2 = b.r * b.r;
  }
  for (let r = 0; r < fieldRows; r++) {
    const cy = fieldCellY(r);
    const base = r * fieldCols;
    for (let c = 0; c < fieldCols; c++) {
      const cx = fieldCellX(c);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const b = balls[i];
        const dx = cx - b.x,
          dy = cy - b.y;
        sum += b.r2 / (dx * dx + dy * dy + 1e-3);
      }
      let v = sum / (sum + 1); // ソフトな 0..1
      v = v ** invGamma;
      fieldBuf[base + c] = v;
    }
  }
  commitField();
  statusText = `METABALL ${fieldCols}x${fieldRows}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MOIRE — 回転グレーティングの干渉 (アニメ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 複数の正弦グレーティングの積がモアレ (うなり) を生む。
// 全グレーティングの角度を t で回すと一周でループする。
// curve=true は放射状に曲げて渦状のモアレにする。

let moirePreset = null;
let moireGratings = null;

function moireInit(preset, s) {
  moirePreset = preset;
  seedRng(s);
  allocField(preset.chars);
  moireGratings = [];
  for (let i = 0; i < preset.layers; i++) {
    moireGratings.push({
      ang: rng() * Math.PI,
      freq: preset.freq * (0.8 + rng() * 0.5),
      phase: rng() * Math.PI * 2,
      curve: preset.curve ? 0.3 + rng() * 0.7 : 0,
    });
  }
  animTime = 0;
  generating = false;
  progress = 1;
  moireFill(0);
}

function moireFill(t) {
  if (!moireGratings || !fieldBuf) return;
  const invGamma = 1.0 / moirePreset.gamma;
  const gr = moireGratings;
  const m = gr.length;
  const cols = calcAACols(),
    rows = calcAARows();
  const cxC = cols / 2,
    cyC = rows / 2;
  for (let r = 0; r < fieldRows; r++) {
    const cy = fieldCellY(r);
    const base = r * fieldCols;
    for (let c = 0; c < fieldCols; c++) {
      const cx = fieldCellX(c);
      let prod = 1;
      for (let i = 0; i < m; i++) {
        const g = gr[i];
        const a = g.ang + t; // 時間で回転 → 周期的
        let coord = cx * Math.cos(a) + cy * Math.sin(a);
        if (g.curve) {
          const dx = cx - cxC,
            dy = cy - cyC;
          coord += g.curve * Math.sqrt(dx * dx + dy * dy);
        }
        prod *= Math.sin(coord * g.freq + g.phase);
      }
      let v = (prod + 1) * 0.5;
      v = v ** invGamma;
      fieldBuf[base + c] = v;
    }
  }
  commitField();
  statusText = `MOIRE ${fieldCols}x${fieldRows}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CAUSTIC — 水面コースティクス (アニメ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 複数の進行波の和を尾根化 (1-|s|) して鋭く累乗すると、
// 光が集まる細い網目 (コースティクス) になる。
// 各波の速度を整数にして t で位相を進めるとループする。

let causticPreset = null;
let causticWaves = null;

function causticInit(preset, s) {
  causticPreset = preset;
  seedRng(s);
  allocField(preset.chars);
  causticWaves = [];
  for (let i = 0; i < preset.waves; i++) {
    const a = rng() * Math.PI * 2;
    causticWaves.push({
      dx: Math.cos(a),
      dy: Math.sin(a),
      freq: preset.freq * (0.7 + rng() * 0.6),
      speed: (rng() < 0.5 ? 1 : -1) * (1 + rngInt(0, 2)),
      phase: rng() * Math.PI * 2,
    });
  }
  animTime = 0;
  generating = false;
  progress = 1;
  causticFill(0);
}

function causticFill(t) {
  if (!causticWaves || !fieldBuf) return;
  const W = causticWaves;
  const K = W.length;
  const sharp = causticPreset.sharp;
  for (let r = 0; r < fieldRows; r++) {
    const cy = fieldCellY(r);
    const base = r * fieldCols;
    for (let c = 0; c < fieldCols; c++) {
      const cx = fieldCellX(c);
      let s = 0;
      for (let i = 0; i < K; i++) {
        const w = W[i];
        s += Math.sin((cx * w.dx + cy * w.dy) * w.freq + w.speed * t + w.phase);
      }
      s /= K; // -1..1
      let v = 1 - Math.abs(s); // s=0 で尾根
      v = v ** sharp; // 細い網目に
      fieldBuf[base + c] = v;
    }
  }
  commitField();
  statusText = `CAUSTIC ${fieldCols}x${fieldRows}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  QUASIC — 準結晶 (N 枚平面波の干渉) (アニメ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 等角度に並べた N 枚の平面波の和は準結晶 (ペンローズ的) な対称を生む。
// N が奇数 (5,7) だと非周期タイル的、偶数だと結晶的。位相を t で進めてループ。

let quasicPreset = null;
let quasicPhase = null;
let quasicRot = 0;

function quasicInit(preset, s) {
  quasicPreset = preset;
  seedRng(s);
  allocField(preset.chars);
  quasicPhase = [];
  for (let i = 0; i < preset.symmetry; i++)
    quasicPhase.push(rng() * Math.PI * 2);
  quasicRot = rng() * Math.PI * 2;
  animTime = 0;
  generating = false;
  progress = 1;
  quasicFill(0);
}

function quasicFill(t) {
  if (!quasicPhase || !fieldBuf) return;
  const N = quasicPreset.symmetry;
  const freq = quasicPreset.freq;
  const invGamma = 1.0 / quasicPreset.gamma;
  const cols = calcAACols(),
    rows = calcAARows();
  const cxC = cols / 2,
    cyC = rows / 2;
  const dirs = [];
  for (let k = 0; k < N; k++) {
    const a = quasicRot + (Math.PI * 2 * k) / N;
    dirs.push([Math.cos(a), Math.sin(a), quasicPhase[k]]);
  }
  for (let r = 0; r < fieldRows; r++) {
    const cy = fieldCellY(r) - cyC;
    const base = r * fieldCols;
    for (let c = 0; c < fieldCols; c++) {
      const cx = fieldCellX(c) - cxC;
      let s = 0;
      for (let k = 0; k < N; k++) {
        const d = dirs[k];
        s += Math.cos((cx * d[0] + cy * d[1]) * freq + d[2] + t);
      }
      let v = (s / N + 1) * 0.5;
      v = v ** invGamma;
      fieldBuf[base + c] = v;
    }
  }
  commitField();
  statusText = `QUASIC ${fieldCols}x${fieldRows}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  JULIA — ジュリア集合 (連続反復) (アニメ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// z ← z² + c の脱出時間を連続化 (smooth iteration) して濃淡場にする。
// 定数 c を円軌道で動かすと集合が形態変化し、一周でループする。
// 解像度ネイティブに描くので DOT では精緻、ASCII では塊状になる。

let juliaPreset = null;
let juliaCbase = null;
let juliaCphase = 0;

function juliaInit(preset, s) {
  juliaPreset = preset;
  seedRng(s);
  allocField(preset.chars);
  juliaCbase = { re: preset.cre, im: preset.cim };
  juliaCphase = rng() * Math.PI * 2;
  animTime = 0;
  generating = false;
  progress = 1;
  juliaFill(0);
}

function juliaFill(t) {
  if (!juliaPreset || !fieldBuf) return;
  const p = juliaPreset;
  const maxIter = p.iters;
  const invGamma = 1.0 / p.gamma;
  const cre = juliaCbase.re + p.crad * Math.cos(t + juliaCphase);
  const cim = juliaCbase.im + p.crad * Math.sin(t + juliaCphase);
  const cols = fieldCols,
    rows = fieldRows;
  const aspect = cols / rows;
  const LOG2 = Math.log(2);
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    const y0 = ((r + 0.5) / rows - 0.5) * p.span;
    for (let c = 0; c < cols; c++) {
      const x0 = ((c + 0.5) / cols - 0.5) * p.span * aspect;
      let zr = x0,
        zi = y0,
        i = 0,
        m = 0;
      for (; i < maxIter; i++) {
        const zr2 = zr * zr,
          zi2 = zi * zi;
        m = zr2 + zi2;
        if (m > 16) break;
        zi = 2 * zr * zi + cim;
        zr = zr2 - zi2 + cre;
      }
      let v;
      if (i >= maxIter) {
        v = 1; // 集合内部 = 最も密
      } else {
        // smooth iteration count
        const sm = i + 1 - Math.log(0.5 * Math.log(m)) / LOG2;
        v = sm / maxIter;
        if (v < 0) v = 0;
        else if (v > 1) v = 1;
        v = v ** invGamma;
      }
      fieldBuf[base + c] = p.invert ? 1 - v : v;
    }
  }
  commitField();
  statusText = `JULIA ${fieldCols}x${fieldRows}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CURL — ドメインワープ墨流し / 大理石 (アニメ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// fbm で座標をワープ (domain warp) してから正弦の縞に通すと、
// 大理石・墨流し・木目の脈になる。標本オフセットを円運動させ位相を
// t で進めると流れながら一周でループする。構造系 FLOW の「場」リベンジ。

let curlPreset = null;
let curlOffX = 0,
  curlOffY = 0;

function curlInit(preset, s) {
  curlPreset = preset;
  seedRng(s);
  initNoise(s);
  allocField(preset.chars);
  curlOffX = rng() * 1000;
  curlOffY = rng() * 1000;
  animTime = 0;
  generating = false;
  progress = 1;
  curlFill(0);
}

function curlFill(t) {
  if (!curlPreset || !fieldBuf) return;
  const p = curlPreset;
  const sc = p.scale;
  const invGamma = 1.0 / p.gamma;
  const ax = curlOffX + p.flow * Math.cos(t);
  const ay = curlOffY + p.flow * Math.sin(t);
  for (let r = 0; r < fieldRows; r++) {
    const cy = fieldCellY(r);
    const base = r * fieldCols;
    for (let c = 0; c < fieldCols; c++) {
      const cx = fieldCellX(c);
      const nx = (cx + ax) * sc,
        ny = (cy + ay) * sc;
      const qx = fbm(nx, ny, p.octaves);
      const qy = fbm(nx + 5.2, ny + 1.3, p.octaves);
      const warp = fbm(nx + p.warp * qx, ny + p.warp * qy, p.octaves);
      let v = 0.5 + 0.5 * Math.sin(cx * sc * p.veinFreq + warp * p.warpAmt + t);
      v = v ** invGamma;
      fieldBuf[base + c] = v;
    }
  }
  commitField();
  statusText = `CURL ${fieldCols}x${fieldRows}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WORLEY — セルラーノイズ (F1/F2 距離場) (アニメ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 各点に最も近い母点までの距離 F1 (細胞) や F2-F1 (境界の尾根) を場にする。
// 母点を小さく円運動させて t で一周しループ。VORONOI dist の連続アニメ版。

let worleyPreset = null;
let worleyPts = null;
let worleyCols = 0,
  worleyRows = 0;

function worleyInit(preset, s) {
  worleyPreset = preset;
  seedRng(s);
  allocField(preset.chars);
  worleyCols = calcAACols();
  worleyRows = calcAARows();
  const minDim = Math.min(worleyCols, worleyRows);
  worleyPts = [];
  for (let i = 0; i < preset.points; i++) {
    worleyPts.push({
      bx: rng() * worleyCols,
      by: rng() * worleyRows,
      orbit: (0.02 + rng() * 0.06) * minDim,
      ang: rng() * Math.PI * 2,
      spin: (rng() < 0.5 ? 1 : -1) * (1 + rngInt(0, 1)),
    });
  }
  animTime = 0;
  generating = false;
  progress = 1;
  worleyFill(0);
}

function worleyFill(t) {
  if (!worleyPts || !fieldBuf) return;
  const p = worleyPreset;
  const pts = worleyPts;
  const n = pts.length;
  const invGamma = 1.0 / p.gamma;
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    q.x = q.bx + Math.cos(q.ang + q.spin * t) * q.orbit;
    q.y = q.by + Math.sin(q.ang + q.spin * t) * q.orbit;
  }
  // 解像度非依存の正規化: 平均母点間隔で距離をスケールする
  const spacing = Math.sqrt((worleyCols * worleyRows) / n);
  const norm = p.scale / spacing;
  const ridge = p.mode === "ridge";
  for (let r = 0; r < fieldRows; r++) {
    const cy = fieldCellY(r);
    const base = r * fieldCols;
    for (let c = 0; c < fieldCols; c++) {
      const cx = fieldCellX(c);
      let f1 = 1e18,
        f2 = 1e18;
      for (let i = 0; i < n; i++) {
        const q = pts[i];
        const dx = cx - q.x,
          dy = cy - q.y;
        const d = dx * dx + dy * dy;
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
      f1 = Math.sqrt(f1);
      f2 = Math.sqrt(f2);
      let v = ridge
        ? Math.min(1, (f2 - f1) * norm)
        : 1 - Math.min(1, f1 * norm);
      v = v ** invGamma;
      fieldBuf[base + c] = v;
    }
  }
  commitField();
  statusText = `WORLEY ${fieldCols}x${fieldRows}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BZ — 興奮性媒質のらせん波 (一回生成)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Greenberg–Hastings 励起性セルオートマトン。各セルは 0 (静止) と
// 1..STATES-1 (興奮→不応) を巡る。静止セルは興奮 (状態 1) の隣接があれば
// 興奮し、それ以外の状態は毎ステップ進んで静止に戻る。位相勾配で初期化
// すると、らせん波 / ターゲット波が自己組織化する (BZ 反応の質感)。
// 状態を持つ進行的シミュなので一回生成 (発展して凍結) 系。

const BZ_MAX_SIDE = 160;
let bzPreset = null;
let bzS = null,
  bzNext = null;
let bzW = 0,
  bzH = 0,
  bzStates = 8;
let bzStep_n = 0,
  bzMaxSteps = 0;

function bzInit(preset, s) {
  bzPreset = preset;
  seedRng(s);
  bzStates = preset.states;
  bzMaxSteps = preset.maxSteps;

  // シミュ格子サイズ (キャンバスから縮小)
  if (artWidth <= BZ_MAX_SIDE && artHeight <= BZ_MAX_SIDE) {
    bzW = artWidth;
    bzH = artHeight;
  } else {
    const sc = Math.ceil(Math.max(artWidth, artHeight) / BZ_MAX_SIDE);
    bzW = Math.ceil(artWidth / sc);
    bzH = Math.ceil(artHeight / sc);
  }
  const len = bzW * bzH;
  bzS = new Uint8Array(len);
  bzNext = new Uint8Array(len);

  const midX = bzW >> 1,
    midY = bzH >> 1;
  const mode = preset.seedMode;
  for (let y = 0; y < bzH; y++) {
    for (let x = 0; x < bzW; x++) {
      const i = y * bzW + x;
      if (mode === "random") {
        bzS[i] = rngInt(0, bzStates - 1);
      } else if (mode === "center") {
        // 半径方向の位相 → ターゲット波
        const dx = x - midX,
          dy = y - midY;
        const d = Math.sqrt(dx * dx + dy * dy);
        bzS[i] = (((d / 6) | 0) + bzStates) % bzStates;
      } else {
        // spiral: 角度方向の位相勾配 → らせん波
        const ang = Math.atan2(y - midY, x - midX);
        let ph = (ang + Math.PI) / (Math.PI * 2); // 0..1
        bzS[i] = (ph * bzStates) | 0;
        if (bzS[i] >= bzStates) bzS[i] = bzStates - 1;
      }
    }
  }
  bzStep_n = 0;
  generating = true;
  progress = 0;
  allocField(preset.chars);
}

function bzStep() {
  const W = bzW,
    H = bzH,
    N = bzStates;
  const stepsPerFrame = 2;
  const wrap = edgeMode === "wrap";
  for (let sIt = 0; sIt < stepsPerFrame && bzStep_n < bzMaxSteps; sIt++, bzStep_n++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const s = bzS[i];
        if (s === 0) {
          // 静止: 興奮した隣接 (状態 1) があれば興奮。
          // wall: 端の外は静止扱い (0) → 波は壁で反射・消滅する。
          const l = x > 0 ? bzS[i - 1] : wrap ? bzS[i + W - 1] : 0;
          const rr = x < W - 1 ? bzS[i + 1] : wrap ? bzS[i - W + 1] : 0;
          const u = y > 0 ? bzS[i - W] : wrap ? bzS[i + (H - 1) * W] : 0;
          const d = y < H - 1 ? bzS[i + W] : wrap ? bzS[i - (H - 1) * W] : 0;
          bzNext[i] = l === 1 || rr === 1 || u === 1 || d === 1 ? 1 : 0;
        } else {
          bzNext[i] = (s + 1) % N; // 不応期を進めて静止に戻る
        }
      }
    }
    const tmp = bzS;
    bzS = bzNext;
    bzNext = tmp;
  }
  // シミュ格子 → fieldBuf へ再標本化。状態を位相濃淡にマップ。
  for (let fr = 0; fr < fieldRows; fr++) {
    const gy = Math.min(bzH - 1, (((fr + 0.5) / fieldRows) * bzH) | 0);
    const fbase = fr * fieldCols;
    const gbase = gy * bzW;
    for (let fc = 0; fc < fieldCols; fc++) {
      const gx = Math.min(bzW - 1, (((fc + 0.5) / fieldCols) * bzW) | 0);
      const s = bzS[gbase + gx];
      fieldBuf[fbase + fc] = s === 0 ? 0 : 1 - (s - 1) / (bzStates - 1);
    }
  }
  commitField();
  progress = bzStep_n / bzMaxSteps;
  statusText = `BZ: ${bzStep_n}/${bzMaxSteps}`;
  if (bzStep_n >= bzMaxSteps) {
    generating = false;
    progress = 1;
    statusText = `DONE - BZ ${bzStates} STATES`;
  }
}

function startGeneration() {
  const algoKey = ALGO_KEYS[currentAlgoIdx];
  const preset = PRESETS[algoKey][currentPresetIdx];
  generating = false;
  progress = 0;
  switch (algoKey) {
    case "react":
      reactInit(preset, seed);
      break;
    case "voronoi":
      voronoiInit(preset, seed);
      break;
    case "wave":
      waveInit(preset, seed);
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
    case "metaball":
      metaballInit(preset, seed);
      break;
    case "moire":
      moireInit(preset, seed);
      break;
    case "caustic":
      causticInit(preset, seed);
      break;
    case "quasic":
      quasicInit(preset, seed);
      break;
    case "julia":
      juliaInit(preset, seed);
      break;
    case "curl":
      curlInit(preset, seed);
      break;
    case "bz":
      bzInit(preset, seed);
      break;
    case "worley":
      worleyInit(preset, seed);
      break;
  }
}

// 一回生成 (漸進描画) 系のステップ。アニメ系 (plasma/drift/grid/land/wave) は
// stepGeneration を通らず、onDraw が animateFill() で毎フレーム更新する。
function stepGeneration() {
  if (!generating) return;
  switch (ALGO_KEYS[currentAlgoIdx]) {
    case "react":
      reactStep();
      break;
    case "voronoi":
      voronoiStep();
      break;
    case "rain":
      aaRainStep();
      break;
    case "bz":
      bzStep();
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
    case "metaball":
      metaballFill(animTime);
      break;
    case "moire":
      moireFill(animTime);
      break;
    case "caustic":
      causticFill(animTime);
      break;
    case "quasic":
      quasicFill(animTime);
      break;
    case "julia":
      juliaFill(animTime);
      break;
    case "curl":
      curlFill(animTime);
      break;
    case "worley":
      worleyFill(animTime);
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
let ddAlgo, ddPreset, ddRender, nbGap, ddDither, ddEdge, ddFps;
let nbHatch, nbScreen, nbContour, nbScan;
let lblSeed, nbSeed, btnDice, btnGen;
let tglInvert, tglAuto;
let ddSize, nbPad, ddFormat, btnSave, btnFile;
let toolbarH = 0;

const BTN_PAD = 8,
  BTN_BORDER = 4;

/**
 * 現在の方式 (レンダーモード) 専用パラメータの { label, widget }。なければ null。
 * buildToolbar 内で各 widget を生成した後に呼ぶ。
 */
function modeParamItems() {
  switch (renderMode) {
    case "ascii":
      return { label: "GAP:", widget: nbGap };
    case "dot":
    case "braille":
      return { label: "DITHER:", widget: ddDither };
    case "hatch":
      return { label: "PITCH:", widget: nbHatch };
    case "screen":
      return { label: "CELL:", widget: nbScreen };
    case "contour":
      return { label: "LEVELS:", widget: nbContour };
    case "scanline":
      return { label: "LINES:", widget: nbScan };
    default:
      return null;
  }
}

function buildToolbar() {
  const presetNames = PRESETS[ALGO_KEYS[currentAlgoIdx]].map((p) => p.name);

  ddAlgo = new UI.DropDown(0, 0, ALGO_NAMES, currentAlgoIdx, (i) => {
    cancelRecording(); // 録画中の切替は録画を破棄 (跨ぐと無意味 + フラグ残り防止)
    currentAlgoIdx = i;
    currentPresetIdx = 0;
    // 新アルゴリズムが現在のレンダーモードに非対応なら既定モードへ
    const modes = ALGO_MODES[ALGO_KEYS[i]];
    if (!modes.includes(renderMode)) renderMode = modes[0];
    applySize(); // 内容寸法を取り直して再生成
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
    cancelRecording(); // モード切替で録画を破棄 (DOT↔ASCII を跨ぐ録画は無意味)
    renderMode = renderModes[i];
    applySize(); // 内容寸法を取り直して再生成 (DOT/ASCII で外寸は同一)
    buildToolbar(); // GAP (字間) の表示/非表示・形式候補をモードに合わせて切替
  });
  ddRender.tooltip =
    "Render: DOT = 1-bit pixels (GIF-able), ASCII = character cells";

  // ── 字間 (GAP): ASCII のときだけ。文字数は変えず間隔のみ ──
  nbGap = new UI.NumberBox(
    0,
    0,
    SPACING_MIN,
    SPACING_MAX,
    charSpacing,
    1,
    (v) => {
      charSpacing = v;
      applySize(); // 字間は内容ピクセルに含まれるので寸法を取り直す
    },
  );
  nbGap.tooltip = "Char spacing (ASCII): gap between glyphs, count unchanged";

  // ── ディザ行列サイズ (DITHER): DOT のときだけ。2x2/4x4/8x8 ──
  const DITHER_SIZES = [2, 4, 8];
  let ditherSel = DITHER_SIZES.indexOf(ditherSize);
  if (ditherSel < 0) ditherSel = 1;
  ddDither = new UI.DropDown(0, 0, ["2x2", "4x4", "8x8"], ditherSel, (i) => {
    setDitherSize(DITHER_SIZES[i]);
    if (fieldBuf) commitField(); // 現在の場を新しい行列で再ディザ (即時反映)
  });
  ddDither.tooltip =
    "Bayer dither matrix (DOT/BRAILLE): 2x2 coarse / 4x4 / 8x8 fine";

  // ── 方式専用パラメータ (各方式のときだけ row1 に出す)。変更で即再レンダー ──
  const reRender = () => {
    if (fieldBuf) commitField();
  };
  nbHatch = new UI.NumberBox(0, 0, HATCH_MIN, HATCH_MAX, hatchPitch, 1, (v) => {
    hatchPitch = v;
    reRender();
  });
  nbHatch.tooltip = "Hatch line pitch (HATCH): smaller = denser lines";
  nbScreen = new UI.NumberBox(0, 0, SCREEN_MIN, SCREEN_MAX, screenCell, 1, (v) => {
    screenCell = v;
    reRender();
  });
  nbScreen.tooltip = "Halftone cell size (SCREEN): dot grid pitch";
  nbContour = new UI.NumberBox(
    0,
    0,
    CONTOUR_MIN,
    CONTOUR_MAX,
    contourLevels,
    1,
    (v) => {
      contourLevels = v;
      reRender();
    },
  );
  nbContour.tooltip = "Contour levels (CONTOUR): number of iso-line bands";
  nbScan = new UI.NumberBox(0, 0, SCAN_MIN, SCAN_MAX, scanStep, 1, (v) => {
    scanStep = v;
    reRender();
  });
  nbScan.tooltip = "Scan line spacing (SCAN): smaller = more lines / taller";

  // ── 境界条件 (EDGE): REACT / BZ のときだけ。WRAP=トーラス / WALL=壁 ──
  const EDGE_MODES = ["wrap", "wall"];
  let edgeSel = EDGE_MODES.indexOf(edgeMode);
  if (edgeSel < 0) edgeSel = 0;
  ddEdge = new UI.DropDown(0, 0, ["WRAP", "WALL"], edgeSel, (i) => {
    edgeMode = EDGE_MODES[i];
    startGeneration(); // 境界は発展の最初から効くのでシミュを生成し直す
  });
  ddEdge.tooltip =
    "Boundary (REACT/BZ): WRAP = torus (edges loop) / WALL = bounded (edges reflect)";

  // ── 再生 FPS (FPS): アニメ算法のときだけ。プレビュー・書き出し共通 ──
  let fpsSel = FPS_OPTIONS.indexOf(loopFps);
  if (fpsSel < 0) fpsSel = FPS_OPTIONS.indexOf(20);
  ddFps = new UI.DropDown(
    0,
    0,
    FPS_OPTIONS.map((v) => String(v)),
    fpsSel,
    (i) => {
      loopFps = FPS_OPTIONS[i];
      animFrame = -1; // 次フレームで即反映
    },
  );
  ddFps.tooltip =
    "Playback FPS (preview & export). Loop length = 60 / fps sec. GIF-clean values.";

  lblSeed = new UI.Label(0, 0, "SEED:");
  // SEED 変更で即再生成 (サイコロボタンと同じ挙動)
  nbSeed = new UI.NumberBox(0, 0, 0, 9999, seed, 1, (v) => {
    seed = v;
    startGeneration();
  });

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

  // ── 出力外寸プリセット (OUTPUT): 最終出力サイズ。プレビューは ÷OUTPUT_SCALE ──
  // 書き出しは整数 ×OUTPUT_SCALE なので均一ドット & 丸いサイズちょうど。
  const outLabels = OUTPUT_PRESETS.map((o) => o.label);
  ddSize = new UI.DropDown(0, 0, outLabels, currentOutIdx, (i) => {
    applyOutputPreset(i);
  });
  ddSize.tooltip =
    "Output size. Preview = output / 8; export upscales x8 (uniform crisp pixels).";

  // ── 書き出し: 形式 (PNG/GIF/MP4) ──
  const formats = availableFormats();
  if (exportFormatIdx >= formats.length) exportFormatIdx = 0;
  ddFormat = new UI.DropDown(
    0,
    0,
    formats.map((f) => f.label),
    exportFormatIdx,
    (i) => {
      exportFormatIdx = i;
    },
  );
  ddFormat.tooltip =
    "Export format: PNG = still, GIF = loop (any browser), MP4 = loop (SNS)";

  // ── 額縁マット (PAD): base から上下左右対称に削る描画領域の余白。書き出し込み ──
  nbPad = new UI.NumberBox(0, 0, MARGIN_MIN, MARGIN_MAX, outerMargin, 1, (v) => {
    outerMargin = v; // 描画領域 = base - 2*PAD。各辺 PAD px の対称マット
    applySize(); // 描画領域が変わるので取り直して再生成
  });
  nbPad.tooltip = "Frame matte: symmetric margin, trims the drawing area (in export too)";

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
  const lblEdge = new UI.Label(0, 0, "EDGE:");
  const lblOut = new UI.Label(0, 0, "OUT:");
  const lblPad = new UI.Label(0, 0, "PAD:");
  const lblFps = new UI.Label(0, 0, "FPS:");
  // 1行目: 何を (ALGO) どんなスタイルで (STYLE) どう見せるか (AS)
  //   + 方式ごとの専用パラメータ (DITHER/GAP/PITCH/CELL/LEVELS/LINES) を出す
  const row1Items = [lblAlgo, ddAlgo, lblStyle, ddPreset, lblRender, ddRender];
  const mp = modeParamItems();
  if (mp) row1Items.push(new UI.Label(0, 0, mp.label), mp.widget);
  const row1 = UI.HBox(row1Items);
  // 2行目: 生成 (seed + transport) + REACT/BZ なら EDGE、アニメ算法なら FPS
  const row2Items = [lblSeed, nbSeed, btnDice, tglAuto, btnGen, tglInvert];
  if (algoSupportsEdge()) row2Items.push(lblEdge, ddEdge);
  if (isAnimated()) row2Items.push(lblFps, ddFps);
  const row2 = UI.HBox(row2Items);
  // 3行目: 出力外寸 (OUT) + 額縁 PAD + 書き出し (形式 + DOWNLOAD/SAVE)
  const row3 = UI.HBox([lblOut, ddSize, lblPad, nbPad, ddFormat, btnSave, btnFile]);
  toolbarRoot = UI.VBox([row1, row2, row3]);
  toolbar = new UI.WidgetGroup(toolbarRoot);
  toolbarH = toolbarRoot.y + toolbarRoot.h;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  額縁 (マット) と合成
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// アート内容の周囲に outerMargin px の背景マットを足し、1px の枠線で囲うと
// 「額縁」になる。ASCII は字間 charSpacing でグリフを配置する (文字数は変えず
// 間隔だけ調整)。表示・書き出しとも、この合成バッファ (0=背景/マット, 1=前景)
// を経由するので、額縁は画面にも書き出しファイルにも等しく反映される。

// プレビュー/合成キャンバス寸法 = base (出力 = base × OUTPUT_SCALE)。
// DOT/ASCII とも同じ base に合成するので外寸が完全一致する。
function canvasDispW() {
  return baseW;
}
function canvasDispH() {
  return baseH;
}

/**
 * ASCII グリフを 1 軸に均一ピッチで中央寄せ配置する位置列を返す (scale 倍)。
 * 文字数 n は base (scale 1) で確定。配置はスケール先で行うので、書き出しの
 * ×OUTPUT_SCALE では余りが必ず偶数になり、外側マージンが左右上下で厳密一致する。
 * 均一ピッチなので中央に継ぎ目 (シーム) を作らない (4 象限分割バグの修正)。
 *
 * @returns {{ n:number, pos:number[], margin:number }}
 */
function asciiLayout(baseDim, pad, glyphSize, spacing, scale = 1) {
  const usable = Math.max(glyphSize, baseDim - 2 * pad);
  const pitch = glyphSize + spacing;
  let n = Math.floor((usable + spacing) / pitch); // 文字数 (base で確定)
  if (n < 1) n = 1;
  const ps = pitch * scale;
  const ev = n * glyphSize * scale + (n - 1) * spacing * scale; // 可視 extent (scale 倍)
  const margin = (baseDim * scale - ev) >> 1; // 中央寄せ (均一ピッチ)
  const pos = new Array(n);
  for (let i = 0; i < n; i++) pos[i] = margin + i * ps;
  return { n, pos, margin };
}

/** DOT バッファ (artWidth×artHeight) を PAD マット付きで base に合成 */
function composeDotBuffer(src) {
  const out = new Uint8Array(baseW * baseH);
  // artWidth = baseW - 2*PAD なので x0 = PAD。端数なく左右上下対称。
  const x0 = (baseW - artWidth) >> 1,
    y0 = (baseH - artHeight) >> 1;
  for (let y = 0; y < artHeight; y++) {
    out.set(src.subarray(y * artWidth, (y + 1) * artWidth), (y0 + y) * baseW + x0);
  }
  return { buf: out, w: baseW, h: baseH };
}

/**
 * ASCII グリフを base×scale のバッファに均一ピッチ中央寄せでラスタライズ。
 * scale=1 はプレビュー、scale=OUTPUT_SCALE は書き出し (×8 で厳密対称)。
 * lines 省略時は現在の aaLines (録画では各フレームの行を渡す)。
 */
function composeAsciiBuffer(scale = 1, lines = aaLines) {
  lines = lines || [];
  const lx = asciiLayout(baseW, outerMargin, GLYPH_W, charSpacing, scale);
  const ly = asciiLayout(baseH, outerMargin, GLYPH_H, charSpacing, scale);
  const W = baseW * scale,
    H = baseH * scale;
  const out = new Uint8Array(W * H);
  for (let r = 0; r < lines.length && r < ly.n; r++) {
    const line = lines[r];
    const oy = ly.pos[r];
    for (let c = 0; c < line.length && c < lx.n; c++) {
      const g = getGlyph(line[c]);
      if (!g) continue;
      const ox = lx.pos[c];
      for (let gy = 0; gy < GLYPH_H; gy++) {
        const gRow = gy * GLYPH_W;
        const yBase = oy + gy * scale;
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (!g[gRow + gx]) continue;
          const xBase = ox + gx * scale;
          for (let sy = 0; sy < scale; sy++) {
            const row = (yBase + sy) * W + xBase;
            for (let sx = 0; sx < scale; sx++) out[row + sx] = 1;
          }
        }
      }
    }
  }
  return { buf: out, w: W, h: H };
}

/** プレビュー用: base サイズの 1bit バッファ (0=背景, 1=前景) */
function composeCanvas() {
  return renderMode === "ascii"
    ? composeAsciiBuffer(1)
    : composeDotBuffer(artBuf);
}

/**
 * 録画フレーム捕捉。DOT は base 合成バッファ (encode 時に整数 ×OUTPUT_SCALE)、
 * ASCII は各フレームの aaLines をコピー (encode 時に出力解像度でラスタライズ
 * → ×8 で厳密対称)。
 */
function captureFrame() {
  return renderMode === "ascii"
    ? (aaLines || []).slice()
    : composeDotBuffer(artBuf).buf;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WM コールバック
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDraw(contentRect) {
  if (gifRecording && isAnimated()) {
    // ── ループ録画: 1 周期 (2π) を gifFrameTotal 等分でサンプル → シームレスループ ──
    animTime = (gifLoopFrame / gifFrameTotal) * Math.PI * 2;
    animateFill();
    gifFrames.push(captureFrame());
    gifLoopFrame++;
    statusText = `RECORDING LOOP ${gifLoopFrame}/${gifFrameTotal}`;
    if (gifLoopFrame >= gifFrameTotal) finishVideoRecording();
  } else if (isAnimated()) {
    // ── 連続アニメ: 実時間ベースで LOOP_FRAMES を loopFps で再生 (=書き出しと一致)。
    // ディスプレイのリフレッシュレートに依存せず、選択 fps がそのまま反映される。
    const frame =
      Math.floor((performance.now() / 1000) * loopFps) % LOOP_FRAMES;
    if (frame !== animFrame) {
      animFrame = frame;
      animTime = (frame / LOOP_FRAMES) * Math.PI * 2;
      animateFill(); // フレームが変わったときだけ場を再計算
    }
  } else {
    // ── 一回生成系 (漸進描画) ──
    if (generating) stepGeneration();

    // 動画録画: 生成過程を progress 閾値ごとに artBuf スナップショットでサンプル。
    // 完了したら最終形を数フレーム保持してエンコード → ダウンロード。
    if (gifRecording) {
      if (generating) {
        if (progress >= gifNextSample) {
          gifFrames.push(captureFrame());
          gifNextSample += 1 / gifFrameTotal;
        }
      } else {
        const final = captureFrame();
        for (let k = 0; k < 5; k++) gifFrames.push(final); // 完成形を少しホールド
        finishVideoRecording();
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

  // 額縁付きキャンバスを合成 (マット + 内容)。表示も書き出しも同じ合成を通す。
  const { buf, w: cw, h: ch } = composeCanvas();

  // キャンバスの左端をツールバー (FOCUS_MARGIN 起点) に揃える。
  const ax = contentRect.x + UI.FOCUS_MARGIN;
  const cy0 = contentRect.y + toolbarH + CANVAS_GAP;
  const cx = ax + 1,
    cy = cy0 + 1;
  GPU.drawRect(ax, cy0, cw + 2, ch + 2, 1); // 枠線 (額縁の縁)
  GPU.fillRect(cx, cy, cw, ch, 0); // 背景 + マット
  GPU.blit(buf, cw, ch, cx, cy, 1); // 前景 (内容)
  if (invertMode) GPU.invertRect(cx, cy, cw, ch);

  if (generating) {
    const barW = cw + 2,
      barH = 3,
      barX = ax,
      barY = cy + ch + 2;
    GPU.fillRect(barX, barY, barW, barH, 0);
    GPU.drawRect(barX, barY, barW, barH, 1);
    const filled = ((barW - 2) * progress) | 0;
    if (filled > 0) GPU.fillRect(barX + 1, barY + 1, filled, barH - 2, 1);
  }

  if (autoMode && !generating) {
    const secs = ((AUTO_INTERVAL - autoTimer) / 60).toFixed(1);
    const txt = `NEXT: ${secs}s`;
    const tw = textWidth(txt);
    const ty = cy + ch - GLYPH_H - 2,
      tx = cx + cw - tw - 2;
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
    w: Math.max(tbSize.w, UI.FOCUS_MARGIN + canvasDispW() + 2),
    h: toolbarH + CANVAS_GAP + canvasDispH() + 2 + 6,
  };
}

function onDrawFooter(footerRect) {
  drawText(footerRect.x, footerRect.y, statusText, 1);
  // 右側: プレビュー base 寸法 → 出力解像度 (base ×OUTPUT_SCALE)。常時表示。
  const key = currentFormatKey();
  const cw = canvasDispW(),
    ch = canvasDispH();
  const outW = cw * OUTPUT_SCALE,
    outH = ch * OUTPUT_SCALE;
  const fmt = key.toUpperCase();
  const info = `${cw}x${ch} ->${fmt} ${outW}x${outH}`;
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
  currentOutIdx = 0; // 1920x1080
  baseW = OUTPUT_PRESETS[0].baseW;
  baseH = OUTPUT_PRESETS[0].baseH;
  renderMode = "dot";
  outerMargin = 8;
  charSpacing = 1;
  setDitherSize(2);
  hatchPitch = 4;
  screenCell = 6;
  contourLevels = 7;
  scanStep = 4;
  edgeMode = "wrap";
  loopFps = 20;
  animTime = 0;
  animFrame = -1;
  gifRecording = false;
  gifLoopFrame = 0;
  videoFormat = "gif";
  videoEncoding = false;
  exportFormatIdx = 0; // PNG
  resizeArt(baseW - 2 * outerMargin, baseH - 2 * outerMargin);
  fieldBuf = null;
  rdU = rdV = rdNU = rdNV = null;
  vorPoints = null;
  waveSources = null;
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
  metaBalls = null;
  moireGratings = null;
  causticWaves = null;
  quasicPhase = null;
  juliaPreset = null;
  curlPreset = null;
  worleyPts = null;
  bzS = bzNext = null;
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

