/**
 * @module core/fish
 * fish.js — エンゼルフィッシュ・スプライト読み込み (AQUARIA 用)
 *
 * assets/fish/manifest.json に基づき PNG から泳ぎアニメーションの
 * フレームを読み込む。AQUARIA がフレームを交互に描画して尾びれの
 * 動きを表現する。
 *
 * ピクセル判定 (cursor.js / app_icon.js と同じ 3-level 方式):
 *   - 白 (R≥192) = 前景
 *   - 灰 (64≤R<192) = アウトライン/背景 (水になじませる)
 *   - 黒 (R<64) = 透過
 */

import { assetUrl } from "../config.js";

// ── マニフェスト URL ──

const MANIFEST_URL = "./assets/fish/manifest.json";

// ── フィッシュパラメータ (initFish でマニフェストから設定) ──

/** フレーム幅 (px) */
export let FISH_W = 12;

/** フレーム高さ (px) */
export let FISH_H = 11;

// ── 内部状態 ──

/**
 * フレームデータ (manifest 記載順): { fgBuf: Uint8Array, bgBuf: Uint8Array }[]
 * fgBuf: 前景 (魚本体) 描画マスク
 * bgBuf: アウトライン描画マスク (水になじませる部分)
 * @type {{ fgBuf: Uint8Array, bgBuf: Uint8Array }[]}
 */
const frames = [];

/** 初期化完了フラグ */
let ready = false;

// ── 内部ヘルパー ──

/**
 * 1 枚の PNG を読み込み、前景/背景バッファを返す (3-level エンコーディング)。
 * @param {string} url  画像 URL
 * @param {number} w    期待幅
 * @param {number} h    期待高さ
 * @returns {Promise<{ fgBuf: Uint8Array, bgBuf: Uint8Array }>}
 */
function loadFishPng(url, w, h) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;

      const fgBuf = new Uint8Array(w * h);
      const bgBuf = new Uint8Array(w * h);

      for (let iy = 0; iy < h; iy++) {
        for (let ix = 0; ix < w; ix++) {
          const srcIdx = (iy * img.width + ix) * 4;
          const r = data[srcIdx];
          if (r >= 192) {
            fgBuf[iy * w + ix] = 1;
          } else if (r >= 64) {
            bgBuf[iy * w + ix] = 1;
          }
        }
      }
      resolve({ fgBuf, bgBuf });
    };
    img.onerror = () => reject(new Error(`Failed to load fish sprite: ${url}`));
    img.src = assetUrl(url);
  });
}

// ── 初期化 ──

/**
 * マニフェストを読み込み、個別 PNG からフレーム配列を構築する。
 * Promise を返すため、kernel.js で await して起動シーケンスに組み込む。
 *
 * @returns {Promise<void>}
 */
export async function initFish() {
  const res = await fetch(assetUrl(MANIFEST_URL));
  if (!res.ok) throw new Error(`Failed to load fish manifest: ${res.status}`);
  const manifest = await res.json();

  const fmt = manifest.format;
  FISH_W = fmt.width;
  FISH_H = fmt.height;

  const baseUrl = MANIFEST_URL.replace(/manifest\.json$/, "");

  const entries = Object.entries(manifest.frames);
  const loaded = new Array(entries.length);
  await Promise.all(
    entries.map(async ([, def], i) => {
      loaded[i] = await loadFishPng(baseUrl + def.file, FISH_W, FISH_H);
    }),
  );
  frames.push(...loaded);

  ready = true;
}

// ── 描画用アクセサ ──

/**
 * 指定フレームのバッファを取得する。
 * @param {number} i  フレーム番号 (0 始まり、フレーム数で循環)
 * @returns {{ fgBuf: Uint8Array, bgBuf: Uint8Array }|null}
 */
export function getFishFrame(i) {
  if (!ready || frames.length === 0) return null;
  return frames[i % frames.length];
}

/** 読み込まれたフレーム数を返す。 */
export function fishFrameCount() {
  return frames.length;
}
