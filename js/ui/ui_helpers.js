/**
 * @module ui/ui_helpers
 * ui_helpers.js — UI 共有ユーティリティ・グローバルステート
 *
 * Widget クラス群と WidgetGroup が共有するユーティリティ関数・定数・
 * グローバルステートをまとめたモジュール。
 * 循環依存を避けるため、Widget / WidgetGroup のいずれにも属さない独立ファイル。
 *
 * ── 単方向依存 ──
 *   ui_helpers → ports.js  (描画・入力ポートへの間接参照)
 *   Widget / WidgetGroup → ui_helpers  (このファイル)
 */

import * as Ports from "./ports.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  レイアウト定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ボタンラベルの上下左右パディング (px) */
export const BUTTON_PADDING = 4;

/** ボタン高さ (固定): GLYPH_H + PAD*2 + border*2 — initPorts() 後に _computeDerivedConstants() で算出 */
export let BUTTON_AUTO_HEIGHT = 0;

/** ラベル行間 (GLYPH_H + gap) — 複数行ラベルの行送りに使用 */
export let LABEL_LINE_HEIGHT = 0;

/** リストボックス / ドロップダウン: アイテム 1 行の高さ */
export let LISTBOX_ITEM_HEIGHT = 0;

/** ドロップダウン: ポップアップアイテム 1 行の高さ */
export let DROPDOWN_ITEM_HEIGHT = 0;

/** ドロップダウン: チェック印幅 (ICON_W + 3px gap) */
export let DROPDOWN_CHECK_WIDTH = 0;

/** TreeView: 1 行の高さ (= LISTBOX_ITEM_HEIGHT) */
export let TREEVIEW_ITEM_HEIGHT = 0;

/** TreeView: 階層インデント幅 */
export let TREEVIEW_INDENT = 0;

/** TextArea: 1 行の高さ (GLYPH_H + 3) */
export let TEXTAREA_LINE_HEIGHT = 0;

/**
 * フォント・アイコンサイズに依存する派生定数を算出する。
 * initPorts() 完了後に呼ばれる (index.js が管理)。
 * @internal
 */
export function _computeDerivedConstants() {
  BUTTON_AUTO_HEIGHT = Ports.GLYPH_H + BUTTON_PADDING * 2 + 4;
  LABEL_LINE_HEIGHT = Ports.GLYPH_H + 4;
  LISTBOX_ITEM_HEIGHT = Ports.GLYPH_H + 8;
  DROPDOWN_ITEM_HEIGHT = Ports.GLYPH_H + 8;
  DROPDOWN_CHECK_WIDTH = Ports.ICON_W + 3;
  TREEVIEW_ITEM_HEIGHT = LISTBOX_ITEM_HEIGHT;
  TREEVIEW_INDENT = (Ports.GLYPH_W + 1) * 2;
  TEXTAREA_LINE_HEIGHT = Ports.GLYPH_H + 3;
}

/** キャレット点滅間隔 (フレーム数) */
export const TEXTBOX_BLINK_CYCLE = 40;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  テキスト幅・サイズ算出
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 文字列のピクセル幅を返す */
export function textWidth(s) {
  return s.length > 0 ? s.length * (Ports.GLYPH_W + 1) - 1 : 0;
}

/** ラベル文字列からボタン幅を算出する */
export function buttonAutoWidth(label) {
  return textWidth(label) + BUTTON_PADDING * 2 + 4;
}

/** アイコンからボタン幅を算出する */
export function buttonIconWidth() {
  return Ports.ICON_W + BUTTON_PADDING * 2 + 4;
}

