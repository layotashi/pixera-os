/**
 * @module core/defaults
 * defaults.js — 現在の全設定スナップショットと書き出し
 *
 * SETTINGS / TUNING で調整した現在の設定 (Config + Wallpaper) を 1 つの
 * オブジェクトに収集し、「出荷時デフォルト」としてコード (config.js) に
 * 反映できる形へ書き出す。runtime はソースを書き換えられないため、EXPORT で
 * 現在値を吐き出し → config.js のデフォルトにベイクする運用。
 */

import * as Config from "../config.js";
import * as Wallpaper from "../wallpaper.js";

/**
 * 現在の全設定を 1 オブジェクトに収集する (読み取りのみ・副作用なし)。
 * @returns {object}
 */
export function snapshotConfig() {
  return {
    // ── TUNING (ディスプレイエフェクト) ──
    effect: Config.getEffectParams(),
    // ── SETTINGS (外観) ──
    palette: Config.getPaletteName(),
    customPalette: Config.getCustomPaletteRgb(),
    invert: Config.isInvert(),
    headerPad: Config.getHeaderPad(),
    contentPad: Config.getContentPad(),
    textTransform: Config.getTextTransform(),
    fontId: Config.getSystemFontId(),
    inputOverlay: Config.isInputOverlayEnabled(),
    systemSfx: Config.isSystemSfxOn(),
    resolution: { w: Config.VRAM_WIDTH, h: Config.VRAM_HEIGHT },
    wallpaper: {
      mode: Wallpaper.getBackgroundMode(),
      solidLevel: Wallpaper.getSolidLevel(),
      solidBayerMode: Wallpaper.getSolidBayerMode(),
      imageFillBit: Wallpaper.getImageFillBit(),
      imagePath: Wallpaper.getImagePath(),
    },
  };
}

/**
 * 現在の設定を「出荷時デフォルト」として貼り付けやすい整形 JSON で返す。
 * @returns {string}
 */
export function exportDefaultsText() {
  return JSON.stringify(snapshotConfig(), null, 2);
}

/**
 * 現在の設定をクリップボードへコピーする。失敗時 (権限なし等) は console へ。
 * @returns {Promise<boolean>} コピー成功なら true
 */
export async function copyDefaultsToClipboard() {
  const text = exportDefaultsText();
  // どの経路でも開発者が拾えるよう、まず console にも出す
  console.log("[SYNESTA] current config snapshot:\n" + text);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
