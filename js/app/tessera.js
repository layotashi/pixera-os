/**
 * @module app/tessera
 * tessera.js — TESSERA — ライブコーディング環境（Tessera 言語）
 *
 * lang/（SYNESTA とは独立した generative-art の小言語 "Tessera"）を SYNESTA に統合した
 * creative-coding ウィンドウ。左でコードを書き、右でライブプレビュー。拡張子は `.tess`。
 *
 * 名前: tessera = モザイクの一片（タイル）。1-bit のセル/ピクセルを敷き詰めて絵にする
 * この言語の本質。tessellation（平面充填）と同語源。
 *
 * 立ち位置: SYNESTA 唯一の generative-art アプリ。旧 GENART（プリセット＋ノブのノーコード）
 * は廃止し、その全 19 算法を `.tess` サンプルへ、出力パイプライン（OUTPUT/dotScale/PAD/
 * PNG·GIF·MP4）を本アプリへ移設・一本化した。「書いて創る」コード一本。
 *
 * 統合の要: 言語は抽象 surface 契約だけに依存。lang/surface.js の純粋な
 * makeBufferSurface（1-bit FB）に描かせ、その .buf を GPU.blit するだけ。合成・書き出しは
 * 共有モジュール core/art_export.js（旧 GENART の compose/encode を抽出・一般化）。
 *
 * 設定はすべてコードの設定ディレクティブで宣言する（recipe 自己完結）:
 *   size: WxH / pixel: N / pad: N / fps: N / seed: N / view: mode(args)
 * 画面のコントロールは「書き出し形式 + DL」のみ＝最小。SEED/方式/出力/pixel/pad/fps の
 * ウィジェットは廃止した（旧 GENART/初期 TESSERA の名残）。プレビューは size のアスペクト比を反映。
 *
 * 構成:
 *   - コントロール: 書き出し形式(PNG/GIF/MP4) + DL ボタンのみ
 *   - 左: コードエディタ (TextArea)。編集で即 compile。
 *   - 右: ライブプレビュー（size のアスペクト比、surface.buf を整数倍 blit）
 *   - 最下部: ショートカット凡例（常時）
 *   - footer: エラー (pos 付き) / 状態 (kind・size・seed) / 書き出し進捗
 *
 * VFS / 操作:
 *   - Alt+N 新規 / Ctrl+O 開く / Ctrl+S 保存 / Ctrl+Shift+S 名前を付けて保存
 *   - Ctrl+E / DL で size ちょうどに PNG/GIF/MP4 書き出し。Ctrl+R で seed: を振り直す。
 *   - Shift+Alt+F で整形。未保存変更は破棄確認。サンプルは /TESSERA/LEARN（番号順
 *     チュートリアル）と /TESSERA/GALLERY（作例）に種まき。
 *   - EXPLORER から .tess をダブルクリックで開く（tesseraOpenFile）。
 */

import * as WM from "../wm/index.js";
import * as UI from "../ui/index.js";
import * as GPU from "../core/gpu.js";
import * as VFS from "../core/vfs.js";
import { drawText, textWidth, getGlyph, GLYPH_W, GLYPH_H } from "../core/font.js";
import { altShiftDown, altDown, ctrlDown, ctrlShiftDown } from "../core/input.js";
import * as FieldRender from "../core/field_render.js";
import * as AsciiArt from "../core/ascii_art.js";
import * as ArtExport from "../core/art_export.js";
import { compile } from "../../lang/runtime.js";
import { makeBufferSurface } from "../../lang/surface.js";
import { format } from "../../lang/format.js";

const APP_NAME = "TESSERA";
const EXT = ".tess";
const HOME_DIR = "/TESSERA"; // .tess 作品の保存先（アプリ名と一致）
// 学習用（番号順・1概念ずつ・解説コメント付き）と作例集（ショーケース）の 2 層。
const LEARN_DIR = "/TESSERA/LEARN";
const GALLERY_DIR = "/TESSERA/GALLERY";

// ── レイアウト/プレビュー ──
const COLS = 40; // エディタ幅 (文字数)。40桁 = レトロ家庭機の画面幅
const ROWS = 16; // エディタ表示行数
const MAX_LINES = 9999;
const PV_BOX = 176; // 画面上のプレビュー枠の長辺px（出力をクリーンな倍率で縮めて表示）
// プレビューは出力合成（art→額縁→base）をクリーンな倍率(整数 or 1/整数)＋NN で見せる
// ＝pixel の粗さ・pad が WYSIWYG かつ半端比率のモアレ無し。cells は重いので評価解像度を抑える。
const PV_CELLS_CAP = 120; // cells の art 評価上限px（毎フレーム step で重いため）
const GAP = 8; // エディタ⇄プレビュー間

/** 起動時 / 新規の既定スケッチ。設定ディレクティブの雛形を兼ね、書き方を示す。 */
const DEFAULT_CODE = `size: 1080x1080
seed: 0
view: dither(2)

sin(x*8 - t) * cos(y*8 + t*1.3) * 0.5 + 0.5`;

/**
 * サンプルは 2 層: LEARN（番号順・1 概念ずつ・解説コメント付き＝見て文法を学ぶ）と
 * GALLERY（ショーケース＝高 ceiling の作例）。種まき先は LEARN_DIR / GALLERY_DIR。
 * コメント・空行は整形で保持されるので、コメントが学習ガイドとして機能する。
 * 座標は x,y ∈ [0,1]、t は経過秒。
 */
