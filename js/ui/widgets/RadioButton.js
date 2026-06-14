/**
 * @module ui/widgets/RadioButton
 * RadioButton.js — ラジオボタン
 *
 * グループ内で 1 つだけ ON になる。排他制御は WidgetGroup が行う。
 */

import { ButtonBase } from "./ButtonBase.js";
import { buttonAutoWidth, BUTTON_AUTO_HEIGHT } from "../ui_helpers.js";

/** @private グローバル SFX コールバック (状態変更時) */
let _sfxOnChange = null;

/**
 * RadioButton 状態変更時の SFX コールバックを設定する。
 * @param {function} fn コールバック
 */
export function radioSetSfxOnChange(fn) {
  _sfxOnChange = fn;
}

export class RadioButton extends ButtonBase {
  /**
   * @param {number} x コンテンツ領域内の X
   * @param {number} y コンテンツ領域内の Y
   * @param {string} label 表示テキスト
   * @param {string} group グループ名
   * @param {function} [onChange] 状態変更コールバック (true) => void
   * @param {boolean} [initial=false] 初期値
   */
  constructor(x, y, label, group, onChange, initial = false) {
    super(x, y, 0, 0); // w/h は label セッター経由で確定
    this.label = label;
    /** @type {string} ラジオグループ名 */
    this.group = group;
    this.value = initial;
    this.onChange = onChange || null;
  }

  /** @override */
  _recomputeLabelSize() {
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
      if (this.pressed && hit && !this.value) {
        this.value = true;
        if (_sfxOnChange) _sfxOnChange();
        if (this.onChange) this.onChange(true);
      }
      this.pressed = false;
    }
  }
}

