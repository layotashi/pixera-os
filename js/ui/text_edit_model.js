/**
 * @module ui/text_edit_model
 * text_edit_model.js — 複数行テキスト編集の純粋モデル (文書 + カーソル + 選択 + Undo)。
 *
 * GPU / Ports / ビューポート (スクロール・px) に一切依存しない編集エンジン。TextArea
 * (枠付き汎用ウィジェット) と NotePad の editor-as-body が同じ編集ロジックを共有する
 * ために切り出した。座標は「行 index (row) / 桁 index (col)」のみで、px やスクロール、
 * 描画、キーバインド、クリップボード I/O は呼び出し側 (ビュー) の責務。
 *
 * ビューの契約:
 *   - 文書状態 (lines / cursorRow / cursorCol / 選択 / boxSelection) を直接読み書きしてよい。
 *   - Undo は「編集前スナップショット」をビューが _snapshot() で取り、編集後に _recordEdit()
 *     で積む (フレーム単位のコアレス）。applyUndo/applyRedo は状態を復元して真偽を返すのみで、
 *     スクロール追従・onChange 等の副作用はビューが行う。
 *   - 単語境界は char_category.charCat に依存 (純粋)。
 */

import { charCat } from "./char_category.js";

/** Undo 履歴の最大段数 */
const UNDO_MAX = 200;
/** 連続入力を 1 undo にまとめる時間窓 (ms) */
const UNDO_COALESCE_MS = 600;

export class TextEditModel {
  /**
   * @param {string} text         初期テキスト (改行区切り)
   * @param {number} maxLines     最大行数
   * @param {object} [opts]
   * @param {boolean} [opts.uppercaseInput=true] 入力を大文字へ畳むか
   */
  constructor(text, maxLines, { uppercaseInput = true } = {}) {
    const initLines = String(text || "")
      .split("\n")
      .slice(0, maxLines);
    this.lines = initLines;
    this.maxLines = maxLines;
    this.cursorRow = 0;
    this.cursorCol = initLines[0] ? initLines[0].length : 0;
    /** 選択アンカー行 (null=選択なし) */
    this.selectionAnchorRow = null;
    /** 選択アンカー列 */
    this.selectionAnchorCol = null;
    /** 矩形選択 {anchorRow, anchorCol, cursorRow, cursorCol} or null */
    this.boxSelection = null;
    /** 入力を大文字へ畳むか（PIXERA OS は大文字表示が前提。表示＝保存を一致させる）。 */
    this.uppercaseInput = uppercaseInput;
    // ── Undo / Redo（行スナップショット方式。連続入力はコアレスして 1 ステップに） ──
    /** @private @type {Array<{lines:string[],cursorRow:number,cursorCol:number}>} */
    this._undoStack = [];
    /** @private */
    this._redoStack = [];
    /** @private 直近編集の種別（"type" は連続入力をまとめる） */
    this._undoKind = null;
    /** @private 直近編集の時刻（コアレス判定用） */
    this._undoTime = 0;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Undo / Redo
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** @private 現在状態のスナップショット */
  _snapshot() {
    return {
      lines: this.lines.slice(),
      cursorRow: this.cursorRow,
      cursorCol: this.cursorCol,
    };
  }

  /** @private スナップショットの文書/カーソルを復元（範囲はクランプ、選択は解除）。 */
  _restoreSnapshot(s) {
    this.lines = s.lines.slice();
    this.cursorRow = Math.max(0, Math.min(s.cursorRow, this.lines.length - 1));
    this.cursorCol = Math.max(
      0,
      Math.min(s.cursorCol, this.lines[this.cursorRow].length),
    );
    this._clearSelection();
    this.boxSelection = null;
  }

  /**
   * Undo（直前の編集を取り消す）。状態を復元できたら true。
   * スクロール追従・onChange 等の副作用はビューが行う。
   */
  applyUndo() {
    if (!this._undoStack.length) return false;
    this._redoStack.push(this._snapshot());
    this._restoreSnapshot(this._undoStack.pop());
    this._undoKind = null; // 次の編集は必ず新規エントリ
    return true;
  }

  /** Redo（取り消した編集をやり直す）。復元できたら true。 */
  applyRedo() {
    if (!this._redoStack.length) return false;
    this._undoStack.push(this._snapshot());
    this._restoreSnapshot(this._redoStack.pop());
    this._undoKind = null;
    return true;
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

  /** 編集後に呼び、undo に積む（"type" は時間窓内でコアレス）。before は編集直前の _snapshot()。 */
  _recordEdit(before, kind) {
    const now = Date.now();
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

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  クエリ / 選択ヘルパー
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** テキスト内容を返す */
  getText() {
    return this.lines.join("\n");
  }

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

  // ── 選択範囲 (ストリーム) ──

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
    const cat = charCat(line[pos - 1]);
    while (pos > 0 && charCat(line[pos - 1]) === cat) pos--;
    return { row, col: pos };
  }

  _findWordBoundaryRight(row, col) {
    const line = this.lines[row];
    if (col >= line.length) {
      if (row < this.lines.length - 1) return { row: row + 1, col: 0 };
      return { row, col: line.length };
    }
    let pos = col;
    const cat = charCat(line[pos]);
    while (pos < line.length && charCat(line[pos]) === cat) pos++;
    return { row, col: pos };
  }
}