const LEARN_SAMPLES = [
  {
    file: "01_field" + EXT,
    src: `// a sketch is a field f(x,y) -> 0..1.
// x,y run 0..1 across the canvas.
// here we just return x (a gradient).
x`,
  },
  {
    file: "02_waves" + EXT,
    src: `// math becomes pattern. sin is -1..1,
// so *0.5 + 0.5 maps it to 0..1.
// x*8 = 8 cycles. change the 8.
sin(x*8) * 0.5 + 0.5`,
  },
  {
    file: "03_time" + EXT,
    src: `// t is elapsed seconds; use it to
// animate. subtracting t scrolls the
// wave sideways.
sin(x*8 - t) * 0.5 + 0.5`,
  },
  {
    file: "04_shapes" + EXT,
    src: `// dist() = distance to a point.
// smoothstep makes a soft edge.
// together: a filled circle.
1 - smoothstep(0.24, 0.26, dist(x, y, 0.5, 0.5))`,
  },
  {
    file: "05_noise" + EXT,
    src: `// fbm = layered (fractal) noise:
// organic, cloud-like. press Ctrl+R
// to reseed and get a new cloud.
fbm(x*4, y*4, 4)`,
  },
  {
    file: "06_view" + EXT,
    src: `// view: how a field becomes 1-bit.
// try dither / hatch / halftone /
// braille / ascii on the same field.
view: halftone(8)
1 - dist(x, y, 0.5, 0.5)`,
  },
  {
    file: "07_output" + EXT,
    src: `// all output settings live in code
// (the file IS the recipe).
// size=pixels, pixel=chunkiness,
// seed=randomness.
size: 1080x1080
pixel: 8
seed: 0
fbm(x*3, y*3, 5)`,
  },
  {
    file: "08_repeat" + EXT,
    src: `// a value block runs statements, then
// returns the final expression.
// repeat N as k loops k=0..N-1.
// here: sum N orbiting blobs.
view: dither(2)
s = 0
repeat 4 as k {
  cx = 0.5 + 0.28 * cos(t + k*1.7)
  cy = 0.5 + 0.28 * sin(t*1.3 + k*1.7)
  s = s + 0.012 / ((x - cx)*(x - cx) + (y - cy)*(y - cy) + 0.001)
}
s / (s + 1)`,
  },
  {
    file: "09_draw" + EXT,
    src: `// draw {} is procedural: point / line
// commands in 0..1. no auto-clear, so
// you can build up. a spinning fan:
draw {
  clear
  repeat 24 as k {
    a = k * (TAU / 24) + t*0.2
    line(0.5, 0.5, 0.5 + cos(a)*0.45, 0.5 + sin(a)*0.45)
  }
}`,
  },
  {
    file: "10_cells" + EXT,
    src: `// field {} keeps per-cell state,
// updated each frame (init/step/show).
// lap()/nbr()/sum8() read neighbours.
// this majority-vote CA grows blobs.
field {
  init: rnd(x*24, y*24)
  step: clamp(s + (sum8()/8 - 0.5) * 0.6, 0, 1)
  show: step(0.5, s)
}`,
  },
  {
    file: "11_reaction" + EXT,
    src: `// channels can react to each other:
// real reaction-diffusion.
// gray-scott: u feeds v, v eats u.
// spots, stripes, self-replication.
field {
  Du = 0.16
  Dv = 0.08
  f = 0.06
  k = 0.062
  u: {
    init: 1
    step: u + Du*lap() - u*v*v + f*(1 - u)
  }
  v: {
    init: 1 - step(0.07, dist(x, y, 0.5, 0.5)) + rnd(x*99, y*99)*0.02
    step: v + Dv*lap() + u*v*v - (f + k)*v
  }
  show: v
}`,
  },
];

