/**
 * @module ui/widgets/VfsBrowser
 * VfsBrowser.js — VFS ツリーブラウジング コンポジットウィジェット
 *
 * 仮想ファイルシステム (VFS) のツリーを TreeView で表示する再利用可能コンポーネント。
 * Files アプリとファイルダイアログ (Save/Open) の共通基盤。
 *
 * ── 責務 ──
 *   - expandedMap (パス → 展開状態) の管理
 *   - flattenTree() → TreeView items への変換
 *   - 展開 / 折りたたみ / 選択 / ダブルクリック起動
 *   - 拡張子フィルタ (filter オプション)
 *   - ファイル非表示モード (dirsOnly オプション)
 *   - フォルダ新規作成 (createFolder)
 *   - D&D によるファイル移動 (enableDragDrop オプション)
 *
 * ── 使用例 ──
 *   // Files (フル機能)
 *   const browser = new VfsBrowser(236, 12, {
 *     onSelect:   (path, item) => { ... },
 *     onActivate: (path, item) => { ... },
 *     enableDragDrop: true,
 *   });
 *
 *   // FileDialog (フィルタ付き, D&D なし)
 *   const browser = new VfsBrowser(200, 8, {
 *     filter: [".pbm"],
 *     onSelect: (path, item) => { ... },
 *   });
 */

import { FocusableWidget } from "../FocusableWidget.js";
import { TreeView } from "./TreeView.js";
import * as VFS from "../../core/vfs.js";

