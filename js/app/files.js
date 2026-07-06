/**
 * @module app/files
 * files.js — FILES ウィンドウ
 *
 * 仮想ファイルシステム (VFS) の内容をツリー表示し、
 * ファイル / フォルダの基本操作を提供するファイルマネージャ。
 *
 * 構成:
 *   - ツールバー: New File / New Folder / Rename / Delete ボタン
 *   - TreeView: フォルダ構造をツリー表示
 *   - footer: 選択中アイテム情報
 *   - Rename ダイアログ: 名前変更時に Dialog API (openPromptDialog) で表示
 *
 * ファイル関連付け:
 *   - .txt, .md, .log → Notepad
 *   - .pbm            → Paint
 *
 * キーボードショートカット:
 *   ↑↓        選択移動
 *   ←→        折りたたみ / 展開
 *   Enter      フォルダ展開 / ファイル起動
 *   Delete     選択アイテム削除
 *   F2         リネーム (モーダルダイアログを表示)
 */

import { wmOpen, wmRegister } from "../wm/index.js";
import * as UI from "../ui/index.js";
import { drawText, GLYPH_W, GLYPH_H } from "../core/font.js";
import { keyDown } from "../core/input.js";
import * as VFS from "../core/vfs.js";
import { notepadOpenFile } from "./notepad.js";
import { tesseraOpenFile } from "./tessera.js";
import { paintOpenFile } from "./paint.js";

const APP_NAME = "FILES";

// VFS の初期化は kernel.js の boot() が一括で行う。ここで副作用 import 的に
// 呼ぶと初期化順序が import 順に依存するため呼ばない (規約: 副作用 import は
// wmRegister 登録のみ)。

// ── 定数 ──
const TREE_W = 236; // ツリー幅 (px)
const TREE_ROWS = 12; // 表示行数

// ── ファイル関連付けマップ ──
/**
 * 拡張子 → アプリ名のマッピング。
 * アプリ名は handler 関数のキーとして使用する。
 */
const FILE_ASSOC = {
  ".txt": "NOTEPAD",
  ".md": "NOTEPAD",
  ".log": "NOTEPAD",
  ".pbm": "PAINT",
  ".tess": "TESSERA",
};

/** 拡張子に応じたオープンハンドラ */
const FILE_HANDLERS = {
  NOTEPAD: notepadOpenFile,
  PAINT: paintOpenFile,
  TESSERA: tesseraOpenFile,
};

/** ファイル名から拡張子を取得 (小文字, 例: ".txt") */
function getExtension(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot).toLowerCase();
}

// ── VfsBrowser インスタンス (遅延初期化) ──
/** @type {UI.VfsBrowser|null} */
let browser = null;

/** VfsBrowser の選択中アイテムを返す (旧 selectedItem 互換) */
function selectedItem() {
  return browser ? browser.selectedItem() : null;
}

/** VfsBrowser のツリーを再構築する (旧 refreshTree 互換) */
function refreshTree() {
  if (browser) browser.refresh();
}

// ── 操作: 新規ファイル ──
function doNewFile() {
  const sel = selectedItem();
  if (!sel) return;

  // 選択中がディレクトリならその中に、ファイルなら親に作成
  const dir = sel.type === "dir" ? sel.path : VFS.parentPath(sel.path);

  // ユニーク名を生成
  let name = "new_file.txt";
  let i = 1;
  while (VFS.stat(VFS.joinPath(dir, name))) {
    name = `new_file_${i}.txt`;
    i++;
  }

  VFS.writeFile(VFS.joinPath(dir, name), "");

  // 親フォルダを展開してツリー更新
  browser.expandedMap[dir] = true;
  refreshTree();

  // 新規ファイルを選択
  const newPath = VFS.joinPath(dir, name);
  browser.selectPath(newPath);
}

// ── 操作: 新規フォルダ ──
function doNewFolder() {
  browser.createFolder();
}

// ── 操作: リネーム (Dialog API) ──

function doStartRename() {
  const sel = selectedItem();
  if (!sel || sel.path === "/") return; // ルートはリネーム不可

  UI.openPromptDialog("NAME:", {
    title: "RENAME",
    defaultValue: sel.label,
    selectBaseName: true,
    maxLength: 64,
    widthChars: 20,
    onResult: (value) => {
      if (value !== null && value !== sel.label) {
        VFS.rename(sel.path, value);
        refreshTree();
      }
    },
  });
}

