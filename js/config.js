/**
 * @module config
 * config.js — システム定数・設定値
 *
 * 解像度プリセット (16:9 / 4:3)、自動スケーリング、
 * パレット、製品情報 (ASCII ロゴ含む) など
 * プロジェクト全体で参照される値を定義する。
 * 他のモジュールはここから import して使う。
 *
 * スケーリング方式:
 *   仮想解像度 (VRAM_WIDTH × VRAM_HEIGHT) をブラウザウィンドウに
 *   収まる最大の整数倍で自動拡大する。ユーザーは解像度のみ選択し、
 *   スケールはシステムが自動算出する。
 */

import { loadCustomPalette, load } from "./core/storage.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Dev / Production モード
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 開発モードフラグ。
 *   true  — DEMO 系アプリや未完成機能がメニュー・デスクトップに表示される。
 *   false — ベータ / 本番公開用。dev フラグ付きアプリは非表示になる。
 */
export const DEV_MODE = false;

// ── 永続化コールバック (責務分離) ──

/**
 * 設定変更時の永続化コールバック。kernel.js が初期化時に注入する。
 * @type {((key: string, value: any) => void) | null}
 */
let _onSave = null;

/**
 * 設定変更時の保存コールバックを登録する。
 * コールバックは `(key, value)` 形式で呼ばれる。
 * key: "palette" | "resolution" | "customPalette"
 * @param {function} cb
 */
