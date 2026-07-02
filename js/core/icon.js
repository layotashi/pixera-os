/**
 * @module core/icon
 * icon.js — アイコン管理・描画
 *
 * assets/icons-{W}x{H}/manifest.json に基づき個別 PNG からアイコンを読み込み、
 * 名前で引ける描画 API を提供する。
 *
 * マニフェスト仕様:
 *   - format.width / format.height: アイコンサイズ (寸法の正は manifest)
 *   - format.encoding: "1bit-white-fg" (白 R≥128 = 前景、黒 = 透過)
 *   - icons[name].file: PNG ファイル名 (manifest.json と同階層)
 *   - icons[name].description: アイコンの説明文
 */

import { blit } from "./gpu.js";

// ── マニフェスト URL ──

/** @type {string} 最後にロードしたマニフェスト URL */
let _manifestUrl = "";

// ── アイコンパラメータ (initIcon でマニフェストから設定) ──

/** アイコン幅 (px) */
export let ICON_W = 7;

/** アイコン高さ (px) */
export let ICON_H = 7;

// ── 内部状態 ──

/**
 * アイコンデータ: name → Uint8Array(ICON_W * ICON_H)
 * @type {Object.<string, Uint8Array>}
 */
const icons = {};

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
function loadIconPng(url, w, h) {
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
    img.onerror = () => reject(new Error(`Failed to load icon: ${url}`));
    img.src = url;
  });
}

// ── 初期化 ──

/**
 * マニフェストを読み込み、個別 PNG からビットマップテーブルを構築する。
 * Promise を返すため、kernel.js で await して起動シーケンスに組み込む。
 *
 * @returns {Promise<void>}
 */
/**
 * @param {string} manifestUrl  マニフェスト URL (フォント定義の iconDir から構築。例 "./assets/icons/manifest.json")
 */
export async function initIcon(manifestUrl) {
  _manifestUrl = manifestUrl;
  const res = await fetch(manifestUrl);
  if (!res.ok) throw new Error(`Failed to load icon manifest: ${res.status}`);
  const manifest = await res.json();

  // マニフェストからサイズを取得
  const fmt = manifest.format;
  ICON_W = fmt.width;
  ICON_H = fmt.height;

  // マニフェストのベース URL (manifest.json と同階層)
  const baseUrl = _manifestUrl.replace(/manifest\.json$/, "");

  // 全アイコンを並行読み込み
  const entries = Object.entries(manifest.icons);
  await Promise.all(
    entries.map(async ([name, def]) => {
      const buf = await loadIconPng(baseUrl + def.file, ICON_W, ICON_H);
      icons[name] = buf;
    }),
  );

  ready = true;
}

// ── 描画 API ──

/**
 * 指定アイコンを描画する。
 * @param {string} name  アイコン名 ("close", "maximize", "restore", "minimize", ...)
 * @param {number} x     描画先 X (左上)
 * @param {number} y     描画先 Y (左上)
 * @param {number} [c=1] 描画色 (0 or 1)
 */
export function drawIcon(name, x, y, c = 1) {
  if (!ready) return;
  const buf = icons[name];
  if (!buf) return;
  blit(buf, ICON_W, ICON_H, x, y, c);
}

