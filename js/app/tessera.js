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
 *   canvas: WxH / pad: N / fps: N / seed: N / period: 秒 / view: mode(args)
 *   （pixel は 8 固定＝チャンキー 1bit が核。ディレクティブは廃止）
 * 画面のコントロールは「書き出し形式 + DL」のみ＝最小。SEED/方式/出力/pad/fps の
 * ウィジェットは廃止した（旧 GENART/初期 TESSERA の名残）。プレビューは size のアスペクト比を反映。
 *
 * 構成:
 *   - トップツールバー(1 行): 形式(PNG/GIF/MP4) + EXPORT/RESEED/SAVE/OPEN/NEW/WALLPAPER。
 *     ショートカットは各ボタンの hover ツールチップに表示する。
 *   - 左: コードエディタ (TextArea)。編集で即 compile。
 *   - 右: ライブプレビュー（ツールバーの下・size のアスペクト比、surface.buf を整数倍 blit）
 *   - footer: エラー (pos 付き) / 状態 (size・seed) / 書き出し進捗
 *
 * VFS / 操作:
 *   - Alt+N 新規 / Ctrl+O 開く / Ctrl+S 保存 / Ctrl+Shift+S 名前を付けて保存
 *   - Ctrl+E / EXPORT で size ちょうどに PNG/GIF/MP4 書き出し。Ctrl+R で seed: を振り直す。
 *   - Alt+W で現在の場をデスクトップ背景に。Shift+Alt+F で整形。未保存変更は破棄確認。
 *     サンプルは /Sketches/Learn（番号順チュートリアル）と /Sketches/Gallery（作例）に種まき。
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
import * as Wallpaper from "../wallpaper.js";

const APP_NAME = "TESSERA";
const EXT = ".tess";
const HOME_DIR = "/Sketches"; // .tess 作品の保存先（内容カテゴリ「スケッチ」）
// 学習用（番号順・1概念ずつ・解説コメント付き）と作例集（ショーケース）の 2 層。
const LEARN_DIR = "/Sketches/Learn";
const GALLERY_DIR = "/Sketches/Gallery";

// ── レイアウト/プレビュー ──
const COLS = 40; // エディタ幅 (文字数)。40桁 = レトロ家庭機の画面幅
const ROWS = 16; // エディタ表示行数
const MAX_LINES = 9999;
const PV_BOX = 176; // 画面上のプレビュー枠の長辺px（出力をクリーンな倍率で縮めて表示）
// プレビューは出力合成（art→額縁→base）をクリーンな倍率(整数 or 1/整数)＋NN で見せる
// ＝pixel の粗さ・pad が WYSIWYG かつ半端比率のモアレ無し。
const GAP = 8; // エディタ⇄プレビュー間

/** 起動時 / 新規の既定スケッチ。設定ディレクティブの雛形を兼ね、書き方を示す。 */
const DEFAULT_CODE = `canvas: 1080x1080
pad: 80
fps: 20
period: tau
seed: 0
view: dither(2)

sin(x*8 - t) * cos(y*8 + t*2) * 0.5 + 0.5`;

