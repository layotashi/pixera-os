/**
 * @module ui/widgets/DropDown
 * DropDown.js — ドロップダウン選択
 *
 * クリックまたはドラッグで選択肢リストを展開。
 * ポップアップは WidgetGroup.draw() → flushPopups() 経由でウィンドウ外に描画される。
 */

import { FocusableWidget } from "../FocusableWidget.js";
import * as Ports from "../ports.js";
import * as Helpers from "../ui_helpers.js";

/** @private グローバル SFX コールバック (選択確定時) */
let _sfxOnSelect = null;

/**
 * DropDown 選択確定時の SFX コールバックを設定する。
 * @param {function} fn コールバック
 */
export function dropdownSetSfxOnSelect(fn) {
  _sfxOnSelect = fn;
}

/** セパレーター高さ (上余白 + 線 + 下余白) */
const DROPDOWN_SEPARATOR_HEIGHT = 3;

export class DropDown extends FocusableWidget {
  /**
   * @param {number} x  コンテンツ領域内の X
   * @param {number} y  コンテンツ領域内の Y
   * @param {string[]} items 選択肢テキスト配列
   * @param {number} selectedIndex 初期選択インデックス
   * @param {function} [onChange] 選択変更コールバック (newIndex) => void
   * @param {object}   [opts]
   * @param {number[]} [opts.separators] セパレーター挿入位置の配列
   */
  constructor(x, y, items, selectedIndex, onChange, opts) {
    super(x, y, 0, 0); // w/h は items セッター経由で確定
    /** @private */
    this._items = items;
    this.selectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex));
    /** @type {boolean} ポップアップ展開中か */
    this.open = false;
    /** @private 今フレームで開いたか */
    this.justOpened = false;
    /** @private マウスで開いたか */
    this._mouseOpen = false;
    this.hoverIndex = -1;
    this.onChange = onChange || null;
    /** @type {number[]|null} セパレーター位置 */
    this.separators = (opts && opts.separators) || null;
    this._recomputeSize();
  }

  get items() {
    return this._items;
  }

  set items(v) {
    this._items = v;
    this._recomputeSize();
  }

  /** @private items から w/h を再計算 */
  _recomputeSize() {
    const maxItemWidth =
      this._items.length > 0
        ? Math.max(...this._items.map((s) => Helpers.textWidth(s)))
        : 0;
    this.w =
      maxItemWidth +
      Helpers.DROPDOWN_CHECK_WIDTH +
      Helpers.BUTTON_PADDING * 2 +
      Ports.ICON_W +
      8;
    this.h = Helpers.BUTTON_AUTO_HEIGHT;
  }

  /** @override — フォント切替時に外部から呼ばれる */
  remeasure() {
    this._recomputeSize();
  }

  /** @override — ポップアップを持つ */
  get hasPopup() {
    return true;
  }

  // ── セパレーターヘルパー (private) ──

  /** セパレーターの合計高さを返す */
  _separatorTotalHeight() {
    return this.separators
      ? this.separators.length * DROPDOWN_SEPARATOR_HEIGHT
      : 0;
  }

  /** アイテム i のポップアップ内 Y オフセット (パディング 2px 含まず) */
  _calcItemOffsetY(i) {
    let y = i * Helpers.DROPDOWN_ITEM_HEIGHT;
    if (this.separators) {
      for (const sepPos of this.separators) {
        if (sepPos <= i) y += DROPDOWN_SEPARATOR_HEIGHT;
      }
    }
    return y;
  }

  /** ポップアップ内のローカル Y からアイテムインデックスを返す (-1 = セパレーター上) */
  _itemIndexFromLocalY(localY) {
    let y = 0;
    for (let i = 0; i < this.items.length; i++) {
      if (this.separators && this.separators.includes(i))
        y += DROPDOWN_SEPARATOR_HEIGHT;
      if (localY < y + Helpers.DROPDOWN_ITEM_HEIGHT)
        return localY >= y ? i : -1;
      y += Helpers.DROPDOWN_ITEM_HEIGHT;
    }
    return -1;
  }

  // ── 描画 ──

  /** @override — 閉じた状態 (ヘッダ部) を描画 */
  draw(contentRect) {
    const absX = contentRect.x + this.x;
    const absY = contentRect.y + this.y;

    Ports.drawRoundRect(absX, absY, this.w, this.h, 1, 1);

    const text = this.items[this.selectedIndex] || "";
    Ports.drawText(
      absX + 2 + Helpers.BUTTON_PADDING,
      absY + 2 + Helpers.BUTTON_PADDING,
      text,
      1,
    );

    // ▼ アイコン
    const arrowX = absX + this.w - 2 - Helpers.BUTTON_PADDING - Ports.ICON_W;
    const arrowY = absY + ((this.h - Ports.ICON_H) >> 1);
    Ports.drawIcon("arrows-v", arrowX, arrowY, 1);
  }

  /**
   * ポップアップを絶対座標で描画する。
   * flushPopups() から呼ばれる。
   * @param {number} ax 絶対 X
   * @param {number} ay 絶対 Y
   */
  drawPopupAbsolute(absX, absY) {
    if (!this.open) return;
    const popupH =
      this.items.length * Helpers.DROPDOWN_ITEM_HEIGHT +
      this._separatorTotalHeight() +
      4;

    Ports.fillRect(absX, absY, this.w, popupH, 0);
    Ports.drawRoundRect(absX, absY, this.w, popupH, 1, 1);

    for (let i = 0; i < this.items.length; i++) {
      const itemY = absY + 2 + this._calcItemOffsetY(i);

      // セパレーター描画
      if (this.separators && this.separators.includes(i)) {
        const sepY =
          itemY - DROPDOWN_SEPARATOR_HEIGHT + (DROPDOWN_SEPARATOR_HEIGHT >> 1);
        Ports.hline(absX + 2, absX + this.w - 3, sepY, 1);
      }

      const textX =
        absX + 2 + Helpers.BUTTON_PADDING + Helpers.DROPDOWN_CHECK_WIDTH;
      const iconY =
        itemY + ((Helpers.DROPDOWN_ITEM_HEIGHT - Ports.ICON_H) >> 1);
      if (i === this.hoverIndex) {
        Ports.fillRect(
          absX + 2,
          itemY,
          this.w - 4,
          Helpers.DROPDOWN_ITEM_HEIGHT,
          1,
        );
        if (i === this.selectedIndex)
          Ports.drawIcon("check", absX + 2 + Helpers.BUTTON_PADDING, iconY, 0);
        Ports.drawText(textX, itemY + 4, this.items[i], 0);
      } else {
        if (i === this.selectedIndex)
          Ports.drawIcon("check", absX + 2 + Helpers.BUTTON_PADDING, iconY, 1);
        Ports.drawText(textX, itemY + 4, this.items[i], 1);
      }
    }
  }

  // ── 入力処理 ──

  /** @override */
  update(ev) {
    const hit = this.hitTest(ev.localX, ev.localY);

    // ── 閉じた状態 ──
    if (!this.open) {
      if (
        (ev.type === "hover" || ev.type === "down" || ev.type === "held") &&
        hit
      ) {
        Helpers.wmRequestCursor("pointer");
      }
      if (ev.type === "down" && hit) {
        this.open = true;
        this.justOpened = true;
        this._mouseOpen = true;
        this.hoverIndex = -1;
      }
      if (ev.type === "wheel" && hit) {
        const dir = ev.deltaY > 0 ? 1 : -1;
        const idx = Math.max(
          0,
          Math.min(this.items.length - 1, this.selectedIndex + dir),
        );
        if (idx !== this.selectedIndex) {
          this.selectedIndex = idx;
          if (_sfxOnSelect) _sfxOnSelect();
          if (this.onChange) this.onChange(this.selectedIndex);
        }
        ev.consumed = true;
      }
      return;
    }

    // ── 展開中 ──
    const popupY = this.y + this.h + 1;
    const popupH =
      this.items.length * Helpers.DROPDOWN_ITEM_HEIGHT +
      this._separatorTotalHeight() +
      4;
    const inPopup =
      ev.localX >= this.x &&
      ev.localX < this.x + this.w &&
      ev.localY >= popupY + 2 &&
      ev.localY < popupY + popupH - 2;

    // キーボード操作 (展開中)
    if (this.justOpened && !this._mouseOpen && !Ports.keyHeld("Enter")) {
      this.justOpened = false;
    }
    if (Ports.keyDown("ArrowUp")) {
      if (this.hoverIndex < 0) this.hoverIndex = this.selectedIndex;
      this.hoverIndex = Math.max(0, this.hoverIndex - 1);
    }
    if (Ports.keyDown("ArrowDown")) {
      if (this.hoverIndex < 0) this.hoverIndex = this.selectedIndex;
      this.hoverIndex = Math.min(this.items.length - 1, this.hoverIndex + 1);
    }
    if (!this.justOpened && Ports.keyDown("Enter")) {
      if (this.hoverIndex >= 0) {
        this.selectedIndex = this.hoverIndex;
        if (_sfxOnSelect) _sfxOnSelect();
        if (this.onChange) this.onChange(this.selectedIndex);
      }
      this.open = false;
      this.hoverIndex = -1;
      return;
    }
    if (Ports.keyDown("Escape")) {
      this.open = false;
      this.hoverIndex = -1;
      return;
    }

    // ── マウス操作 (展開中) ──
    if (ev.type === "wheel") {
      const dir = ev.deltaY > 0 ? 1 : -1;
      const idx = Math.max(
        0,
        Math.min(this.items.length - 1, this.selectedIndex + dir),
      );
      if (idx !== this.selectedIndex) {
        this.selectedIndex = idx;
        this.hoverIndex = idx;
        if (_sfxOnSelect) _sfxOnSelect();
        if (this.onChange) this.onChange(this.selectedIndex);
      }
      ev.consumed = true;
      return;
    }

    // ホバー追従
    if (ev.type === "hover" || ev.type === "down" || ev.type === "held") {
      if (inPopup) {
        const localY = ev.localY - popupY - 2;
        const idx = this._itemIndexFromLocalY(localY);
        if (idx >= 0) this.hoverIndex = idx;
        Helpers.wmRequestCursor("pointer");
      }
    }

    // マウスリリースで選択確定 or 閉じる
    if (ev.type === "up") {
      if (this.justOpened) {
        this.justOpened = false;
        return;
      }
      if (inPopup && this.hoverIndex >= 0) {
        this.selectedIndex = this.hoverIndex;
        if (_sfxOnSelect) _sfxOnSelect();
        if (this.onChange) this.onChange(this.selectedIndex);
      }
      this.open = false;
      this.hoverIndex = -1;
    }
  }

  /** @override — ↑↓ で選択切替 (closed), Enter で展開 */
  handleKey() {
    if (this.open) return false; // 展開中は update() 内で処理
    if (Ports.keyDown("Enter")) {
      this.open = true;
      this.justOpened = true;
      this._mouseOpen = false;
      this.hoverIndex = this.selectedIndex;
      return true;
    }
    let dir = 0;
    if (Ports.keyDown("ArrowUp")) dir = -1;
    if (Ports.keyDown("ArrowDown")) dir = +1;
    if (dir !== 0) {
      const idx = Math.max(
        0,
        Math.min(this.items.length - 1, this.selectedIndex + dir),
      );
      if (idx !== this.selectedIndex) {
        this.selectedIndex = idx;
        if (_sfxOnSelect) _sfxOnSelect();
        if (this.onChange) this.onChange(this.selectedIndex);
      }
      return true;
    }
    return false;
  }
}