const GALLERY_SAMPLES = [
  {
    // WAVE: 複数点源の同心波の干渉
    file: "wave" + EXT,
    src: `view: dither(2)
(sin(dist(x, y, 0.3, 0.4)*40 - t*2)
 + sin(dist(x, y, 0.7, 0.65)*40 - t*2)) * 0.25 + 0.5`,
  },
  {
    // PLASMA: sin/cos 多重干渉プラズマ
    file: "plasma" + EXT,
    src: `view: dither(2)
(sin(x*8 + t) + sin(y*8 - t)
 + sin((x + y)*6 + t)
 + sin(dist(x, y, 0.5, 0.5)*12 - t)) * 0.125 + 0.5`,
  },
  {
    // DRIFT: fbm 密度場。標本点が円運動し雲のように漂う
    file: "drift" + EXT,
    src: `fbm(x*4 + sin(t)*0.3, y*4 + cos(t)*0.3, 4)`,
  },
  {
    // GRID: 市松テッセレーション（ゆっくり漂う）
    file: "grid" + EXT,
    src: `view: dither(2)
step(0.5, mod(floor(x*8 + sin(t)*2) + floor(y*8 + cos(t)*2), 2))`,
  },
  {
    // MOIRE: わずかに角度のずれた 2 枚の同周波グレーティングの積（うなり）
    file: "moire" + EXT,
    src: `sin((x*cos(t) + y*sin(t))*18)
 * sin((x*cos(t + 0.2) + y*sin(t + 0.2))*18) * 0.5 + 0.5`,
  },
  {
    // CAUSTIC: 進行波の和を尾根化し鋭く累乗 → 水面の光の網目
    file: "caustic" + EXT,
    src: `view: dither(2)
s = (sin(x*22 + t*2) + sin(y*20 - t*2) + sin((x + y)*16 + t)) / 3
(1 - abs(s)) ^ 4`,
  },
  {
    // QUASIC: 等角に並べた N 枚平面波の和 → 準結晶（5 回対称）
    file: "quasic" + EXT,
    src: `view: dither(2)
s = 0
repeat 5 as k {
  a = k * (TAU / 5)
  s = s + cos(((x - 0.5)*cos(a) + (y - 0.5)*sin(a))*30 + t)
}
s / 5 * 0.5 + 0.5`,
  },
  {
    // JULIA: z <- z*z + c の脱出時間（値ブロックで反復）。c が円運動し形態変化
    file: "julia" + EXT,
    src: `view: dither(2)
zr = (x - 0.5)*3
zi = (y - 0.5)*3
cr = cos(t)*0.2 - 0.6
ci = sin(t)*0.2
m = 0
repeat 24 {
  zt = clamp(zr*zr - zi*zi + cr, -4, 4)
  zi = clamp(2*zr*zi + ci, -4, 4)
  zr = zt
  m = m + (zr*zr + zi*zi)
}
clamp(1 - m/120, 0, 1)`,
  },
  {
    // CURL: fbm でドメインワープした正弦の縞 → 大理石 / 墨流し
    file: "curl" + EXT,
    src: `view: dither(2)
qx = fbm(x*3 + t*0.1, y*3, 4)
qy = fbm(x*3 + 4.2, y*3 + 1.7, 4)
w = fbm(x*3 + qx*2, y*3 + qy*2, 4)
0.5 + 0.5 * sin(x*20 + w*8 + t)`,
  },
  {
    // WORLEY: セルラーノイズ（最近傍距離）。細胞 / 石畳模様
    file: "worley" + EXT,
    src: `view: dither(2)
1 - worley(x*6 + sin(t*0.5)*0.5, y*6)`,
  },
  {
    // ATTRACT: カオス力学系（de Jong）を点描。draw の高 ceiling 例
    file: "attractor" + EXT,
    src: `draw {
  clear
  x = 0
  y = 0
  repeat 30000 {
    nx = sin(-1.4 * y) + 1.6 * cos(-1.4 * x)
    ny = sin(1.6 * x) + 0.7 * cos(1.6 * y)
    x = nx
    y = ny
    point(x*0.25 + 0.5, y*0.25 + 0.5)
  }
}`,
  },
  {
    // GIERER-MEINHARDT: 活性 a / 抑制 h。斑点状チューリングパターン
    file: "gierer" + EXT,
    src: `field {
  Da = 0.04
  Dh = 0.25
  rate = 0.06
  ka = 0.1
  a: {
    init: 1 + (rnd(x*40, y*40) - 0.5)*0.1
    step: clamp(a + Da*lap() + rate*(a*a/((h + 0.001)*(1 + ka*a*a)) - a), 0, 50)
  }
  h: {
    init: 1 + (rnd(x*40 + 9, y*40 + 9) - 0.5)*0.1
    step: clamp(h + Dh*lap() + rate*(a*a - h), 0.001, 50)
  }
  show: smoothstep(0.8, 3, a)
}`,
  },
  {
    // BZ: 励起性媒質。対称性を破る初期値かららせん波 / ターゲット波
    file: "bz" + EXT,
    src: `field {
  Du = 0.18
  eps = 0.05
  a1 = 0.6
  dt = 0.5
  u: {
    init: step(0.5, x)*2 - 1
    step: clamp(u + Du*lap() + dt*(u - u*u*u - v), -2, 2)
  }
  v: {
    init: step(0.5, y)*0.6 - 0.3
    step: clamp(v + dt*eps*(u - a1*v), -2, 2)
  }
  show: smoothstep(-0.4, 0.6, u)
}`,
  },
];

// ── レンダーモード（場 → 1-bit。共有 core/field_render.js を使う） ──
// 場プログラム(field/cells)の blitField を共有レンダラへ通す。draw プログラムは
// point/line を直接バッファへ描くので無関係。方式は view: でコードから宣言する。
const RENDER_MODES = ["dither", "ascii", "hatch", "halftone", "braille"];

// ── ASCII（場 → 文字グリッド → グリフ）。共有コア core/ascii_art.js を使う ──
// ASCII は場(field/cells)専用。draw は線画なので不適 → asciiActive で場のみゲート。
const ASCII_RAMP_CHARS = " .-:;+=*&%@$#";
let _asciiRamp = null;
function asciiRamp() {
  if (!_asciiRamp) _asciiRamp = AsciiArt.buildToneRamp(ASCII_RAMP_CHARS);
  return _asciiRamp;
}
let asciiActive = false; // onDraw で確定（ascii モード かつ 場プログラム）
// 方式パラメータの既定（view: で個別指定が無いとき）。
const MODE_PARAMS = {
  ditherSize: 2,
  hatchPitch: 4,
  halftoneCell: 6,
};
const DEFAULT_MODE = "dither";
// 実効モード/パラメータ（onDraw で config.view 優先で確定し、blitField が参照）。
let activeMode = DEFAULT_MODE;
let activeParams = MODE_PARAMS;

/** view: 引数（数値）を field_render パラメータへ写す。各モードは args[0] を使う。 */
const VIEW_PARAM = {
  dither: "ditherSize",
  braille: "ditherSize",
  hatch: "hatchPitch",
  halftone: "halftoneCell",
};

