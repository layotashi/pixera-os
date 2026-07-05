/**
 * @module app/notepad
 * notepad.js — NOTEPAD ウィンドウ
 *
 * テキスト編集用のメモ帳ウィンドウ。
 * 今後 live coding 環境へ拡張する土台となる。
 *
 * 構成:
 *   - TextArea: メイン編集領域
 *   - footer (WM 管理): Ln:Col / 文字数 / 行数
 *
 * VFS 連携:
 *   - Ctrl+N: 新規作成 (未保存確認あり)
 *   - Ctrl+O: ファイルを開く (未保存確認あり)
 *   - Ctrl+S: 上書き保存 (パスが無い場合は Save As にフォールバック)
 *   - Ctrl+Shift+S: 名前を付けて保存 (FileDialog)
 *   - notepadOpenFile(path): Explorer 等の外部モジュールからファイルを開く
 */

import * as WM from "../wm/index.js";
import { WidgetGroup, openFileDialog, openConfirmDialog } from "../ui/index.js";
import { NotepadEditor } from "./notepad_editor.js";
import { drawText, textWidth } from "../core/font.js";
import { ctrlDown, ctrlShiftDown, altDown } from "../core/input.js";
import * as VFS from "../core/vfs.js";

const APP_NAME = "NOTEPAD";

// ── 定数 ──
const MAX_LINES = 9999; // 最大行数
// editor-as-body ウィンドウの既定外寸 (px)。ボディいっぱいにエディタがフィルするので
// これは「開いたときの初期サイズ」の意味。Maximize/リサイズには自動追従する。
const NOTEPAD_W = 272;
const NOTEPAD_H = 240;

// ── Welcome テキスト ──
const WELCOME_TEXT = `\
========================================
  SYNESTA NOTEPAD
========================================

  Welcome!

  This is a notepad for notes and
  (in the future) live coding.

  You can freely type, edit, and
  experiment here.

----------------------------------------
  KEYBOARD SHORTCUTS
----------------------------------------

  File
    Alt+N       New file
    Ctrl+O      Open file
    Ctrl+S      Save
    Ctrl+Shift+S  Save As

  General
    Tab         Insert 4 spaces
    Esc         Unfocus editor

  Navigation
    Arrow keys  Move cursor
    Home / End  Line start / end
    Ctrl+Left   Word jump left
    Ctrl+Right  Word jump right

  Selection
    Shift+Arrow    Stream select
    Shift+Home     Select to line start
    Shift+End      Select to line end
    Ctrl+Shift+Left/Right  Word select
    Middle drag    Box (column) select

  Editing
    Ctrl+A      Select all
    Ctrl+C      Copy
    Ctrl+X      Cut
    Ctrl+V      Paste
    Ctrl+BkSp   Delete word left
    Ctrl+Del    Delete word right

  Mouse
    Left click    Place cursor
    Left drag     Stream select
    Double click  Select word
    Wheel         Scroll

----------------------------------------

  Tip: Whitespace is visible --
  spaces appear as centered dots.

  Happy hacking!
`;

// ── ファイル状態 ──
/** 現在開いているファイルの VFS パス (null = 無題) */
let currentFilePath = null;
/** 最後に保存した時点から変更があるか */
let isDirty = false;
/** wmOpen が返したウィンドウ ID */
let winId = null;

// ── ウィジェット (遅延初期化) ──
let textAreaEditor;
let group;
let _ready = false;

function _initWidgets() {
  if (_ready) return;
  _ready = true;
  textAreaEditor = new NotepadEditor(MAX_LINES, WELCOME_TEXT, () => {
    isDirty = true;
    refreshTitle();
  });
  // 配列形式の WidgetGroup（自動レイアウト無し）。フォーカス/キーボード配信のみ担い、
  // 位置・サイズは onDraw でボディ矩形に合わせる（editor-as-body）。
  group = new WidgetGroup([textAreaEditor]);
}

// ── タイトル更新 ──
function refreshTitle() {
  if (winId === null) return;
  const name = currentFilePath ? VFS.basename(currentFilePath) : "UNTITLED";
  const dirty = isDirty ? "* " : "";
  WM.wmSetTitle(winId, `${dirty}${name} - ${APP_NAME}`);
}

// ── 状態リセット ──
function resetState() {
  currentFilePath = null;
  isDirty = false;
  setEditorText(WELCOME_TEXT);
  refreshTitle();
}

// ── 未保存確認 → コールバック実行 ──
function confirmDiscard(callback) {
  if (!isDirty) {
    callback();
    return;
  }
  openConfirmDialog("DISCARD UNSAVED CHANGES?", {
    variant: "danger",
    onOk: callback,
  });
}

// ── 名前を付けて保存 ──
function saveFileAs() {
  const dir = currentFilePath
    ? VFS.parentPath(currentFilePath)
    : "/Documents";
  const name = currentFilePath
    ? VFS.basename(currentFilePath)
    : "untitled.txt";

  openFileDialog("save", {
    title: "SAVE AS",
    defaultPath: dir,
    defaultName: name,
    filter: [".txt"],
    onResult: (path) => {
      if (!path) return;
      currentFilePath = path;
      const content = textAreaEditor.lines.join("\n");
      VFS.writeFile(currentFilePath, content);
      isDirty = false;
      refreshTitle();
    },
  });
}

