/**
 * @module ui/widgets/ButtonBase
 * ButtonBase.js — ボタン系ウィジェットの基底クラス
 *
 * PushButton / ToggleButton / RadioButton の共通描画ロジックを提供する。
 * value=true または pressed=true のとき反転表示 (塗りつぶし+反転色)。
 * icon プロパティが設定されている場合はアイコンモードで描画される。
 *
 * label プロパティはセッターでカプセル化されており、代入時にサブクラスの
 * _recomputeLabelSize() が自動で呼ばれて w/h が再計算される
 * (派生状態の不変条件を機械的に維持)。
 */

import { FocusableWidget } from "../FocusableWidget.js";
import * as Ports from "../ports.js";
import { BUTTON_PADDING } from "../ui_helpers.js";

export class ButtonBase extends FocusableWidget {
  /**
   * @param {number} x コンテンツ領域内の X
   * @param {number} y コンテンツ領域内の Y
   * @param {number} w 幅 (px)
   * @param {number} h 高さ (px)
   */
  constructor(x, y, w, h) {
    super(x, y, w, h);
    /** @private 表示テキスト */
    this._label = "";
    /** @type {boolean} 状態値 (Toggle/Radio で ON/OFF) */
    this.value = false;
    /** @type {boolean} マウスプレス中か */
    this.pressed = false;
    /** @type {string|null} アイコン名 (null でテキストモード) */
    this.icon = null;
  }

  get label() {
    return this._label;
  }

  set label(v) {
    this._label = v;
    this._recomputeLabelSize();
  }

  /**
   * @protected サブクラスが label から w/h を再計算するロジックを実装する。
   * デフォルトは何もしない (基底クラス単独では w/h を扱わない)。
   */
  _recomputeLabelSize() {}

  /** @override — フォント切替時に外部から呼ばれる */
  remeasure() {
    this._recomputeLabelSize();
  }

  /** @override — 操作中 (プレスされている) */
  get isActive() {
    return this.pressed;
  }

  /** @override — ボタン共通描画 */
  draw(contentRect) {
    const absX = contentRect.x + this.x;
    const absY = contentRect.y + this.y;
    const active = this.value || this.pressed;

    // 外側: 1px 角丸ボーダー
    Ports.drawRoundRect(absX, absY, this.w, this.h, 1, 1);

    // 反転領域
    const fillX = absX + 2;
    const fillY = absY + 2;
    const fillW = this.w - 4;
    const fillH = this.h - 4;

    if (this.icon) {
      // アイコンモード
      const iconX = fillX + Math.floor((fillW - Ports.ICON_W) / 2);
      const iconY = fillY + Math.floor((fillH - Ports.ICON_H) / 2);
      if (active) {
        Ports.fillRect(fillX, fillY, fillW, fillH, 1);
        Ports.drawIcon(this.icon, iconX, iconY, 0);
      } else {
        Ports.drawIcon(this.icon, iconX, iconY, 1);
      }
    } else {
      // テキストモード
      const textX = fillX + BUTTON_PADDING;
      const textY = fillY + BUTTON_PADDING;
      if (active) {
        Ports.fillRect(fillX, fillY, fillW, fillH, 1);
        Ports.drawText(textX, textY, this._label, 0);
      } else {
        Ports.drawText(textX, textY, this._label, 1);
      }
    }
  }
}