/**
 * サンプルは 2 層: LEARN（番号順・1 概念ずつ・解説コメント付き＝見て文法を学ぶ）と
 * GALLERY（ショーケース＝高 ceiling の作例）。LEARN は LEARN_DIR、GALLERY は形別に
 * GALLERY_DIR/{Field,Draw,Cells} へ種まきする（どの算法がどの形かを EXPLORER で一覧）。
 * コメント・空行は整形で保持されるので、コメントが学習ガイドとして機能する。
 * 座標は x,y ∈ [0,1]、t は経過秒。
 *
 * 【ループ規約】作品は period（既定 tau）で**きっちりループ**させる（GIF/MP4 の継ぎ目なし）。
 * t は必ず周期 tau の整数分の 1 で使う:
 *   - OK: sin(k*t) / cos(k*t)（k は整数）、ノイズ/fbm 領域を cos(t)/sin(t) で公転
 *   - NG: t の線形ドリフト（t*0.1 等）、非整数倍（t*1.3 等）, sin(t*0.5)（半周期）
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
// (the file IS the recipe). canvas =
// output px; dots are a fixed 8px
// (chunky). fps snaps to a divisor of
// 100 (5/10/20/25/50/100) so GIF frame
// timing is exact. footer shows fps.
canvas: 1080x1080
fps: 20
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
  cy = 0.5 + 0.28 * sin(t + k*1.7)
  s = s + 0.012 / ((x - cx)*(x - cx) + (y - cy)*(y - cy) + 0.001)
}
s / (s + 1)`,
  },
];

// 作品(GALLERY)は全ディレクティブを冒頭に明示する（調整時に一覧を調べずその場で直せる）。
// お決まり順 = キャンバス(canvas/pad) → 時間(fps/period) → seed → view。値は既定どおり
// なので見た目は不変＝「全ノブが見えて編集できる」状態にするだけ。
const HEADER = `canvas: 1080x1080
pad: 80
fps: 20
period: tau
seed: 0
view: dither(2)

`;

const GALLERY_SAMPLES = [
  {
    // WAVE: 複数点源の同心波の干渉。seed で点源位置と周波数が変わる
    file: "wave" + EXT,
    src: HEADER + `cx0 = 0.2 + rnd(1, 0)*0.6
cy0 = 0.2 + rnd(2, 0)*0.6
cx1 = 0.2 + rnd(3, 0)*0.6
cy1 = 0.2 + rnd(4, 0)*0.6
f = 30 + rnd(5, 0)*24
(sin(dist(x, y, cx0, cy0)*f - t*2)
 + sin(dist(x, y, cx1, cy1)*f - t*2)) * 0.25 + 0.5`,
  },
  {
    // PLASMA: sin/cos 多重干渉プラズマ。seed で位相・周波数・源が変わる
    file: "plasma" + EXT,
    src: HEADER + `p1 = rnd(1, 0)*TAU
p2 = rnd(2, 0)*TAU
p3 = rnd(3, 0)*TAU
cx = 0.3 + rnd(4, 0)*0.4
cy = 0.3 + rnd(5, 0)*0.4
fa = 6 + rnd(6, 0)*6
(sin(x*fa + t + p1) + sin(y*fa - t + p2)
 + sin((x + y)*6 + t + p3)
 + sin(dist(x, y, cx, cy)*12 - t)) * 0.125 + 0.5`,
  },
  {
    // DRIFT: fbm 密度場。標本点が円運動し雲のように漂う
    file: "drift" + EXT,
    src: HEADER + `fbm(x*4 + sin(t)*0.3, y*4 + cos(t)*0.3, 4)`,
  },
  {
    // GRID: 市松テッセレーション（ゆっくり漂う）。seed で格子数とずれが変わる
    file: "grid" + EXT,
    src: HEADER + `n = 4 + floor(rnd(1, 0)*9)
ox = rnd(2, 0)*4
oy = rnd(3, 0)*4
step(0.5, mod(floor(x*n + ox + sin(t)*2) + floor(y*n + oy + cos(t)*2), 2))`,
  },
  {
    // MOIRE: わずかに角度のずれた 2 枚の同周波グレーティングの積（うなり）。
    // seed で周波数・基準角・ずれ角が変わる
    file: "moire" + EXT,
    src: HEADER + `f = 14 + rnd(1, 0)*14
a0 = rnd(2, 0)*TAU
da = 0.1 + rnd(3, 0)*0.22
sin((x*cos(t + a0) + y*sin(t + a0))*f)
 * sin((x*cos(t + a0 + da) + y*sin(t + a0 + da))*f) * 0.5 + 0.5`,
  },
  {
    // CAUSTIC: 進行波の和を尾根化し鋭く累乗 → 水面の光の網目。
    // seed で 3 波の周波数と位相が変わる
    file: "caustic" + EXT,
    src: HEADER + `f1 = 16 + rnd(1, 0)*12
f2 = 16 + rnd(2, 0)*12
f3 = 12 + rnd(3, 0)*10
p1 = rnd(4, 0)*TAU
p2 = rnd(5, 0)*TAU
p3 = rnd(6, 0)*TAU
s = (sin(x*f1 + t*2 + p1) + sin(y*f2 - t*2 + p2) + sin((x + y)*f3 + t + p3)) / 3
(1 - abs(s)) ^ 4`,
  },
  {
    // QUASIC: 等角に並べた N 枚平面波の和 → 準結晶。
    // seed で対称数 N(5..8)・回転・周波数が変わる
    file: "quasic" + EXT,
    src: HEADER + `n = 5 + floor(rnd(1, 0)*4)
r = rnd(2, 0)*TAU
f = 22 + rnd(3, 0)*18
s = 0
repeat n as k {
  a = k * (TAU / n) + r
  s = s + cos(((x - 0.5)*cos(a) + (y - 0.5)*sin(a))*f + t)
}
s / n * 0.5 + 0.5`,
  },
  {
    // JULIA: z <- z*z + c の脱出時間（値ブロックで反復）。c が円運動し形態変化。
    // seed で c の中心と円運動半径が変わる＝別の Julia 集合（樹枝/兎/渦…）が出る
    file: "julia" + EXT,
    src: HEADER + `ccx = -0.75 + rnd(1, 0)*0.7
ccy = -0.3 + rnd(2, 0)*0.6
rad = 0.12 + rnd(3, 0)*0.16
zr = (x - 0.5)*3
zi = (y - 0.5)*3
cr = cos(t)*rad + ccx
ci = sin(t)*rad + ccy
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
    src: HEADER + `qx = fbm(x*3 + cos(t)*0.3, y*3 + sin(t)*0.3, 4)
qy = fbm(x*3 + 4.2, y*3 + 1.7, 4)
w = fbm(x*3 + qx*2, y*3 + qy*2, 4)
0.5 + 0.5 * sin(x*20 + w*8 + t)`,
  },
  {
    // WORLEY: セルラーノイズ（最近傍距離）。細胞 / 石畳模様
    file: "worley" + EXT,
    src: HEADER + `1 - worley(x*6 + cos(t)*0.4, y*6 + sin(t)*0.4)`,
  },
];

// ── レンダーモード（場 → 1-bit。共有 core/field_render.js を使う） ──
// 場の blitField を共有レンダラへ通す。方式は view: でコードから宣言する。
const RENDER_MODES = ["dither", "ascii", "hatch", "halftone", "braille"];

// ── ASCII（場 → 文字グリッド → グリフ）。共有コア core/ascii_art.js を使う ──
const ASCII_RAMP_CHARS = " .-:;+=*&%@$#";
let _asciiRamp = null;
function asciiRamp() {
  if (!_asciiRamp) _asciiRamp = AsciiArt.buildToneRamp(ASCII_RAMP_CHARS);
  return _asciiRamp;
}
let asciiActive = false; // onDraw で確定（ascii モードか）
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
// 出力 = base ×PIXEL。base = 出力 ÷ PIXEL の解像度で描き、整数 ×PIXEL で書き出す。
// PIXEL は **8 固定**＝1 アートドット = 8 出力px のチャンキー 1bit が Tessera の核。
// pixel ディレクティブは廃止（理念＝低解像度の徹底・性能の予測可能性）。canvas が
// 実質「ドット数（base = canvas/8）」を決める。額縁 pad は出力px。fps のみスナップ。
const PIXEL = 8; // 固定。1 アートドット = 8 出力px（チャンキーさ＝Tessera の identity）
// fps は全て 100 の約数。GIF の遅延はセンチ秒(1/100s)整数なので、約数でないと
// round(100/fps) の丸めで再生速度がズレ・ループ長も狂う（MP4 は μ秒で約数不問だが統一）。
const FPS_OPTIONS = [5, 10, 20, 25, 50, 100];
const TAU = Math.PI * 2; // period 既定（t を sin/cos に通す作例の 1 周期）
const PERIOD_CAP_S = 30; // 動画 1 本の上限秒（period をこの長さでクランプ）
const DEFAULTS = { sizeW: 1080, sizeH: 1080, pad: 80, fps: 20, seed: 0, period: TAU };

const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const clampF = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const nearest = (v, arr) => arr.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

/** program.config（生の宣言値）を既定値・範囲とともに解決した実効設定にする。 */
function resolvedConfig() {
  const c = (program && program.config) || {};
  const canvas = c.canvas || {};
  const sizeW = clampI(canvas.w ?? DEFAULTS.sizeW, 16, 4096);
  const sizeH = clampI(canvas.h ?? DEFAULTS.sizeH, 16, 4096);
  const pixel = PIXEL; // 8 固定（pixel ディレクティブは無し）
  const fps = nearest(c.fps ?? DEFAULTS.fps, FPS_OPTIONS);
  const seed = clampI(c.seed ?? DEFAULTS.seed, 0, 999999);
  // pad（出力px）は base 上で各辺がアート(≥4px)を潰さない範囲にクランプ。
  const padMax = Math.max(0, Math.floor((Math.min(sizeW, sizeH) / pixel - 4) / 2) * pixel);
  const pad = clampI(c.pad ?? DEFAULTS.pad, 0, padMax);
  // period（秒）= プレビュー周期かつ動画長。既定 tau、上限 PERIOD_CAP_S。
  const period = clampF(c.period ?? DEFAULTS.period, 0.1, PERIOD_CAP_S);
  return { sizeW, sizeH, pixel, pad, fps, seed, period };
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

// プレビューを宣言 fps のフレームグリッドに同期（WYSIWYG）。フレームが変わるまで
// 再レンダーせず直近バッファを再ブリット＝低 fps はカクつき。
let _pvCache = null; // 直近に描いた pv（{buf,w,h}）
let _pvFrame = -1; // 直近に描いた fps フレーム番号（-1 = 要再描画）

/** 現在編集中のファイル VFS パス (null = 無題) */
let currentFilePath = null;
let isDirty = false;

// ── ウィジェット (遅延初期化) ──
// パラメータ（seed/方式/出力/dot/pad/fps）はすべてコードの設定ディレクティブで指定する。
// 画面に残すコントロールは「書き出し形式 + DOWNLOAD」のみ（最小コントロール）。
let editor, ddFormat, btnExport, btnReseed, btnSave, btnOpen, btnNew, btnWallpaper, ctrlRow, root, group;
let _ready = false;
let _seeded = false;

function recompile(src) {
  _pvFrame = -1; // コード変更（fps 含む）は即プレビューへ反映
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

  // ── ツールバー（1 行）: 書き出し形式 + アクション群。ショートカットは各ボタンの
  // hover ツールチップに表示する（画面下部の凡例は廃止）。
  ddFormat = new UI.DropDown(0, 0, availableFormats().map((f) => f.label), exportFormatIdx, (i) => {
    exportFormatIdx = i;
  });
  ddFormat.tooltip = "Export format: PNG = still, GIF = loop (any browser), MP4 = loop (SNS).";

  const mkBtn = (label, tip, fn) => {
    const b = new UI.PushButton(0, 0, label, fn);
    b.tooltip = tip;
    return b;
  };
  // DL と EXPORT は同一アクション（コード宣言の size に書き出し）＝1 ボタンに統合。
  btnExport = mkBtn("EXPORT", "Export at the declared size — Ctrl+E (PNG/GIF/MP4)", exportArt);
  btnReseed = mkBtn("RESEED", "Randomize the seed: directive — Ctrl+R", rerollSeed);
  btnSave = mkBtn("SAVE", "Save — Ctrl+S   (Save As — Ctrl+Shift+S)", saveFile);
  btnOpen = mkBtn("OPEN", "Open a .tess sketch — Ctrl+O", openFile);
  btnNew = mkBtn("NEW", "New sketch — Alt+N", newFile);
  btnWallpaper = mkBtn("WALLPAPER", "Set as desktop wallpaper, live-rendered — Alt+W", setWallpaper);

  ctrlRow = UI.HBox([ddFormat, btnExport, btnReseed, btnSave, btnOpen, btnNew, btnWallpaper]);

  // エディタは HBox で包む。VBox は直下のリーフ幅を最大子（=幅広ツールバー）へ引き伸ばす
  // が、Box 子は引き伸ばさない。これで枠が 40 桁テキストと一致する（枠だけ広くならない）。
  root = UI.VBox([ctrlRow, UI.HBox([editor])]);
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
 * 場を評価解像度で直接描く（合成後の再標本化はしない）ので常に綺麗。
 * @returns {{ buf:Uint8Array, w:number, h:number }} 画面に出す 1-bit バッファと寸法
 */
function renderPreview(t, seed, mode, params, ascii) {
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
// プレビューと独立した surface・プログラム実体でオフスクリーン描画する（書き出し時は
// ソースを別途 compile する）。場を art 解像度で直接描く。合成・符号化は core/art_export.js。

/** 任意サイズの 1-bit バッファへ「場 → 1-bit」を描くオフスクリーン surface。 */
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
  const asciiOn = mode === "ascii";
  const { seed, period } = resolvedConfig();

  // t→art 解像度バッファを描く（場を art で直接描画）。
  const artAt = (t) => {
    const surf = makeExportSurface(artW, artH, asciiOn, mode, params);
    prog.render(surf, t, seed);
    return surf.buf;
  };

  try {
    if (key === "png") {
      // 画面に出ている量子化フレームと同じ t を捕らえる（WYSIWYG）。
      const t = (Math.floor(((performance.now() - t0) / 1000) * fps) / fps) % period;
      const base = ArtExport.composeMatte(artAt(t), artW, artH, baseW, baseH);
      ArtExport.downloadPng(base, baseW, baseH, pixel, false, exportName("png"));
    } else {
      // GIF/MP4: period 秒ぶん（= period×fps フレーム、上限 PERIOD_CAP_S 秒）を集める。
      // t∈[0,period) を等間隔サンプル＝シームレスループ（末尾の次が t=0）。
      const loopFrames = clampI(period * fps, 2, PERIOD_CAP_S * fps);
      const frames = [];
      for (let i = 0; i < loopFrames; i++) {
        const t = (i / loopFrames) * period;
        frames.push(ArtExport.composeMatte(artAt(t), artW, artH, baseW, baseH));
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

/** ALT+W: 現在の場をデスクトップ背景に設定（ソースをスナップショット保存 → live-render）。 */
function setWallpaper() {
  if (!program) return; // コンパイル不能なソースは無視
  const ok = Wallpaper.setTessSource(editor.getText());
  statusText = ok ? "WALLPAPER SET" : "WALLPAPER: ERROR";
  setTimeout(() => {
    if (statusText === "WALLPAPER SET" || statusText === "WALLPAPER: ERROR") {
      statusText = "";
    }
  }, 1500);
}


function onDraw(cr) {
  // ── キーボードショートカット (フォーカス時のみ) ──
  if (WM.wmIsFocused(winId)) {
    if (ctrlShiftDown("KeyS")) saveFileAs();
    else if (ctrlDown("KeyS")) saveFile();
    else if (ctrlDown("KeyO")) openFile();
    else if (ctrlDown("KeyE")) exportArt(); // 書き出し（コード宣言の size）
    else if (ctrlDown("KeyR")) rerollSeed(); // seed: をコード内で振り直す
    else if (altDown("KeyW")) setWallpaper(); // 現在の場をデスクトップ背景に
    else if (altDown("KeyN")) newFile();
    else if (altShiftDown("KeyF")) formatEditor();
  }

  GPU.fillRect(cr.x, cr.y, cr.w, cr.h, 0); // 背景クリア

  // ── トップツールバー + エディタ（左カラム）──
  group.draw(cr);

  // ── 右: ライブプレビュー（エディタの右・ツールバーの下。size アスペクト比を反映）──
  const pvX = cr.x + editor.x + editor.w + GAP;
  const pvY = cr.y + editor.y;

  if (program) {
    // 実効方式（view: があればコードが決める。無ければ既定 dither）。
    const eff = effectiveRender();
    activeMode = eff.mode;
    activeParams = eff.params;
    asciiActive = activeMode === "ascii";
    const { seed, period, fps } = resolvedConfig();
    // WYSIWYG: プレビューを宣言 fps のフレームグリッドへ量子化（書き出しと同じ間引き・速度）。
    // フレーム番号が変わったときだけ再レンダー。
    const frameIdx = Math.floor(((performance.now() - t0) / 1000) * fps);
    // t を [0,period) で周回＝プレビューが実際にループ（見た目＝書き出し）。
    const t = (frameIdx / fps) % period;
    try {
      if (frameIdx !== _pvFrame || _pvCache === null) {
        _pvCache = renderPreview(t, seed, activeMode, activeParams, asciiActive);
        _pvFrame = frameIdx;
      }
    } catch (e) {
      program = null;
      errMsg = e.message + (e.pos != null ? ` (pos ${e.pos})` : "");
      _pvCache = null;
    }
    const pv = _pvCache;
    if (pv) {
      GPU.fillRect(pvX, pvY, pv.w, pv.h, 0); // 背景 (未描画セルの下地)
      GPU.drawRect(pvX - 1, pvY - 1, pv.w + 1, pv.h + 1, 1); // 枠線
      GPU.blit(pv.buf, pv.w, pv.h, pvX, pvY, 1);
    }
  }
}

function onDrawFooter(fr) {
  if (errMsg) {
    drawText(fr.x, fr.y, "ERR " + errMsg, 1);
    return;
  }
  const rc = resolvedConfig();
  // 書き出し中は進捗、平常は seed。出力外寸・実効 fps を左に併記（fps→100の約数への
  // スナップを可視化）。pixel は 8 固定なので表示しない。
  const right = statusText || `seed ${rc.seed}`;
  const left = `${rc.sizeW}x${rc.sizeH}  ${rc.fps}fps`;
  drawText(fr.x, fr.y, left, 1);
  drawText(fr.x + fr.w - textWidth(right), fr.y, right, 1);
}

function onInput(ev) {
  group.update(ev);
}

function onMeasure() {
  // トップツールバーが全幅に渡り、その下に [エディタ | プレビュー]。ウィンドウ幅は
  // 「ツールバー幅」と「エディタ + プレビュー幅」の広い方。
  const contentW = Math.max(ctrlRow ? ctrlRow.w : 0, editor.w + GAP + PV_BOX);
  const w = editor.x + contentW + UI.FOCUS_MARGIN;
  const bodyH = editor.y + Math.max(editor.h, PV_BOX); // プレビューはエディタと同じ上端
  const h = bodyH + UI.FOCUS_MARGIN;
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
        "the left, watch it render on the right. A sketch is a field " +
        "f(x,y,t) -> 0..1 (one expression; value blocks with let/repeat too). " +
        "All settings live in code as directives: " +
        "canvas: WxH, pad: N, fps: N, seed: N, period: sec, view: mode(args) " +
        "(pixel is fixed at 8 = chunky 1-bit). " +
        "Learn from /Sketches/Learn (numbered tutorial), browse /Sketches/Gallery. " +
        "Shortcuts: Alt+N new, Ctrl+O " +
        "open, Ctrl+S save, Ctrl+Shift+S save as, Ctrl+E / DL export " +
        "(PNG/GIF/MP4 at the declared size), Ctrl+R reseed, Alt+W set as " +
        "desktop wallpaper (live-rendered), Shift+Alt+F format.",
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
