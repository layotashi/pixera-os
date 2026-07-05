/**
 * @module core/app_icon
 * app_icon.js — デスクトップ用アプリアイコン管理・描画
 *
 * 個別 PNG からアプリアイコンを読み込み、名前で引ける描画 API を提供する。
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
 * ── アイコン解決 (規約ベース) ──
 * アイコン名 <name> は "<name>.png" というファイル名で解決する
 * (SSoT はファイル名そのもの。手動の索引を持たず乖離を防ぐ)。
 *   - 例: アプリ名 FOO → icon="foo" → foo.png を自動読み込み
 *   - <name>.png が無いアプリは自動的に "default" (default.png) へフォールバック
 * → 新規アプリのアイコンは、規約名の PNG を app-icons/ に置くだけで有効になる。
 *
 * manifest.json は format (寸法・エンコーディング) の SSoT としてのみ使う。
 */

import { blit } from "./gpu.js";
import { assetUrl } from "../config.js";

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
    img.src = assetUrl(url);
  });
}

// ── 初期化 ──

/** フォールバック用アイコンのファイル名 (規約: 名前 "default")。 */
const DEFAULT_ICON_FILE = "default.png";

/**
 * manifest から寸法を取得し、規約ベースで各アプリアイコンを読み込む。
 * "default" は必須。各 <name>.png は存在すれば読み込み、無ければ静かにスキップ
 * (描画時に default へフォールバックする)。
 * Promise を返すため、kernel.js で await して起動シーケンスに組み込む。
 *
 * @param {string[]} [iconNames]  読み込むアイコン名 (アプリ由来)。既定 [].
 * @returns {Promise<void>}
 */
export async function initAppIcon(iconNames = []) {
  const res = await fetch(assetUrl(MANIFEST_URL));
  if (!res.ok)
    throw new Error(`Failed to load app-icon manifest: ${res.status}`);
  const manifest = await res.json();

  // マニフェストからサイズを取得 (format が SSoT)
  const fmt = manifest.format;
  APP_ICON_W = fmt.width;
  APP_ICON_H = fmt.height;

  // マニフェストのベース URL (manifest.json と同階層)
  const baseUrl = MANIFEST_URL.replace(/manifest\.json$/, "");

  // フォールバックの default は必須 (失敗すれば throw)
  appIcons["default"] = await loadAppIconPng(
    baseUrl + DEFAULT_ICON_FILE,
    APP_ICON_W,
    APP_ICON_H,
  );

  // 規約ベース解決: <name>.png を並行読み込み。未提供 (404) は正常系として
  // スキップし、描画時に default へフォールバックする。
  const names = [...new Set(iconNames)].filter((n) => n && n !== "default");
  await Promise.all(
    names.map(async (name) => {
      try {
        appIcons[name] = await loadAppIconPng(
          baseUrl + `${name}.png`,
          APP_ICON_W,
          APP_ICON_H,
        );
      } catch {
        // アイコン未提供のアプリ: default にフォールバック (正常系)
      }
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
 * selected=true のときは 2 パスの色を入れ替えてアイコン自身を反転描画する
 * (アウトライン=1・前景=0)。透過画素はそのまま残るため、外周に矩形の箱を
 * 作らず「アイコンそのものが反転した」見た目になる (ラベルチップの反転と対).
 *
 * @param {string} name  アイコン名 ("dolphin", "notepad", ...)
 * @param {number} x     描画先 X (左上)
 * @param {number} y     描画先 Y (左上)
 * @param {boolean} [selected]  選択状態 (前景/背景色を反転)
 */
export function drawAppIcon(name, x, y, selected = false) {
  if (!ready) return;
  const icon = appIcons[name] || appIcons["default"];
  if (!icon) return;
  const bgColor = selected ? 1 : 0;
  const fgColor = selected ? 0 : 1;
  blit(icon.bgBuf, APP_ICON_W, APP_ICON_H, x, y, bgColor);
  blit(icon.fgBuf, APP_ICON_W, APP_ICON_H, x, y, fgColor);
}

