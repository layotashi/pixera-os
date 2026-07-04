/**
 * @module wm/tooltip
 * tooltip.js — ホバーツールチップ (遅延表示 + カーソル追従)
 *
 * hover ハンドラが毎フレーム wmSetTooltip(text) を呼び、呼ばれなくなったら
 * 自動的に消える。同じテキストが TOOLTIP_DELAY フレーム連続したら
 * カーソル付近にボックス表示する。
 *
 * フレームループとの連携:
 *   - wmUpdate 冒頭で tooltipBeginFrame() を呼び、前フレームのテキストを
 *     退避して今フレームのテキストをクリアする。
 *   - wmDraw 末尾で drawTooltip(modalOpen) を呼ぶ。
 */

import * as Config from "../config.js";
import * as GPU from "../core/gpu.js";
import * as Input from "../core/input.js";
import { drawText, GLYPH_W, GLYPH_H } from "../core/font.js";
import { wrapText } from "./text_wrap.js";

/** ツールチップテキスト (null = 非表示, '\n' で複数行) */
let tooltipText = null;

/** ツールチップ表示ディレイ (同じテキストがセットされ続けたフレーム数) */
let tooltipFrames = 0;
let tooltipPrevText = null;

/** ツールチップ表示までのディレイフレーム数 */
const TOOLTIP_DELAY = 20;

/** ツールチップのパディング (px) */
const TOOLTIP_PADDING = 4;

/** ツールチップのカーソルからのオフセット (px) */
const TOOLTIP_OFFSET_X = 12;
const TOOLTIP_OFFSET_Y = 12;

/** ツールチップ 1 行の最大文字数 (これを超える行は折り返す) */
const TOOLTIP_MAX_CHARS = 38;

/**
 * ツールチップテキストをセットする。
 * hover ハンドラ内で毎フレーム呼ぶ。呼ばなければ自動消去。
 * '\n' で改行可能。
 * @param {string} text  ツールチップテキスト
 */
export function wmSetTooltip(text) {
  tooltipText = text;
}

/**
 * フレーム開始時に呼ぶ: 前フレームのテキストを退避して今フレームをクリアする。
 * hover ハンドラがこの後 wmSetTooltip() を呼ばなければテキストは消える。
 */
export function tooltipBeginFrame() {
  tooltipPrevText = tooltipText;
  tooltipText = null;
}

/**
 * ツールチップを描画する。ディレイ後にカーソル付近にボックスを表示。
 * @param {boolean} modalOpen  モーダル表示中は抑制する
 */
export function drawTooltip(modalOpen) {
  // ディレイカウンタ更新
  if (tooltipText !== null && tooltipText === tooltipPrevText) {
    tooltipFrames++;
  } else {
    tooltipFrames = 0;
  }
  if (tooltipText === null || tooltipFrames < TOOLTIP_DELAY) return;
  if (modalOpen) return;

  const mx = Input.mouseX();
  const my = Input.mouseY();
  // 1 行の最大文字数: TOOLTIP_MAX_CHARS を上限に、狭い VRAM ではさらに詰める
  const vramCap = Math.floor(
    (Config.VRAM_WIDTH - TOOLTIP_PADDING * 2 - 8) / (GLYPH_W + 1),
  );
  const max = Math.max(8, Math.min(TOOLTIP_MAX_CHARS, vramCap));
  const lines = wrapText(tooltipText, max);
  const maxChars = Math.max(...lines.map((l) => l.length));
  const tw = maxChars * (GLYPH_W + 1) - 1;
  const lineH = GLYPH_H + 2;
  const th = lines.length * lineH - 2;
  const boxW = tw + TOOLTIP_PADDING * 2;
  const boxH = th + TOOLTIP_PADDING * 2;

  // 位置: カーソル右下、画面外にはみ出さないよう補正
  let tx = mx + TOOLTIP_OFFSET_X;
  let ty = my + TOOLTIP_OFFSET_Y;
  if (tx + boxW >= Config.VRAM_WIDTH) tx = mx - boxW - 4;
  if (ty + boxH >= Config.VRAM_HEIGHT) ty = my - boxH - 4;
  tx = Math.max(0, tx);
  ty = Math.max(0, ty);

  // 描画 (GPU.fillRoundRect で四隅を透過)
  GPU.fillRoundRect(tx, ty, boxW, boxH, 1, 0);
  GPU.drawRoundRect(tx, ty, boxW, boxH, 1, 1);
  for (let i = 0; i < lines.length; i++) {
    drawText(tx + TOOLTIP_PADDING, ty + TOOLTIP_PADDING + i * lineH, lines[i], 1);
  }
}
