/**
 * @module splash
 * splash.js — スプラッシュスクリーン (ブート演出)
 *
 * OS 風のブートシーケンス演出を行う。
 * フォント読み込み完了後 〜 メインループ開始前に kernel.js から呼び出す。
 *
 * 演出フロー:
 *   1. ブランク (短い間)
 *   2. ASCII アートロゴ + バージョン + 著作権 + 区切り線
 *   3. ブートメッセージ + ASCII プログレスバー
 *   4. Bayer 4×4 ディザトランジション (フェードアウト → フェードイン)
 *
 * ASCII 要素はすべて文字単位 (CHAR_PITCH = GLYPH_W + 1) で中央揃えし、
 * ピクセル単位の半端なずれを防いでいる。
 *
 * 依存:
 *   - core/gpu.js   — cls, fillRect, flush, vram
 *   - core/font.js  — drawText, GLYPH_W, GLYPH_H
 *   - core/dither.js — BAYER_4x4
 *   - config.js     — VRAM_WIDTH, VRAM_HEIGHT, APP_VERSION, APP_DATE, APP_AUTHOR,
 *                     APP_ASCII_LOGO
 */

import { cls, fillRect, flush, vram } from "./core/gpu.js";
import { drawText, GLYPH_W, GLYPH_H } from "./core/font.js";
import { BAYER_4x4 } from "./core/dither.js";
import * as Config from "./config.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 文字ピッチ (グリフ幅 + 字間 1px) */
const CHAR_PITCH = GLYPH_W + 1;

/** PIXERA OS ASCII ロゴの文字幅 (APP_ASCII_LOGO から自動算出) */
const APP_LOGO_COLS = Config.APP_ASCII_LOGO[0].length;

/** ブートメッセージ一覧 */
const BOOT_MESSAGES = [
  "INITIALIZING SYSTEM...",
  "LOADING FONTS...",
  "LOADING ICONS...",
  "LOADING CURSORS...",
  "LOADING WALLPAPER...",
  "STARTING PIXERA...",
];

// ── タイミング (ms) ──

/** Phase 1: ブランク画面の表示時間 */
const BLANK_DURATION = 400;

/** Phase 2: ロゴ表示後の待機時間 */
const SPLASH_HOLD = 600;

/** Phase 3: 各ブートメッセージの表示間隔 */
const MSG_INTERVAL = 350;

/** Phase 3 → 4 の間の待機時間 */
const POST_MSG_WAIT = 400;

/** Phase 4: ディザトランジションのステップ数 */
const TRANSITION_STEPS = 16;

/** Phase 4: ディザトランジションの合計時間 */
const TRANSITION_DURATION = 600;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ユーティリティ (内部)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * rAF ベースの待機関数。毎フレーム flush() を呼び、エフェクトを滑らかに更新する。
 * @param {number} ms 待機ミリ秒
 * @returns {Promise<void>}
 */
