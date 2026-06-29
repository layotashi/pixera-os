/**
 * @module ui/widgets/TextArea
 * TextArea.js — 複数行テキスト入力
 *
 * 複数行テキスト編集。ストリーム選択・矩形選択に対応。
 * スクロールバー付き。キーボード/マウスの両方で操作可能。
 */

import { FocusableWidget } from "../FocusableWidget.js";
import * as Ports from "../ports.js";
import * as Helpers from "../ui_helpers.js";
import * as Scroll from "../scrollbar.js";

/** Undo 履歴の最大段数 */
const UNDO_MAX = 200;
/** 連続入力を 1 undo にまとめる時間窓 (ms) */
const UNDO_COALESCE_MS = 600;

export class TextArea extends FocusableWidget {
  /**
   * @param {number} x  コンテンツ領域内の X
   * @param {number} y  コンテンツ領域内の Y
   * @param {number} widthChars   表示幅 (文字数)
   * @param {number} visibleRows  表示行数
   * @param {number} maxLines     最大行数
   * @param {string} text         初期テキスト (改行区切り)
   * @param {function} [onChange] テキスト変更コールバック (newText) => void
   */
  constructor(x, y, widthChars, visibleRows, maxLines, text, onChange) {
    const charW = Ports.GLYPH_W + 1;
    const lineH = Helpers.TEXTAREA_LINE_HEIGHT;
    const innerW = widthChars * charW + Ports.GLYPH_W;
    const innerH = visibleRows * lineH - 1;
    const w =
      innerW + Helpers.BUTTON_PADDING * 2 + Scroll.SCROLLBAR_SLOT_WIDTH + 4;
    const h = innerH + Helpers.BUTTON_PADDING * 2 + 4;
    super(x, y, w, h);
    const initLines = String(text || "")
      .split("\n")
      .slice(0, maxLines);
    this.lines = initLines;
    this.maxLines = maxLines;
    this.widthChars = widthChars;
    this.visibleRows = visibleRows;
    this.cursorRow = 0;
    this.cursorCol = initLines[0] ? initLines[0].length : 0;
    /** 横スクロールオフセット (全行共通, 文字数) */
    this.scrollX = 0;
    /** @private 縦スクロール */
    this._vScroll = Scroll.createScrollState(visibleRows, initLines.length);
    /** 選択アンカー行 (null=選択なし) */
    this.selectionAnchorRow = null;
    /** 選択アンカー列 */
    this.selectionAnchorCol = null;
    /** 矩形選択 {anchorRow, anchorCol, cursorRow, cursorCol} or null */
    this.boxSelection = null;
    /** @private 中ボタンドラッグ中 */
    this._middleButtonDragging = false;
    /** @private マウスドラッグ中 */
    this._dragging = false;
    this.onChange = onChange || null;
    /** @private */
    this._blinkTimer = 0;
    // ── Undo / Redo（行スナップショット方式。連続入力はコアレスして 1 ステップに） ──
    /** @private @type {Array<{lines:string[],cursorRow:number,cursorCol:number}>} */
    this._undoStack = [];
    /** @private */
    this._redoStack = [];
    /** @private 直近編集の種別（"type" は連続入力をまとめる） */
    this._undoKind = null;
    /** @private 直近編集の時刻（コアレス判定用） */
    this._undoTime = 0;
    /** 空白/改行マーカー（・/↓）を表示するか。コード編集では消すと読みやすい。 */
    this.showWhitespace = true;
    /** 入力を大文字へ畳むか（SYNESTA は大文字表示が前提。表示＝保存を一致させる）。 */
    this.uppercaseInput = true;
    /**
     * 桁ガイド列（null=無効）。設定すると、その列に点線の縦ガイドを描き、その列を超える
     * 行は右端を実線ティックで強調する（TESS の 40桁制約を可視化＝折り返しの目安）。
     */
    this.guideCol = null;
  }

  /** @private 現在状態のスナップショット */
  _snapshot() {
    return {
      lines: this.lines.slice(),
      cursorRow: this.cursorRow,
      cursorCol: this.cursorCol,
    };
  }

  /** @private スナップショットを復元（範囲はクランプ）して onChange を発火 */
  _applySnapshot(s) {
    this.lines = s.lines.slice();
    this.cursorRow = Math.max(0, Math.min(s.cursorRow, this.lines.length - 1));
    this.cursorCol = Math.max(
      0,
      Math.min(s.cursorCol, this.lines[this.cursorRow].length),
    );
    this._clearSelection();
    this.boxSelection = null;
    Scroll.scrollSetContent(this._vScroll, this.lines.length);
    this._ensureCursorVisible();
    this._blinkTimer = 0;
    if (this.onChange) this.onChange(this.getText());
  }

