/**
 * @module ui/widgets/TreeView
 * TreeView.js — スクロール付きツリービュー
 *
 * フォルダ展開 / 折りたたみ付きのスクロール可能なツリー表示。
 * items は flattenTree() 等で事前にフラットリスト化したもの。
 * ドラッグ&ドロップにも対応 (onDrop コールバック設定時)。
 */

import { FocusableWidget } from "../FocusableWidget.js";
import * as Ports from "../ports.js";
import * as Helpers from "../ui_helpers.js";
import * as Scroll from "../scrollbar.js";

/** 展開/折りたたみインジケータ */
const TREEVIEW_ICON_EXPANDED = "-";
const TREEVIEW_ICON_COLLAPSED = "+";
const TREEVIEW_ICON_LEAF = " ";
/** ドラッグ判定のデッドゾーン (px) */
const TREEVIEW_DRAG_DEADZONE = 3;

export class TreeView extends FocusableWidget {
  /**
   * @param {number} x  コンテンツ領域内の X
   * @param {number} y  コンテンツ領域内の Y
   * @param {number} w  幅 (px)
   * @param {number} visibleRows 表示行数
   * @param {Array}  items フラットリスト [{label, depth, expanded, hasChildren, data}, ...]
   * @param {function} [onSelect]   選択変更コールバック (index, item) => void
   * @param {function} [onActivate] ダブルクリック/Enter コールバック (index, item) => void
   * @param {function} [onToggle]   展開/折りたたみコールバック (index, item) => void
   */
  constructor(x, y, w, visibleRows, items, onSelect, onActivate, onToggle) {
    const h = visibleRows * Helpers.TREEVIEW_ITEM_HEIGHT + 4;
    super(x, y, w, h);
    /** @private */
    this._items = items;
    this.visibleRows = visibleRows;
    this.selectedIndex = 0;
    /** @private */
    this._vScroll = Scroll.createScrollState(visibleRows, items.length);
    this.hoverIndex = -1;
    this.onSelect = onSelect || null;
    this.onActivate = onActivate || null;
    this.onToggle = onToggle || null;
    /** @type {((index: number) => string | null) | null} */
    this.onItemTooltip = null;
    /** @type {((srcIndex: number, destIndex: number) => void) | null} */
    this.onDrop = null;
    // D&D 内部状態
    /** @private */ this._dragSrcIndex = -1;
    /** @private */ this._dragActive = false;
    /** @private */ this._dragStartX = 0;
    /** @private */ this._dragStartY = 0;
    /** @private */ this._dropTargetIndex = -1;
  }

  get items() {
    return this._items;
  }

  set items(v) {
    this._items = v;
    // w/h は固定 (w はアプリ指定、h は visibleRows から確定)。
    // スクロール状態のみ自動同期 (setContentLength の呼び忘れ防止)。
    if (this._vScroll) Scroll.scrollSetContent(this._vScroll, v.length);
  }

