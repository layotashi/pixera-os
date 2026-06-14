/**
 * @module ui/widgets/ToggleButton
 * ToggleButton.js — ON/OFF トグルボタン
 *
 * クリックで value が反転する。onChange(newValue) で通知。
 */

import { ButtonBase } from "./ButtonBase.js";
import { buttonAutoWidth, BUTTON_AUTO_HEIGHT } from "../ui_helpers.js";
import { keyDown } from "../ports.js";

/** @type {(() => void)|null} グローバル SFX コールバック */
let _sfxOnChange = null;

/**
 * トグル状態変更時のグローバル SFX コールバックを設定する。
 * @param {(() => void)|null} fn
 */
export function toggleSetSfxOnChange(fn) {
  _sfxOnChange = fn;
}

export class ToggleButton extends ButtonBase {
  /**
   * @param {number} x コンテンツ領域内の X
   * @param {number} y コンテンツ領域内の Y
   * @param {string} label 表示テキスト
   * @param {function} [onChange] 状態変更コールバック (newValue) => void
   * @param {boolean} [initial=false] 初期値
   */
  constructor(x, y, label, onChange, initial = false) {
    super(x, y, 0, 0); // w/h は label セッター経由で確定
    this.label = label;
    this.value = initial;
    this.onChange = onChange || null;
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
      if (this.pressed && hit) {
        this.value = !this.value;
        if (_sfxOnChange) _sfxOnChange();
        if (this.onChange) this.onChange(this.value);
      }
      this.pressed = false;
    }
  }

  /** @override — Enter でトグル */
  handleKey() {
    if (keyDown("Enter")) {
      this.value = !this.value;
      if (_sfxOnChange) _sfxOnChange();
      if (this.onChange) this.onChange(this.value);
      return true;
    }
    return false;
  }
}

