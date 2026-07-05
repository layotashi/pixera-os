/**
 * @module core/vfs
 * vfs.js — 仮想ファイルシステム (VFS)
 *
 * localStorage ベースのツリー構造ファイルシステム。
 * レトロ PC 風デスクトップ環境のファイル管理基盤。
 *
 * ── パス規約 ──
 *   "/" が区切り文字。ルートは "/"。
 *   末尾 "/" は許容するが正規化で除去される。
 *   例: "/Documents/hello.txt"
 *
 * ── ストレージ ──
 *   ファイルツリー全体を 1 つの JSON として保存する。
 *   キー: "pixera.vfs"
 *
 * ── ノード構造 ──
 *   ディレクトリ: { type: "dir",  name, children: [], createdAt, modifiedAt }
 *   ファイル:     { type: "file", name, content: "", createdAt, modifiedAt, encoding?: "base64" }
 *
 *   encoding フィールド:
 *     省略 or "text"  — content は平文テキスト (従来互換)
 *     "base64"        — content は Base64 エンコードされたバイナリデータ
 */

import { save, load } from "./storage.js";

// ── 定数 ──

const VFS_KEY = "vfs";

// ── Base64 ユーティリティ ──

/**
 * ArrayBuffer → Base64 文字列に変換する。
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Base64 文字列 → ArrayBuffer に変換する。
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ── 初期ツリー ──

function createDefaultTree() {
  const now = Date.now();
  return {
    type: "dir",
    name: "",
    createdAt: now,
    modifiedAt: now,
    children: [
      {
        type: "dir",
        name: "Desktop",
        createdAt: now,
        modifiedAt: now,
        children: [],
      },
      {
        type: "dir",
        name: "Documents",
        createdAt: now,
        modifiedAt: now,
        children: [
          {
            type: "file",
            name: "readme.txt",
            content: "Welcome to PIXERA!\nThis is your virtual filesystem.",
            createdAt: now,
            modifiedAt: now,
          },
        ],
      },
      {
        type: "dir",
        name: "Pictures",
        createdAt: now,
        modifiedAt: now,
        children: [
          {
            type: "dir",
            name: "Wallpapers",
            createdAt: now,
            modifiedAt: now,
            children: [],
          },
        ],
      },
      {
        type: "dir",
        name: "Music",
        createdAt: now,
        modifiedAt: now,
        children: [],
      },
    ],
  };
}

// ── 内部状態 ──

/** @type {{ type: string, name: string, children?: Array, content?: string }} */
let root = null;

// ── 初期化 ──

/**
 * VFS を初期化する。保存済みツリーがあれば復元、なければデフォルトを生成。
 * 二重呼び出しは no-op (初期化順序を import 順に依存させないためのガード。
 * 実際の初期化は kernel.js の boot() で 1 回だけ行う)。
 */
export function initVfs() {
  if (root) return;
  const stored = load(VFS_KEY, null);
  root = stored || createDefaultTree();
  if (!stored) persist();
}

/** @internal テスト用: ツリーを未初期化状態へ戻す (次の initVfs で再構築) */
export function _resetVfs() {
  root = null;
}

/** ツリーを localStorage に永続化する */
function persist() {
  save(VFS_KEY, root);
}

// ── パスユーティリティ ──

/**
 * パスを正規化する。先頭 "/" を保証、末尾 "/" を除去。
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  if (!p || p === "/") return "/";
  // 先頭 "/" を保証
  if (!p.startsWith("/")) p = "/" + p;
  // 末尾 "/" を除去
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * パスをセグメント配列に分解する。"/" → []、"/a/b" → ["a","b"]
 * @param {string} p
 * @returns {string[]}
 */
function segments(p) {
  p = normalizePath(p);
  if (p === "/") return [];
  return p.slice(1).split("/");
}

/**
 * 親パスを返す。"/" の親は "/" 自身。
 * @param {string} p
 * @returns {string}
 */
export function parentPath(p) {
  const segs = segments(p);
  if (segs.length <= 1) return "/";
  return "/" + segs.slice(0, -1).join("/");
}

