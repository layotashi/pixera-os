/**
 * @module ui
 * index.js — UI モジュール ファサード
 *
 * Widget クラス群・WidgetGroup・ユーティリティ・Layout・Scrollbar の
 * すべてのパブリック API を re-export する。
 * 外部モジュールは `"../ui/index.js"` のみを import すればよい。
 *
 * ── 依存注入 (DI) ──
 *   initPorts() を呼んで描画・入力などの外部実装を注入すること。
 *   ウィジェットの生成・描画・更新はすべて initPorts() 呼び出し後に
 *   行わなければならない。
 */

import { _initPorts } from "./ports.js";
import { _computeDerivedConstants } from "./ui_helpers.js";

// ── ポート初期化 ──

/**
 * 描画・入力ポートの実装を注入し、派生定数を算出する。
 * ホスト (例: kernel.js) がブート時に 1 回呼ぶ。
 *
 * @param {{
 *   gpu:      { fillRect, drawRoundRect, drawRect, drawCheckerboard, hline, vline, pset, setClip, resetClip, pushClip, popClip },
 *   font:     { GLYPH_W, GLYPH_H, drawText },
 *   icon:     { ICON_W, ICON_H, drawIcon },
 *   input:    { keyDown, keyHeld, getCharQueue, getPasteText, mouseHasShift, ctrlDown },
 *   textIcon: { drawTextIcon },
 *   dither:   { BAYER_4x4, BAYER_8x8 },
 * }} ports
 */
export function initPorts(ports) {
  _initPorts(ports);
  _computeDerivedConstants();
}

// ── ウィジェット基底クラス ──
export { Widget } from "./Widget.js";
export { FocusableWidget } from "./FocusableWidget.js";

// ── ウィジェットグループ ──
export { WidgetGroup } from "./WidgetGroup.js";

// ── ウィジェットクラス ──
export { Label } from "./widgets/Label.js";
export { Link } from "./widgets/Link.js";
export { SectionLabel } from "./widgets/SectionLabel.js";
export { HSep } from "./widgets/HSep.js";
export { VSep } from "./widgets/VSep.js";
export { ButtonBase } from "./widgets/ButtonBase.js";
export { PushButton } from "./widgets/PushButton.js";
export { ToggleButton } from "./widgets/ToggleButton.js";
export { RadioButton } from "./widgets/RadioButton.js";
export { Slider } from "./widgets/Slider.js";
export { NumberBox } from "./widgets/NumberBox.js";
export { DropDown } from "./widgets/DropDown.js";
export { ListBox } from "./widgets/ListBox.js";
export { TreeView } from "./widgets/TreeView.js";
export { VfsBrowser } from "./widgets/VfsBrowser.js";
export { BayerPicker } from "./widgets/BayerPicker.js";
export { TextBox } from "./widgets/TextBox.js";
export { TextArea } from "./widgets/TextArea.js";
export { TabBar } from "./widgets/TabBar.js";

// ── ダイアログ ──
export { openFileDialog } from "./FileDialog.js";
export {
  openConfirmDialog,
  openPromptDialog,
  openAlertDialog,
  isDialogOpen,
  dialogSetSfxOnOpen,
} from "./Dialog.js";

// ── ユーティリティ ──
export {
  textWidth,
  buttonAutoWidth,
  buttonIconWidth,
  buttonIconHeight,
} from "./ui_helpers.js";

// ── 定数 ──
export { FOCUS_MARGIN, GAP, MIN_GAP, SECTION_PAD } from "./ui_constants.js";

// ── レイアウトコンテナ ──
export { Box, HBox, VBox, measureWidgets } from "./layout.js";

// ── スクロールバー プリミティブ ──
// scrollbar.js は内部モジュール。ウィジェットクラスおよび wm.js が
// 直接 import して使用する。consumer (app/) からの利用は不要。
// 各ウィジェットに setContentLength() / scrollToTop() / ensureVisible()
// メソッドを提供しているため、consumer はこれらを使うこと。

