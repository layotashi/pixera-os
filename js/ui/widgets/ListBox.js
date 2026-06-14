/**
 * @module ui/widgets/ListBox
 * ListBox.js — スクロール付きリスト
 *
 * クリックで選択、ホイールでスクロール。
 * アイテム単位のツールチップにも対応 (onItemTooltip コールバック)。
 */

import { FocusableWidget } from "../FocusableWidget.js";
import * as Ports from "../ports.js";
import * as Helpers from "../ui_helpers.js";
import * as Scroll from "../scrollbar.js";

/** @private グローバル SFX コールバック (選択変更時) */
let _sfxOnSelect = null;

/**
 * ListBox 選択変更時の SFX コールバックを設定する。
 * @param {function} fn コールバック
 */
export function listboxSetSfxOnSelect(fn) {
  _sfxOnSelect = fn;
}

export class ListBox extends FocusableWidget {
  /**
   * @param {number} x  コンテンツ領域内の X
   * @param {number} y  コンテンツ領域内の Y
   * @param {number} visibleRows 表示行数
   * @param {string[]} items アイテム文字列配列
   * @param {number} selectedIndex 初期選択インデックス
   * @param {function} [onChange] 選択変更コールバック (newIndex) => void
   */
  constructor(x, y, visibleRows, items, selectedIndex, onChange) {
    super(x, y, 0, 0); // w/h は items セッター経由で確定
    this.visibleRows = visibleRows;
    /** @private */
    this._items = items;
    this.selectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex));
    /** @private */
    this._vScroll = Scroll.createScrollState(visibleRows, items.length);
    this.hoverIndex = -1;
    this.onChange = onChange || null;
    /** @type {((index: number) => string | null) | null} */
    this.onItemTooltip = null;
    this._recomputeSize();
  }

  get items() {
    return this._items;
  }

  set items(v) {
    this._items = v;
    this._recomputeSize();
    // スクロール状態のコンテンツ長も同期 (setContentLength の呼び忘れ防止)
    if (this._vScroll) Scroll.scrollSetContent(this._vScroll, v.length);
  }

  /** @private items / visibleRows から w/h を再計算 */
  _recomputeSize() {
    const maxItemWidth =
      this._items.length > 0
        ? Math.max(...this._items.map((s) => Helpers.textWidth(s)))
        : 0;
    this.w =
      maxItemWidth +
      Helpers.BUTTON_PADDING * 2 +
      Scroll.SCROLLBAR_SLOT_WIDTH +
      4;
    this.h = this.visibleRows * Helpers.LISTBOX_ITEM_HEIGHT + 4;
  }

  /** @override — フォント切替時に外部から呼ばれる */
  remeasure() {
    this._recomputeSize();
  }

  // ── パブリック スクロール操作 ──

  /**
   * コンテンツ長 (総アイテム数) を更新しスクロール範囲を再計算する。
   * 外部から items を差し替えた際に呼ぶ。
   * @param {number} length 新しいアイテム数
   */
  setContentLength(length) {
    Scroll.scrollSetContent(this._vScroll, length);
  }

  /**
   * スクロール位置を先頭にリセットする。
   */
  scrollToTop() {
    this._vScroll.offset = 0;
  }

  /**
   * 指定インデックスが表示領域に入るようスクロールする。
   * @param {number} index 可視化したいアイテムのインデックス
   */
  ensureVisible(index) {
    Scroll.scrollEnsureVisible(this._vScroll, index);
  }

  /** @override */
  resetDragState() {
    Scroll.scrollDragReset(this._vScroll);
  }

  /** @override */
  draw(contentRect) {
    const absX = contentRect.x + this.x;
    const absY = contentRect.y + this.y;

    Ports.drawRoundRect(absX, absY, this.w, this.h, 1, 1);

    const innerX = absX + 2;
    const innerY = absY + 2;
    const innerW = this.w - 4 - Scroll.SCROLLBAR_SLOT_WIDTH;
    const innerH = this.h - 4;
    Ports.pushClip(innerX, innerY, innerW, innerH);

    const startIdx = this._vScroll.offset;
    const endIdx = Math.min(this.items.length, startIdx + this.visibleRows);
    for (let i = startIdx; i < endIdx; i++) {
      const itemY = innerY + (i - startIdx) * Helpers.LISTBOX_ITEM_HEIGHT;
      if (i === this.selectedIndex || i === this.hoverIndex) {
        Ports.fillRect(innerX, itemY, innerW, Helpers.LISTBOX_ITEM_HEIGHT, 1);
        Ports.drawText(
          innerX + Helpers.BUTTON_PADDING,
          itemY + 4,
          this.items[i],
          0,
        );
      } else {
        Ports.drawText(
          innerX + Helpers.BUTTON_PADDING,
          itemY + 4,
          this.items[i],
          1,
        );
      }
    }
    Ports.popClip();

    const slotX = absX + this.w - 1 - Scroll.SCROLLBAR_SLOT_WIDTH;
    const slotY = absY + 1;
    const slotH = this.h - 2;
    Scroll.drawVScrollbarSlot(this._vScroll, slotX, slotY, slotH);
  }

  /** @override */
  update(ev) {
    const vScroll = this._vScroll;

    const itemX0 = this.x + 2;
    const itemW = this.w - 4 - Scroll.SCROLLBAR_SLOT_WIDTH;
    const itemY0 = this.y + 2;
    const itemH = this.h - 4;

    const scrollbar = Scroll.vScrollbarSlotThumbArea(
      this.x + this.w - 1 - Scroll.SCROLLBAR_SLOT_WIDTH,
      this.y + 1,
      this.h - 2,
    );

    const inItemArea =
      ev.localX >= itemX0 &&
      ev.localX < itemX0 + itemW &&
      ev.localY >= itemY0 &&
      ev.localY < itemY0 + itemH;

    const inScrollbar =
      ev.localX >= scrollbar.x &&
      ev.localX < scrollbar.x + scrollbar.w &&
      ev.localY >= scrollbar.y &&
      ev.localY < scrollbar.y + scrollbar.h;

    // ホバー追従
    if (ev.type === "hover" || ev.type === "held" || ev.type === "down") {
      if (inItemArea && !Scroll.scrollIsDragging(vScroll)) {
        const row = ((ev.localY - itemY0) / Helpers.LISTBOX_ITEM_HEIGHT) | 0;
        const idx = vScroll.offset + row;
        this.hoverIndex = idx >= 0 && idx < this.items.length ? idx : -1;
      } else {
        this.hoverIndex = -1;
      }
      // スクロールバー領域では drag-v カーソル
      if (inScrollbar || Scroll.scrollIsDragging(vScroll)) {
        Helpers.wmRequestCursor("drag-v");
      } else if (inItemArea) {
        Helpers.wmRequestCursor("pointer");
      }
      if (ev.type === "hover" && this.hoverIndex >= 0 && this.onItemTooltip) {
        const tip = this.onItemTooltip(this.hoverIndex);
        if (tip) Helpers.wmSetTooltip(tip);
      }
    }

    // クリック選択
    if (ev.type === "down" && inItemArea) {
      const row = ((ev.localY - itemY0) / Helpers.LISTBOX_ITEM_HEIGHT) | 0;
      const idx = vScroll.offset + row;
      if (idx >= 0 && idx < this.items.length && idx !== this.selectedIndex) {
        this.selectedIndex = idx;
        if (_sfxOnSelect) _sfxOnSelect();
        if (this.onChange) this.onChange(this.selectedIndex);
      }
    }

    // スクロールバー入力
    if (
      inScrollbar &&
      (ev.type === "down" || ev.type === "held" || ev.type === "up")
    ) {
      Scroll.handleVScrollInput(
        vScroll,
        ev.type,
        ev.localY,
        scrollbar.y,
        scrollbar.h,
      );
    }
    if (
      ev.type === "held" &&
      Scroll.scrollIsDragging(vScroll) &&
      !inScrollbar
    ) {
      Scroll.handleVScrollInput(
        vScroll,
        ev.type,
        ev.localY,
        scrollbar.y,
        scrollbar.h,
      );
    }
    if (ev.type === "up") {
      Scroll.scrollDragReset(vScroll);
    }

    // ホイール
    if (ev.type === "wheel" && (inItemArea || inScrollbar)) {
      Scroll.scrollBy(vScroll, ev.deltaY > 0 ? 1 : -1);
      ev.consumed = true;
    }
  }

  /** @override — ↑↓ で選択移動 (リピートあり、加速なし) */
  handleKey() {
    let dir = 0;
    if (Helpers.tickRepeat("ArrowUp", false)) dir = -1;
    else if (Helpers.tickRepeat("ArrowDown", false)) dir = +1;
    if (dir !== 0) {
      const idx = Math.max(
        0,
        Math.min(this.items.length - 1, this.selectedIndex + dir),
      );
      if (idx !== this.selectedIndex) {
        this.selectedIndex = idx;
        Scroll.scrollEnsureVisible(this._vScroll, idx);
        if (_sfxOnSelect) _sfxOnSelect();
        if (this.onChange) this.onChange(this.selectedIndex);
      }
      return true;
    }
    return false;
  }
}

