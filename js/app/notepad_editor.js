/**
 * @module app/notepad_editor
 * notepad_editor.js — NOTEPAD の editor-as-body ウィジェット
 *
 * 専用テキストエディタらしく「ウィンドウボディ＝編集面」にする chrome。汎用 TextArea
 * と同じ TextEditView（文書・選択・Undo・入力・本文描画）を共有しつつ、枠を描かず
 * ボディいっぱいにフィルし、四辺に均等余白を取り、縦/横スクロールバーをボディ端に
 * フラッシュ配置する（横バーは常時表示・ステッパーボタン付き）。表示桁数/行数はボディ
 * 実寸から毎フレーム算出するので、Maximize でも右下に余白が残らない。
 *
 * host（notepad.js）は毎フレーム this.x/y/w/h をボディ矩形に合わせてから draw する。
 * 横スクロールは view.scrollX を真実とし、ここで H スクロールバー状態へ橋渡しする。
 */

import { FocusableWidget } from "../ui/FocusableWidget.js";
import * as Ports from "../ui/ports.js";
import * as Helpers from "../ui/ui_helpers.js";
import * as Scroll from "../ui/scrollbar.js";
import { TextEditView } from "../ui/text_edit_view.js";

/** 編集面の四辺に取る均等余白 (px)。 */
const MARGIN = 3;

export class NotepadEditor extends FocusableWidget {
  /**
   * @param {number} maxLines  最大行数
   * @param {string} text      初期テキスト (改行区切り)
   * @param {function} [onChange] テキスト変更コールバック
   */
  constructor(maxLines, text, onChange) {
    super(0, 0, 0, 0); // 実寸は host が毎フレーム設定する
    this.view = new TextEditView(text, maxLines, { onChange });
    /** @private 横スクロールバー状態（view.scrollX へ橋渡し） */
    this._hScroll = Scroll.createScrollState(1, 1);
  }

  // ── 公開 API は view へ委譲（notepad.js の後方互換） ──
  get lines() { return this.view.lines; }
  set lines(v) { this.view.lines = v; }
  get cursorRow() { return this.view.cursorRow; }
  set cursorRow(v) { this.view.cursorRow = v; }
  get cursorCol() { return this.view.cursorCol; }
  set cursorCol(v) { this.view.cursorCol = v; }
  get scrollX() { return this.view.scrollX; }
  set scrollX(v) { this.view.scrollX = v; }
  getText() { return this.view.getText(); }
  selectedCharCount() { return this.view.selectedCharCount(); }
  setContentLength(length) { this.view.setContentLength(length); }
  scrollToTop() { this.view.scrollToTop(); }
  clearHistory() { this.view.clearHistory(); }

  /** @override */
  get isTextInput() {
    return true;
  }

  /** @override */
  clearSelection() {
    this.view.clearSelection();
  }

  /** @override */
  resetDragState() {
    this.view.resetDragState();
    Scroll.scrollDragReset(this._hScroll);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  レイアウト（ボディ矩形 → 本文内側矩形 / スクロールバースロット）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * this.x/y/w/h（ボディ矩形, 親コンテンツ領域内ローカル）から各領域を算出する。
   * 描画は abs=true（親原点加算）で絶対座標、入力はローカルで使う。
   * @private
   */
  _geom(originX, originY) {
    const charW = Ports.GLYPH_W + 1;
    const lineH = Helpers.TEXTAREA_LINE_HEIGHT;
    const bx = originX + this.x;
    const by = originY + this.y;
    const W = this.w;
    const H = this.h;
    const innerX = bx + MARGIN;
    const innerY = by + MARGIN;
    // 縦横スクロールバースロットは WM 標準 chrome が this.w/this.h の外側に確保済み
    // (host が渡す contentRect が既にスロット分縮まっている) ため、ここでは四辺の
    // 均等余白 (MARGIN) だけを引く。
    const innerW = Math.max(charW, W - MARGIN * 2);
    const innerH = Math.max(lineH, H - MARGIN * 2);
    return {
      bx, by, W, H, charW, lineH,
      innerX, innerY, innerW, innerH,
      widthChars: Math.max(1, Math.floor(innerW / charW)),
      visibleRows: Math.max(1, Math.floor(innerH / lineH)),
    };
  }

  /**
   * @private 横スクロールバー状態を view.scrollX と最長行から同期する。
   *
   * _hScroll は WM 標準 chrome の横バーへ接続されており (notepad.js の wmAttachScroll)、
   * WM がドラッグ / ステッパーで _hScroll.offset を書き換える。横スクロールの真実は
   * view.scrollX（本文描画が参照）なので、両者を橋渡しする:
   *   - WM がバー操作中 (ドラッグ / ステッパー押下) → バー → view.scrollX
   *   - それ以外 (タイプでキャレット追従して view.scrollX が動く等) → view.scrollX → バー
   */
  _syncHScroll() {
    let maxLen = 0;
    const lines = this.view.lines;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > maxLen) maxLen = lines[i].length;
    }
    this._hScroll.viewport = this.view.widthChars;
    Scroll.scrollSetContent(this._hScroll, maxLen);
    if (Scroll.scrollIsDragging(this._hScroll)) {
      // _hScroll.offset は scrollBy/scrollTo でクランプ済み。本文へ反映する。
      this.view.scrollX = this._hScroll.offset;
    } else {
      Scroll.scrollTo(this._hScroll, this.view.scrollX);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  描画（枠なし・本文 + 端の V/H スクロールバー）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** @override */
  draw(contentRect) {
    const g = this._geom(contentRect.x, contentRect.y);
    this.view.setViewport(g.widthChars, g.visibleRows);
    this._syncHScroll();

    const focused = Helpers.getFocused() === this;
    this.view.drawContent(g.innerX, g.innerY, g.innerW, g.innerH, focused);

    // 縦横スクロールバー + ステッパー + コーナーは WM 標準 chrome が枠端に描画する
    // (notepad.js の wmAttachScroll で view._vScroll / this._hScroll を接続済み)。
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  入力（本文マウス / キーボード）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** @override */
  update(ev) {
    // 縦横スクロールバー・ステッパー・コーナーの入力は WM 標準 chrome が処理し、
    // その領域のクリックはコンテンツへ伝播しない (this.w/this.h の外側にある)。
    // ここでは本文領域のマウスのみを扱う。
    const g = this._geom(0, 0); // 入力はローカル座標
    const hit = this.hitTest(ev.localX, ev.localY);
    this.view.handleTextMouse(ev, hit, g.innerX, g.innerY);
  }

  /** @override */
  handleKey() {
    return this.view.handleKey();
  }
}
