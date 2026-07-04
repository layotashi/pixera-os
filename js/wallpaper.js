/**
 * @module wallpaper
 * wallpaper.js — 壁紙管理モジュール
 *
 * 3 モード:
 *   "solid"   — Bayer ディザ階調 (4×4 / 8×8)
 *   "image"   — VFS 上の PBM ファイルを 1-bit バッファとして表示
 *   "tessera" — TESSERA の場 f(x,y,t) をデスクトップに live-render（静止/アニメ自動判別）
 *
 * 毎フレーム drawWallpaper() で VRAM にコピーする。
 */

import { VRAM_WIDTH, VRAM_HEIGHT, onResize } from "./config.js";
import { vram } from "./core/gpu.js";
import { BAYER_4x4, BAYER_8x8 } from "./core/dither.js";
import { readFile } from "./core/vfs.js";
import { decodePBM } from "./core/pbm.js";
import { resolveTessConfig, makeFieldSurface } from "./core/tess_host.js";
import { compile } from "../lang/runtime.js";

import * as Storage from "./core/storage.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  内部状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 壁紙モード: "solid" | "image" | "tessera" */
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

// ── "tessera" モード（.tess を live-render）──
let tessSource = null; // 現在の .tess ソース（スナップショット）
let tessProgram = null; // compile 結果（render/config）
let tessConfig = null; // 解決済み { seed, period, fps, viewMode, viewParams }
let tessBits = null; // 直近に描いた 1-bit（VRAM サイズ）
let tessFrame = -1; // 直近に描いた fps フレーム番号
let tessT0 = 0; // アニメ開始 wall-clock(ms)
let tessStatic = false; // t 非依存＝静止画（1 回描いてキャッシュ）

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
  // tessera は新 VRAM サイズで再描画（領域寸法が変わる）
  if (wallpaperMode === "tessera" && tessProgram) {
    tessFrame = -1;
    tessBits = renderTessFrame(0);
  }
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
//  Tessera 場 live-render (VFS の .tess を背景に)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ディレクティブ解決 (fps スナップ・view→パラメータ・既定値/クランプ) と
// 場サーフェス生成は core/tess_host.js に一元化 (tessera プレビュー/書き出しと共有)。
// 壁紙は結果から seed/period/fps/view のみ使う。

/**
 * 場を時刻 t で 1 フレーム描く。壁紙は常に画面いっぱい (Fill)＝画面解像度・
 * アスペクトで場を再評価する。場の座標は canvas 寸法に依らず x,y ∈ [0,1] なので
 * (lang/runtime.js)、これはラスタ画像の引き伸ばしと違いネイティブ解像度の再描画で
 * 劣化しない。canvas ディレクティブの縦横比はプレビュー/書き出し枠であり壁紙では無視。
 * @returns {Uint8Array} VRAM サイズの 1-bit (毎回新規バッファ)
 */
function renderTessFrame(t) {
  const { seed, viewMode, viewParams } = tessConfig;
  const surf = makeFieldSurface(VRAM_WIDTH, VRAM_HEIGHT, viewMode, viewParams);
  tessProgram.render(surf, t, seed);
  return surf.buf;
}

const eqBits = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * ソースを compile して tessera 描画状態を準備する（モード切替・保存はしない）。
 * t=0 と t=period*0.37 が一致すれば静止画と判定し 1 回描いてキャッシュする。
 * @returns {boolean} compile 成功なら true
 */
function prepTess(src) {
  let prog;
  try {
    prog = compile(src);
  } catch {
    return false;
  }
  tessProgram = prog;
  tessConfig = resolveTessConfig(prog.config || {});
  tessT0 = performance.now();
  tessFrame = -1;
  const a = renderTessFrame(0);
  const b = renderTessFrame(tessConfig.period * 0.37);
  tessStatic = eqBits(a, b);
  tessBits = a;
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
  } else if (savedMode === "tessera") {
    const savedSrc = Storage.loadBgTessSource(null);
    if (savedSrc && prepTess(savedSrc)) {
      wallpaperMode = "tessera";
      tessSource = savedSrc;
    }
    // compile 失敗時は solid にフォールバック
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
  // ── tessera: 場 f(x,y,t) を live-render ──
  if (wallpaperMode === "tessera") {
    if (tessProgram) {
      if (!tessStatic) {
        const { fps, period } = tessConfig;
        const frameIdx = Math.floor(((performance.now() - tessT0) / 1000) * fps);
        if (frameIdx !== tessFrame || tessBits === null) {
          tessBits = renderTessFrame((frameIdx / fps) % period);
          tessFrame = frameIdx;
        }
      }
      if (tessBits) vram.set(tessBits);
      else vram.fill(0);
    } else {
      vram.fill(0);
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

/** 現在の背景モードを返す ("solid" | "image" | "tessera") */
export function getBackgroundMode() {
  return wallpaperMode;
}

/**
 * 背景モードを切り替える。
 * @param {"solid"|"image"|"tessera"} mode
 */
export function setBackgroundMode(mode) {
  if (mode !== "solid" && mode !== "image" && mode !== "tessera") return;
  if (mode === wallpaperMode) return;

  wallpaperMode = mode;
  Storage.saveBgMode(mode);

  if (mode === "solid") return;

  if (mode === "image") {
    // 保存済みパスがあればロード
    if (imagePath) loadImageFromVfs(imagePath);
    else imageBits = null;
    return;
  }

  // tessera: 既存ソース（無ければ保存済み）を compile し直す
  const src = tessSource || Storage.loadBgTessSource(null);
  if (src && prepTess(src)) tessSource = src;
  else tessProgram = null;
}

/**
 * .tess ソースを壁紙に設定する（TESSERA「Set as wallpaper」/ SETTINGS から）。
 * ソースはスナップショット保存し、デスクトップで f(x,y,t) を live-render する。
 * @param {string} src  .tess ソース
 * @returns {boolean} compile 成功なら true
 */
export function setTessSource(src) {
  if (!prepTess(src)) return false;
  tessSource = src;
  wallpaperMode = "tessera";
  Storage.saveBgMode("tessera");
  Storage.saveBgTessSource(src);
  return true;
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

/** Image 背景の未カバー領域（マット）を埋めるビットを設定する (0 | 1) */
export function setImageFillBit(bit) {
  const nextBit = bit ? 1 : 0;
  if (nextBit === imageFillBit) return;
  imageFillBit = nextBit;
  Storage.saveBgImageFillBit(imageFillBit);
  if (imagePath) loadImageFromVfs(imagePath);
}

/** 現在の Image 背景埋めビットを返す */
export function getImageFillBit() {
  return imageFillBit;
}