// ── 上書き保存 ──
function saveFile() {
  if (!currentFilePath) {
    saveFileAs();
    return;
  }
  const content = textAreaEditor.lines.join("\n");
  VFS.writeFile(currentFilePath, content);
  isDirty = false;
  refreshTitle();
}

// ── ファイルを開く ──
function openFile() {
  confirmDiscard(() => {
    openFileDialog("open", {
      title: "OPEN",
      filter: [".txt"],
      onResult: (path) => {
        if (!path) return;
        const content = VFS.readFile(path);
        if (content === null) return;
        setEditorText(content);
        currentFilePath = path;
        isDirty = false;
        refreshTitle();
      },
    });
  });
}

// ── 新規作成 ──
function newFile() {
  confirmDiscard(() => {
    setEditorText("");
    currentFilePath = null;
    isDirty = false;
    refreshTitle();
  });
}

// ── テキスト差し替え ──
function setEditorText(text) {
  const lines = String(text || "").split("\n");
  textAreaEditor.lines = lines;
  textAreaEditor.cursorRow = 0;
  textAreaEditor.cursorCol = 0;
  textAreaEditor.selAnchorRow = null;
  textAreaEditor.selAnchorCol = null;
  textAreaEditor.boxSel = null;
  textAreaEditor.scrollX = 0;
  textAreaEditor.setContentLength(lines.length);
  textAreaEditor.scrollToTop();
}

// ── 描画 ──
function onDraw(contentRect) {
  // ── キーボードショートカット (フォーカス中のみ) ──
  if (WM.wmIsFocused(winId)) {
    if (ctrlShiftDown("KeyS")) {
      saveFileAs();
    } else if (ctrlDown("KeyS")) {
      saveFile();
    } else if (ctrlDown("KeyO")) {
      openFile();
    } else if (altDown("KeyN")) {
      newFile();
    }
  }

  // editor-as-body: エディタをボディいっぱいにフィルさせて直接描画（枠・ブラケット無し）。
  textAreaEditor.x = 0;
  textAreaEditor.y = 0;
  textAreaEditor.w = contentRect.w;
  textAreaEditor.h = contentRect.h;
  textAreaEditor.draw(contentRect);
}

// ── footer 描画 ──
function onDrawFooter(fr) {
  const row = textAreaEditor.cursorRow + 1;
  const col = textAreaEditor.cursorCol + 1;
  const lines = textAreaEditor.lines.length;
  const chars =
    textAreaEditor.lines.reduce((sum, l) => sum + l.length, 0) +
    (textAreaEditor.lines.length - 1); // 改行文字分
  const selN = textAreaEditor.selectedCharCount();

  const left = `Ln ${row} : Col ${col}`;
  const right =
    (selN > 0 ? `Sel ${selN}  ` : "") + `${chars} chars  ${lines} lines`;

  drawText(fr.x, fr.y, left, 1);

  // 右寄せ
  const rw = textWidth(right);
  drawText(fr.x + fr.w - rw, fr.y, right, 1);
}

// ── 入力 ──
function onInput(ev) {
  group.update(ev);
}

// ── ウィンドウを閉じる前の未保存確認 ──
function onBeforeClose() {
  if (isDirty) {
    openConfirmDialog("DISCARD UNSAVED CHANGES?", {
      variant: "danger",
      onOk: () => {
        resetState();
        WM.wmClose(winId);
      },
    });
    return false;
  }
  resetState();
  return true;
}

// ── 登録 ──
WM.wmRegister(APP_NAME, () => {
  _initWidgets();
  // 既定外寸で開く（onMeasure 無し＝内容に合わせず自由にリサイズ可能）。
  // ボディはエディタが毎フレームフィルするので、Maximize でも余白が残らない。
  winId = WM.wmOpen(-1, -1, NOTEPAD_W, NOTEPAD_H, APP_NAME, onDraw, onInput, null, {
    footer: true,
    padding: "none", // editor-as-body: ボディ端まで使う（枠内側の余白を消す）
    onDrawFooter,
    onBeforeClose,
    about:
      "A plain text editor. Type to write, and save notes to the filesystem.",
  });
  return winId;
});

// ── 公開 API: 外部からファイルを開く ──

/**
 * 指定パスのファイルを Notepad で開く。
 * ウィンドウが閉じていれば自動的に開き、最前面に持ってくる。
 * @param {string} path  VFS 上のファイルパス
 * @returns {boolean} 読み込み成功なら true
 */
export function notepadOpenFile(path) {
  _initWidgets();
  const content = VFS.readFile(path);
  if (content === null) return false;

  // ウィンドウを開く / 最前面に出す
  WM.wmOpenOrFocus(APP_NAME);

  // テキストを差し替え
  setEditorText(content);
  currentFilePath = path;
  isDirty = false;
  refreshTitle();
  return true;
}