/** アイコンからボタン高さを算出する */
export function buttonIconHeight() {
  return Ports.ICON_H + BUTTON_PADDING * 2 + 4;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  フォーカス管理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 現在フォーカス中のウィジェット (全ウィンドウで共有) */
let _focusedWidget = null;

/** 現在フォーカス中のウィジェットを返す */
export function getFocused() {
  return _focusedWidget;
}

/**
 * フォーカスを設定する。
 * 前のウィジェットの選択状態はクリアされる。
 * @param {import("./Widget.js").Widget} w
 */
export function setFocused(w) {
  if (_focusedWidget && _focusedWidget !== w) {
    _focusedWidget.clearSelection();
  }
  _focusedWidget = w;
  _repeatKey = null;
}

/** フォーカスを解除する */
export function clearFocus() {
  if (_focusedWidget) {
    _focusedWidget.clearSelection();
  }
  _focusedWidget = null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WM コールバック (循環依存回避のためコールバック注入)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {((text: string) => void) | null} */
let _wmSetTooltip = null;
/** @type {((name: string) => void) | null} */
let _wmRequestCursor = null;

/**
 * WM からのコールバックを注入する。kernel.js が初期化時に呼ぶ。
 * @param {{ setTooltip: function, requestCursor: function }} cbs
 */
export function setWmCallbacks(cbs) {
  _wmSetTooltip = cbs.setTooltip;
  _wmRequestCursor = cbs.requestCursor;
}

/** WM にツールチップテキストを通知する */
export function wmSetTooltip(text) {
  if (_wmSetTooltip) _wmSetTooltip(text);
}

/** WM にカーソル形状変更を依頼する */
export function wmRequestCursor(name) {
  if (_wmRequestCursor) _wmRequestCursor(name);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  キーリピート & 加速
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {string|null} 現在押されているリピート対象キー */
let _repeatKey = null;
/** キーが押されてからのフレーム数 */
let _repeatHeld = 0;
/** 次に発火するまでのカウント */
let _repeatCooldown = 0;

// リピートタイミング定数 (60fps前提)
const REPEAT_DELAY = 20; // 初回リピートまでのフレーム数 (≈333ms)
const REPEAT_SLOW = 6; // ステージ 1: 遅い間隔 (≈100ms)
const REPEAT_FAST = 2; // ステージ 2: 速い間隔 (≈33ms)
const ACCEL_AFTER = 60; // 加速までのフレーム数 (DELAY+この値 ≈ 1.3s)

/**
 * リピートステートを更新し、発火すべきなら true を返す。
 * 毎フレーム 1 回呼ぶ。
 * @param {string} key       チェックするキーコード
 * @param {boolean} accel    true なら 2 段階加速、false なら一定速度
 * @returns {boolean}
 */
export function tickRepeat(key, accel) {
  if (Ports.keyDown(key)) {
    _repeatKey = key;
    _repeatHeld = 0;
    _repeatCooldown = REPEAT_DELAY;
    return true;
  }
  if (_repeatKey === key && Ports.keyHeld(key)) {
    _repeatHeld++;
    _repeatCooldown--;
    if (_repeatCooldown <= 0) {
      const interval =
        accel && _repeatHeld >= REPEAT_DELAY + ACCEL_AFTER
          ? REPEAT_FAST
          : REPEAT_SLOW;
      _repeatCooldown = interval;
      return true;
    }
    return false;
  }
  if (_repeatKey === key) {
    _repeatKey = null;
    _repeatHeld = 0;
  }
  return false;
}

/** キーリピート状態をリセットする (フォーカス変更時等) */
export function resetRepeatKey() {
  _repeatKey = null;
  _repeatHeld = 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ポップアップ描画リスト (ウィンドウ外に描画するための遅延バッチ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {{ dd: object, ax: number, ay: number }[]} */
const _popupDrawList = [];

/** ポップアップを描画リストに追加する */
export function pushPopup(entry) {
  _popupDrawList.push(entry);
}

/**
 * ポップアップ描画リストを描画・クリアする。
 * wmDraw() の全ウィンドウ描画後に呼ぶ。
 */
export function flushPopups() {
  for (const p of _popupDrawList) {
    p.dd.drawPopupAbsolute(p.ax, p.ay);
  }
  _popupDrawList.length = 0;
}

/** ポップアップが展開中か */
let _popupActive = false;

/** 現在ポップアップが開いているかを返す */
export function hasOpenPopup() {
  return _popupActive;
}

/** ポップアップのアクティブ状態を設定する */
export function setPopupActive(val) {
  _popupActive = val;
}

// ── ポップアップ所有グループ (全面オーバーレイ入力ルーティング用) ──
//
// ポップアップは flushPopups() でウィンドウ/ウィジェット領域の外まで全面に
// オーバーレイ描画される。一方アプリの入力は領域ごとにルーティングされうる
// (例: TESSERA の出力パネル vs PREVIEW)。この非対称があると、ポップアップが
// ウィジェット領域外へ張り出した部分の項目をホバー/クリックできない。
//
// それを根本から解くため、ポップアップを開いている WidgetGroup と、その最終
// 描画原点 (絶対座標) を登録しておき、WM が画面座標のイベントを「描画と対称に」
// 所有グループへ直接配信する (dispatchPopupInput)。アプリの領域分岐は介さない。

/** @type {{ update: function } | null} ポップアップを開いている WidgetGroup */
let _popupOwner = null;
/** @private 所有グループの最終描画原点 (絶対座標) */
let _popupOriginX = 0;
let _popupOriginY = 0;

/**
 * ポップアップ所有グループとその描画原点 (絶対座標) を登録する。
 * WidgetGroup.draw() が、開いているポップアップを検出したときに呼ぶ。
 * @param {{ update: function }} group  所有 WidgetGroup
 * @param {number} originX  最終描画原点 X (絶対座標)
 * @param {number} originY  最終描画原点 Y (絶対座標)
 */
export function setPopupOwner(group, originX, originY) {
  _popupOwner = group;
  _popupOriginX = originX;
  _popupOriginY = originY;
}

/**
 * 展開中ポップアップの所有グループへ、画面座標のイベントを直接配信する。
 *
 * グループが update() で期待するローカル座標は「画面座標 − 描画原点」に一致する
 * (draw の原点と update のローカル座標原点は常に同一)。よって描画原点さえ
 * 覚えておけば、領域ルーティングを経由せず正しい座標で配信できる。
 *
 * @param {number} screenX  画面 (VRAM) 絶対 X
 * @param {number} screenY  画面 (VRAM) 絶対 Y
 * @param {object} evBase  type 等を含むイベントの素
 * @returns {boolean}  所有グループへ配信したら true (未登録なら false)
 */
export function dispatchPopupInput(screenX, screenY, evBase) {
  if (!_popupOwner) return false;
  _popupOwner.update({
    ...evBase,
    localX: screenX - _popupOriginX,
    localY: screenY - _popupOriginY,
  });
  return true;
}

/** テキスト入力系ウィジェットにフォーカスがあるかを返す */
export function hasTextInputFocus() {
  return _focusedWidget !== null && _focusedWidget.isTextInput;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  テキスト入力ヘルパー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Shift キーが押されているか */
export function shiftHeld() {
  return Ports.keyHeld("ShiftLeft") || Ports.keyHeld("ShiftRight");
}

/** Ctrl キーが押されているか */
export function ctrlHeld() {
  return Ports.keyHeld("ControlLeft") || Ports.keyHeld("ControlRight");
}

// ── 文字カテゴリ & 単語境界ヘルパー ──
// 定義は純粋モジュール char_category.js に置き、ここは互換のため再 export する
// (TextEditModel など Ports 非依存で使いたい側が直接 import できるように)。
export { CAT_WORD, CAT_SPACE, CAT_PUNCT, charCat } from "./char_category.js";

/** クリップボードにテキストを書き込む (非同期, fire-and-forget) */
export function clipboardWrite(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