// ── 操作: 削除 ──
function doDelete() {
  const sel = selectedItem();
  if (!sel || sel.path === "/") return; // ルートは削除不可

  if (sel.type === "dir") {
    // ディレクトリは中身ごと再帰削除 (空なら通常削除と同じ)
    VFS.remove(sel.path, { recursive: true });
  } else {
    VFS.remove(sel.path);
  }
  refreshTree();
}

// ── ウィジェット生成 (遅延初期化) ──

let btnNewFile;
let btnNewFolder;
let btnRename;
let btnDelete;
let mainGroup;
let root;
let _ready = false;

function _initWidgets() {
  if (_ready) return;
  _ready = true;

  // ── VfsBrowser ──
  browser = new UI.VfsBrowser(TREE_W, TREE_ROWS, {
    enableDragDrop: true,
    collapseByDefault: true, // 初期はルート / だけ開く（全展開だと目的を探しにくい）
    onActivate: (path, item) => {
      if (!item || item.type !== "file") return;
      const ext = getExtension(item.label);
      const appName = FILE_ASSOC[ext];
      if (!appName) return;
      const handler = FILE_HANDLERS[appName];
      if (handler) handler(path);
    },
  });

  // ツールバー
  const iconW = UI.buttonIconWidth();
  const iconH = UI.buttonIconHeight();

  btnNewFile = new UI.PushButton(0, 0, "", doNewFile);
  btnNewFile.icon = "add-file";
  btnNewFile.w = iconW;
  btnNewFile.h = iconH;
  btnNewFile.tooltip = "New File";

  btnNewFolder = new UI.PushButton(0, 0, "", doNewFolder);
  btnNewFolder.icon = "add-folder";
  btnNewFolder.w = iconW;
  btnNewFolder.h = iconH;
  btnNewFolder.tooltip = "New Folder";

  btnRename = new UI.PushButton(0, 0, "", doStartRename);
  btnRename.icon = "rename";
  btnRename.w = iconW;
  btnRename.h = iconH;
  btnRename.tooltip = "Rename";

  btnDelete = new UI.PushButton(0, 0, "", doDelete);
  btnDelete.icon = "trash";
  btnDelete.w = iconW;
  btnDelete.h = iconH;
  btnDelete.tooltip = "Delete";

  // ── Box レイアウト ──
  const toolbarRow = UI.HBox([btnNewFile, btnNewFolder, btnRename, btnDelete]);
  root = UI.VBox([toolbarRow, browser]);

  // WidgetGroup(root) は初期 layout + auto-layout を実行
  mainGroup = new UI.WidgetGroup(root);
}

// ── 描画 ──
function onDraw(contentRect) {
  mainGroup.draw(contentRect);
}

// ── footer 描画 ──
function onDrawFooter(footerRect) {
  const sel = selectedItem();
  if (!sel) {
    drawText(footerRect.x, footerRect.y, "No selection", 1);
    return;
  }

  const typeStr = sel.type === "dir" ? "[DIR]" : "[FILE]";
  const info = VFS.stat(sel.path);
  let left = `${typeStr} ${sel.path}`;
  let right = "";

  if (info) {
    if (sel.type === "file") {
      right = `${info.size} bytes`;
    } else {
      right = `${info.childCount} items`;
    }
  }

  // 左寄せ: パス情報
  const maxLeftW = footerRect.w - UI.textWidth(right) - 8;
  if (UI.textWidth(left) > maxLeftW) {
    // 長すぎる場合は切り詰め
    const maxChars = ((maxLeftW / (GLYPH_W + 1)) | 0) - 3;
    if (maxChars > 0) {
      left = left.substring(0, maxChars) + "...";
    }
  }
  drawText(footerRect.x, footerRect.y, left, 1);

  // 右寄せ
  if (right) {
    const rw = UI.textWidth(right);
    drawText(footerRect.x + footerRect.w - rw, footerRect.y, right, 1);
  }
}

// ── 入力 ──
function onInput(ev) {
  mainGroup.update(ev);

  // Delete キー
  if (keyDown("Delete")) doDelete();
  // F2 キー
  if (keyDown("F2")) doStartRename();
}

// ── サイズ計測 ──
function onMeasure() {
  return root.measure();
}

// ── 登録 ──
wmRegister(APP_NAME, () => {
  _initWidgets();
  return wmOpen(-1, -1, 0, 0, APP_NAME, onDraw, onInput, onMeasure, {
    about:
      "A file manager for the virtual filesystem. Browse the tree and " +
      "create, rename, move, or delete files and folders.",
    footer: true,
    onDrawFooter,
    onRelayout: () => {
      mainGroup.remeasureAll();
      root.layout(UI.FOCUS_MARGIN, UI.FOCUS_MARGIN);
    },
  });
});

