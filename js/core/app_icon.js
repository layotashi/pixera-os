/**
 * @module core/app_icon
 * app_icon.js — デスクトップ用アプリアイコン管理・描画
 *
 * assets/app-icons/manifest.json に基づき個別 PNG からアプリアイコンを
 * 読み込み、名前で引ける描画 API を提供する。
 *
 * icon.js (小さな UI 部品用アイコン) とは独立した、デスクトップアイコン向けの
 * スプライトシステム (寸法は manifest の format が正)。
 *
 * エンコーディング: cursor.js と同じ 3-level 方式
 *   - 白 (R≥192) = 前景 (fgBuf)
 *   - 灰 (64≤R<192) = アウトライン/背景色 (bgBuf)
 *   - 黒 (R<64) = 透過
 *
 * アウトライン → 前景の 2 パス描画により、
 * どんな背景でも視認可能なアイコンを実現する。
 *
 * フォールバック: 要求されたアイコン名が存在しない場合、
 * "default" アイコンが自動的に使用される。
 *
 * マニフェスト仕様:
 *   - format.width / format.height: アイコンサイズ (既定 18×18)
 *   - format.encoding: "3level"
 *   - icons[name].file: PNG ファイル名 (manifest.json と同階層)
 *   - icons[name].description: アイコンの説明文
 */

import { blit } from "./gpu.js";

// ── マニフェスト URL ──

const MANIFEST_URL = "./assets/app-icons/manifest.json";

// ── アイコンパラメータ (initAppIcon でマニフェストから設定) ──

/** アプリアイコン幅 (px) */
export let APP_ICON_W = 18;

/** アプリアイコン高さ (px) */
export let APP_ICON_H = 18;

// ── 内部状態 ──

/**
 * アイコンデータ: name → { fgBuf: Uint8Array, bgBuf: Uint8Array }
 * fgBuf: 前景描画マスク (1 = 前景色で描画)
 * bgBuf: アウトライン描画マスク (1 = 背景色で描画)
 * @type {Object.<string, { fgBuf: Uint8Array, bgBuf: Uint8Array }>}
 */
const appIcons = {};

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
function loadAppIconPng(url, w, h) {
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
    img.onerror = () => reject(new Error(`Failed to load app icon: ${url}`));
    img.src = url;
  });
}

// ── 初期化 ──

/**
 * マニフェストを読み込み、個別 PNG から前景/背景バッファテーブルを構築する。
 * Promise を返すため、kernel.js で await して起動シーケンスに組み込む。
 *
 * @returns {Promise<void>}
 */
export async function initAppIcon() {
  const res = await fetch(MANIFEST_URL);
  if (!res.ok)
    throw new Error(`Failed to load app-icon manifest: ${res.status}`);
  const manifest = await res.json();

  // マニフェストからサイズを取得
  const fmt = manifest.format;
  APP_ICON_W = fmt.width;
  APP_ICON_H = fmt.height;

  // マニフェストのベース URL (manifest.json と同階層)
  const baseUrl = MANIFEST_URL.replace(/manifest\.json$/, "");

  // 全アイコンを並行読み込み
  const entries = Object.entries(manifest.icons);
  await Promise.all(
    entries.map(async ([name, def]) => {
      const { fgBuf, bgBuf } = await loadAppIconPng(
        baseUrl + def.file,
        APP_ICON_W,
        APP_ICON_H,
      );
      appIcons[name] = { fgBuf, bgBuf };
    }),
  );

  ready = true;
}

// ── 描画 API ──

/**
 * 指定アプリアイコンを描画する。
 * アウトライン (背景色 c=0) → 前景 (c=1) の 2 パス描画。
 * 指定名が未登録の場合は "default" アイコンにフォールバックする。
 *
 * @param {string} name  アイコン名 ("dolphin", "notepad", ...)
 * @param {number} x     描画先 X (左上)
 * @param {number} y     描画先 Y (左上)
 */
export function drawAppIcon(name, x, y) {
  if (!ready) return;
  const icon = appIcons[name] || appIcons["default"];
  if (!icon) return;
  blit(icon.bgBuf, APP_ICON_W, APP_ICON_H, x, y, 0);
  blit(icon.fgBuf, APP_ICON_W, APP_ICON_H, x, y, 1);
}

