/**
 * @module ui/widgets/PushButton
 * PushButton.js — 押しボタン
 *
 * 押して離すと onClick コールバックが発火する。
 * 状態 (value) を持たない。
 */

import { ButtonBase } from "./ButtonBase.js";
import { buttonAutoWidth, BUTTON_AUTO_HEIGHT } from "../ui_helpers.js";
import { keyDown, keyHeld } from "../ports.js";

/** @type {(() => void)|null} グローバル SFX コールバック */
let _sfxOnClick = null;

/**
 * ボタンクリック時のグローバル SFX コールバックを設定する。
 * @param {(() => void)|null} fn
 */
export function buttonSetSfxOnClick(fn) {
  _sfxOnClick = fn;
}

export class PushButton extends ButtonBase {
  /**
   * @param {number} x コンテンツ領域内の X
   * @param {number} y コンテンツ領域内の Y
   * @param {string} label 表示テキスト
   * @param {function} [onClick] クリック時コールバック
   */
  constructor(x, y, label, onClick) {
    super(x, y, 0, 0); // w/h は label セッター経由で確定
    this.label = label;
    this.onClick = onClick || null;
    /** @private Enter キー押下追跡 */
    this._keyActive = false;
  }

  /** @override — アイコンボタンはアプリ側で w/h を手動設定するためスキップ */
  _recomputeLabelSize() {
    if (this.icon) return;
    this.w = buttonAutoWidth(this._label);
    this.h = BUTTON_AUTO_HEIGHT;
  }

  /** @override */
  update(ev) {
    const hit = this.hitTest(ev.localX, ev.localY);
    if (ev.type === "down" && hit) {
      this.pressed = true;
    }
    if (ev.type === "up") {
      if (this.pressed && hit && this.onClick) {
        if (_sfxOnClick) _sfxOnClick();
        this.onClick();
      }
      this.pressed = false;
    }
  }

  /** @override — Enter キーで押下→離して発火 */
  handleKey() {
    if (keyDown("Enter")) {
      this.pressed = true;
      this._keyActive = true;
      return true;
    }
    if (this._keyActive) {
      if (keyHeld("Enter")) return true; // 押し込み継続
      // Enter リリース → 発火
      this.pressed = false;
      this._keyActive = false;
      if (this.onClick) {
        if (_sfxOnClick) _sfxOnClick();
        this.onClick();
      }
      return true;
    }
    return false;
  }

  /** @override */
  clearSelection() {
    this._keyActive = false;
    this.pressed = false;
  }
}