  /** @private Undo（直前の編集を取り消す） */
  _undo() {
    if (!this._undoStack.length) return;
    this._redoStack.push(this._snapshot());
    this._applySnapshot(this._undoStack.pop());
    this._undoKind = null; // 次の編集は必ず新規エントリ
  }

  /** @private Redo（取り消した編集をやり直す） */
  _redo() {
    if (!this._redoStack.length) return;
    this._undoStack.push(this._snapshot());
    this._applySnapshot(this._redoStack.pop());
    this._undoKind = null;
  }

  /** 履歴をクリアする（ファイルを開く/新規など、編集の連続性が切れるとき）。 */
  clearHistory() {
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this._undoKind = null;
  }

  /**
   * 外部からの一括変更（整形・seed 振り直し等）を 1 ステップとして undo 可能にする。
   * lines を書き換える「前」に呼ぶと、その直前状態が undo に積まれる。
   */
  snapshotForUndo() {
    this._undoStack.push(this._snapshot());
    if (this._undoStack.length > UNDO_MAX) this._undoStack.shift();
    this._redoStack.length = 0;
    this._undoKind = null;
  }

  /** @private 編集後に呼び、undo に積む（"type" は時間窓内でコアレス）。 */
  _recordEdit(before, kind) {
    const now = Ports.now ? Ports.now() : Date.now();
    const coalesce =
      kind === "type" &&
      this._undoKind === "type" &&
      now - this._undoTime < UNDO_COALESCE_MS;
    if (!coalesce) {
      this._undoStack.push(before);
      if (this._undoStack.length > UNDO_MAX) this._undoStack.shift();
      this._redoStack.length = 0; // 新規編集で redo を破棄
    }
    this._undoKind = kind;
    this._undoTime = now;
  }

  /** @override */
  remeasure() {
    const charW = Ports.GLYPH_W + 1;
    const innerW = this.widthChars * charW + Ports.GLYPH_W;
    const innerH = this.visibleRows * Helpers.TEXTAREA_LINE_HEIGHT - 1;
    this.w =
      innerW + Helpers.BUTTON_PADDING * 2 + Scroll.SCROLLBAR_SLOT_WIDTH + 4;
    this.h = innerH + Helpers.BUTTON_PADDING * 2 + 4;
  }

  /** @override */
  get isTextInput() {
    return true;
  }

  /** @override */
  clearSelection() {
    this.selectionAnchorRow = null;
    this.selectionAnchorCol = null;
    this.boxSelection = null;
    this._dragging = false;
    this._middleButtonDragging = false;
  }

  /** @override */
  resetDragState() {
    Scroll.scrollDragReset(this._vScroll);
    this._dragging = false;
    this._middleButtonDragging = false;
  }

  /** テキスト内容を返す */
  getText() {
    return this.lines.join("\n");
  }