// ── 出力サイズモデル（すべてコードの設定ディレクティブから。ウィジェットは廃止）──
// 出力 = base ×pixel。base = 出力 ÷ pixel の解像度で描き、整数 ×pixel で書き出す。
// 「1 アートピクセル = pixel 物理px」が厳密（粗さ＝チャンキーさ）。額縁 pad は出力px。
const PIXEL_SIZES = [8, 4, 2, 1]; // 1 アートピクセル = N 物理px（小さいほど高精細）
const FPS_OPTIONS = [5, 10, 20, 25, 50, 100]; // GIF は 100 の約数が綺麗
const LOOP_FRAMES = 60; // 動画 1 周期のフレーム数
const CELLS_SIM_CAP = 128; // cells のシミュ格子 長辺上限（出力解像度だと重い）
const CELLS_WARMUP = 320; // 書き出し前に回すステップ数（模様を発展させる）
const DEFAULTS = { sizeW: 1080, sizeH: 1080, pixel: 8, pad: 0, fps: 20, seed: 0 };

const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const nearest = (v, arr) => arr.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

/** program.config（生の宣言値）を既定値・範囲とともに解決した実効設定にする。 */
function resolvedConfig() {
  const c = (program && program.config) || {};
  const size = c.size || {};
  const sizeW = clampI(size.w ?? DEFAULTS.sizeW, 16, 4096);
  const sizeH = clampI(size.h ?? DEFAULTS.sizeH, 16, 4096);
  const pixel = nearest(c.pixel ?? DEFAULTS.pixel, PIXEL_SIZES);
  const fps = nearest(c.fps ?? DEFAULTS.fps, FPS_OPTIONS);
  const seed = clampI(c.seed ?? DEFAULTS.seed, 0, 999999);
  // pad（出力px）は base 上で各辺がアート(≥4px)を潰さない範囲にクランプ。
  const padMax = Math.max(0, Math.floor((Math.min(sizeW, sizeH) / pixel - 4) / 2) * pixel);
  const pad = clampI(c.pad ?? DEFAULTS.pad, 0, padMax);
  return { sizeW, sizeH, pixel, pad, fps, seed };
}

/** 出力寸法を実効設定から導出（base / art / pad[base上] / pixel / fps）。 */
function outputDims() {
  const { sizeW, sizeH, pixel, pad, fps } = resolvedConfig();
  const baseW = Math.round(sizeW / pixel);
  const baseH = Math.round(sizeH / pixel);
  const bpad = Math.round(pad / pixel);
  const artW = Math.max(8, baseW - 2 * bpad);
  const artH = Math.max(8, baseH - 2 * bpad);
  return { baseW, baseH, artW, artH, pixel, fps };
}

const EXPORT_FORMATS = [
  { key: "png", label: "PNG" },
  { key: "gif", label: "GIF" },
  { key: "mp4", label: "MP4" },
];
let exportFormatIdx = 0; // availableFormats() のインデックス
/** この環境で選べる書き出し形式（MP4 は WebCodecs 対応時のみ）。 */
function availableFormats() {
  return EXPORT_FORMATS.filter((f) => f.key !== "mp4" || ArtExport.isMp4Supported());
}
function currentFormatKey() {
  const a = availableFormats();
  return (a[exportFormatIdx] || a[0]).key;
}
let statusText = ""; // 書き出し進捗（footer 右に表示）

/** プログラムの view: があればそれを、無ければ既定方式（dither）を実効方式とする。 */
function effectiveRender() {
  const v = program && program.config && program.config.view;
  if (v && RENDER_MODES.includes(v.mode)) {
    const params = { ...MODE_PARAMS };
    if (v.args.length && VIEW_PARAM[v.mode]) params[VIEW_PARAM[v.mode]] = v.args[0];
    return { mode: v.mode, params };
  }
  return { mode: DEFAULT_MODE, params: MODE_PARAMS };
}

// ── プレビュー surface（art 評価解像度で確保。解像度が変わるときだけ再確保＝状態場を温存）──
let surface = null,
  pvW = 0,
  pvH = 0;
/** プレビュー surface を必要なら再確保（解像度が変わったときだけ＝状態場を温存）。 */
function ensureSurface(w, h) {
  if (surface && pvW === w && pvH === h) return;
  pvW = w;
  pvH = h;
  surface = makeBufferSurface(w, h);
  // ASCII は文字グリッド解像度で場を評価（1 文字 = 1 セル）。それ以外は w×h。
  surface.width = () => (asciiActive ? Math.max(1, Math.floor(w / AsciiArt.CELL_W)) : w);
  surface.height = () => (asciiActive ? Math.max(1, Math.floor(h / AsciiArt.CELL_H)) : h);
  surface.blitField = (field, fw, fh) => {
    if (asciiActive)
      rasterizeAsciiLinesToBuf(
        AsciiArt.renderAsciiLines(field, fw, fh, asciiRamp()),
        surface.buf,
        w,
        h,
      );
    else FieldRender.renderField(field, fw, fh, surface.buf, activeMode, activeParams);
  };
}

/** 文字グリッド（string[]）を任意サイズの 1-bit バッファへグリフ描画する。 */
function rasterizeAsciiLinesToBuf(lines, buf, w, h) {
  buf.fill(0);
  for (let r = 0; r < lines.length; r++) {
    const oy = r * AsciiArt.CELL_H;
    if (oy >= h) break;
    const line = lines[r];
    for (let c = 0; c < line.length; c++) {
      const g = getGlyph(line[c]);
      if (!g) continue;
      const ox = c * AsciiArt.CELL_W;
      if (ox >= w) break;
      for (let gy = 0; gy < GLYPH_H; gy++) {
        const grow = gy * GLYPH_W;
        const py = oy + gy;
        if (py >= h) break;
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (!g[grow + gx]) continue;
          const px = ox + gx;
          if (px < w) buf[py * w + px] = 1;
        }
      }
    }
  }
}