export class VfsBrowser extends FocusableWidget {
  /**
   * @param {number} w  幅 (px)
   * @param {number} visibleRows  表示行数
   * @param {object} [opts]
   * @param {string[]} [opts.filter]         拡張子フィルタ (例: [".pbm", ".txt"])。null で全表示
   * @param {boolean}  [opts.dirsOnly]       true ならファイルを非表示 (ディレクトリのみ)
   * @param {boolean}  [opts.enableDragDrop] true なら D&D によるファイル移動を有効化
   * @param {boolean}  [opts.collapseByDefault] true なら初期はルート "/" だけ展開（開いたフォルダのみ展開）
   * @param {string}   [opts.initialPath]    初期選択パス (デフォルト: "/")
   * @param {(path: string, item: object) => void} [opts.onSelect]   選択変更コールバック
   * @param {(path: string, item: object) => void} [opts.onActivate] ダブルクリック/Enter コールバック
   */
  constructor(w, visibleRows, opts = {}) {
    // TreeView 計算で確定する高さは TreeView コンストラクタに委ねるため、暫定 0
    super(0, 0, w, 0);

    /** @type {string[]|null} 拡張子フィルタ (小文字, ドット付き) */
    this._filter = opts.filter ? opts.filter.map((f) => f.toLowerCase()) : null;

    /** @type {boolean} ディレクトリのみ表示 */
    this._dirsOnly = opts.dirsOnly || false;

    /** @type {boolean} D&D 有効 */
    this._enableDragDrop = opts.enableDragDrop || false;

    /** @type {boolean} 既定で畳む（true なら開いたフォルダだけ展開＝ルートだけ開く初期表示） */
    this._defaultExpanded = !opts.collapseByDefault;

    /** @type {(path: string, item: object) => void|null} */
    this._onSelect = opts.onSelect || null;

    /** @type {(path: string, item: object) => void|null} */
    this._onActivate = opts.onActivate || null;

    /** @type {Object.<string, boolean>} パス → 展開状態 */
    this._expandedMap = { "/": true };

    // 初期パス展開
    if (opts.initialPath && opts.initialPath !== "/") {
      this._expandToPath(opts.initialPath);
    }

    /** @type {Array} フラットリスト (TreeView items 形式) */
    this._items = this._rebuildItems();

    /** @type {TreeView} 内部 TreeView */
    this._treeView = new TreeView(
      0,
      0,
      w,
      visibleRows,
      this._items,
      (idx, item) => this._handleSelect(idx, item),
      (idx, item) => this._handleActivate(idx, item),
      (idx, item) => this._handleToggle(idx, item),
    );

    if (this._enableDragDrop) {
      this._treeView.onDrop = (srcIdx, destIdx) =>
        this._handleDrop(srcIdx, destIdx);
    }

    // Widget のサイズを TreeView に合わせる
    this.w = this._treeView.w;
    this.h = this._treeView.h;

    // 初期パスを選択
    if (opts.initialPath) {
      const initIdx = this._items.findIndex(
        (it) => it.path === opts.initialPath,
      );
      if (initIdx >= 0) {
        this._treeView.selectedIndex = initIdx;
        // 初期フォルダはツリー最上部に置く（見栄え。例: OPEN 時の /Sketches）。
        this._treeView.scrollToIndex(initIdx);
      }
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  公開 API
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** 現在選択中のパスを返す */
  selectedPath() {
    const idx = this._treeView.selectedIndex;
    if (idx >= 0 && idx < this._items.length) {
      return this._items[idx].path;
    }
    return "/";
  }

  /** 現在選択中のアイテムを返す ({path, type, label, ...} or null) */
  selectedItem() {
    const idx = this._treeView.selectedIndex;
    if (idx >= 0 && idx < this._items.length) {
      return this._items[idx];
    }
    return null;
  }

  /**
   * 選択中のディレクトリ (ファイル選択時はその親) の直下に新規フォルダを作成する。
   * @returns {string|null} 作成されたフォルダのパス (失敗時 null)
   */
  createFolder() {
    const sel = this.selectedItem();
    if (!sel) return null;

    const dir = sel.type === "dir" ? sel.path : VFS.parentPath(sel.path);

    let name = "New Folder";
    let i = 1;
    while (VFS.stat(VFS.joinPath(dir, name))) {
      name = `New Folder ${i}`;
      i++;
    }

    VFS.mkdir(VFS.joinPath(dir, name));

    this._expandedMap[dir] = true;
    this.refresh();

    const newPath = VFS.joinPath(dir, name);
    const newIdx = this._items.findIndex((it) => it.path === newPath);
    if (newIdx >= 0) {
      this._treeView.selectedIndex = newIdx;
      this._treeView.ensureVisible(newIdx);
    }
    return newPath;
  }

  /**
   * VFS の現在の状態でツリーを再構築する。
   * 外部からファイル操作を行った後に呼ぶ。
   */
  refresh() {
    this._items = this._rebuildItems();
    this._treeView.items = this._items; // setter がスクロール長を自動同期
    if (this._treeView.selectedIndex >= this._items.length) {
      this._treeView.selectedIndex = Math.max(0, this._items.length - 1);
    }
  }

  /**
   * 指定パスを選択し、そこまでのツリーを展開する。
   * @param {string} path 選択するパス
   */
  selectPath(path) {
    this._expandToPath(path);
    this.refresh();
    const idx = this._items.findIndex((it) => it.path === path);
    if (idx >= 0) {
      this._treeView.selectedIndex = idx;
      this._treeView.ensureVisible(idx);
    }
  }

  /**
   * 指定インデックスが表示領域に入るようスクロールする。
   * @param {number} idx
   */
  ensureVisible(idx) {
    this._treeView.ensureVisible(idx);
  }

  /** 内部 items 配列への参照 (Files 互換用) */
  get items() {
    return this._items;
  }

  /** 内部 TreeView の selectedIndex (Files 互換用) */
  get selectedIndex() {
    return this._treeView.selectedIndex;
  }

  set selectedIndex(v) {
    this._treeView.selectedIndex = v;
  }

  /** 展開状態マップへの参照 (Files 互換用) */
  get expandedMap() {
    return this._expandedMap;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Widget インターフェース
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** @override */
  get focusable() {
    return true;
  }

  /** @override */
  remeasure() {
    this._treeView.remeasure();
    this.w = this._treeView.w;
    this.h = this._treeView.h;
  }

  /** @override */
  get cursorName() {
    return "pointer";
  }

  /** @override */
  draw(contentRect) {
    // TreeView の座標を自身に同期
    this._treeView.x = this.x;
    this._treeView.y = this.y;
    this._treeView.draw(contentRect);
  }

  /** @override */
  update(ev) {
    this._treeView.x = this.x;
    this._treeView.y = this.y;
    this._treeView.update(ev);
  }

  /** @override */
  handleKey() {
    return this._treeView.handleKey();
  }

  /** @override */
  resetDragState() {
    this._treeView.resetDragState();
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  内部ヘルパー
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * flattenTree() を呼び出してフィルタを適用し、TreeView items を構築する。
   * @returns {Array}
   */
  _rebuildItems() {
    const flat = VFS.flattenTree(this._expandedMap, this._defaultExpanded);
    return flat
      .filter((entry) => {
        // ディレクトリは常に表示
        if (entry.type === "dir") return true;
        // ファイル非表示モード
        if (this._dirsOnly) return false;
        // 拡張子フィルタ
        if (this._filter) {
          const ext = _getExtension(entry.name);
          return this._filter.includes(ext);
        }
        return true;
      })
      .map((entry) => ({
        label: entry.name,
        depth: entry.depth,
        expanded: entry.expanded,
        hasChildren: entry.type === "dir",
        path: entry.path,
        type: entry.type,
      }));
  }

  /**
   * 指定パスまでの全祖先ディレクトリを展開する。
   * @param {string} path
   */
  _expandToPath(path) {
    const parts = path.split("/").filter(Boolean);
    let current = "/";
    this._expandedMap["/"] = true;
    for (const part of parts) {
      current = current === "/" ? "/" + part : current + "/" + part;
      this._expandedMap[current] = true;
    }
  }

  // ── TreeView コールバック ──

  _handleSelect(idx, item) {
    if (this._onSelect && item) {
      this._onSelect(item.path, item);
    }
  }

  _handleActivate(idx, item) {
    if (this._onActivate && item) {
      this._onActivate(item.path, item);
    }
  }

  _handleToggle(idx, item) {
    if (item && item.hasChildren) {
      this._expandedMap[item.path] = !item.expanded;
      this.refresh();
    }
  }

  _handleDrop(srcIdx, destIdx) {
    const src = this._items[srcIdx];
    const dest = this._items[destIdx];
    if (!src || !dest) return;
    if (src.path === "/") return;

    const destDir = dest.type === "dir" ? dest.path : VFS.parentPath(dest.path);
    const destPath = VFS.joinPath(destDir, VFS.basename(src.path));

    if (src.path === destPath) return;

    if (VFS.move(src.path, destPath)) {
      this._expandedMap[destDir] = true;
      this.refresh();

      const newIdx = this._items.findIndex((it) => it.path === destPath);
      if (newIdx >= 0) {
        this._treeView.selectedIndex = newIdx;
        this._treeView.ensureVisible(newIdx);
      }
    }
  }
}

// ── ユーティリティ (モジュール内) ──

/** ファイル名から拡張子を取得 (小文字, 例: ".txt") */
function _getExtension(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot).toLowerCase();
}

