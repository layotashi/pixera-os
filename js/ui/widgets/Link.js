/**
 * @module ui/widgets/Link
 * Link.js — ハイパーリンク (下線付きクリック可能テキスト)
 *
 * 通常時は点線下線、ホバー時は実線下線で状態を示す。1-bit では色が使えないため、
 * 状態は色ではなくパターン (点線 ↔ 実線) で区別する。
 * クリックで onClick を発火する (実際の遷移は呼び出し側の責務。ui 層は window を
 * 直接触らない)。
 *
 * 点線は文字列全幅に連続する 1 本で、「ローカル x が偶数」を点灯させる。
 * 文字セルが (GLYPH_W+1)=6px の偶数ピッチ、文字列幅 textWidth=6N-1 が奇数のため、
 * 両端が点灯し、文字境界と位相がずれない左右対称の点線になる (どの桁数でも成立)。
 *
 * VBox 等が交差軸で this.w を stretch するため、下線幅・当たり判定にはレイアウトで
 * 変わらない「テキスト幅」(_textW) を使い、リンクはテキスト分だけを占有する。
 */

import { Widget } from "../Widget.js";
import { drawText, hline, pset, GLYPH_W, GLYPH_H } from "../ports.js";

/** 文字下と下線の間の余白 (px) */
const UNDERLINE_GAP = 1;

export class Link extends Widget {
  /**
   * @param {number} x
   * @param {number} y
   * @param {string} text  表示テキスト
   * @param {function} [onClick]  クリック時コールバック (遷移は呼び出し側の責務)
   */
  constructor(x, y, text, onClick) {
    super(x, y, 0, 0);
    /** @private */
    this._text = text;
    this.onClick = onClick || null;
    /** @private ホバー中か (実線下線) */
    this._hover = false;
    /** @private プレス中か */
    this._pressed = false;
    /** @private レイアウト stretch に影響されないテキスト幅 */
    this._textW = 0;
    this._recomputeSize();
  }

  get text() {
    return this._text;
  }
  set text(v) {
    this._text = v;
    this._recomputeSize();
  }

  /** @private text から w/h とテキスト幅を再計算する (下線 + 余白を高さに含める) */
  _recomputeSize() {
    this._textW =
      this._text.length > 0 ? this._text.length * (GLYPH_W + 1) - 1 : 0;
    this.w = this._textW;
    this.h = GLYPH_H + UNDERLINE_GAP + 1; // 文字 + 余白 + 下線 1px
  }

  /** @override — フォント切替時に外部から呼ばれる */
  remeasure() {
    this._recomputeSize();
  }

  /** @override — ホバーでポインターカーソル */
  get cursorName() {
    return "pointer";
  }

  /** @override — 当たり判定はテキスト幅で行う (stretch された this.w は使わない) */
  hitTest(localX, localY) {
    return (
      localX >= this.x &&
      localX < this.x + this._textW &&
      localY >= this.y &&
      localY < this.y + this.h
    );
  }

  /** @override */
  draw(contentRect) {
    const absX = contentRect.x + this.x;
    const absY = contentRect.y + this.y;
    drawText(absX, absY, this._text, 1);
    const uy = absY + GLYPH_H + UNDERLINE_GAP;
    if (this._hover) {
      // ホバー: 実線下線
      hline(absX, absX + this._textW - 1, uy, 1);
    } else {
      // 通常: 点線下線 (ローカル x 偶数を点灯 = 両端点灯・左右対称)
      for (let dx = 0; dx < this._textW; dx += 2) {
        pset(absX + dx, uy, 1);
      }
    }
  }

  /** @override */
  update(ev) {
    const hit = this.hitTest(ev.localX, ev.localY);
    if (ev.type === "hover") {
      this._hover = hit;
    }
    if (ev.type === "down" && hit) {
      this._pressed = true;
    }
    if (ev.type === "up") {
      if (this._pressed && hit && this.onClick) this.onClick();
      this._pressed = false;
    }
  }

  /** @override */
  resetDragState() {
    this._pressed = false;
  }
}