let program = null;
let errMsg = "";
let t0 = performance.now();
let winId = null;
/** 現在編集中のファイル VFS パス (null = 無題) */
let currentFilePath = null;
let isDirty = false;

// ── ウィジェット (遅延初期化) ──
// パラメータ（seed/方式/出力/dot/pad/fps）はすべてコードの設定ディレクティブで指定する。
// 画面に残すコントロールは「書き出し形式 + DOWNLOAD」のみ（最小コントロール）。
let editor, ddFormat, btnDownload, ctrlRow, root, group;
let _ready = false;
let _seeded = false;

function recompile(src) {
  try {
    program = compile(src);
    errMsg = "";
  } catch (e) {
    program = null;
    errMsg = e.message + (e.pos != null ? ` (pos ${e.pos})` : "");
  }
}

/** エディタへコードを流し込み、再コンパイルして時刻リセット（open/new 用。dirty は呼び側） */
function setCode(src) {
  editor.lines = src.split("\n");
  editor.cursorRow = 0;
  editor.cursorCol = 0;
  editor.selectionAnchorRow = null;
  editor.selectionAnchorCol = null;
  editor.boxSelection = null;
  editor.scrollX = 0;
  editor.setContentLength(editor.lines.length);
  editor.scrollToTop();
  editor.clearHistory(); // 別ファイル/新規へ undo で戻れないようにする
  recompile(src);
  t0 = performance.now();
}

function _initWidgets() {
  if (_ready) return;
  _ready = true;

  editor = new UI.TextArea(0, 0, COLS, ROWS, MAX_LINES, DEFAULT_CODE, (text) => {
    isDirty = true;
    refreshTitle();
    recompile(text); // 編集で即コンパイル (LangError は footer へ)
  });
  editor.showWhitespace = false; // コード編集では空白/改行マーカーを消す（読みやすさ）

  // 最小コントロール: 書き出し形式 + DOWNLOAD のみ（他は全てコードの設定ディレクティブ）。
  ddFormat = new UI.DropDown(0, 0, availableFormats().map((f) => f.label), exportFormatIdx, (i) => {
    exportFormatIdx = i;
  });
  ddFormat.tooltip = "Export format: PNG = still, GIF = loop (any browser), MP4 = loop (SNS).";

  btnDownload = new UI.PushButton(0, 0, "DL", () => {
    exportArt();
  });
  btnDownload.tooltip = "Export at the size declared in code (Ctrl+E). PNG / GIF / MP4.";

  ctrlRow = UI.HBox([ddFormat, btnDownload]);

  root = UI.VBox([ctrlRow, editor]);
  group = new UI.WidgetGroup(root);

  recompile(DEFAULT_CODE);
}

/** コントロール再レイアウト。 */
function relayout() {
  group.remeasureAll();
  root.layout(UI.FOCUS_MARGIN, UI.FOCUS_MARGIN);
}

// ── サンプル種まき（無ければ書く。既存ユーザーへの追加も安全に backfill） ──
function seedSamples() {
  if (_seeded) return;
  _seeded = true;
  VFS.mkdir(HOME_DIR);
  const seedInto = (dir, list) => {
    VFS.mkdir(dir);
    for (const s of list) {
      const p = `${dir}/${s.file}`;
      if (!VFS.exists(p)) VFS.writeFile(p, s.src);
    }
  };
  seedInto(LEARN_DIR, LEARN_SAMPLES); // 番号順チュートリアル
  seedInto(GALLERY_DIR, GALLERY_SAMPLES); // 作例ショーケース
}

// ── タイトル ──
function refreshTitle() {
  if (winId === null) return;
  const name = currentFilePath ? VFS.basename(currentFilePath) : "UNTITLED";
  WM.wmSetTitle(winId, `${isDirty ? "* " : ""}${name} - ${APP_NAME}`);
}

// ── 状態リセット（新規/閉じる時） ──
function resetState() {
  currentFilePath = null;
  isDirty = false;
  setCode(DEFAULT_CODE);
  refreshTitle();
}

// ── 未保存確認 → コールバック ──
function confirmDiscard(callback) {
  if (!isDirty) {
    callback();
    return;
  }
  UI.openConfirmDialog("DISCARD UNSAVED CHANGES?", {
    variant: "danger",
    onOk: callback,
  });
}

// ── ファイル操作 ──
function newFile() {
  confirmDiscard(() => {
    setCode(DEFAULT_CODE);
    currentFilePath = null;
    isDirty = false;
    refreshTitle();
  });
}

function openFile() {
  confirmDiscard(() => {
    UI.openFileDialog("open", {
      title: "OPEN",
      defaultPath: HOME_DIR,
      filter: [EXT],
      onResult: (path) => {
        if (!path) return;
        const content = VFS.readFile(path);
        if (content === null) return;
        setCode(content);
        currentFilePath = path;
        isDirty = false;
        refreshTitle();
      },
    });
  });
}

function saveFileAs() {
  UI.openFileDialog("save", {
    title: "SAVE AS",
    defaultPath: currentFilePath ? VFS.parentPath(currentFilePath) : HOME_DIR,
    defaultName: currentFilePath ? VFS.basename(currentFilePath) : "untitled" + EXT,
    filter: [EXT],
    onResult: (path) => {
      if (!path) return;
      currentFilePath = path;
      VFS.writeFile(path, editor.getText());
      isDirty = false;
      refreshTitle();
    },
  });
}

