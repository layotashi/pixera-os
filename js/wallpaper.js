/**
 * @module wallpaper
 * wallpaper.js — 壁紙管理モジュール
 *
 * 2 モード:
 *   "solid" — Bayer ディザ階調 (4×4 / 8×8)
 *   "image" — VFS 上の PBM ファイルを 1-bit バッファとして表示
 *
 * 毎フレーム drawWallpaper() で VRAM にコピーする。
 */

import { VRAM_WIDTH, VRAM_HEIGHT, onResize } from "./config.js";
import { vram } from "./core/gpu.js";
import { BAYER_4x4, BAYER_8x8 } from "./core/dither.js";
import { readFile } from "./core/vfs.js";
import { decodePBM } from "./core/pbm.js";

import * as Storage from "./core/storage.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  内部状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 壁紙モード: "solid" | "image" */
let wallpaperMode = "solid";

/** Solid 背景の Bayer 階調レベル (4x4: 0–16, 8x8: 0–64) */
let solidLevel = 0;

/** Solid 背景の Bayer 行列モード */
let solidBayerMode = "4x4";

/** 現在の壁紙 PBM ファイルパス (VFS) */
let imagePath = null;

/** Image 背景で画像が届かない領域を埋めるビット (0 | 1) */
let imageFillBit = 1;

/** デコード済み 1-bit バッファ (VRAM_WIDTH × VRAM_HEIGHT に中央配置) */
let imageBits = null;

/** initWallpaper 完了フラグ */
let wallpaperReady = false;

// ── Solid タイル事前生成 ──
let solidRows = Array.from({ length: 8 }, () => new Uint8Array(VRAM_WIDTH));
let cachedSolidLevel = -1;
let cachedSolidMode = "";

// ── 解像度変更対応 ──
onResize(() => {
  solidRows = Array.from({ length: 8 }, () => new Uint8Array(VRAM_WIDTH));
  cachedSolidLevel = -1;
  cachedSolidMode = "";
  // PBM を新解像度で再配置
  if (imagePath) loadImageFromVfs(imagePath);
});

