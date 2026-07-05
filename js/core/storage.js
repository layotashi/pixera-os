/**
 * @module core/storage
 * storage.js — localStorage ベースの設定永続化
 *
 * パレット・壁紙 (Solid 階調 / 画像パス)・解像度の設定を
 * 保存し、次回起動時に復元する。
 *
 * キーは "pixera." プレフィックス付きで名前空間を分離。
 */

const PREFIX = "pixera.";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  汎用 save / load
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 値を localStorage に保存する。
 * @param {string} key  キー名 (PREFIX 自動付与)
 * @param {*} value  JSON シリアライズ可能な値
 */
export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota / private mode — 無視 */
  }
}

/**
 * localStorage から値を読み出す。存在しない・パース失敗時は def を返す。
 * @param {string} key  キー名 (PREFIX 自動付与)
 * @param {*} def  デフォルト値
 * @returns {*}
 */
export function load(key, def) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return def;
    return JSON.parse(raw);
  } catch {
    return def;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Appearance 一括保存 / 復元
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// キー定数
const K_PALETTE = "palette";
const K_SOLID_LEVEL = "solidLevel";
const K_SOLID_BAYER_MODE = "solidBayerMode";

/** パレット名を保存する */
export function savePalette(name) {
  save(K_PALETTE, name);
}

/** Solid 階調レベルを保存する */
export function saveSolidLevel(level) {
  save(K_SOLID_LEVEL, level);
}

/** Solid Bayer 行列モードを保存する ("4x4" | "8x8") */
export function saveSolidBayerMode(mode) {
  save(K_SOLID_BAYER_MODE, mode);
}

/** 保存されたパレット名を読み出す */
export function loadPalette(def) {
  return load(K_PALETTE, def);
}

/** 保存された Solid 階調を読み出す */
export function loadSolidLevel(def) {
  return load(K_SOLID_LEVEL, def);
}

/** 保存された Solid Bayer 行列モードを読み出す */
export function loadSolidBayerMode(def) {
  return load(K_SOLID_BAYER_MODE, def);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  カスタムパレット
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const K_CUSTOM_PALETTE = "customPalette";

/** カスタムパレットを保存する ({ bg: "#RRGGBB", fg: "#RRGGBB" }) */
export function saveCustomPalette(hex) {
  save(K_CUSTOM_PALETTE, hex);
}

/** 保存されたカスタムパレットを読み出す */
export function loadCustomPalette(def) {
  return load(K_CUSTOM_PALETTE, def);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  解像度
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const K_VRAM_W = "vramW";
const K_VRAM_H = "vramH";

/** 解像度を保存する */
export function saveResolution(w, h) {
  save(K_VRAM_W, w);
  save(K_VRAM_H, h);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  背景モード
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const K_BG_MODE = "bgMode";
const K_BG_TESS_SRC = "bgTessSource";

/** 背景モードを保存する ("solid" | "image" | "tessera") */
export function saveBgMode(mode) {
  save(K_BG_MODE, mode);
}

/** tessera 壁紙の .tess ソース（スナップショット）を保存する */
export function saveBgTessSource(src) {
  save(K_BG_TESS_SRC, src);
}

/** 保存された tessera 壁紙の .tess ソースを読み出す */
export function loadBgTessSource(def) {
  return load(K_BG_TESS_SRC, def);
}

/** 保存された背景モードを読み出す */
export function loadBgMode(def) {
  return load(K_BG_MODE, def);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  壁紙画像パス (VFS)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const K_BG_IMAGE_PATH = "bgImagePath";
const K_BG_IMAGE_FILL_BIT = "bgImageFillBit";

/** 壁紙画像の VFS パスを保存する */
export function saveBgImagePath(path) {
  save(K_BG_IMAGE_PATH, path);
}

/** 保存された壁紙画像パスを読み出す */
export function loadBgImagePath(def) {
  return load(K_BG_IMAGE_PATH, def);
}

/** 画像背景の未カバー領域を埋めるビットを保存する (0 | 1) */
export function saveBgImageFillBit(bit) {
  save(K_BG_IMAGE_FILL_BIT, bit);
}

/** 保存された画像背景の埋めビットを読み出す */
export function loadBgImageFillBit(def) {
  return load(K_BG_IMAGE_FILL_BIT, def);
}

