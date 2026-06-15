/**
 * @module app/app
 * app.js — アプリケーション層 (ハブ)
 *
 * 各ウィンドウモジュールを副作用インポートで登録し、
 * kernel.js から毎フレーム呼ばれる update() / draw() を export する。
 */

import { VRAM_WIDTH, VRAM_HEIGHT, DEV_MODE } from "../config.js";
import { flush } from "../core/gpu.js";
import { keyHeld, mouseX, mouseY, isMouseInside } from "../core/input.js";
import { drawCursor } from "../core/cursor.js";
import { wmDraw, wmGetRegistry, desktopSetIcons } from "../wm/index.js";
import { drawWallpaper } from "../wallpaper.js";
import * as Capture from "./capture.js";
import { updateInputOverlay, drawInputOverlay } from "./input_overlay.js";
import { drawVramDumpOverlay } from "./vram_dump.js";
import { updateTransport } from "../audio/transport.js";

// ── 各ウィンドウモジュール (副作用: wmRegister を実行) ──
import "./settings.js";
import "./display_tuning.js";
import "./notepad.js";
// capture.js は上で named import 済み
import "./studio/studio.js";
// studio/synth_panel.js, studio/piano_roll.js は studio.js 経由で読み込まれる
import "./about.js";
import "./lifegame.js";
import "./explorer.js";
import "./paint.js";
import "./gradient_demo.js";
import "./easing_demo.js";
import "./ascii_art_demo.js";
import "./breakout.js";
import "./graze.js";
import "./genart.js";
import "./telex.js";
import "./aquarium.js";
import "./observatory.js";
import "./band.js";
import "./oracle.js";
import { DOLPHIN_TOOLTIP } from "./dolphin.js";

// ── デスクトップアイコン初期化 ──
// 全ウィンドウモジュールが wmRegister を実行した後にレジストリを読む。
// モーダルウィンドウはデスクトップアイコンに表示しない。
// label は shortName が定義されていればそれを使用し、なければ name をそのまま渡す
//   (desktop.js 側で MAX_LABEL_CHARS=7 に切り捨てる)。
// icon フィールドは name を小文字化して設定する。
// 対応する PNG が無い場合は app_icon.js が "default" にフォールバックする。

{
  const entries = wmGetRegistry()
    .filter((e) => !e.modal)
    .filter((e) => !e.dev || DEV_MODE)
    .map((e) => ({
      name: e.name,
      label: e.shortName || e.name,
      icon: e.name.toLowerCase(),
      tooltip: e.name,
    }));

  // ── イースターエッグ: "Totally not a virus" イルカアイコン ──
  entries.push({
    name: "DOLPHIN",
    label: "DOLPHIN",
    icon: "dolphin",
    tooltip: DOLPHIN_TOOLTIP,
  });

  desktopSetIcons(entries);
}

// ── サンプル用の状態 ──
let cursorX = (VRAM_WIDTH / 2) | 0;
let cursorY = (VRAM_HEIGHT / 2) | 0;

/**
 * 毎フレーム呼ばれるロジック更新。
 */
export function update() {
  // ── 再生エンジン更新 (Space キーなど、マウス位置に依存しない処理) ──
  updateTransport();

  if (keyHeld("ArrowUp")) cursorY--;
  if (keyHeld("ArrowDown")) cursorY++;
  if (keyHeld("ArrowLeft")) cursorX--;
  if (keyHeld("ArrowRight")) cursorX++;
  cursorX = ((cursorX % VRAM_WIDTH) + VRAM_WIDTH) % VRAM_WIDTH;
  cursorY = ((cursorY % VRAM_HEIGHT) + VRAM_HEIGHT) % VRAM_HEIGHT;

  // ── 入力オーバーレイ更新 ──
  updateInputOverlay();

  // ── スクリーンショット タイマー更新 ──
  Capture.updateScreenshotTimer();

  // ── 録画タイマー更新 ──
  Capture.updateRecordingTimer();

  // ── GIF ループ タイマー更新 ──
  Capture.updateGifTimer();
}

/**
 * 毎フレーム呼ばれる描画処理。
 */
export function draw() {
  drawWallpaper();

  // ── ウィンドウ描画 ──
  wmDraw();

  // ── カーソル: マウスが領域内ならマウス座標、そうでなければキーボード座標 ──
  const cx = isMouseInside() ? mouseX() : cursorX;
  const cy = isMouseInside() ? mouseY() : cursorY;
  drawCursor(cx, cy);

  // ── 入力オーバーレイ (カーソルの上に表示) ──
  drawInputOverlay();

  // ── タイマーカウントダウン オーバーレイ ──
  Capture.drawScreenshotOverlay();
  Capture.drawRecordingOverlay();
  Capture.drawGifOverlay();

  // ── VRAM ダンプ オーバーレイ (開発用) ──
  if (DEV_MODE) drawVramDumpOverlay();

  flush();

  // ── 録画フレームコピー (flush 後、スクショ前) ──
  Capture.commitRecording();

  // ── GIF フレームキャプチャ (flush 後) ──
  Capture.commitGifRecording();

  // ── スクリーンショット(flush後に実行) ──
  Capture.executePendingScreenshot();
}