  /**
   * 選択中の文字数を返す (選択なし → 0)。
   * @returns {number}
   */
  selectedCharCount() {
    if (this.boxSelection) {
      const normalizedBox = this._normalizeBoxSelection();
      if (!normalizedBox) return 0;
      let n = 0;
      for (let r = normalizedBox.r0; r <= normalizedBox.r1; r++) {
        const len = this.lines[r].length;
        n += Math.min(normalizedBox.c1, len) - Math.min(normalizedBox.c0, len);
      }
      return n;
    }
    const selection = this._getSelectionRange();
    if (!selection) return 0;
    return this._getSelectedText(selection).length;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Private helpers
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** 現在のカーソル行テキスト */
  _currentLine() {
    return this.lines[this.cursorRow];
  }

  _clearSelection() {
    this.selectionAnchorRow = null;
    this.selectionAnchorCol = null;
  }

  _setSelectionAnchor() {
    if (this.selectionAnchorRow === null) {
      this.selectionAnchorRow = this.cursorRow;
      this.selectionAnchorCol = this.cursorCol;
    }
  }

  // ── 選択範囲 ──

  /** 正規化された選択範囲 [sr, sc, er, ec] を返す。選択なしは null */
  _getSelectionRange() {
    if (this.selectionAnchorRow === null) return null;
    const anchorRow = this.selectionAnchorRow,
      anchorCol = this.selectionAnchorCol;
    const curRow = this.cursorRow,
      curCol = this.cursorCol;
    if (anchorRow === curRow && anchorCol === curCol) return null;
    if (anchorRow < curRow || (anchorRow === curRow && anchorCol < curCol))
      return [anchorRow, anchorCol, curRow, curCol];
    return [curRow, curCol, anchorRow, anchorCol];
  }

  /** 選択範囲を削除 */
  _deleteSelection() {
    const selection = this._getSelectionRange();
    if (!selection) return false;
    const [startRow, startCol, endRow, endCol] = selection;
    if (startRow === endRow) {
      this.lines[startRow] =
        this.lines[startRow].slice(0, startCol) +
        this.lines[startRow].slice(endCol);
    } else {
      this.lines[startRow] =
        this.lines[startRow].slice(0, startCol) +
        this.lines[endRow].slice(endCol);
      this.lines.splice(startRow + 1, endRow - startRow);
    }
    this.cursorRow = startRow;
    this.cursorCol = startCol;
    this.selectionAnchorRow = null;
    this.selectionAnchorCol = null;
    return true;
  }

  /** 選択範囲のテキストを返す */
  _getSelectedText(selection) {
    const [startRow, startCol, endRow, endCol] = selection;
    if (startRow === endRow)
      return this.lines[startRow].slice(startCol, endCol);
    const parts = [this.lines[startRow].slice(startCol)];
    for (let i = startRow + 1; i < endRow; i++) parts.push(this.lines[i]);
    parts.push(this.lines[endRow].slice(0, endCol));
    return parts.join("\n");
  }

  // ── 矩形選択 ──

  /** 矩形選択の正規化 */
  _normalizeBoxSelection() {
    const box = this.boxSelection;
    if (!box) return null;
    const minRow = Math.min(box.anchorRow, box.cursorRow);
    const maxRow = Math.max(box.anchorRow, box.cursorRow);
    const minCol = Math.min(box.anchorCol, box.cursorCol);
    const maxCol = Math.max(box.anchorCol, box.cursorCol);
    if (minRow === maxRow && minCol === maxCol) return null;
    return { r0: minRow, c0: minCol, r1: maxRow, c1: maxCol };
  }

  /** 矩形選択テキスト */
  _getBoxSelectionText() {
    const box = this._normalizeBoxSelection();
    if (!box) return "";
    const parts = [];
    for (let r = box.r0; r <= box.r1; r++) {
      const line = r < this.lines.length ? this.lines[r] : "";
      parts.push(line.slice(box.c0, Math.min(box.c1, line.length)));
    }
    return parts.join("\n");
  }

  /** 矩形選択を削除 */
  _deleteBoxSelection() {
    const box = this._normalizeBoxSelection();
    if (!box) return false;
    for (let r = box.r0; r <= Math.min(box.r1, this.lines.length - 1); r++) {
      const line = this.lines[r];
      const start = Math.min(box.c0, line.length);
      const end = Math.min(box.c1, line.length);
      this.lines[r] = line.slice(0, start) + line.slice(end);
    }
    this.cursorRow = box.r0;
    this.cursorCol = box.c0;
    this.boxSelection = null;
    return true;
  }

  // ── 単語境界 ──

  _findWordBoundaryLeft(row, col) {
    if (col === 0) {
      if (row > 0) return { row: row - 1, col: this.lines[row - 1].length };
      return { row: 0, col: 0 };
    }
    const line = this.lines[row];
    let pos = col;
    const cat = Helpers.charCat(line[pos - 1]);
    while (pos > 0 && Helpers.charCat(line[pos - 1]) === cat) pos--;
    return { row, col: pos };
  }

  _findWordBoundaryRight(row, col) {
    const line = this.lines[row];
    if (col >= line.length) {
      if (row < this.lines.length - 1) return { row: row + 1, col: 0 };
      return { row, col: line.length };
    }
    let pos = col;
    const cat = Helpers.charCat(line[pos]);
    while (pos < line.length && Helpers.charCat(line[pos]) === cat) pos++;
    return { row, col: pos };
  }

  // ── カーソル可視化 ──

  _ensureCursorVisible() {
    Scroll.scrollEnsureVisible(this._vScroll, this.cursorRow);
    if (this.cursorCol < this.scrollX) {
      this.scrollX = this.cursorCol;
    }
    if (this.cursorCol > this.scrollX + this.widthChars) {
      this.scrollX = this.cursorCol - this.widthChars;
    }
  }

  // ── パブリック スクロール操作 ──

  /**
   * コンテンツ長 (総行数) を更新しスクロール範囲を再計算する。
   * 外部から lines を差し替えた際に呼ぶ。
   * @param {number} length 新しい行数
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
   * 指定行が表示領域に入るようスクロールする。
   * @param {number} row 可視化したい行インデックス
   */
  ensureVisible(row) {
    Scroll.scrollEnsureVisible(this._vScroll, row);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  描画
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** @override */
  draw(contentRect) {
    const absX = contentRect.x + this.x;
    const absY = contentRect.y + this.y;

    Ports.drawRoundRect(absX, absY, this.w, this.h, 1, 1);

    const innerX = absX + 2 + Helpers.BUTTON_PADDING;
    const innerY = absY + 2 + Helpers.BUTTON_PADDING;
    const innerW =
      this.w - 4 - Helpers.BUTTON_PADDING * 2 - Scroll.SCROLLBAR_SLOT_WIDTH;
    const innerH = this.h - 4 - Helpers.BUTTON_PADDING * 2;
    const charW = Ports.GLYPH_W + 1;

    Ports.pushClip(innerX, innerY, innerW, innerH);

    const selection = this._getSelectionRange();

    // 各行を描画
    for (let viewRow = 0; viewRow < this.visibleRows; viewRow++) {
      const lineIdx = this._vScroll.offset + viewRow;
      if (lineIdx >= this.lines.length) break;
      const line = this.lines[lineIdx];
      const visible = line.slice(this.scrollX, this.scrollX + this.widthChars);
      const lineY = innerY + viewRow * Helpers.TEXTAREA_LINE_HEIGHT;

      // 選択範囲ハイライト
      if (selection && lineIdx >= selection[0] && lineIdx <= selection[2]) {
        const lineSelStart = lineIdx === selection[0] ? selection[1] : 0;
        const isLastLine = lineIdx === this.lines.length - 1;
        const lineSelEnd =
          lineIdx === selection[2]
            ? selection[3]
            : line.length + (isLastLine ? 0 : 1);
        const selVisStart = Math.max(lineSelStart, this.scrollX) - this.scrollX;
        const selVisEnd =
          Math.min(lineSelEnd, this.scrollX + this.widthChars + 1) -
          this.scrollX;

        this._drawLineChars(visible, innerX, lineY, charW);
        this._drawNewlineIcon(line, lineIdx, innerX, lineY, charW);

        // 選択下線
        if (selVisStart < selVisEnd) {
          const underlineY = lineY + Ports.GLYPH_H + 1;
          const isLast = lineIdx === this.lines.length - 1;
          const clampedEnd = Math.min(
            selVisEnd,
            line.length + (isLast ? 0 : 1),
          );
          for (let i = selVisStart; i < clampedEnd; i++) {
            const charX = innerX + i * charW;
            Ports.hline(charX, charX + (Ports.GLYPH_W - 1), underlineY, 1);
          }
        }
      } else {
        this._drawLineChars(visible, innerX, lineY, charW);
        this._drawNewlineIcon(line, lineIdx, innerX, lineY, charW);
      }
    }

    // 桁ガイド + オーバーフロー（D）。guideCol 設定時のみ。点線ガイド＋超過行は実線ティック。
    if (this.guideCol != null) {
      const gx = innerX + (this.guideCol - this.scrollX) * charW - 1;
      if (gx >= innerX && gx < innerX + innerW) {
        for (let yy = innerY; yy < innerY + innerH; yy += 3) Ports.pset(gx, yy, 1);
        // 超過行は 2px 実線ティックで強調（点線ガイドと明確に区別）。
        for (let viewRow = 0; viewRow < this.visibleRows; viewRow++) {
          const lineIdx = this._vScroll.offset + viewRow;
          if (lineIdx >= this.lines.length) break;
          if (this.lines[lineIdx].length > this.guideCol) {
            const lineY = innerY + viewRow * Helpers.TEXTAREA_LINE_HEIGHT;
            const y1 = lineY + Helpers.TEXTAREA_LINE_HEIGHT - 1; // 行全高（連続超過行は実線で繋がる）
            Ports.vline(gx, lineY, y1, 1);
            Ports.vline(gx - 1, lineY, y1, 1);
          }
        }
      }
    }

    // 矩形選択の下線描画
    const box = this._normalizeBoxSelection();
    if (box) {
      for (let viewRow = 0; viewRow < this.visibleRows; viewRow++) {
        const lineIdx = this._vScroll.offset + viewRow;
        if (lineIdx < box.r0 || lineIdx > box.r1) continue;
        if (lineIdx >= this.lines.length) break;
        const lineY = innerY + viewRow * Helpers.TEXTAREA_LINE_HEIGHT;
        const underlineY = lineY + Ports.GLYPH_H + 1;
        const selVisStart = Math.max(box.c0, this.scrollX) - this.scrollX;
        const selVisEnd =
          Math.min(box.c1, this.scrollX + this.widthChars) - this.scrollX;
        for (let i = selVisStart; i < selVisEnd; i++) {
          const charX = innerX + i * charW;
          Ports.hline(charX, charX + (Ports.GLYPH_W - 1), underlineY, 1);
        }
      }
    }

    // キャレット
    const isFocused = Helpers.getFocused() === this;
    if (isFocused && !selection && !box) {
      this._blinkTimer = (this._blinkTimer + 1) % Helpers.TEXTBOX_BLINK_CYCLE;
      if (this._blinkTimer < Helpers.TEXTBOX_BLINK_CYCLE / 2) {
        const screenRow = this.cursorRow - this._vScroll.offset;
        const screenCol = this.cursorCol - this.scrollX;
        if (screenRow >= 0 && screenRow < this.visibleRows) {
          const charX = innerX + screenCol * charW;
          const underlineY =
            innerY +
            screenRow * Helpers.TEXTAREA_LINE_HEIGHT +
            Ports.GLYPH_H +
            1;
          Ports.hline(charX, charX + (Ports.GLYPH_W - 1), underlineY, 1);
        }
      }
    } else if (!isFocused) {
      this._blinkTimer = 0;
    }

    Ports.popClip();

    // スクロールバー
    const slotX = absX + this.w - 1 - Scroll.SCROLLBAR_SLOT_WIDTH;
    const slotY = absY + 1;
    const slotH = this.h - 2;
    Scroll.drawVScrollbarSlot(this._vScroll, slotX, slotY, slotH);
  }

  /** 1行分の文字を描画する (private) */
  _drawLineChars(visible, innerX, lineY, charW) {
    for (let i = 0; i < visible.length; i++) {
      const charX = innerX + i * charW;
      if (visible[i] === " ") {
        // 空白は中点で可視化（showWhitespace=false なら何も描かない＝素の空白）。
        if (this.showWhitespace) Ports.drawTextIcon("space-dot", charX, lineY, 1);
      } else {
        Ports.drawText(charX, lineY, visible[i], 1);
      }
    }
  }

  /** 行末改行アイコンを描画する (private) */
  _drawNewlineIcon(line, lineIdx, innerX, lineY, charW) {
    if (!this.showWhitespace) return; // 改行マーカー（↓）を消す
    if (lineIdx < this.lines.length - 1) {
      const nlScreenCol = line.length - this.scrollX;
      if (nlScreenCol >= 0 && nlScreenCol < this.widthChars) {
        Ports.drawTextIcon("newline", innerX + nlScreenCol * charW, lineY, 1);
      }
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  入力処理
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** @override */
  update(ev) {
    const hit = this.hitTest(ev.localX, ev.localY);

    // ── スクロールバー ──
    const scrollbar = Scroll.vScrollbarSlotThumbArea(
      this.x + this.w - 1 - Scroll.SCROLLBAR_SLOT_WIDTH,
      this.y + 1,
      this.h - 2,
    );
    const vScroll = this._vScroll;
    const inScrollbar =
      ev.localX >= scrollbar.x &&
      ev.localX < scrollbar.x + scrollbar.w &&
      ev.localY >= scrollbar.y &&
      ev.localY < scrollbar.y + scrollbar.h;

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
    if (ev.type === "up" && Scroll.scrollIsDragging(vScroll)) {
      Scroll.scrollDragReset(vScroll);
    }
    // スクロールバー領域では drag-v カーソル
    if (
      (inScrollbar || Scroll.scrollIsDragging(vScroll)) &&
      (ev.type === "hover" || ev.type === "held" || ev.type === "down")
    ) {
      Helpers.wmRequestCursor("drag-v");
    }
    if (Scroll.scrollIsDragging(vScroll)) return;

    const charW = Ports.GLYPH_W + 1;
    const innerX = this.x + 2 + Helpers.BUTTON_PADDING;
    const innerY = this.y + 2 + Helpers.BUTTON_PADDING;

    // 左クリック
    if (ev.type === "down" && hit && !inScrollbar) {
      this.boxSelection = null;
      this._middleButtonDragging = false;
      const relX = ev.localX - innerX;
      const relY = ev.localY - innerY;
      const row = Math.max(
        0,
        Math.min(
          this.lines.length - 1,
          this._vScroll.offset + ((relY / Helpers.TEXTAREA_LINE_HEIGHT) | 0),
        ),
      );
      const col = Math.max(
        0,
        Math.min(
          this.lines[row].length,
          this.scrollX + Math.round(relX / charW),
        ),
      );
      if (Ports.mouseHasShift()) {
        if (this.selectionAnchorRow === null) {
          this.selectionAnchorRow = this.cursorRow;
          this.selectionAnchorCol = this.cursorCol;
        }
        this.cursorRow = row;
        this.cursorCol = col;
      } else {
        this.selectionAnchorRow = row;
        this.selectionAnchorCol = col;
        this.cursorRow = row;
        this.cursorCol = col;
        this._dragging = true;
      }
      this._blinkTimer = 0;
    }

    // ドラッグ
    if (ev.type === "held" && this._dragging) {
      const relX = ev.localX - innerX;
      const relY = ev.localY - innerY;
      const row = Math.max(
        0,
        Math.min(
          this.lines.length - 1,
          this._vScroll.offset + ((relY / Helpers.TEXTAREA_LINE_HEIGHT) | 0),
        ),
      );
      const col = Math.max(
        0,
        Math.min(
          this.lines[row].length,
          this.scrollX + Math.round(relX / charW),
        ),
      );
      this.cursorRow = row;
      this.cursorCol = col;
      this._ensureCursorVisible();
      this._blinkTimer = 0;
    }

    if (ev.type === "up" && this._dragging) {
      this._dragging = false;
      if (
        this.selectionAnchorRow === this.cursorRow &&
        this.selectionAnchorCol === this.cursorCol
      ) {
        this.selectionAnchorRow = null;
        this.selectionAnchorCol = null;
      }
    }

    // 中ボタンドラッグ: 矩形選択
    if (ev.type === "mdown" && hit) {
      const relX = ev.localX - innerX;
      const relY = ev.localY - innerY;
      const row = Math.max(
        0,
        Math.min(
          this.lines.length - 1,
          this._vScroll.offset + ((relY / Helpers.TEXTAREA_LINE_HEIGHT) | 0),
        ),
      );
      const col = Math.max(
        0,
        Math.min(this.widthChars, this.scrollX + Math.round(relX / charW)),
      );
      this.selectionAnchorRow = null;
      this.selectionAnchorCol = null;
      this.boxSelection = {
        anchorRow: row,
        anchorCol: col,
        cursorRow: row,
        cursorCol: col,
      };
      this.cursorRow = row;
      this.cursorCol = col;
      this._middleButtonDragging = true;
      this._blinkTimer = 0;
    }
    if (ev.type === "mheld" && this._middleButtonDragging) {
      const relX = ev.localX - innerX;
      const relY = ev.localY - innerY;
      const row = Math.max(
        0,
        Math.min(
          this.lines.length - 1,
          this._vScroll.offset + ((relY / Helpers.TEXTAREA_LINE_HEIGHT) | 0),
        ),
      );
      const col = Math.max(
        0,
        Math.min(this.widthChars, this.scrollX + Math.round(relX / charW)),
      );
      this.boxSelection.cursorRow = row;
      this.boxSelection.cursorCol = col;
      this.cursorRow = row;
      this.cursorCol = Math.min(col, (this.lines[row] || "").length);
      this._ensureCursorVisible();
      this._blinkTimer = 0;
    }
    if (ev.type === "mup" && this._middleButtonDragging) {
      this._middleButtonDragging = false;
      if (!this._normalizeBoxSelection()) {
        this.boxSelection = null;
      }
    }

    // ホイール
    if (ev.type === "wheel" && hit) {
      const dir = ev.deltaY > 0 ? 1 : -1;
      Scroll.scrollBy(vScroll, dir);
      ev.consumed = true;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  キーボード入力
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** @override */
  handleKey() {
    // ── Undo / Redo（他の編集より先に処理）──
    if (Ports.ctrlDown("KeyZ")) {
      if (Helpers.shiftHeld()) this._redo();
      else this._undo();
      return true;
    }
    if (Ports.ctrlDown("KeyY")) {
      this._redo();
      return true;
    }

    let changed = false;
    const before = this._snapshot(); // 変更があればこの直前状態を undo に積む
    const chars = Ports.getCharQueue();
    const shift = Helpers.shiftHeld();
    const prevRow = this.cursorRow;
    const prevCol = this.cursorCol;

    // ── 文字入力 ──
    for (const raw of chars) {
      const ch = this.uppercaseInput ? raw.toUpperCase() : raw;
      if (this.boxSelection) {
        this._deleteBoxSelection();
        changed = true;
      } else if (this._getSelectionRange()) {
        this._deleteSelection();
        changed = true;
      }
      const line = this._currentLine();
      this.lines[this.cursorRow] =
        line.slice(0, this.cursorCol) + ch + line.slice(this.cursorCol);
      this.cursorCol++;
      changed = true;
      this._clearSelection();
      this.boxSelection = null;
    }

    // Tab
    if (Ports.keyDown("Tab")) {
      if (this.boxSelection) {
        this._deleteBoxSelection();
        changed = true;
      } else if (this._getSelectionRange()) {
        this._deleteSelection();
        changed = true;
      }
      const spaces = "    ";
      const line = this._currentLine();
      this.lines[this.cursorRow] =
        line.slice(0, this.cursorCol) + spaces + line.slice(this.cursorCol);
      this.cursorCol += spaces.length;
      changed = true;
      this._clearSelection();
      this.boxSelection = null;
    }

    // Enter
    if (Helpers.tickRepeat("Enter", true)) {
      if (this.boxSelection) {
        this._deleteBoxSelection();
        changed = true;
      } else if (this._getSelectionRange()) {
        this._deleteSelection();
        changed = true;
      }
      if (this.lines.length < this.maxLines) {
        const line = this._currentLine();
        this.lines[this.cursorRow] = line.slice(0, this.cursorCol);
        this.lines.splice(this.cursorRow + 1, 0, line.slice(this.cursorCol));
        this.cursorRow++;
        this.cursorCol = 0;
        changed = true;
      }
      this._clearSelection();
      this.boxSelection = null;
    }

    // Backspace
    if (Helpers.tickRepeat("Backspace", true)) {
      if (this.boxSelection) {
        this._deleteBoxSelection();
        changed = true;
      } else if (this._getSelectionRange()) {
        this._deleteSelection();
        changed = true;
      } else if (Helpers.ctrlHeld()) {
        const pos = this._findWordBoundaryLeft(this.cursorRow, this.cursorCol);
        if (pos.row === this.cursorRow) {
          const line = this._currentLine();
          this.lines[this.cursorRow] =
            line.slice(0, pos.col) + line.slice(this.cursorCol);
          this.cursorCol = pos.col;
          changed = true;
        } else {
          const prev = this.lines[pos.row];
          const cur = this._currentLine();
          this.lines[pos.row] =
            prev.slice(0, pos.col) + cur.slice(this.cursorCol);
          this.lines.splice(pos.row + 1, this.cursorRow - pos.row);
          this.cursorRow = pos.row;
          this.cursorCol = pos.col;
          changed = true;
        }
      } else if (this.cursorCol > 0) {
        const line = this._currentLine();
        this.lines[this.cursorRow] =
          line.slice(0, this.cursorCol - 1) + line.slice(this.cursorCol);
        this.cursorCol--;
        changed = true;
      } else if (this.cursorRow > 0) {
        const prev = this.lines[this.cursorRow - 1];
        const cur = this._currentLine();
        this.cursorCol = prev.length;
        this.lines[this.cursorRow - 1] = prev + cur;
        this.lines.splice(this.cursorRow, 1);
        this.cursorRow--;
        changed = true;
      }
      this._clearSelection();
      this.boxSelection = null;
    }

    // Delete
    if (Helpers.tickRepeat("Delete", true)) {
      if (this.boxSelection) {
        this._deleteBoxSelection();
        changed = true;
      } else if (this._getSelectionRange()) {
        this._deleteSelection();
        changed = true;
      } else if (Helpers.ctrlHeld()) {
        const pos = this._findWordBoundaryRight(this.cursorRow, this.cursorCol);
        if (pos.row === this.cursorRow) {
          const line = this._currentLine();
          this.lines[this.cursorRow] =
            line.slice(0, this.cursorCol) + line.slice(pos.col);
          changed = true;
        } else {
          const cur = this._currentLine();
          const next = this.lines[pos.row];
          this.lines[this.cursorRow] =
            cur.slice(0, this.cursorCol) + next.slice(pos.col);
          this.lines.splice(this.cursorRow + 1, pos.row - this.cursorRow);
          changed = true;
        }
      } else {
        const line = this._currentLine();
        if (this.cursorCol < line.length) {
          this.lines[this.cursorRow] =
            line.slice(0, this.cursorCol) + line.slice(this.cursorCol + 1);
          changed = true;
        } else if (this.cursorRow < this.lines.length - 1) {
          this.lines[this.cursorRow] = line + this.lines[this.cursorRow + 1];
          this.lines.splice(this.cursorRow + 1, 1);
          changed = true;
        }
      }
      this._clearSelection();
      this.boxSelection = null;
    }

    // ← カーソル移動
    if (Helpers.tickRepeat("ArrowLeft", true)) {
      this.boxSelection = null;
      const ctrl = Helpers.ctrlHeld();
      if (shift) {
        this._setSelectionAnchor();
        if (ctrl) {
          const pos = this._findWordBoundaryLeft(
            this.cursorRow,
            this.cursorCol,
          );
          this.cursorRow = pos.row;
          this.cursorCol = pos.col;
        } else if (this.cursorCol > 0) {
          this.cursorCol--;
        } else if (this.cursorRow > 0) {
          this.cursorRow--;
          this.cursorCol = this.lines[this.cursorRow].length;
        }
      } else {
        if (ctrl) {
          const pos = this._findWordBoundaryLeft(
            this.cursorRow,
            this.cursorCol,
          );
          this.cursorRow = pos.row;
          this.cursorCol = pos.col;
        } else {
          const selection = this._getSelectionRange();
          if (selection) {
            this.cursorRow = selection[0];
            this.cursorCol = selection[1];
          } else if (this.cursorCol > 0) {
            this.cursorCol--;
          } else if (this.cursorRow > 0) {
            this.cursorRow--;
            this.cursorCol = this.lines[this.cursorRow].length;
          }
        }
        this._clearSelection();
      }
    }

    // → カーソル移動
    if (Helpers.tickRepeat("ArrowRight", true)) {
      this.boxSelection = null;
      const ctrl = Helpers.ctrlHeld();
      if (shift) {
        this._setSelectionAnchor();
        if (ctrl) {
          const pos = this._findWordBoundaryRight(
            this.cursorRow,
            this.cursorCol,
          );
          this.cursorRow = pos.row;
          this.cursorCol = pos.col;
        } else if (this.cursorCol < this._currentLine().length) {
          this.cursorCol++;
        } else if (this.cursorRow < this.lines.length - 1) {
          this.cursorRow++;
          this.cursorCol = 0;
        }
      } else {
        if (ctrl) {
          const pos = this._findWordBoundaryRight(
            this.cursorRow,
            this.cursorCol,
          );
          this.cursorRow = pos.row;
          this.cursorCol = pos.col;
        } else {
          const selection = this._getSelectionRange();
          if (selection) {
            this.cursorRow = selection[2];
            this.cursorCol = selection[3];
          } else if (this.cursorCol < this._currentLine().length) {
            this.cursorCol++;
          } else if (this.cursorRow < this.lines.length - 1) {
            this.cursorRow++;
            this.cursorCol = 0;
          }
        }
        this._clearSelection();
      }
    }

    // ↑ 行移動
    if (Helpers.tickRepeat("ArrowUp", false)) {
      this.boxSelection = null;
      if (shift) this._setSelectionAnchor();
      else this._clearSelection();
      if (this.cursorRow > 0) {
        this.cursorRow--;
        this.cursorCol = Math.min(
          this.cursorCol,
          this.lines[this.cursorRow].length,
        );
      } else {
        this.cursorCol = 0;
      }
    }

    // ↓ 行移動
    if (Helpers.tickRepeat("ArrowDown", false)) {
      this.boxSelection = null;
      if (shift) this._setSelectionAnchor();
      else this._clearSelection();
      if (this.cursorRow < this.lines.length - 1) {
        this.cursorRow++;
        this.cursorCol = Math.min(
          this.cursorCol,
          this.lines[this.cursorRow].length,
        );
      } else {
        this.cursorCol = this.lines[this.cursorRow].length;
      }
    }

    // Home
    if (Ports.keyDown("Home")) {
      this.boxSelection = null;
      if (shift) this._setSelectionAnchor();
      else this._clearSelection();
      this.cursorCol = 0;
    }

    // End
    if (Ports.keyDown("End")) {
      this.boxSelection = null;
      if (shift) this._setSelectionAnchor();
      else this._clearSelection();
      this.cursorCol = this._currentLine().length;
    }

    // Ctrl+A
    if (Ports.ctrlDown("KeyA")) {
      this.boxSelection = null;
      this.selectionAnchorRow = 0;
      this.selectionAnchorCol = 0;
      this.cursorRow = this.lines.length - 1;
      this.cursorCol = this.lines[this.cursorRow].length;
    }

    // Ctrl+C
    if (Ports.ctrlDown("KeyC")) {
      if (this.boxSelection) {
        const boxText = this._getBoxSelectionText();
        if (boxText) Helpers.clipboardWrite(boxText);
      } else {
        const selection = this._getSelectionRange();
        if (selection) Helpers.clipboardWrite(this._getSelectedText(selection));
      }
    }

    // Ctrl+X
    if (Ports.ctrlDown("KeyX")) {
      if (this.boxSelection) {
        const boxText = this._getBoxSelectionText();
        if (boxText) Helpers.clipboardWrite(boxText);
        this._deleteBoxSelection();
        changed = true;
      } else {
        const selection = this._getSelectionRange();
        if (selection) {
          Helpers.clipboardWrite(this._getSelectedText(selection));
          this._deleteSelection();
          this._clearSelection();
          changed = true;
        }
      }
    }

    // Ctrl+V
    if (Ports.ctrlDown("KeyV")) {
      let paste = Ports.getPasteText();
      if (this.uppercaseInput && paste) paste = paste.toUpperCase();
      if (paste) {
        if (this.boxSelection) {
          this._deleteBoxSelection();
        } else if (this._getSelectionRange()) {
          this._deleteSelection();
        }
        const pasteLines = paste
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .split("\n");
        const line = this._currentLine();
        const before = line.slice(0, this.cursorCol);
        const after = line.slice(this.cursorCol);
        if (pasteLines.length === 1) {
          this.lines[this.cursorRow] = before + pasteLines[0] + after;
          this.cursorCol += pasteLines[0].length;
        } else {
          this.lines[this.cursorRow] = before + pasteLines[0];
          const mid = pasteLines.slice(1, -1);
          const last = pasteLines[pasteLines.length - 1];
          this.lines.splice(this.cursorRow + 1, 0, ...mid, last + after);
          this.cursorRow += pasteLines.length - 1;
          this.cursorCol = last.length;
          if (this.lines.length > this.maxLines) {
            this.lines.length = this.maxLines;
            this.cursorRow = Math.min(this.cursorRow, this.lines.length - 1);
            this.cursorCol = Math.min(
              this.cursorCol,
              this.lines[this.cursorRow].length,
            );
          }
        }
        this._clearSelection();
        changed = true;
      }
    }

    if (changed) {
      this._recordEdit(before, chars.length > 0 ? "type" : "struct");
      Scroll.scrollSetContent(this._vScroll, this.lines.length);
    }
    if (this.cursorRow !== prevRow || this.cursorCol !== prevCol || changed) {
      this._ensureCursorVisible();
    }
    if (changed) {
      this._blinkTimer = 0;
      if (this.onChange) this.onChange(this.getText());
    }
    return chars.length > 0 || changed;
  }
}