function saveFile() {
  if (!currentFilePath) {
    saveFileAs();
    return;
  }
  VFS.writeFile(currentFilePath, editor.getText());
  isDirty = false;
  refreshTitle();
}

/** Shift+Alt+F: エディタを整形（意味は変えないので再コンパイル不要） */
function formatEditor() {
  const formatted = format(editor.getText());
  if (formatted === editor.getText()) return;
  editor.snapshotForUndo(); // 整形を 1 ステップで undo 可能に
  const row = editor.cursorRow,
    col = editor.cursorCol; // カーソル位置を保持（0,0 にリセットしない）
  editor.lines = formatted.split("\n");
  editor.setContentLength(editor.lines.length);
  // 整形で行数・空白が変わりうるので、おおむね同じ位置へクランプする。
  editor.cursorRow = Math.max(0, Math.min(editor.lines.length - 1, row));
  editor.cursorCol = Math.max(0, Math.min(editor.lines[editor.cursorRow].length, col));
  editor.selectionAnchorRow = null;
  editor.selectionAnchorCol = null;
  editor.boxSelection = null;
  editor._ensureCursorVisible(); // カーソルが見える位置までスクロール調整
  isDirty = true; // 整形は内容（空白）を変える → dirty
  refreshTitle();
}

/**
 * Ctrl+R: エディタ内の `seed:` 行を新しい乱数に書き換える（無ければ先頭に挿入）。
 * 「コードが唯一の真実」を保ったまま、キー一発でシードを探索する（案A）。整形と同質。
 */
function rerollSeed() {
  const n = (Math.random() * 10000) | 0;
  editor.snapshotForUndo(); // シード振り直しを 1 ステップで undo 可能に
  const lines = editor.lines;
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*seed\s*:/.test(lines[i])) {
      found = i;
      break;
    }
  }
  if (found >= 0) {
    lines[found] = lines[found].replace(/^(\s*seed\s*:\s*).*$/, `$1${n}`);
  } else {
    lines.unshift(`seed: ${n}`);
    editor.cursorRow = Math.min(lines.length - 1, editor.cursorRow + 1); // 行ズレ追従
  }
  editor.setContentLength(lines.length);
  isDirty = true;
  refreshTitle();
  recompile(editor.getText()); // 新シードで即再コンパイル（状態場も再 init）
}

/**
 * プレビュー 1-bit バッファを作る。**クリーンな倍率のみ**で表示する（半端比率の縮小は
 * 汚いモアレを生むため不可）。base(=出力÷pixel) を枠 PV_BOX に対し:
 *   - base ≤ 枠 … 整数倍 NN 拡大（1 アートドット = 整数px。チャンキー）。
 *   - base > 枠 … 1/整数 に評価解像度を落として描く（場を粗く標本化＝再ディザ不要・モアレ無し）。
 * 場を評価解像度で直接描く（合成後の再標本化はしない）ので常に綺麗。cells は重いので更に抑える。
 * @returns {{ buf:Uint8Array, w:number, h:number }} 画面に出す 1-bit バッファと寸法
 */
function renderPreview(t, seed, mode, params, ascii, isCells) {
  const { baseW, baseH, artW, artH } = outputDims();
  const padBase = (baseW - artW) / 2; // 額縁（base 上、上下左右一定）
  const maxBase = Math.max(baseW, baseH);

  // 評価解像度の分母 renderDenom（1/N）と画面表示の整数倍 displayScale を決める。
  let renderDenom = 1,
    displayScale = 1;
  if (maxBase <= PV_BOX) displayScale = Math.max(1, Math.floor(PV_BOX / maxBase));
  else renderDenom = Math.ceil(maxBase / PV_BOX);
  // ASCII はグリフを拡大すると汚いので等倍表示・枠に収まる評価解像度に。
  if (ascii && displayScale > 1) displayScale = 1;
  // cells は毎フレーム step で重い → 評価解像度の上限を更に低く。
  if (isCells) {
    const minDenom = Math.ceil(maxBase / PV_CELLS_CAP);
    if (renderDenom < minDenom) {
      renderDenom = minDenom;
      displayScale = 1;
    }
  }

  const rbW = Math.max(1, Math.round(baseW / renderDenom));
  const rbH = Math.max(1, Math.round(baseH / renderDenom));
  const rpad = Math.round(padBase / renderDenom);
  const raW = Math.max(1, rbW - 2 * rpad);
  const raH = Math.max(1, rbH - 2 * rpad);

  ensureSurface(raW, raH);
  program.render(surface, t, seed); // surface.buf = raW×raH の art（評価解像度で直接）
  const base = ArtExport.composeMatte(surface.buf, raW, raH, rbW, rbH);

  if (displayScale === 1) return { buf: base, w: rbW, h: rbH };
  // 整数 NN 拡大（チャンキー・モアレ無し）。
  const dw = rbW * displayScale,
    dh = rbH * displayScale;
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < rbH; y++) {
    for (let x = 0; x < rbW; x++) {
      if (!base[y * rbW + x]) continue;
      const ox = x * displayScale,
        oy = y * displayScale;
      for (let j = 0; j < displayScale; j++) {
        const r = (oy + j) * dw + ox;
        for (let i = 0; i < displayScale; i++) out[r + i] = 1;
      }
    }
  }
  return { buf: out, w: dw, h: dh };
}