  /** @override — h のみ更新 (w はアプリが指定するため不変) */
  remeasure() {
    this.h = this.visibleRows * Helpers.TREEVIEW_ITEM_HEIGHT + 4;
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
    Ports.pushClip(innerX, innerY, innerW, this.h - 4);

    const startIdx = this._vScroll.offset;
    const endIdx = Math.min(this.items.length, startIdx + this.visibleRows);
    for (let i = startIdx; i < endIdx; i++) {
      const item = this.items[i];
      const itemY = innerY + (i - startIdx) * Helpers.TREEVIEW_ITEM_HEIGHT;
      const indent = item.depth * Helpers.TREEVIEW_INDENT;

      const isDropTarget = this._dragActive && i === this._dropTargetIndex;
      const selected = i === this.selectedIndex;
      const hovered = i === this.hoverIndex && !this._dragActive;
      const invert = selected || hovered || isDropTarget;

      if (invert) {
        Ports.fillRect(innerX, itemY, innerW, Helpers.TREEVIEW_ITEM_HEIGHT, 1);
      }
      const textColor = invert ? 0 : 1;

      // 展開インジケータ (+/-)
      const indicatorX = innerX + Helpers.BUTTON_PADDING + indent;
      const indicatorY = itemY + 4;
      if (item.hasChildren) {
        Ports.drawText(
          indicatorX,
          indicatorY,
          item.expanded ? TREEVIEW_ICON_EXPANDED : TREEVIEW_ICON_COLLAPSED,
          textColor,
        );
      } else {
        Ports.drawText(indicatorX, indicatorY, TREEVIEW_ICON_LEAF, textColor);
      }

      // ファイル / フォルダ アイコン
      const iconX = indicatorX + Ports.GLYPH_W + 4;
      Ports.drawIcon(
        item.hasChildren ? "folder" : "file",
        iconX,
        indicatorY,
        textColor,
      );

      // ラベル
      const labelX = iconX + Ports.ICON_W + 4;
      Ports.drawText(labelX, indicatorY, item.label, textColor);
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

    const scrollbar = Scroll.vScrollbarSlotThumbArea(
      this.x + this.w - 1 - Scroll.SCROLLBAR_SLOT_WIDTH,
      this.y + 1,
      this.h - 2,
    );

    const inItemArea =
      ev.localX >= itemX0 &&
      ev.localX < itemX0 + itemW &&
      ev.localY >= itemY0 &&
      ev.localY < itemY0 + (this.h - 4);

    const inScrollbar =
      ev.localX >= scrollbar.x &&
      ev.localX < scrollbar.x + scrollbar.w &&
      ev.localY >= scrollbar.y &&
      ev.localY < scrollbar.y + scrollbar.h;

    // ── ホバー追従 ──
    if (ev.type === "hover" || ev.type === "held" || ev.type === "down") {
      if (
        inItemArea &&
        !Scroll.scrollIsDragging(vScroll) &&
        !this._dragActive
      ) {
        const row = ((ev.localY - itemY0) / Helpers.TREEVIEW_ITEM_HEIGHT) | 0;
        const idx = vScroll.offset + row;
        this.hoverIndex = idx >= 0 && idx < this.items.length ? idx : -1;
      } else {
        this.hoverIndex = -1;
      }
      if (ev.type === "hover" && this.hoverIndex >= 0 && this.onItemTooltip) {
        const tip = this.onItemTooltip(this.hoverIndex);
        if (tip) Helpers.wmSetTooltip(tip);
      }
      // アイテム領域では pointer カーソル
      if (inItemArea && !Scroll.scrollIsDragging(vScroll)) {
        Helpers.wmRequestCursor("pointer");
      }
    }

    // ── クリック選択 + D&D 開始準備 ──
    if (ev.type === "down" && inItemArea) {
      const row = ((ev.localY - itemY0) / Helpers.TREEVIEW_ITEM_HEIGHT) | 0;
      const idx = vScroll.offset + row;
      if (idx >= 0 && idx < this.items.length) {
        const item = this.items[idx];

        // インジケータ領域クリック → 展開 / 折りたたみ
        const indent = item.depth * Helpers.TREEVIEW_INDENT;
        const indicatorX = itemX0 + Helpers.BUTTON_PADDING + indent;
        const indicatorW = Ports.GLYPH_W + 1;
        if (
          item.hasChildren &&
          ev.localX >= indicatorX &&
          ev.localX < indicatorX + indicatorW
        ) {
          if (this.onToggle) this.onToggle(idx, item);
        }

        if (idx !== this.selectedIndex) {
          this.selectedIndex = idx;
          if (this.onSelect) this.onSelect(idx, item);
        }

        // D&D 開始準備
        if (this.onDrop) {
          this._dragSrcIndex = idx;
          this._dragActive = false;
          this._dragStartX = ev.localX;
          this._dragStartY = ev.localY;
          this._dropTargetIndex = -1;
        }
      }
    }

    // ── D&D: held 中にデッドゾーン超過 → ドラッグモード ──
    if (ev.type === "held" && this._dragSrcIndex >= 0 && this.onDrop) {
      if (!this._dragActive) {
        const dx = ev.localX - this._dragStartX;
        const dy = ev.localY - this._dragStartY;
        if (
          dx * dx + dy * dy >
          TREEVIEW_DRAG_DEADZONE * TREEVIEW_DRAG_DEADZONE
        ) {
          this._dragActive = true;
        }
      }
      if (this._dragActive && inItemArea) {
        const row = ((ev.localY - itemY0) / Helpers.TREEVIEW_ITEM_HEIGHT) | 0;
        const idx = vScroll.offset + row;
        this._dropTargetIndex =
          idx >= 0 && idx < this.items.length && idx !== this._dragSrcIndex
            ? idx
            : -1;
      } else if (this._dragActive) {
        this._dropTargetIndex = -1;
      }
    }

    // ── D&D: up → ドロップ発火 ──
    if (ev.type === "up" && this._dragActive && this.onDrop) {
      if (this._dropTargetIndex >= 0) {
        this.onDrop(this._dragSrcIndex, this._dropTargetIndex);
      }
      this._dragSrcIndex = -1;
      this._dragActive = false;
      this._dropTargetIndex = -1;
    } else if (ev.type === "up") {
      this._dragSrcIndex = -1;
      this._dragActive = false;
      this._dropTargetIndex = -1;
    }

    // ── ダブルクリック → 展開トグル or 起動 ──
    if (ev.type === "dblclick" && inItemArea) {
      const row = ((ev.localY - itemY0) / Helpers.TREEVIEW_ITEM_HEIGHT) | 0;
      const idx = vScroll.offset + row;
      if (idx >= 0 && idx < this.items.length) {
        const item = this.items[idx];
        if (item.hasChildren) {
          if (this.onToggle) this.onToggle(idx, item);
        } else {
          if (this.onActivate) this.onActivate(idx, item);
        }
      }
    }

    // ── スクロールバーカーソル ──
    if (
      (inScrollbar || Scroll.scrollIsDragging(vScroll)) &&
      (ev.type === "hover" || ev.type === "held" || ev.type === "down")
    ) {
      Helpers.wmRequestCursor("drag-v");
    }

    // ── スクロールバー入力 ──
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
    if (ev.type === "up") Scroll.scrollDragReset(vScroll);

    // ── ホイール ──
    if (ev.type === "wheel" && (inItemArea || inScrollbar)) {
      Scroll.scrollBy(vScroll, ev.deltaY > 0 ? 1 : -1);
      ev.consumed = true;
    }
  }

  /** @override — ↑↓ 選択移動, ← 折りたたみ, → 展開, Enter 起動 */
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
        if (this.onSelect) this.onSelect(idx, this.items[idx]);
      }
      return true;
    }
    // ← 折りたたみ
    if (Ports.keyDown("ArrowLeft")) {
      const item = this.items[this.selectedIndex];
      if (item && item.hasChildren && item.expanded) {
        if (this.onToggle) this.onToggle(this.selectedIndex, item);
      }
      return true;
    }
    // → 展開
    if (Ports.keyDown("ArrowRight")) {
      const item = this.items[this.selectedIndex];
      if (item && item.hasChildren && !item.expanded) {
        if (this.onToggle) this.onToggle(this.selectedIndex, item);
      }
      return true;
    }
    // Enter で起動
    if (Ports.keyDown("Enter")) {
      const item = this.items[this.selectedIndex];
      if (item) {
        if (item.hasChildren) {
          if (this.onToggle) this.onToggle(this.selectedIndex, item);
        } else {
          if (this.onActivate) this.onActivate(this.selectedIndex, item);
        }
      }
      return true;
    }
    return false;
  }
}

