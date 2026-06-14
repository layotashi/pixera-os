/**
 * @module ui/widgets/Label
 * Label.js — 静的テキストラベル
 *
 * 入力を受け付けない表示専用ウィジェット。
 * テキストに "\n" を含む場合は複数行で描画される。
 *
 * text プロパティはセッターでカプセル化されており、代入時に w/h が自動再計算される
 * (派生状態の不変条件を機械的に維持)。
 */

import { Widget } from "../Widget.js";
import { drawText, GLYPH_H } from "../ports.js";
import { textWidth, LABEL_LINE_HEIGHT } from "../ui_helpers.js";

export class Label extends Widget {
  /**
   * @param {number} x コンテンツ領域内の X
   * @param {number} y コンテンツ領域内の Y
   * @param {string} text 表示テキスト ("\n" で改行)
   * @param {number} [color=1] 描画色 (0 or 1)
   */
  constructor(x, y, text, color = 1) {
    super(x, y, 0, 0); // w/h は _recomputeSize で確定
    /** @private */
    this._text = text;
    this.color = color;
    this._recomputeSize();
  }

  get text() {
    return this._text;
  }

  set text(v) {
    this._text = v;
    this._recomputeSize();
  }

  /** @private text から w/h を再計算 */
  _recomputeSize() {
    const lines = this._text.split("\n");
    this.w =
      lines.length > 0
        ? Math.max(...lines.map((line) => textWidth(line)))
        : 0;
    this.h =
      lines.length === 1
        ? GLYPH_H
        : (lines.length - 1) * LABEL_LINE_HEIGHT + GLYPH_H;
  }

  /** @override — フォント切替時に外部から呼ばれる */
  remeasure() {
    this._recomputeSize();
  }

  /** @override */
  draw(contentRect) {
    const absX = contentRect.x + this.x;
    let absY = contentRect.y + this.y;
    const lines = this._text.split("\n");
    for (const line of lines) {
      if (line.length > 0) drawText(absX, absY, line, this.color);
      absY += LABEL_LINE_HEIGHT;
    }
  }
}