// ── 書き出し（PNG / GIF / MP4）──
// プレビューと独立した surface・プログラム実体でオフスクリーン描画する（プレビューの
// 状態場を壊さないため、書き出し時はソースを別途 compile する）。field/draw は art 解像度で
// 直接描き、cells はキャップ格子で warmup→NN 拡大。合成・符号化は core/art_export.js。

/** 任意サイズの 1-bit バッファへ「場 → 1-bit / draw 線画」を描くオフスクリーン surface。 */
function makeExportSurface(w, h, asciiOn, mode, params) {
  const surf = makeBufferSurface(w, h);
  if (asciiOn) {
    const cols = Math.max(1, Math.floor(w / AsciiArt.CELL_W));
    const rows = Math.max(1, Math.floor(h / AsciiArt.CELL_H));
    surf.width = () => cols; // 場は文字グリッド解像度で評価（1 文字 = 1 セル）
    surf.height = () => rows;
    surf.blitField = (field, fw, fh) =>
      rasterizeAsciiLinesToBuf(
        AsciiArt.renderAsciiLines(field, fw, fh, asciiRamp()),
        surf.buf,
        w,
        h,
      );
  } else {
    surf.blitField = (field, fw, fh) =>
      FieldRender.renderField(field, fw, fh, surf.buf, mode, params);
  }
  return surf;
}

/** 書き出しファイル名 tessera_<name>_<seed>_<ts>.<ext>。 */
function exportName(ext) {
  const base = currentFilePath
    ? VFS.basename(currentFilePath).replace(/\.tess$/i, "")
    : "untitled";
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `tessera_${base}_${resolvedConfig().seed}_${ts}.${ext}`;
}

/** DOWNLOAD / Ctrl+E: 現在のスケッチをコード宣言の size ちょうどに書き出す。 */
function exportArt() {
  if (!program || statusText) return; // 未コンパイル or 書き出し中は無視
  let prog;
  try {
    prog = compile(editor.getText()); // プレビューと独立した実体（状態場を壊さない）
  } catch {
    return; // プレビューが描けている＝コンパイルは通るはずだが念のため
  }
  const key = currentFormatKey();
  const { baseW, baseH, artW, artH, pixel, fps } = outputDims();
  const eff = effectiveRender();
  const mode = eff.mode,
    params = eff.params;
  const asciiOn = mode === "ascii" && prog.kind !== "draw";
  const isCells = prog.kind === "cells";
  const seed = resolvedConfig().seed;

  // cells は出力解像度だと重い → キャップ格子で warmup（模様を発展させる）。
  let sim = null,
    cw = 0,
    ch = 0;
  if (isCells) {
    cw = Math.min(artW, CELLS_SIM_CAP);
    ch = Math.max(1, Math.round((cw * artH) / artW));
    sim = makeExportSurface(cw, ch, asciiOn, mode, params);
  }
  // t→art 解像度バッファ。cells は sim を 1 step 進めて NN 拡大、それ以外は art で直接描画。
  const artAt = (t, stepCells) => {
    if (isCells) {
      if (stepCells) prog.render(sim, t, seed);
      return ArtExport.resampleNN(sim.buf, cw, ch, artW, artH);
    }
    const surf = makeExportSurface(artW, artH, asciiOn, mode, params);
    prog.render(surf, t, seed);
    return surf.buf;
  };

  try {
    if (isCells) for (let i = 0; i <= CELLS_WARMUP; i++) prog.render(sim, i / fps, seed);

    if (key === "png") {
      const t = isCells ? CELLS_WARMUP / fps : (performance.now() - t0) / 1000;
      const base = ArtExport.composeMatte(artAt(t, false), artW, artH, baseW, baseH);
      ArtExport.downloadPng(base, baseW, baseH, pixel, false, exportName("png"));
    } else {
      // GIF/MP4: 1 周期 LOOP_FRAMES を集める。field は t∈[0,2π) でシームレスループ、
      // cells は warmup 後の連続ステップ。合成 1-bit フレームを符号化器へ。
      const frames = [];
      for (let i = 0; i < LOOP_FRAMES; i++) {
        const t = isCells
          ? (CELLS_WARMUP + 1 + i) / fps
          : (i / LOOP_FRAMES) * Math.PI * 2;
        frames.push(ArtExport.composeMatte(artAt(t, true), artW, artH, baseW, baseH));
      }
      statusText = `ENCODING ${key.toUpperCase()}...`;
      ArtExport.exportVideo(
        frames,
        baseW,
        baseH,
        pixel,
        false,
        fps,
        key,
        exportName(key),
        (s) => {
          statusText = s;
        },
      );
    }
  } catch (e) {
    errMsg = e.message + (e.pos != null ? ` (pos ${e.pos})` : "");
    statusText = "";
  }
}

// 常時表示の凡例（ショートカットの発見性。パラメータはコードで指定する設計のため重要）。
const LEGEND = "^E EXPORT  ^R RESEED  ^S SAVE  ^O OPEN  ALT+N NEW  ALT+SHIFT+F FORMAT";
const LEGEND_H = GLYPH_H + 4;