/**
 * パスの末尾名を返す。
 * @param {string} p
 * @returns {string}
 */
export function basename(p) {
  const segs = segments(p);
  return segs.length > 0 ? segs[segs.length - 1] : "";
}

/**
 * 2 つのパスを結合する。
 * @param {string} base
 * @param {string} name
 * @returns {string}
 */
export function joinPath(base, name) {
  base = normalizePath(base);
  if (base === "/") return "/" + name;
  return base + "/" + name;
}

// ── ノード検索 ──

/**
 * パスに対応するノードを返す。見つからなければ null。
 * @param {string} path
 * @returns {object|null}
 */
function resolveNode(path) {
  const segs = segments(path);
  let node = root;
  for (const seg of segs) {
    if (!node || node.type !== "dir") return null;
    const child = node.children.find((c) => c.name === seg);
    if (!child) return null;
    node = child;
  }
  return node;
}

/**
 * 親ノードを返す。ルートの親は null。
 * @param {string} path
 * @returns {object|null}
 */
function resolveParent(path) {
  const p = parentPath(path);
  if (normalizePath(path) === "/") return null;
  return resolveNode(p);
}

// ── 公開 API ──

/**
 * パスが存在するか判定する。
 * @param {string} path
 * @returns {boolean}
 */
export function exists(path) {
  return resolveNode(path) !== null;
}

/**
 * ノードの情報を返す。存在しなければ null。
 * @param {string} path
 * @returns {{ type: string, name: string, createdAt: number, modifiedAt: number, size?: number, encoding?: string }|null}
 */
export function stat(path) {
  const node = resolveNode(path);
  if (!node) return null;
  const info = {
    type: node.type,
    name: node.name,
    createdAt: node.createdAt,
    modifiedAt: node.modifiedAt,
  };
  if (node.type === "file") {
    if (node.encoding === "base64") {
      // Base64 文字列から実バイトサイズを算出
      const b64 = node.content || "";
      const padding = (b64.match(/=+$/) || [""])[0].length;
      info.size = Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
      info.encoding = "base64";
    } else {
      info.size = (node.content || "").length;
    }
  } else {
    info.childCount = node.children.length;
  }
  return info;
}

/**
 * ディレクトリの中身を返す。
 * @param {string} path
 * @returns {{ type: string, name: string }[]|null} ソート済みリスト (dir → file, 名前昇順)
 */
export function readDir(path) {
  const node = resolveNode(path);
  if (!node || node.type !== "dir") return null;
  // ディレクトリ→ファイル順、各グループ内は名前昇順
  return [...node.children]
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((c) => ({ type: c.type, name: c.name }));
}

/**
 * ファイルの内容を読み出す。
 * バイナリファイル (encoding === "base64") に対しては null を返す。
 * バイナリデータを取得するには readFileBinary() を使用すること。
 * @param {string} path
 * @returns {string|null}
 */
export function readFile(path) {
  const node = resolveNode(path);
  if (!node || node.type !== "file") return null;
  // バイナリファイルはテキスト API では読めない
  if (node.encoding === "base64") return null;
  return node.content;
}

/**
 * ファイルに書き込む。存在しなければ新規作成、存在すれば上書き。
 * 親ディレクトリが存在しない場合は失敗。
 * @param {string} path
 * @param {string} content
 * @returns {boolean} 成功/失敗
 */
export function writeFile(path, content) {
  const name = basename(path);
  if (!name) return false;

  const existing = resolveNode(path);
  if (existing) {
    if (existing.type !== "file") return false; // ディレクトリには書けない
    existing.content = content;
    existing.modifiedAt = Date.now();
    // テキスト書き込みなので encoding をクリア
    delete existing.encoding;
    persist();
    return true;
  }

  // 新規作成
  const parent = resolveParent(path);
  if (!parent || parent.type !== "dir") return false;

  const now = Date.now();
  parent.children.push({
    type: "file",
    name,
    content,
    createdAt: now,
    modifiedAt: now,
  });
  parent.modifiedAt = now;
  persist();
  return true;
}