function splashWait(ms) {
  return new Promise((resolve) => {
    const start = performance.now();
    function tick() {
      flush();
      if (performance.now() - start >= ms) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });
}

/**
 * 文字列を基準幅 (cols 文字) の中で中央寄せするためのスペース文字列を返す。
 * @param {string} str  対象文字列
 * @param {number} cols 基準幅 (文字数)
 * @returns {string} スペースパディング + str
 */
function centerPad(str, cols) {
  const pad = Math.floor((cols - str.length) / 2);
  return " ".repeat(Math.max(0, pad)) + str;
}

/**
 * レイアウトブロックの開始 X 座標を文字グリッドに揃えて算出する。
 * @param {number} cols ブロックの文字数幅
 * @returns {number} 開始 X (px)
 */
function gridAlignedX(cols) {
  const blockPxW = cols * CHAR_PITCH;
  return (
    Math.floor((Config.VRAM_WIDTH - blockPxW) / (2 * CHAR_PITCH)) * CHAR_PITCH
  );
}

/**
 * Bayer 4×4 ディザで vram を進行度 t に応じて徐々に置換する共通ループ。
 * 置換後の値は getPixel(i) で決める (単色は () => color、スナップショットは
 * (i) => snapshot[i])。
 * @param {number} t  進行度 (0 = 変化なし, 1 = 全置換)
 * @param {(i:number)=>number} getPixel  VRAM インデックス i の置換後の値 (0|1)
 */
function ditherReveal(t, getPixel) {
  const threshold = t * 17;
  const w = Config.VRAM_WIDTH;
  const h = Config.VRAM_HEIGHT;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (BAYER_4x4[y & 3][x & 3] < threshold) {
        vram[i] = getPixel(i);
      }
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  メイン API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * スプラッシュスクリーン演出を実行する。
 *
 * フォント初期化 (`initFont`) 完了後に呼び出すこと。
 * 演出が完了するまでの Promise を返す。
 *
 * @returns {Promise<void>}
 */
export async function runSplash() {
  const alignedX = gridAlignedX(APP_LOGO_COLS);
  const lineH = GLYPH_H + 1; // 8px — 全要素をこのグリッドに揃える

  // ── レイアウト (すべて lineH 単位) ──
  //
  //  行 0…3  APP_ASCII_LOGO
  //  行 4     (空行)
  //  行 5     バージョン
  //  行 6     著作権
  //  行 7     区切り線
  //  行 8     (空行)
  //  行 9     ブートメッセージ
  //  行 10    (空行)
  //  行 11    プログレスバー
  //
  const APP_LOGO_ROWS = Config.APP_ASCII_LOGO.length;
  const TOTAL_ROWS = APP_LOGO_ROWS + 8; // 4 + 8 = 12 行
  const totalH = TOTAL_ROWS * lineH;
  const splashY = Math.max(0, Math.floor((Config.VRAM_HEIGHT - totalH) / 2));

  /** 行番号 (0-based) → Y 座標 */
  const rowY = (r) => splashY + r * lineH;

  // ── Phase 1: ブランク ──
  cls();
  await splashWait(BLANK_DURATION);

  // ── Phase 2: ロゴ + バージョン + 著作権 + 区切り線 ──
  cls();

  // ASCII アートロゴ (行 0‥APP_LOGO_ROWS-1)
  for (let i = 0; i < APP_LOGO_ROWS; i++) {
    drawText(alignedX, rowY(i), Config.APP_ASCII_LOGO[i], 1);
  }

  // バージョン (行 APP_LOGO_ROWS+1 = 空行1つ挟む)
  const verStr = centerPad("V" + Config.APP_VERSION, APP_LOGO_COLS);
  drawText(alignedX, rowY(APP_LOGO_ROWS + 1), verStr, 1);

  // 著作権
  const crStr = centerPad(
    "(C) " + Config.APP_DATE.slice(0, 4) + " " + Config.APP_AUTHOR,
    APP_LOGO_COLS,
  );
  drawText(alignedX, rowY(APP_LOGO_ROWS + 2), crStr, 1);

  // 区切り線
  const sep = "_".repeat(APP_LOGO_COLS);
  drawText(alignedX, rowY(APP_LOGO_ROWS + 3), sep, 1);

  await splashWait(SPLASH_HOLD);

  // ── Phase 3: ブートメッセージ + ASCII プログレスバー ──
  const msgRow = APP_LOGO_ROWS + 5; // 区切り線の2行下 (空行1つ挟む)
  const barRow = msgRow + 2; // メッセージの2行下 (空行1つ挟む)
  const msgY = rowY(msgRow);
  const barY = rowY(barRow);
  // バー文字数: "[" + fill + "] " + "100" + "%" = BAR + 7 → APP_LOGO_COLS と同幅
  const barChars = Math.max(1, APP_LOGO_COLS - 7);
  const clearH = barY + GLYPH_H - msgY + 2;

  for (let i = 0; i < BOOT_MESSAGES.length; i++) {
    // メッセージエリアをクリア
    fillRect(alignedX, msgY - 1, APP_LOGO_COLS * CHAR_PITCH, clearH, 0);

    // メッセージ (文字単位中央)
    const msg = centerPad(BOOT_MESSAGES[i], APP_LOGO_COLS);
    drawText(alignedX, msgY, msg, 1);

    // プログレスバー (ロゴと同幅)
    const progress = (i + 1) / BOOT_MESSAGES.length;
    const filled = Math.floor(barChars * progress);
    const empty = barChars - filled;
    const pct = Math.floor(progress * 100);
    const barStr =
      "[" +
      "#".repeat(filled) +
      ".".repeat(empty) +
      "] " +
      String(pct).padStart(3) +
      "%";
    drawText(alignedX, barY, barStr, 1);

    await splashWait(MSG_INTERVAL);
  }

  await splashWait(POST_MSG_WAIT);

  // ── Phase 4: ディザトランジション (フェードアウト) ──
  const splashSnapshot = new Uint8Array(vram);
  const stepMs = TRANSITION_DURATION / TRANSITION_STEPS;

  for (let step = 0; step <= TRANSITION_STEPS; step++) {
    vram.set(splashSnapshot);
    ditherReveal(step / TRANSITION_STEPS, () => 0);
    await splashWait(stepMs);
  }

  await splashWait(200);
}

/**
 * デスクトップ画面をディザトランジションでフェードインする。
 *
 * メインループ開始後の最初のフレームで呼び出す。
 * 呼び出し元が現在のデスクトップ VRAM のスナップショットを渡し、
 * 背景色 (cls) からディザで徐々に表示する。
 *
 * @param {Uint8Array} desktopVram  デスクトップ描画済みの VRAM スナップショット
 * @returns {Promise<void>}
 */
export async function fadeInDesktop(desktopVram) {
  const stepMs = TRANSITION_DURATION / TRANSITION_STEPS;
  const w = Config.VRAM_WIDTH;
  const h = Config.VRAM_HEIGHT;

  for (let step = 0; step <= TRANSITION_STEPS; step++) {
    cls();
    ditherReveal(step / TRANSITION_STEPS, (i) => desktopVram[i]);
    await splashWait(stepMs);
  }

  // 最終フレーム (完全なデスクトップ)
  vram.set(desktopVram);
  flush();
}