export function configSetSaveCallback(cb) {
  _onSave = cb;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  解像度プリセット
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 選択可能な画面解像度プリセット。
 * 16:9 = 横長 / デスクトップ用。1:1・4:3 = SNS 共有向け。
 * SNS 最適枠は書き出し幅を 1080px(SNS 再エンコードの安全幅)に当てる:
 * 幅 540 は CAPTURE X2、幅 360 は X3 で 1080(540x540 / 360x360 / 360x270)。
 * 480x360 は汎用 4:3 兼デフォルト。全寸を偶数に統一(MP4/GIF は偶数寸前提)。
 * 表示スケールはブラウザウィンドウに収まる最大整数倍を自動算出する。
 */
export const RESOLUTIONS = [
  { label: "960x540 (16:9)", w: 960, h: 540 },
  { label: "640x360 (16:9)", w: 640, h: 360 },
  { label: "540x540 (1:1)", w: 540, h: 540 },
  { label: "360x360 (1:1)", w: 360, h: 360 },
  { label: "480x360 (4:3)", w: 480, h: 360 },
  { label: "360x270 (4:3)", w: 360, h: 270 },
];

/** サポートする最大解像度 (vram 事前確保用) */
export const MAX_VRAM_WIDTH = 960;
export const MAX_VRAM_HEIGHT = 540;

/** 仮想画面 横ピクセル数 (localStorage から復元、デフォルト 480) */
export let VRAM_WIDTH = load("vramW", 480);

/** 仮想画面 縦ピクセル数 (localStorage から復元、デフォルト 360) */
export let VRAM_HEIGHT = load("vramH", 360);

/** 解像度変更時のコールバック一覧 */
const _resizeCallbacks = [];

/** 解像度変更コールバックを登録する */
export function onResize(cb) {
  _resizeCallbacks.push(cb);
}

/**
 * 解像度を変更する。値を更新し、登録済みコールバックを順に実行する。
 * @param {number} w  新しい横ピクセル数
 * @param {number} h  新しい縦ピクセル数
 */
export function setResolution(w, h) {
  if (w === VRAM_WIDTH && h === VRAM_HEIGHT) return;
  VRAM_WIDTH = w;
  VRAM_HEIGHT = h;
  if (_onSave) _onSave("resolution", { w, h });
  for (const cb of _resizeCallbacks) cb();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィンドウパディング設定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** デフォルト HEADER_PAD (上下左右共通) */
const DEFAULT_HEADER_PADDING = 8;
/** デフォルト CONTENT_PAD (上下左右共通) */
const DEFAULT_CONTENT_PADDING = 6;

/** HEADER_PAD 最小値 */
export const HEADER_PADDING_MIN = 2;
/** HEADER_PAD 最大値 */
export const HEADER_PADDING_MAX = 12;
/** CONTENT_PAD 最小値 */
export const CONTENT_PADDING_MIN = 0;
/** CONTENT_PAD 最大値 */
export const CONTENT_PADDING_MAX = 10;

/** ヘッダーパディング (localStorage から復元) */
let _headerPad = load("headerPad", DEFAULT_HEADER_PADDING);

/** コンテンツパディング (localStorage から復元) */
let _contentPad = load("contentPad", DEFAULT_CONTENT_PADDING);

/** ヘッダーパディング変更コールバック */
const _headerPadCallbacks = [];
/** コンテンツパディング変更コールバック */
const _contentPadCallbacks = [];

/** 現在のヘッダーパディングを返す */
export function getHeaderPad() {
  return _headerPad;
}

/** 現在のコンテンツパディングを返す */
export function getContentPad() {
  return _contentPad;
}

/** ヘッダーパディング変更コールバックを登録する */
export function onHeaderPadChange(cb) {
  _headerPadCallbacks.push(cb);
}

/** コンテンツパディング変更コールバックを登録する */
export function onContentPadChange(cb) {
  _contentPadCallbacks.push(cb);
}

/**
 * ヘッダーパディングを変更する。
 * @param {number} v  新しいパディング値
 */
export function setHeaderPad(v) {
  v = Math.max(HEADER_PADDING_MIN, Math.min(HEADER_PADDING_MAX, v | 0));
  if (v === _headerPad) return;
  _headerPad = v;
  if (_onSave) _onSave("headerPad", v);
  for (const cb of _headerPadCallbacks) cb();
}

/**
 * コンテンツパディングを変更する。
 * @param {number} v  新しいパディング値
 */
export function setContentPad(v) {
  v = Math.max(CONTENT_PADDING_MIN, Math.min(CONTENT_PADDING_MAX, v | 0));
  if (v === _contentPad) return;
  _contentPad = v;
  if (_onSave) _onSave("contentPad", v);
  for (const cb of _contentPadCallbacks) cb();
}

/**
 * 1 仮想ピクセルの表示倍率。
 * ブラウザウィンドウに収まる最大の整数倍を autoScale() で算出する。
 * 外部モジュールは getScale() で取得すること。
 */
let _scale = 1;

/** 現在のスケール値を返す */
export function getScale() {
  return _scale;
}

/**
 * ブラウザウィンドウサイズから最適な整数スケールを算出して適用する。
 * gpu.js の initGpu / onResize、および kernel.js の window resize / focus で呼ぶ。
 *
 * ブラウザがフォーカスを持たない場合はスケール再計算をスキップする。
 * 全画面表示中に Alt+Tab 等でフォーカスを失うと、ブラウザが全画面を一時解除して
 * resize イベントを発火し、innerWidth/Height が縮小値を返すため、
 * スキップしないとスケールが一時的に落ちる (Chrome / Edge で確認済み)。
 * フォーカス復帰時に kernel.js が再度 autoScale() を呼んで正しい値に戻す。
 *
 * @returns {number} 現在のスケール値
 */
export function autoScale() {
  if (!document.hasFocus()) return _scale;
  const maxW = window.innerWidth;
  const maxH = window.innerHeight;
  _scale = Math.max(
    1,
    Math.min(Math.floor(maxW / VRAM_WIDTH), Math.floor(maxH / VRAM_HEIGHT)),
  );
  for (const cb of _scaleCallbacks) cb();
  return _scale;
}

/** スケール変更コールバック一覧 */
const _scaleCallbacks = [];

/** スケール変更コールバックを登録する */
export function onScaleChange(cb) {
  _scaleCallbacks.push(cb);
}

// ── 製品情報 ──

/** 製品名 */
export const APP_NAME = "SYNESTA";

/** バージョン番号 (semver) */
export const APP_VERSION = "0.2.2";

// ── アセットのキャッシュバスティング ──

/** キャッシュバスト用トークン (初回 assetUrl 呼び出し時に一度だけ確定) */
let _assetToken = null;

/**
 * アセット URL にキャッシュバスト用のクエリを付与する。
 * 全アセットローダ (app_icon / icon / text_icon / cursor …) の実読み込み点
 * (img.src / fetch) で通し、サーバのキャッシュ設定に依存せず更新を保証する。
 *
 *   - 開発時 (localhost / file://): ブート毎のトークンで毎回フレッシュに再取得
 *     → 編集した PNG 等がリロードで確実に反映される
 *   - 本番: APP_VERSION で版ごとにキャッシュを分離
 *     → キャッシュを効かせつつ、リリース (版更新) で確実に更新される
 *
 * @param {string} url  アセット URL
 * @returns {string} クエリ付き URL
 */
export function assetUrl(url) {
  if (_assetToken === null) {
    const host = typeof location !== "undefined" ? location.hostname : "";
    const isDev =
      host === "" ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]";
    _assetToken = isDev ? `dev${Date.now()}` : APP_VERSION;
  }
  return url + (url.includes("?") ? "&" : "?") + "v=" + _assetToken;
}

/** ビルド / リリース日 */
export const APP_DATE = "2026-04-24";

/** 説明文 (改行区切り) */
export const APP_DESCRIPTION =
  "A retro-computer-inspired environment\n" +
  "for expressing structure through sound and visuals.";

/** 著作権者名 */
export const APP_AUTHOR = "Layotashi";

/** 公開 URL */
export const APP_URL = "x.com/layotashi_";

/** SYNESTA の ASCII アートロゴ (splash / about 共通) */
export const APP_ASCII_LOGO = [
  "._______._______._______._______._______._______._______.",
  "|     __|   |   |    |  |    ___|     __|_     _|   _   |",
  "|__     |\\     /|       |    ___|__     | |   | |       |",
  "|_______| |___| |__|____|_______|_______| |___| |___|___|",
];

/**
 * テキスト描画時の自動変換。CSS の text-transform 相当。
 *   "uppercase" — 全て大文字で描画
 *   "none"      — 変換なし (そのまま描画)
 */
let _textTransform = "uppercase";

/** 現在の textTransform 値を返す */
export function getTextTransform() {
  return _textTransform;
}

/**
 * textTransform を動的に切り替える。
 * @param {"uppercase"|"none"} mode
 */
export function setTextTransform(mode) {
  if (mode === "uppercase" || mode === "none") _textTransform = mode;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  フォント設定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * システムフォントプリセット定義。
 *
 * SYNESTA のシステムフォントは 5x5 の単一寸法に統一されている。
 * 複数の寸法を持たないことで、フォント切替が「グリフ内容の差し替えだけ」に
 * なり、寸法依存のメトリクス・アイコン・レイアウト再計算が一切不要になる
 * (シンプルさ = SYNESTA の美学)。
 * FONTSMITH が作るユーザーフォントも同じ 5x5 でこの配列に登録される。
 *
 *   id     : 内部識別子 (localStorage 保存用)
 *   label  : Settings DropDown の表示名
 *   file   : assets/font/ 内の PNG ファイル名
 *   glyphW : グリフ幅 (px)
 *   glyphH : グリフ高さ (px)
 *   cols   : フォントシートの列数
 */
export const FONTS = [
  {
    id: "default",
    label: "Default",
    file: "default.png",
    glyphW: 5,
    glyphH: 5,
    cols: 10,
    iconDir: "icons",
    textIconDir: "icons-text",
  },
];

/** 現在のシステムフォント ID (localStorage から復元) */
let _currentFontId = load("fontId", "default");

/** フォント変更コールバック一覧 */
const _fontChangeCallbacks = [];

/** フォント変更コールバックを登録する */
export function onFontChange(cb) {
  _fontChangeCallbacks.push(cb);
}

/**
 * フォント変更コールバックを手動発火する。
 * boot() 完了後に 1 回呼ぶことで、wm.js 等の派生定数を
 * 実際にロードされたフォントに合わせて再計算させる。
 * @internal
 */
export function _fireFontChangeCallbacks() {
  for (const cb of _fontChangeCallbacks) cb();
}

/** 現在のシステムフォント ID を返す */
export function getSystemFontId() {
  return _currentFontId;
}

/**
 * 現在のシステムフォント定義オブジェクトを返す。
 * @returns {{ id: string, label: string, file?: string, glyphW: number, glyphH: number, cols?: number }}
 */
export function getSystemFont() {
  return FONTS.find((f) => f.id === _currentFontId) || FONTS[0];
}

// ── フォントレジストリ (組込 + FONTSMITH 製ユーザーフォント) ──
//
// 全フォントは 5x5 同一寸法。各定義は `_glyphs` (Uint8Array[95]、各 25 byte)
// を持ち、切替は kernel 経由の content-swap (font.js setGlyphs) で行う。
//   - 組込 default:    boot 時に PNG からスナップショットして _glyphs を設定
//   - ユーザーフォント:  registerUserFont で _glyphs 付きで登録

/** フォント一覧 (登録/削除) 変更コールバック。Settings ドロップダウン更新用 */
const _fontListChangeCallbacks = [];

/** フォント一覧変更コールバックを登録する */
export function onFontListChange(cb) {
  _fontListChangeCallbacks.push(cb);
}

function _fireFontListChange() {
  for (const cb of _fontListChangeCallbacks) cb();
}

/**
 * 指定フォントのグリフデータを設定する (boot のスナップショット注入等)。
 * @param {string} id
 * @param {Uint8Array[]} glyphs
 */
export function setFontGlyphs(id, glyphs) {
  const f = FONTS.find((x) => x.id === id);
  if (f) f._glyphs = glyphs;
}

/**
 * 指定フォントのグリフデータを返す (なければ null)。
 * @param {string} id
 * @returns {Uint8Array[]|null}
 */
export function getFontGlyphs(id) {
  const f = FONTS.find((x) => x.id === id);
  return f && f._glyphs ? f._glyphs : null;
}

/**
 * FONTSMITH 製のユーザーフォントを登録する (同 id があれば上書き)。
 * @param {string} id        一意なフォント ID
 * @param {string} label     ドロップダウン表示名
 * @param {Uint8Array[]} glyphs  5x5 グリフ配列 (95 文字)
 * @returns {object} 登録された font 定義
 */
export function registerUserFont(id, label, glyphs) {
  const existing = FONTS.find((f) => f.id === id);
  if (existing) {
    existing.label = label;
    existing._glyphs = glyphs;
    _fireFontListChange();
    return existing;
  }
  const def = { id, label, user: true, glyphW: 5, glyphH: 5, _glyphs: glyphs };
  FONTS.push(def);
  _fireFontListChange();
  return def;
}

/**
 * フォント切替実装コールバック。kernel.js が注入する。
 * font.js の switchFont を直接呼べない (循環依存回避) ため、
 * kernel.js 経由で間接呼び出しする。
 * @type {((fontDef: object) => Promise<void>) | null}
 */
let _onFontSwitch = null;

/** フォント切替実装コールバックを登録する。kernel.js が起動時に呼ぶ */
export function configSetFontSwitchCallback(fn) {
  _onFontSwitch = fn;
}

/**
 * システムフォントを変更する。
 * 全フォントが 5x5 同一寸法のため、切替は kernel コールバック内の
 * content-swap (font.js setGlyphs) で行う。寸法不変なのでメトリクス・
 * アイコン・レイアウトは変わらず、字形だけが置き換わる。
 * @param {string} id  FONTS に定義されたフォント ID
 * @returns {Promise<void>}
 */
export async function setSystemFont(id) {
  const font = FONTS.find((f) => f.id === id);
  if (!font || id === _currentFontId) return;
  _currentFontId = id;
  if (_onSave) _onSave("fontId", id);
  if (_onFontSwitch) await _onFontSwitch(font);
  for (const cb of _fontChangeCallbacks) cb();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  パレット定義
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * カラーパレット プリセット集
 *
 * 各パレットは以下のフィールドを持つ。
 *   bg     : 背景色 "#RRGGBB"  (VRAM値 0)
 *   fg     : 前景色 "#RRGGBB"  (VRAM値 1)
 *   label  : ドロップダウン/リスト表示名
 *   origin : 元ネタ (デバイス・技術名)
 *   note   : 補足説明
 */
export const PALETTES = {
  // ── CRT 蛍光体ファミリー ──

  p1_green: {
    bg: "#001200",
    fg: "#33FF00",
    label: "P1 Green",
    origin: "P1 phosphor\nDEC VT100, IBM 5151, Apple II",
    note: "The archetypal green-screen.\nPeak emission ~525 nm.",
  },
  p3_amber: {
    bg: "#1A0800",
    fg: "#FFB000",
    label: "P3 Amber",
    origin: "P3 phosphor\nIBM 3278, Wyse 50, Heathkit H19",
    note: "Popular in Europe; considered\neasier on the eyes than green.",
  },
  p4_white: {
    bg: "#080808",
    fg: "#C8C8C8",
    label: "P4 White",
    origin: "P4 phosphor\nDEC VT52, Televideo 925",
    note: "Cool white phosphor aiming for\na paper-like reading experience.",
  },
  p7_blue: {
    bg: "#000510",
    fg: "#7AB8FF",
    label: "P7 Blue-white",
    origin: "P7 long-persistence phosphor\nTektronix 4010, radar displays",
    note: "Dual-layer: blue flash fading\nto yellow-green afterglow.",
  },

  // ── 特殊ディスプレイ技術 ──

  plato: {
    bg: "#0C0200",
    fg: "#FF6E1A",
    label: "PLATO",
    origin: "PLATO V gas-plasma terminal\nCDC, 1972",
    note: "Neon-gas orange glow. Birthplace\nof online forums and e-mail.",
  },
  el_teal: {
    bg: "#001A18",
    fg: "#00D4AA",
    label: "EL Teal",
    origin: "Electroluminescent backlight\nTimex Indiglo, Game Boy Light",
    note: "Cool blue-green cold-cathode\nglow. The iconic '90s backlight.",
  },

  // ── 携帯機・LCD ──

  dmg: {
    bg: "#9BBC0F",
    fg: "#0F380F",
    label: "DMG",
    origin: "Game Boy DMG-01\nNintendo, 1989",
    note: "100M+ units sold. Yellow-green\nreflective STN LCD, dark on light.",
  },
  pocket_lcd: {
    bg: "#B0C4A0",
    fg: "#1A2818",
    label: "Pocket LCD",
    origin: "Reflective STN LCD\nCasio, Sharp Wizard, Palm Pilot",
    note: "The muted grey-green of everyday\nelectronic organizers.",
  },
  blue_lcd: {
    bg: "#041018",
    fg: "#5CCFEF",
    label: "Blue LCD",
    origin: "Blue-backlit LCD\nPSION, Canon Cat, pocket computers",
    note: "A cool blue glow emerging from\nthe dark. '80s-'90s devices.",
  },

  // ── ゲーム・異色ハード ──

  virtual_boy: {
    bg: "#100000",
    fg: "#E80020",
    label: "Virtual Boy",
    origin: "Virtual Boy\nNintendo, 1995",
    note: "Red LED-only stereoscopic display.\nA commercial failure, but an\nunforgettable visual experience.",
  },

  // ── デスクトップ・紙メタファー ──

  macintosh: {
    bg: "#F0F0E0",
    fg: "#0A0A0A",
    label: "Macintosh",
    origin: "Macintosh 128K\nApple, 1984",
    note: "Susan Kare's pixel art came to\nlife here. Dawn of the desktop.",
  },

  // ── 非コンピュータ系 ──

  blueprint: {
    bg: "#002B5C",
    fg: "#E0D8C8",
    label: "Blueprint",
    origin: "Cyanotype reprography\n19th century",
    note: "Prussian-blue ground, white lines.\nSymbol of engineering drawings.",
  },

  // ── 追加候補 (評価中) ──

  minitel: {
    bg: "#0A0A0A",
    fg: "#C0C0C0",
    label: "Minitel",
    origin: "Minitel terminal\nFrance Telecom, 1980",
    note: "France's pre-internet videotex.\nWhite P4-like phosphor on a\ndistinctively compact terminal.",
  },
  vectrex: {
    bg: "#020208",
    fg: "#A0C0FF",
    label: "Vectrex",
    origin: "Vectrex\nGCE/MB, 1982",
    note: "Vector-scan CRT home console.\nPale blue-white beam drawing\nbright wire-frame graphics.",
  },
  thermal: {
    bg: "#F0E8E0",
    fg: "#1A1410",
    label: "Thermal",
    origin: "Thermal paper\nReceipt printers, fax machines",
    note: "Slightly pinkish off-white with\ndark brown-black print.",
  },
  e_ink: {
    bg: "#D8D4C8",
    fg: "#28241C",
    label: "E-Ink",
    origin: "E Ink display\nKindle, 2007",
    note: "Low-contrast paper-like display.\nElectrophoretic microcapsules;\nthe modern paper metaphor.",
  },
  bsod: {
    bg: "#0000AA",
    fg: "#FFFFFF",
    label: "BSoD",
    origin: "Blue Screen of Death (STOP error)\nMicrosoft Windows, 1992–2001",
    note: "Famously spotted on public displays,\nfrom Times Square billboards to ATMs.",
  },
};

/** カスタムパレットのドロップダウン表示名 */
export const CUSTOM_PALETTE_NAME = "Custom";

// ── HEX ↔ RGB 変換 ──

/**
 * "#RRGGBB" → [R, G, B] 配列に変換する。
 * @param {string} hex
 * @returns {number[]}
 */
function hex2rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * [R, G, B] → "#RRGGBB" に変換する。
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
function rgb2hex(r, g, b) {
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/**
 * 現在のアクティブパレット名
 * "Custom" の場合はカスタムパレットが使われる。
 */
let currentPaletteName = "plato";

/** カスタムパレットの HEX 値 (localStorage から復元) */
let customPaletteHex = loadCustomPalette({ bg: "#201600", fg: "#fdb931" });

/**
 * 現在のパレットオブジェクト (ライブ参照)
 * gpu.js の flush() が毎フレームここを参照する。
 * bg / fg は [R, G, B] 配列 (高速参照用)。
 */
export let palette = {
  bg: hex2rgb(PALETTES[currentPaletteName].bg),
  fg: hex2rgb(PALETTES[currentPaletteName].fg),
};

/**
 * パレットを動的に切り替える。
 * @param {string} name  PALETTES に定義された名前、または "Custom"
 */
export function setPalette(name) {
  if (name === CUSTOM_PALETTE_NAME) {
    currentPaletteName = name;
    palette.bg = hex2rgb(customPaletteHex.bg);
    palette.fg = hex2rgb(customPaletteHex.fg);
    if (_onSave) _onSave("palette", name);
    return;
  }
  const p = PALETTES[name];
  if (!p) {
    console.warn(
      `Unknown palette: "${name}". Available: ${Object.keys(PALETTES).join(", ")}`,
    );
    return;
  }
  currentPaletteName = name;
  palette.bg = hex2rgb(p.bg);
  palette.fg = hex2rgb(p.fg);
  if (_onSave) _onSave("palette", name);
}

/** 現在のパレット名を返す */
export function getPaletteName() {
  return currentPaletteName;
}

/**
 * カスタムパレットの色を RGB で設定する。
 * 現在 Custom が選択中なら即座に描画に反映される。
 * @param {"bg"|"fg"} role
 * @param {number} r  0-255
 * @param {number} g  0-255
 * @param {number} b  0-255
 */
export function setCustomPaletteRgb(role, r, g, b) {
  customPaletteHex[role] = rgb2hex(r, g, b);
  if (currentPaletteName === CUSTOM_PALETTE_NAME) {
    palette[role] = [r, g, b];
  }
  if (_onSave) _onSave("customPalette", customPaletteHex);
}

/**
 * カスタムパレットの現在の RGB 値を返す。
 * @returns {{ bg: number[], fg: number[] }}
 */
export function getCustomPaletteRgb() {
  return {
    bg: hex2rgb(customPaletteHex.bg),
    fg: hex2rgb(customPaletteHex.fg),
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  エフェクトパラメータ (DISPLAY_TUNING)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** エフェクトパラメータのデフォルト値 */
export const EFFECT_DEFAULTS = {
  vignetteEnabled: true,
  vignetteStrength: 20,
  vignetteRadius: 40,
  diagEnabled: true,
  diagDarkness: 5,
  diagSpeed: 5,
  diagSpacing: 4,
  diagThickness: 2,
};

let _effectParams = { ...EFFECT_DEFAULTS };

const _effectCallbacks = [];

/** エフェクト変更コールバックを登録する */
export function onEffectChange(cb) {
  _effectCallbacks.push(cb);
}

/** エフェクトパラメータを取得する */
export function getEffectParam(key) {
  return _effectParams[key];
}

/** 全エフェクトパラメータのコピーを返す */
export function getEffectParams() {
  return { ..._effectParams };
}

/**
 * エフェクトパラメータを設定する。
 * @param {string} key  パラメータ名
 * @param {*} value  新しい値
 */
export function setEffectParam(key, value) {
  if (_effectParams[key] === value) return;
  _effectParams[key] = value;
  if (_onSave) _onSave("effect", _effectParams);
  for (const cb of _effectCallbacks) cb(key, value);
}

/**
 * 保存されたエフェクトパラメータを復元する。
 * @param {object|null} saved  localStorage から読み出したオブジェクト
 * @internal
 */
export function _restoreEffectParams(saved) {
  if (!saved) return;
  for (const [k, v] of Object.entries(saved)) {
    if (k in _effectParams) _effectParams[k] = v;
  }
}

/**
 * 全エフェクトパラメータについてコールバックを発火する。
 * boot() でのパラメータ復元後に display_fx へ反映するため使用。
 * @internal
 */
export function _fireEffectCallbacks() {
  for (const [k, v] of Object.entries(_effectParams)) {
    for (const cb of _effectCallbacks) cb(k, v);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力オーバーレイ設定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 入力オーバーレイの ON/OFF (localStorage から復元、デフォルト OFF) */
let _inputOverlay = !!load("inputOverlay", false);

/** 入力オーバーレイが有効か */
export function isInputOverlayEnabled() {
  return _inputOverlay;
}

/**
 * 入力オーバーレイの ON/OFF を切り替える。
 * @param {boolean} v
 */
export function setInputOverlay(v) {
  _inputOverlay = !!v;
  if (_onSave) _onSave("inputOverlay", _inputOverlay);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  システム SFX 設定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** システム SFX の ON/OFF (localStorage から復元、デフォルト ON) */
let _systemSfx = load("systemSfx", true) !== false;

/** システム SFX が有効か */
export function isSystemSfxOn() {
  return _systemSfx;
}

/**
 * システム SFX の ON/OFF を切り替える。
 * @param {boolean} v
 */
export function setSystemSfx(v) {
  _systemSfx = !!v;
  if (_onSave) _onSave("systemSfx", _systemSfx);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  トランスポート / 再生設定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** デフォルト BPM */
export const DEFAULT_BPM = 120;

/** BPM 最小値 */
export const BPM_MIN = 30;

/** BPM 最大値 */
export const BPM_MAX = 300;

/** 先読みスケジューリング時間 (秒) */
export const SCHEDULE_AHEAD = 0.1;

/** スケジューラのタイマー間隔 (ミリ秒) */
export const SCHEDULE_INTERVAL = 25;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ピアノロール / グリッド定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 1拍 = 4ステップ (16分音符解像度) */
export const PIANO_ROLL_STEPS_PER_BEAT = 4;

/** 4/4 拍子 */
export const PIANO_ROLL_BEATS_PER_BAR = 4;

/** 1小節あたりのステップ数 */
export const PIANO_ROLL_STEPS_PER_BAR =
  PIANO_ROLL_STEPS_PER_BEAT * PIANO_ROLL_BEATS_PER_BAR;

/** 全列数 (8小節) */
export const PIANO_ROLL_TOTAL_COLUMNS = 128;