/**
 * バイナリデータをファイルに書き込む。
 * ArrayBuffer を Base64 エンコードして保存する。
 * 存在しなければ新規作成、存在すれば上書き。
 * 親ディレクトリが存在しない場合は失敗。
 * @param {string} path
 * @param {ArrayBuffer} arrayBuffer
 * @returns {boolean} 成功/失敗
 */
export function writeFileBinary(path, arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer)) return false;

  const name = basename(path);
  if (!name) return false;

  const b64 = arrayBufferToBase64(arrayBuffer);

  const existing = resolveNode(path);
  if (existing) {
    if (existing.type !== "file") return false;
    existing.content = b64;
    existing.encoding = "base64";
    existing.modifiedAt = Date.now();
    persist();
    return true;
  }

  // 新規作成
  const parent = resolveParent(path);
  if (!parent || parent.type !== "dir") return false;

  const now = Date.now();
  parent.children.push({
    type: "file",
    name,
    content: b64,
    encoding: "base64",
    createdAt: now,
    modifiedAt: now,
  });
  parent.modifiedAt = now;
  persist();
  return true;
}

/**
 * バイナリファイルの内容を ArrayBuffer として読み出す。
 * テキストファイルに対しては null を返す。
 * @param {string} path
 * @returns {ArrayBuffer|null}
 */
export function readFileBinary(path) {
  const node = resolveNode(path);
  if (!node || node.type !== "file") return null;
  if (node.encoding !== "base64") return null;
  return base64ToArrayBuffer(node.content || "");
}

/**
 * ファイルがバイナリ (encoding === "base64") かどうかを判定する。
 * @param {string} path
 * @returns {boolean}
 */
export function isBinaryFile(path) {
  const node = resolveNode(path);
  if (!node || node.type !== "file") return false;
  return node.encoding === "base64";
}

/**
 * ディレクトリを作成する。既に存在する場合は何もせず true を返す。
 * @param {string} path
 * @returns {boolean}
 */
export function mkdir(path) {
  if (exists(path)) return true;

  const name = basename(path);
  if (!name) return false;

  const parent = resolveParent(path);
  if (!parent || parent.type !== "dir") return false;

  // 同名ファイルが存在したら失敗
  if (parent.children.some((c) => c.name === name)) return false;

  const now = Date.now();
  parent.children.push({
    type: "dir",
    name,
    children: [],
    createdAt: now,
    modifiedAt: now,
  });
  parent.modifiedAt = now;
  persist();
  return true;
}

/**
 * ファイルまたは空ディレクトリを削除する。
 * @param {string} path
 * @returns {boolean}
 */
/**
 * パスを削除する。既定は非再帰 (空でないディレクトリは削除不可)。
 * @param {string} path
 * @param {{ recursive?: boolean }} [opts]  recursive:true で中身ごと再帰削除
 * @returns {boolean} 削除できたら true
 */
export function remove(path, { recursive = false } = {}) {
  if (normalizePath(path) === "/") return false; // ルートは削除不可

  const node = resolveNode(path);
  if (!node) return false;

  // 非再帰時: ディレクトリが空でなければ削除不可
  if (!recursive && node.type === "dir" && node.children.length > 0) {
    return false;
  }

  const parent = resolveParent(path);
  if (!parent) return false;

  const idx = parent.children.indexOf(node);
  if (idx < 0) return false;

  parent.children.splice(idx, 1);
  parent.modifiedAt = Date.now();
  persist();
  return true;
}

/**
 * リネームする。同階層内での名前変更のみ。
 * @param {string} path
 * @param {string} newName  新しいファイル / ディレクトリ名 (パスではない)
 * @returns {boolean}
 */
export function rename(path, newName) {
  if (normalizePath(path) === "/") return false;
  if (!newName || newName.includes("/")) return false;

  const node = resolveNode(path);
  if (!node) return false;

  const parent = resolveParent(path);
  if (!parent) return false;

  // 同名の兄弟が既に存在したら失敗
  if (parent.children.some((c) => c !== node && c.name === newName))
    return false;

  node.name = newName;
  node.modifiedAt = Date.now();
  parent.modifiedAt = Date.now();
  persist();
  return true;
}