function onDraw(cr) {
  // ── キーボードショートカット (フォーカス時のみ) ──
  if (WM.wmIsFocused(winId)) {
    if (ctrlShiftDown("KeyS")) saveFileAs();
    else if (ctrlDown("KeyS")) saveFile();
    else if (ctrlDown("KeyO")) openFile();
    else if (ctrlDown("KeyE")) exportArt(); // 書き出し（コード宣言の size）
    else if (ctrlDown("KeyR")) rerollSeed(); // seed: をコード内で振り直す
    else if (altDown("KeyN")) newFile();
    else if (altShiftDown("KeyF")) formatEditor();
  }

  GPU.fillRect(cr.x, cr.y, cr.w, cr.h, 0); // 背景クリア

  // ── 左カラム (最小コントロール + エディタ) ──
  group.draw(cr);

  // ── 右: ライブプレビュー（コード宣言の size アスペクト比を反映）──
  const leftW = Math.max(editor.w, ctrlRow ? ctrlRow.w : 0);
  const pvX = cr.x + editor.x + leftW + GAP;
  const pvY = cr.y + UI.FOCUS_MARGIN;

  let pv = null;
  if (program) {
    // 実効方式（view: があればコードが決める。無ければ既定 dither）。
    const eff = effectiveRender();
    activeMode = eff.mode;
    activeParams = eff.params;
    // ASCII は場(field/cells)専用。draw では無効化（線画なので不適）。
    asciiActive = activeMode === "ascii" && program.kind !== "draw";
    const t = (performance.now() - t0) / 1000;
    const seed = resolvedConfig().seed;
    try {
      pv = renderPreview(t, seed, activeMode, activeParams, asciiActive, program.kind === "cells");
    } catch (e) {
      program = null;
      errMsg = e.message + (e.pos != null ? ` (pos ${e.pos})` : "");
    }
  }

  if (pv) {
    GPU.fillRect(pvX, pvY, pv.w, pv.h, 0); // 背景 (未描画セルの下地)
    GPU.drawRect(pvX - 1, pvY - 1, pv.w + 1, pv.h + 1, 1); // 枠線
    GPU.blit(pv.buf, pv.w, pv.h, pvX, pvY, 1);
  }

  // ── 凡例（常時、最下部）──
  drawText(cr.x + UI.FOCUS_MARGIN, cr.y + cr.h - GLYPH_H - 1, LEGEND, 1);
}

function onDrawFooter(fr) {
  if (errMsg) {
    drawText(fr.x, fr.y, "ERR " + errMsg, 1);
    return;
  }
  const rc = resolvedConfig();
  const kind = program ? program.kind.toUpperCase() : "-";
  // 書き出し中は進捗、平常は seed。出力外寸も左に併記（書き出しサイズの可視化）。
  const right = statusText || `seed ${rc.seed}`;
  const left = `${kind}  ${rc.sizeW}x${rc.sizeH}`;
  drawText(fr.x, fr.y, left, 1);
  drawText(fr.x + fr.w - textWidth(right), fr.y, right, 1);
}

function onInput(ev) {
  group.update(ev);
}

function onMeasure() {
  // 左カラム右端 = 最も広い行（コントロール or エディタ）。プレビューは最大 PV_BOX 角。
  const leftRight = editor.x + Math.max(editor.w, ctrlRow ? ctrlRow.w : 0);
  const w = leftRight + GAP + PV_BOX + UI.FOCUS_MARGIN;
  const bodyH = Math.max(editor.y + editor.h, UI.FOCUS_MARGIN + PV_BOX);
  const h = bodyH + LEGEND_H + UI.FOCUS_MARGIN; // 最下部に凡例行を確保
  return { w, h };
}

function onBeforeClose() {
  if (isDirty) {
    UI.openConfirmDialog("DISCARD UNSAVED CHANGES?", {
      variant: "danger",
      onOk: () => {
        resetState();
        WM.wmClose(winId);
      },
    });
    return false;
  }
  resetState();
  return true;
}

// ── 登録 ──
WM.wmRegister(
  APP_NAME,
  () => {
    _initWidgets();
    seedSamples();
    winId = WM.wmOpen(-1, -1, 0, 0, APP_NAME, onDraw, onInput, onMeasure, {
      footer: true,
      onDrawFooter,
      onBeforeClose,
      about:
        "Tessera: a tiny language for 1-bit generative art. Write code on " +
        "the left, watch it render on the right. Bare expressions are fields " +
        "f(x,y,t); draw {} is procedural; field {} is a stateful cellular " +
        "field (init/step/show). All settings live in code as directives: " +
        "size: WxH, pixel: N, pad: N, fps: N, seed: N, view: mode(args). " +
        "Learn from /TESSERA/LEARN (numbered tutorial), browse /TESSERA/GALLERY. " +
        "Shortcuts: Alt+N new, Ctrl+O " +
        "open, Ctrl+S save, Ctrl+Shift+S save as, Ctrl+E / DL export " +
        "(PNG/GIF/MP4 at the declared size), Ctrl+R reseed, Shift+Alt+F format.",
      onRelayout: relayout,
    });
    refreshTitle();
    return winId;
  },
  { category: "CREATIVE" },
);

// ── 公開 API: EXPLORER 等から .tess を開く ──

/**
 * 指定パスの Tessera ソースを TESSERA で開く。
 * ウィンドウが閉じていれば開き、最前面へ。
 * @param {string} path  VFS パス
 * @returns {boolean} 読み込み成功なら true
 */
export function tesseraOpenFile(path) {
  _initWidgets();
  const content = VFS.readFile(path);
  if (content === null) return false;
  WM.wmOpenOrFocus(APP_NAME); // 未オープンなら登録 cb が winId を確定
  setCode(content);
  currentFilePath = path;
  isDirty = false;
  refreshTitle();
  return true;
}
