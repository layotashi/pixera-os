/**
 * @module core/cursor
 * cursor.js — カーソル管理・描画
 *
 * assets/cursors/manifest.json に基づき個別 PNG からカーソルを読み込み、
 * ビットマップ + ホットスポット情報で管理する。
 *
 * マニフェスト仕様:
 *   - format.width / format.height: カーソルサイズ (既定 15×15)
 *   - format.encoding: "3level"
 *   - cursors[name].file: PNG ファイル名
 *   - cursors[name].hotX / hotY: ホットスポット座標
 *   - cursors[name].description: カーソルの説明文
 *
 * ピクセル判定:
 *   - 白 (R≥192) = 前景
 *   - 灰 (64≤R<192) = アウトライン (背景色)
 *   - 黒 (R<64) = 透過
 */

import { blit } from "./gpu.js";
import { assetUrl } from "../config.js";

// ── マニフェスト URL ──

const MANIFEST_URL = "./assets/cursors/manifest.json";

// ── カーソルパラメータ (initCursor でマニフェストから設定) ──

/** カーソル幅 (px) */
let CURSOR_W = 15;

/** カーソル高さ (px) */
let CURSOR_H = 15;

// ── 内部状態 ──

/**
 * カーソルデータ: name → { fgBuf: Uint8Array, bgBuf: Uint8Array, hotX, hotY }
 * fgBuf: 前景描画マスク (1 = 前景色で描画)
 * bgBuf: アウトライン描画マスク (1 = 背景色で描画)
 * @type {Object.<string, { fgBuf: Uint8Array, bgBuf: Uint8Array, hotX: number, hotY: number }>}
 */
const cursors = {};

/** 現在のカーソル種別名 */
let currentCursor = "default";

/** 初期化完了フラグ */
let ready = false;

// ── 内部ヘルパー ──

/**
 * 1 枚の PNG を読み込み、前景/背景バッファを返す。
 * @param {string} url  画像 URL
 * @param {number} w    期待幅
 * @param {number} h    期待高さ
 * @returns {Promise<{ fgBuf: Uint8Array, bgBuf: Uint8Array }>}
 */
function loadCursorPng(url, w, h) {
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

      for (let cy = 0; cy < h; cy++) {
        for (let cx = 0; cx < w; cx++) {
          const srcIdx = (cy * img.width + cx) * 4;
          const r = data[srcIdx];
          if (r >= 192) {
            fgBuf[cy * w + cx] = 1;
          } else if (r >= 64) {
            bgBuf[cy * w + cx] = 1;
          }
        }
      }
      resolve({ fgBuf, bgBuf });
    };
    img.onerror = () => reject(new Error(`Failed to load cursor: ${url}`));
    img.src = assetUrl(url);
  });
}

// ── 初期化 ──

/**
 * マニフェストを読み込み、個別 PNG からカーソルテーブルを構築する。
 * Promise を返すため、kernel.js で await して起動シーケンスに組み込む。
 *
 * @returns {Promise<void>}
 */
export async function initCursor() {
  const res = await fetch(assetUrl(MANIFEST_URL));
  if (!res.ok) throw new Error(`Failed to load cursor manifest: ${res.status}`);
  const manifest = await res.json();

  // マニフェストからサイズを取得
  const fmt = manifest.format;
  CURSOR_W = fmt.width;
  CURSOR_H = fmt.height;

  // マニフェストのベース URL
  const baseUrl = MANIFEST_URL.replace(/manifest\.json$/, "");

  // 全カーソルを並行読み込み
  const entries = Object.entries(manifest.cursors);
  await Promise.all(
    entries.map(async ([name, def]) => {
      const { fgBuf, bgBuf } = await loadCursorPng(
        baseUrl + def.file,
        CURSOR_W,
        CURSOR_H,
      );
      cursors[name] = { fgBuf, bgBuf, hotX: def.hotX, hotY: def.hotY };
    }),
  );

  ready = true;
}

// ── カーソル種別設定 ──

/**
 * カーソル種別を変更する。
 * @param {string} name  カーソル名 ("default", "move", "resize-ew", ...)
 */
export function setCursor(name) {
  if (cursors[name]) currentCursor = name;
}

/**
 * 現在のカーソル種別名を取得する。
 * @returns {string}
 */
export function getCursor() {
  return currentCursor;
}

// ── カーソル描画 ──

/**
 * 現在のカーソルを描画する。
 * アウトライン (背景色) → 前景の順で描画し、
 * どんな背景でも視認可能なカーソルを実現する。
 *
 * @param {number} x  マウス仮想画面 X
 * @param {number} y  マウス仮想画面 Y
 */
export function drawCursor(x, y) {
  if (!ready) return;
  const cur = cursors[currentCursor];
  if (!cur) return;
  const dx = x - cur.hotX;
  const dy = y - cur.hotY;
  blit(cur.bgBuf, CURSOR_W, CURSOR_H, dx, dy, 0);
  blit(cur.fgBuf, CURSOR_W, CURSOR_H, dx, dy, 1);
}

