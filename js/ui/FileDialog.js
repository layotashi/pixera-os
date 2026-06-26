/**
 * @module ui/FileDialog
 * FileDialog.js — 汎用ファイルダイアログ (Save / Open)
 *
 * VfsBrowser を内蔵したモーダルウィンドウを開き、
 * ユーザーがファイルを選択 (Open) またはファイル名を指定 (Save) できる。
 *
 * ── 使用例 ──
 *   import { openFileDialog } from "../ui/FileDialog.js";
 *
 *   // Save
 *   openFileDialog("save", {
 *     title:       "SAVE AS",
 *     defaultPath: "/Pictures/Wallpapers",
 *     defaultName: "art.pbm",
 *     filter:      [".pbm"],
 *     onResult:    (path) => { if (path) writeFile(path, data); },
 *   });
 *
 *   // Open
 *   openFileDialog("open", {
 *     title:    "OPEN",
 *     filter:   [".pbm", ".txt"],
 *     onResult: (path) => { if (path) loadFile(path); },
 *   });
 */

import { wmOpen, wmClose } from "../wm/index.js";
import { VfsBrowser } from "./widgets/VfsBrowser.js";
import { PushButton } from "./widgets/PushButton.js";
import { TextBox } from "./widgets/TextBox.js";
import { Label } from "./widgets/Label.js";
import { WidgetGroup } from "./WidgetGroup.js";
import { HBox, VBox } from "./layout.js";
import { FOCUS_MARGIN } from "./ui_constants.js";
import { buttonIconWidth, buttonIconHeight, setFocused } from "./ui_helpers.js";
import { keyDown } from "./ports.js";
import { joinPath, parentPath } from "../core/vfs.js";

// ── 定数 ──

/** ツリー幅 (px) */
const DIALOG_TREE_W = 200;
/** ツリー表示行数 */
const DIALOG_TREE_ROWS = 8;
/** 行間 */
const DIALOG_GAP = 4;

/** 現在開いている FileDialog の WM ID (二重起動防止) */
let _dialogWinId = null;

/**
 * ファイルダイアログを開く。
 *
 * @param {"save"|"open"} mode  モード
 * @param {object} opts
 * @param {string}   [opts.title]        ダイアログタイトル (デフォルト: "SAVE AS" / "OPEN")
 * @param {string}   [opts.defaultPath]  初期ディレクトリ (デフォルト: "/")
 * @param {string}   [opts.defaultName]  初期ファイル名 (save 時のみ)
 * @param {string[]} [opts.filter]       拡張子フィルタ (例: [".pbm"])
 * @param {(path: string|null) => void} opts.onResult  結果コールバック (Cancel 時は null)
 */
export function openFileDialog(mode, opts = {}) {
  // 二重起動防止
  if (_dialogWinId !== null) return;

  const isSave = mode === "save";
  const title = opts.title || (isSave ? "SAVE AS" : "OPEN");
  const defaultPath = opts.defaultPath || "/";
  const defaultName = opts.defaultName || "";
  const filter = opts.filter || null;
  const onResult = opts.onResult || (() => {});

  // ── VfsBrowser ──
  const browser = new VfsBrowser(DIALOG_TREE_W, DIALOG_TREE_ROWS, {
    filter: filter,
    initialPath: defaultPath,
    onSelect: (path, item) => {
      // ファイル選択時に TextBox へ名前を反映 (Save モード)
      if (isSave && item && item.type === "file") {
        txtName.text = item.label;
        txtName.cursor = item.label.length;
        txtName.selectionAnchor = null;
      }
    },
    onActivate: (path, item) => {
      if (!item) return;
      if (item.type === "file") {
        // ファイルダブルクリック → 確定
        if (isSave) {
          txtName.text = item.label;
          txtName.cursor = item.label.length;
          txtName.selectionAnchor = null;
        }
        confirm();
      }
      // ディレクトリダブルクリックは VfsBrowser 内で展開処理される
    },
  });

  // ── ファイル名入力 (Save モードのみ) ──
  const lblName = new Label(0, 0, "Name:");
  const txtName = new TextBox(
    0,
    0,
    24, // widthChars
    128, // maxLength
    defaultName,
    null, // onChange
  );
  if (defaultName) {
    txtName.cursor = defaultName.length;
  }

  // ── ボタン ──
  const btnNewFolder = new PushButton(0, 0, "", () => {
    browser.createFolder();
  });
  btnNewFolder.icon = "add-folder";
  btnNewFolder.w = buttonIconWidth();
  btnNewFolder.h = buttonIconHeight();
  btnNewFolder.tooltip = "New Folder";
  const btnOk = new PushButton(0, 0, "OK", confirm);
  const btnCancel = new PushButton(0, 0, "CANCEL", cancel);

  let dialogRoot;
  if (isSave) {
    const nameRow = HBox([lblName, txtName]);
    const buttonRow = HBox([btnNewFolder, btnOk, btnCancel]);
    dialogRoot = VBox([browser, nameRow, buttonRow], DIALOG_GAP);
  } else {
    const buttonRow = HBox([btnOk, btnCancel]);
    dialogRoot = VBox([browser, buttonRow], DIALOG_GAP);
  }

  dialogRoot.layout(FOCUS_MARGIN, FOCUS_MARGIN);

  // ボタン行を右揃え
  const lastChild = dialogRoot.children[dialogRoot.children.length - 1];
  if (lastChild.w < browser.w) {
    lastChild.children.forEach((b) => {
      b.x += browser.w - lastChild.w;
    });
  }

  const dialogGroup = new WidgetGroup(dialogRoot.leaves());

  // Save モードではファイル名 TextBox に初期フォーカスを設定
  if (isSave) setFocused(txtName);

  // ── 結果の組み立て ──

  /**
   * 選択中のディレクトリパスを返す。
   * ファイルが選択中ならその親ディレクトリ。
   */
  function getSelectedDir() {
    const sel = browser.selectedItem();
    if (!sel) return defaultPath;
    return sel.type === "dir" ? sel.path : parentPath(sel.path);
  }

  /**
   * OK 押下時の処理。
   * Save: dir + ファイル名 → フルパスを返す。
   * Open: 選択中のファイルパスを返す。
   */
  function confirm() {
    let resultPath = null;

    if (isSave) {
      const name = txtName.text.trim();
      if (!name) return; // 名前が空なら無視
      const dir = getSelectedDir();
      resultPath = joinPath(dir, name);
    } else {
      // Open モード: ファイルが選択されている場合のみ
      const sel = browser.selectedItem();
      if (!sel || sel.type !== "file") return;
      resultPath = sel.path;
    }

    close();
    onResult(resultPath);
  }

  function cancel() {
    close();
    onResult(null);
  }

  function close() {
    if (_dialogWinId !== null) {
      wmClose(_dialogWinId);
      _dialogWinId = null;
    }
  }

  // ── WM コールバック ──

  function onDraw(contentRect) {
    dialogGroup.draw(contentRect);
  }

  function onInput(ev) {
    dialogGroup.update(ev);
    if (keyDown("Enter")) confirm();
    if (keyDown("Escape")) cancel();
  }

  function onMeasure() {
    return dialogRoot.measure();
  }

  // ── モーダルウィンドウを開く ──
  _dialogWinId = wmOpen(-1, -1, 0, 0, title, onDraw, onInput, onMeasure, {
    modal: true,
    noResize: true,
    center: true,
    onBeforeClose: () => {
      // × ボタンで閉じた場合もキャンセル扱い
      _dialogWinId = null;
      onResult(null);
      return true;
    },
  });
}