/**
 * ファイルまたはフォルダを別のパスに移動する。
 * 移動先がディレクトリならその中へ、ファイル名付きなら名前変更も同時に行う。
 * ディレクトリの移動は子ノードごと再帰的に移動される (ツリーノードの付け替え)。
 * @param {string} srcPath  - 移動元パス (例: "/Documents/note.txt")
 * @param {string} destPath - 移動先パス (例: "/Desktop/note.txt")
 * @returns {boolean} 成功したら true
 */
export function move(srcPath, destPath) {
  srcPath = normalizePath(srcPath);
  destPath = normalizePath(destPath);

  // ルートは移動不可
  if (srcPath === "/") return false;

  // 同一パスなら何もしない
  if (srcPath === destPath) return false;

  // 移動元の存在確認
  const srcNode = resolveNode(srcPath);
  if (!srcNode) return false;

  // ディレクトリを自身の子孫へ移動するのは不正
  if (srcNode.type === "dir" && destPath.startsWith(srcPath + "/")) {
    return false;
  }

  // 移動先がすでに存在するディレクトリなら、その中へ移動
  const destNode = resolveNode(destPath);
  if (destNode && destNode.type === "dir") {
    destPath = joinPath(destPath, srcNode.name);
    // 移動先ディレクトリ内に同名が既にある場合は失敗
    if (resolveNode(destPath)) return false;
  } else if (destNode) {
    // 移動先に同名ファイルが既存
    return false;
  }

  // 移動先の親ディレクトリの存在確認
  const destParent = resolveParent(destPath);
  if (!destParent || destParent.type !== "dir") return false;

  const newName = basename(destPath);
  if (!newName) return false;

  // 移動先の親に同名ノードが既にある場合は失敗
  if (destParent.children.some((c) => c.name === newName)) return false;

  // 元の親からノードを除去
  const srcParent = resolveParent(srcPath);
  if (!srcParent) return false;

  const idx = srcParent.children.indexOf(srcNode);
  if (idx < 0) return false;

  srcParent.children.splice(idx, 1);

  // 新しい親にノードを追加 (名前変更も反映)
  srcNode.name = newName;
  const now = Date.now();
  srcNode.modifiedAt = now;
  destParent.children.push(srcNode);

  srcParent.modifiedAt = now;
  destParent.modifiedAt = now;
  persist();
  return true;
}

/**
 * ツリー全体をフラット化した一覧を返す (TreeView 向け)。
 * 各エントリ: { path, name, type, depth, expanded, hasChildren }
 * @param {Object.<string, boolean>} expandedMap  パス → 展開状態のマップ
 * @param {boolean} [defaultExpanded=true]  マップに無いフォルダの既定展開状態。
 *   false にすると「明示的に開いたフォルダだけ展開」（EXPLORER は / だけ開いた初期表示）。
 * @returns {Array}
 */
export function flattenTree(expandedMap, defaultExpanded = true) {
  const result = [];

  function walk(node, depth, parentPath) {
    const path =
      parentPath === "/" ? "/" + node.name : parentPath + "/" + node.name;

    // ルートは特別扱い: パス "/"
    const actualPath = node === root ? "/" : path;
    const displayName = node === root ? "/" : node.name;

    if (node.type === "dir") {
      const e = expandedMap[actualPath]; // 明示指定があれば優先、無ければ既定
      const expanded = e === undefined ? defaultExpanded : e;
      const sorted = [...node.children].sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      result.push({
        path: actualPath,
        name: displayName,
        type: "dir",
        depth,
        expanded,
        hasChildren: sorted.length > 0,
      });

      if (expanded) {
        for (const child of sorted) {
          walk(child, depth + 1, actualPath);
        }
      }
    } else {
      result.push({
        path: actualPath,
        name: displayName,
        type: "file",
        depth,
        expanded: false,
        hasChildren: false,
      });
    }
  }

  walk(root, 0, "");
  return result;
}

