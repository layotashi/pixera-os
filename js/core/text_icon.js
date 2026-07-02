/**
 * @module core/text_icon
 * text_icon.js — テキスト用アイコン管理・描画
 *
 * assets/icons-text-{W}x{H}/manifest.json に基づき個別 PNG から
 * テキスト可視化記号を読み込む。
 * スペース中点 (·) や改行矢印 (↵) など。
 *
 * マニフェスト仕様:
 *   - format.width / format.height: アイコンサイズ (寸法の正は manifest)
 *   - format.encoding: "1bit-white-fg" (白 R≥128 = 前景、黒 = 透過)
 *   - icons[name].file: PNG ファイル名
 *   - icons[name].description: アイコンの説明文
 */

import { blit } from "./gpu.js";

// ── マニフェスト URL ──

/** @type {string} 最後にロードしたマニフェスト URL */
let _manifestUrl = "";

// ── パラメータ ──

/** テキストアイコン幅 (px) — マニフェストから設定 */
export let TEXT_ICON_W = 5;

/** テキストアイコン高さ (px) — マニフェストから設定 */
export let TEXT_ICON_H = 7;

// ── 内部状態 ──

/** @type {Object.<string, Uint8Array>} name → ビットマップ */
const textIcons = {};

/** 初期化完了フラグ */
let ready = false;

// ── 内部ヘルパー ──

/**
 * 1 枚の PNG を読み込みビットマップを返す。
 * @param {string} url  画像 URL
 * @param {number} w    期待幅
 * @param {number} h    期待高さ
 * @returns {Promise<Uint8Array>}
 */
function loadTextIconPng(url, w, h) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;

      const buf = new Uint8Array(w * h);
      for (let iy = 0; iy < h; iy++) {
        for (let ix = 0; ix < w; ix++) {
          const srcIdx = (iy * img.width + ix) * 4;
          buf[iy * w + ix] = data[srcIdx] >= 128 ? 1 : 0;
        }
      }
      resolve(buf);
    };
    img.onerror = () => reject(new Error(`Failed to load text icon: ${url}`));
    img.src = url;
  });
}

// ── 初期化 ──

/**
 * マニフェストを読み込み、個別 PNG からテキストアイコンテーブルを構築する。
 * kernel.js の起動シーケンスで await する。
 * @returns {Promise<void>}
 */
/**
 * @param {string} manifestUrl  マニフェスト URL (フォント定義の textIconDir から構築。例 "./assets/icons-text/manifest.json")
 */
export async function initTextIcon(manifestUrl) {
  _manifestUrl = manifestUrl;
  const res = await fetch(manifestUrl);
  if (!res.ok)
    throw new Error(`Failed to load text-icon manifest: ${res.status}`);
  const manifest = await res.json();

  const fmt = manifest.format;
  TEXT_ICON_W = fmt.width;
  TEXT_ICON_H = fmt.height;

  const baseUrl = _manifestUrl.replace(/manifest\.json$/, "");

  const entries = Object.entries(manifest.icons);
  await Promise.all(
    entries.map(async ([name, def]) => {
      const buf = await loadTextIconPng(
        baseUrl + def.file,
        TEXT_ICON_W,
        TEXT_ICON_H,
      );
      textIcons[name] = buf;
    }),
  );

  ready = true;
}

// ── 描画 API ──

/**
 * テキストアイコンを描画する。
 * @param {string} name  アイコン名 ("space-dot", "newline", ...)
 * @param {number} x     描画先 X (左上)
 * @param {number} y     描画先 Y (左上)
 * @param {number} [c=1] 描画色 (0 or 1)
 */
export function drawTextIcon(name, x, y, c = 1) {
  if (!ready) return;
  const buf = textIcons[name];
  if (!buf) return;
  blit(buf, TEXT_ICON_W, TEXT_ICON_H, x, y, c);
}