/** solidLevel に応じてタイル行を再生成する。 */
function buildSolidRows() {
  if (cachedSolidLevel === solidLevel && cachedSolidMode === solidBayerMode)
    return;
  cachedSolidLevel = solidLevel;
  cachedSolidMode = solidBayerMode;
  const is8 = solidBayerMode === "8x8";
  const mat = is8 ? BAYER_8x8 : BAYER_4x4;
  const tile = is8 ? 8 : 4;
  for (let r = 0; r < tile; r++) {
    const row = solidRows[r];
    for (let x = 0; x < tile; x++) {
      row[x] = mat[r][x] < solidLevel ? 1 : 0;
    }
    for (let w = tile; w < VRAM_WIDTH; w <<= 1) {
      row.copyWithin(w, 0, Math.min(w, VRAM_WIDTH - w));
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PBM 画像ロード (VFS)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * VFS から PBM ファイルを読み込み、VRAM サイズに中央配置して imageBits にセットする。
 * @param {string} path  VFS パス
 * @returns {boolean} 成功なら true
 */
function loadImageFromVfs(path) {
  const text = readFile(path);
  if (text === null) {
    imageBits = null;
    return false;
  }
  const result = decodePBM(text);
  if (!result) {
    imageBits = null;
    return false;
  }
  const { w, h, buf } = result;
  const bits = new Uint8Array(VRAM_WIDTH * VRAM_HEIGHT);
  bits.fill(imageFillBit);
  const ox = ((VRAM_WIDTH - w) / 2) | 0;
  const oy = ((VRAM_HEIGHT - h) / 2) | 0;
  for (let y = 0; y < h; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= VRAM_HEIGHT) continue;
    for (let x = 0; x < w; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= VRAM_WIDTH) continue;
      bits[dy * VRAM_WIDTH + dx] = buf[y * w + x];
    }
  }
  imageBits = bits;
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  公開 API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 壁紙システムを初期化する。localStorage から設定を復元。
 */
export async function initWallpaper() {
  // Solid Bayer モード復元
  const savedBayerMode = Storage.loadSolidBayerMode(null);
  if (savedBayerMode === "4x4" || savedBayerMode === "8x8") {
    solidBayerMode = savedBayerMode;
  }

  // Solid レベル復元
  const savedLevel = Storage.loadSolidLevel(null);
  if (savedLevel !== null) {
    const max = solidBayerMode === "8x8" ? 64 : 16;
    solidLevel = Math.max(0, Math.min(max, savedLevel | 0));
  }

  // Image 背景の未カバー領域埋めビット復元
  const savedImageFillBit = Storage.loadBgImageFillBit(null);
  if (savedImageFillBit !== null) {
    imageFillBit = savedImageFillBit ? 1 : 0;
  }

  // 背景モード復元
  const savedMode = Storage.loadBgMode(null);
  if (savedMode === "image") {
    const savedPath = Storage.loadBgImagePath(null);
    if (savedPath && loadImageFromVfs(savedPath)) {
      wallpaperMode = "image";
      imagePath = savedPath;
    }
    // 読み込み失敗時は solid にフォールバック
  }

  wallpaperReady = true;
}

/**
 * 壁紙を VRAM に書き込む。cls() の代わりにフレーム先頭で呼ぶ。
 */
export function drawWallpaper() {
  // ── solid: Bayer ディザ階調 ──
  if (wallpaperMode === "solid") {
    const maxLevel = solidBayerMode === "8x8" ? 64 : 16;
    if (solidLevel <= 0) {
      vram.fill(0);
    } else if (solidLevel >= maxLevel) {
      vram.fill(1);
    } else {
      buildSolidRows();
      const mask = solidBayerMode === "8x8" ? 7 : 3;
      for (let y = 0; y < VRAM_HEIGHT; y++) {
        vram.set(solidRows[y & mask], y * VRAM_WIDTH);
      }
    }
    return;
  }
  // ── image: VFS 上の PBM ──
  if (imageBits) {
    vram.set(imageBits);
  } else {
    vram.fill(imageFillBit);
  }
}

/** initWallpaper が完了したかどうかを返す */
export function isWallpaperReady() {
  return wallpaperReady;
}

/** 現在の背景モードを返す ("solid" | "image") */
export function getBackgroundMode() {
  return wallpaperMode;
}

/**
 * 背景モードを切り替える。
 * @param {"solid"|"image"} mode
 */
export function setBackgroundMode(mode) {
  if (mode !== "solid" && mode !== "image") return;
  if (mode === wallpaperMode) return;

  wallpaperMode = mode;
  Storage.saveBgMode(mode);

  if (mode === "solid") return;

  // image: 保存済みパスがあればロード
  if (imagePath) {
    loadImageFromVfs(imagePath);
  } else {
    imageBits = null;
  }
}

/** Solid 背景の Bayer 階調を設定する (4x4: 0–16, 8x8: 0–64) */
export function setSolidLevel(level) {
  const max = solidBayerMode === "8x8" ? 64 : 16;
  solidLevel = Math.max(0, Math.min(max, level | 0));
  Storage.saveSolidLevel(solidLevel);
}

/** 現在の Solid 階調レベルを返す */
export function getSolidLevel() {
  return solidLevel;
}

/** Solid 背景の Bayer 行列モードを設定する */
export function setSolidBayerMode(mode) {
  if (mode !== "4x4" && mode !== "8x8") return;
  solidBayerMode = mode;
  cachedSolidLevel = -1;
  cachedSolidMode = "";
  Storage.saveSolidBayerMode(mode);
}

/** 現在の Solid Bayer 行列モードを返す */
export function getSolidBayerMode() {
  return solidBayerMode;
}

/**
 * 壁紙画像の VFS パスを設定し、PBM を読み込む。
 * @param {string|null} path  VFS パス (null でクリア)
 */
export function setImagePath(path) {
  if (path) {
    imagePath = path;
    Storage.saveBgImagePath(path);
    loadImageFromVfs(path);
  } else {
    imagePath = null;
    imageBits = null;
    Storage.saveBgImagePath(null);
  }
}

/** 現在の壁紙画像パスを返す */
export function getImagePath() {
  return imagePath;
}

/** Image 背景の未カバー領域を埋めるビットを設定する (0 | 1) */
export function setImageFillBit(bit) {
  const nextBit = bit ? 1 : 0;
  if (nextBit === imageFillBit) return;
  imageFillBit = nextBit;
  Storage.saveBgImageFillBit(imageFillBit);
  if (imagePath) {
    loadImageFromVfs(imagePath);
  }
}

/** 現在の Image 背景埋めビットを返す */
export function getImageFillBit() {
  return imageFillBit;
}

