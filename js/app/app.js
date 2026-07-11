/**
 * @module app/app
 * app.js — アプリケーション層 (ハブ)
 *
 * 各ウィンドウモジュールを副作用インポートで登録し、
 * kernel.js から毎フレーム呼ばれる update() / draw() を export する。
 */

import { DEV_MODE } from "../config.js";
import { flush } from "../core/gpu.js";
import { mouseX, mouseY, isMouseInside } from "../core/input.js";
import { drawCursor } from "../core/cursor.js";
import { wmDraw, wmGetRegistry, desktopSetIcons } from "../wm/index.js";
import { drawWallpaper } from "../wallpaper.js";
import * as Capture from "./capture.js";
import { updateInputOverlay, drawInputOverlay } from "./input_overlay.js";
import { drawVramDumpOverlay } from "./vram_dump.js";

// ── 各ウィンドウモジュール (副作用: wmRegister を実行) ──
import "./settings.js"; // TUNING を統合 (DISPLAY/EFFECTS/THEME/SYSTEM タブ)
import "./notepad.js";
// capture.js は上で named import 済み
// SYNESTA (旧 DAW) はアーカイブ済み。app/synesta/ と audio/ は参照用に残すが読み込まない。
import "./synth/synth.js"; // SYNTH — ポリフォニック・ソフトシンセ (音楽機能の再設計・第1弾)
import "./roll/roll.js"; // ROLL — ステップグリッド MIDI フレーズエディタ (音楽機能の再設計・第2弾)
// WELCOME / ABOUT はランチャ最下部の system セクションに並ぶ。
// import 順が並び順を決めるため、WELCOME を先に読み込む (メニュー: WELCOME → ABOUT)。
import "./welcome.js";
import "./about.js";
import "./life.js";
import "./files.js";
import "./paint.js";
import "./bricker.js";
import "./dungeon.js";
import "./tessera.js";
import "./telex.js";
import { updateDesktopFish, drawDesktopFish } from "./aquaria.js";
import "./oscillo.js";
import "./oracle.js";
import "./glypher.js";
import { DOLPHIN_TOOLTIP } from "./dolphin.js";

// ── デスクトップアイコン初期化 ──
// 全ウィンドウモジュールが wmRegister を実行した後にレジストリを読む。
// モーダルウィンドウはデスクトップアイコンに表示しない。
// label は shortName が定義されていればそれを使用し、なければ name をそのまま渡す
//   (desktop.js 側で 7 文字幅に収める。8 文字以上は末尾を省略マーク … に置換)。
// icon フィールドは name を小文字化して設定する。
// 対応する PNG が無い場合は app_icon.js が "default" にフォールバックする。

const desktopIconEntries = wmGetRegistry()
  .filter((e) => !e.modal)
  .filter((e) => !e.noIcon)
  .filter((e) => !e.dev || DEV_MODE)
  .map((e) => ({
    name: e.name,
    label: e.shortName || e.name,
    icon: e.name.toLowerCase(),
    tooltip: e.name,
  }));

// ── イースターエッグ: "Totally not a virus" イルカアイコン ──
desktopIconEntries.push({
  name: "DOLPHIN",
  label: "DOLPHIN",
  icon: "dolphin",
  tooltip: DOLPHIN_TOOLTIP,
});

// ── 表示確認用スタブ: 8 文字以上のファイル名の省略表示 (AMETHY…) を確認する ──
// アプリ実体は持たない (ダブルクリックで起動するアプリは無い)。ユーザーが将来
// デスクトップに作成しうる長名ファイルの見た目を検証するためのダミー。
// icon は既定アイコンを流用 (専用 PNG は不要)。
desktopIconEntries.push({
  name: "AMETHYST",
  label: "AMETHYST",
  icon: "default",
  tooltip: "AMETHYST",
});

desktopSetIcons(desktopIconEntries);

/**
 * デスクトップアイコンが必要とするアイコン名 (重複排除)。
 * kernel.js が initAppIcon へ渡し、規約ベース (<name>.png) で読み込む。
 * @type {string[]}
 */
export const appIconNames = [
  ...new Set(desktopIconEntries.map((e) => e.icon)),
];

/**
 * 毎フレーム呼ばれるロジック更新。
 */
export function update() {
  // ── 入力オーバーレイ更新 ──
  updateInputOverlay();

  // ── AQUARIA デスクトップモードの魚を更新 (ウィンドウ有無と独立に常駐) ──
  updateDesktopFish();

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

  // ── AQUARIA デスクトップモードの魚 (最前面) ──
  // wmDraw() の後に描くことで、アイコン・ウィンドウ・コンテキストメニューを
  // 含むすべての UI の上、かつカーソルの下に魚を表示する。
  drawDesktopFish();

  // ── カーソル: マウスが canvas 領域内のときだけ表示 ──
  if (isMouseInside()) drawCursor(mouseX(), mouseY());

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
