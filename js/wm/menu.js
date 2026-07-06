/**
 * @module wm/menu
 * menu.js — メニュー基盤 (ランチャー ≡ / デスクトップ・ウィンドウ右クリック共用)
 *
 * N 階層サブメニュー対応のコンテキストメニュー基盤。メニューツリー構築・
 * パネル寸法算出・描画・ヒットテスト・入力ディスパッチと、メニュースタック
 * 状態を持つ。
 *
 * wm.js への依存 (registry / toggleRegistered / システム SFX) は
 * menuSetDeps() で注入し、逆方向 import を持たない (wm → menu の一方向)。
 * メニュー項目のクリックで実際にウィンドウを開閉するのは注入された
 * toggleRegistered / action コールバックの責務。
 *
 * ── メニューアイテム型 ──
 *   { type: 'app',    entry }                  — アプリ (リーフ)
 *   { type: 'sub',    label, children[] }      — サブメニュー (ブランチ)
 *   { type: 'action', label, action: () => * } — 任意アクション (コンテキストメニュー用)
 *   { type: 'sep' }                            — セパレーター
 */

import * as Config from "../config.js";
import * as GPU from "../core/gpu.js";
import { drawText, GLYPH_W, GLYPH_H } from "../core/font.js";
import { drawIcon, ICON_W, ICON_H } from "../core/icon.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  依存注入 (wm.js から)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * @type {{ registry: object[], toggleRegistered: (entry:object)=>void,
 *          onMenu: ()=>void, onMenuItem: ()=>void }}
 */
let _deps = {
  registry: [],
  toggleRegistered: () => {},
  onMenu: () => {},
  onMenuItem: () => {},
};

/** wm.js から registry / toggleRegistered / SFX コールバックを注入する。 */
export function menuSetDeps(deps) {
  _deps = { ..._deps, ...deps };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** メニューの1項目の高さ */
let MENU_ITEM_HEIGHT = GLYPH_H + 6;
/** メニュー左右パディング */
const MENU_PADDING = 6;
/** チェックアイコン幅 (ICON_W + 3px gap) */
let MENU_CHECK_WIDTH = ICON_W + 3;
/** サブメニュー矢印アイコン用の右マージン (ICON_W + 3px gap) */
let MENU_ARROW_WIDTH = ICON_W + 3;
/** メニュー内セパレーター高さ (上余白 + 線 + 下余白) */
const MENU_SEPARATOR_HEIGHT = 3;
/**
 * 画面端からパネル本体 (境界線) までの最小距離。
 * 内訳: 背景との分離用アウトライン 1px + 背景透過マージン 1px。
 */
const MENU_EDGE_INSET = 2;

/** フォント変更時に menu 派生定数を再計算する (wm.js の recalcDerivedConstants が呼ぶ)。 */
export function menuRecalcConstants() {
  MENU_ITEM_HEIGHT = GLYPH_H + 6;
  MENU_CHECK_WIDTH = ICON_W + 3;
  MENU_ARROW_WIDTH = ICON_W + 3;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** メニューが開いているか (wm.js から live binding で参照される) */
export let menuOpen = false;

/**
 * メニュースタック。各要素は1階層分のパネル情報。
 * @type {{ items: object[], x: number, y: number, w: number, h: number,
 *          hover: number, parentIdx: number }[]}
 */
let menuStack = [];

/** メニューアイテムの表示ラベルを返す (sep は呼び出し側で除外しておく)。 */
function _menuItemLabel(item) {
  if (item.type === "app") return item.entry.name;
  return item.label;
}

/**
 * アイテムにチェックマークを表示すべきか。
 *   app    … 対応ウィンドウが開いている
 *   action … item.checked が true (ラジオ/トグル状態の表示に使う)
 */
function _itemChecked(item) {
  if (item.type === "app") return !item.entry.modal && item.entry.winId !== null;
  if (item.type === "action") return item.checked === true;
  return false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ツリー構築 / 寸法算出
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * レジストリからメニューツリーを構築する。
 * category 文字列を ">" で分割して N 階層に対応。
 *
 * 並び順: 非階層アプリ (アルファベット順) → セパレーター →
 *           サブメニュー (アルファベット順)。
 * dev フラグ付きアプリは DEV_MODE=false 時に除外。
 * hidden フラグ付きアプリはメニューに表示しない。
 * @param {object[]} registry  wmRegister 済みエントリの配列
 */
export function buildMenuTree(registry) {
  const regular = [];
  const modal = [];
  for (const e of registry) {
    // dev アプリを非表示
    if (e.dev && !Config.DEV_MODE) continue;
    // hidden アプリをメニューから除外
    if (e.hidden) continue;
    if (e.modal) modal.push(e);
    else regular.push(e);
  }

  // ── ツリーノード (中間構造) ──
  // subMap: カテゴリ名 → { label, childMap, entries[] }
  function ensureNode(root, parts) {
    let node = root;
    for (const part of parts) {
      if (!node.childMap) node.childMap = new Map();
      if (!node.childMap.has(part)) {
        node.childMap.set(part, {
          label: part,
          childMap: new Map(),
          entries: [],
        });
      }
      node = node.childMap.get(part);
    }
    return node;
  }

  const root = { childMap: new Map(), entries: [] };

  for (const e of regular) {
    if (e.category) {
      const parts = e.category.split(">");
      const node = ensureNode(root, parts);
      node.entries.push(e);
    } else {
      root.entries.push(e);
    }
  }

  // ── ノードをメニューアイテム配列に変換 (再帰) ──
  function nodeToItems(node) {
    const items = [];

    // サブメニュー (アルファベット順)
    if (node.childMap && node.childMap.size > 0) {
      const subs = [...node.childMap.entries()].sort((a, b) =>
        a[0].localeCompare(b[0]),
      );
      for (const [, child] of subs) {
        items.push({
          type: "sub",
          label: child.label,
          children: nodeToItems(child),
        });
      }
    }

    // リーフエントリ (アルファベット順)
    const sorted = [...node.entries].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const e of sorted) {
      items.push({ type: "app", entry: e });
    }

    // トップレベルでのみ: サブメニューとアプリをアルファベット混在ソート
    // (深い階層はすでに分類済みなのでそのまま)
    return items;
  }

  /**
   * サブツリー内の全エントリが dev フラグ付きかを判定する。
   * dev カテゴリはメニュー末尾に配置するために使用。
   */
  function _isAllDev(node) {
    for (const e of node.entries) {
      if (!e.dev) return false;
    }
    if (node.childMap) {
      for (const [, child] of node.childMap) {
        if (!_isAllDev(child)) return false;
      }
    }
    return node.entries.length > 0 || (node.childMap && node.childMap.size > 0);
  }

  // トップレベル: 非階層アプリ → セパレーター → プロダクションサブメニュー
  //              → セパレーター → dev サブメニュー → セパレーター → モーダル
  let topItems = [];

  // 1) 非階層アプリ (アルファベット順)
  const sortedTop = [...root.entries].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const e of sortedTop) {
    topItems.push({ type: "app", entry: e });
  }

  // 2) サブメニュー: プロダクション → dev の順 (各グループ内はアルファベット順)
  if (root.childMap && root.childMap.size > 0) {
    const prodSubs = [];
    const devSubs = [];
    const subs = [...root.childMap.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [, child] of subs) {
      const item = {
        type: "sub",
        label: child.label,
        children: nodeToItems(child),
      };
      if (_isAllDev(child)) {
        devSubs.push(item);
      } else {
        prodSubs.push(item);
      }
    }
    if (prodSubs.length > 0) {
      if (topItems.length > 0) topItems.push({ type: "sep" });
      topItems.push(...prodSubs);
    }
    if (devSubs.length > 0) {
      if (topItems.length > 0) topItems.push({ type: "sep" });
      topItems.push(...devSubs);
    }
  }

  // モーダルをセパレーター付きで末尾に追加
  if (topItems.length > 0 && modal.length > 0) {
    topItems.push({ type: "sep" });
  }
  const sortedModal = [...modal].sort((a, b) => a.name.localeCompare(b.name));
  for (const e of sortedModal) {
    topItems.push({ type: "app", entry: e });
  }

  return topItems;
}

/**
 * アイテム配列からパネルの幅と高さを計算する。
 */
function calcPanelSize(items) {
  let maxLabelLen = 0;
  let hasSubmenu = false;
  let h = 4; // 上下マージン 2px ずつ
  for (const item of items) {
    if (item.type === "sep") {
      h += MENU_SEPARATOR_HEIGHT;
    } else {
      const label = _menuItemLabel(item);
      if (label.length > maxLabelLen) maxLabelLen = label.length;
      if (item.type === "sub") hasSubmenu = true;
      h += MENU_ITEM_HEIGHT;
    }
  }
  const textW = maxLabelLen * (GLYPH_W + 1) - 1;
  const arrowW = hasSubmenu ? MENU_ARROW_WIDTH : 0;
  const w = MENU_PADDING + MENU_CHECK_WIDTH + textW + arrowW + MENU_PADDING;
  return { w, h };
}

/**
 * アイテムリスト中の Y オフセットからアイテムインデックスを返す。
 * セパレーター上: -1。範囲外: -1。
 */
function itemIndexFromLocalY(items, ly) {
  let y = 2; // 上マージン
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === "sep") {
      y += MENU_SEPARATOR_HEIGHT;
    } else {
      if (ly >= y && ly < y + MENU_ITEM_HEIGHT) return i;
      y += MENU_ITEM_HEIGHT;
    }
  }
  return -1;
}

/**
 * アイテムインデックスからパネルローカル Y 座標 (アイテム先頭) を返す。
 */
function itemTopY(items, idx) {
  let y = 2;
  for (let i = 0; i < idx; i++) {
    y += items[i].type === "sep" ? MENU_SEPARATOR_HEIGHT : MENU_ITEM_HEIGHT;
  }
  return y;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  開閉
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function openMenu(x, y) {
  openContextMenu(buildMenuTree(_deps.registry), x, y);
}

/**
 * 任意のアイテム配列でコンテキストメニューを開く。
 * デスクトップ launcher (openMenu)、ウィンドウヘッダー右クリック、将来の
 * アイコン右クリック等で共通利用する基盤 API。
 */
export function openContextMenu(items, x, y) {
  const { w, h } = calcPanelSize(items);
  // 画面内に収まるよう補正 (アウトライン+透過マージン込み)
  const px = Math.max(
    MENU_EDGE_INSET,
    Math.min(x, Config.VRAM_WIDTH - MENU_EDGE_INSET - w),
  );
  const py = Math.max(
    MENU_EDGE_INSET,
    Math.min(y, Config.VRAM_HEIGHT - MENU_EDGE_INSET - h),
  );
  menuStack = [{ items, x: px, y: py, w, h, hover: -1, parentIdx: -1 }];
  menuOpen = true;
  _deps.onMenu();
}

export function closeMenu() {
  menuOpen = false;
  menuStack = [];
}

/**
 * 指定レベル以降のサブメニューを閉じる。
 * @param {number} keepDepth  この depth まで残す (0 = ルートのみ)
 */
function closeSubmenusFrom(keepDepth) {
  if (menuStack.length > keepDepth + 1) {
    menuStack.length = keepDepth + 1;
  }
}

/**
 * サブメニューを開く。
 * @param {number} depth       親パネルの depth
 * @param {number} parentIdx   親パネルでのアイテムインデックス
 * @param {object[]} children  サブメニューのアイテム配列
 */
function openSubmenu(depth, parentIdx, children) {
  // 既に同じサブメニューが開いているなら何もしない
  if (
    menuStack.length > depth + 1 &&
    menuStack[depth + 1].parentIdx === parentIdx
  ) {
    return;
  }
  // depth+1 以降を閉じてから開く
  closeSubmenusFrom(depth);

  const parent = menuStack[depth];
  const { w, h } = calcPanelSize(children);
  const iy = parent.y + itemTopY(parent.items, parentIdx);

  // X: 親の右端 + 2px 余白。画面外なら左側に出す (アウトライン+透過マージン込み)
  let sx = parent.x + parent.w + 1;
  if (sx + w > Config.VRAM_WIDTH - MENU_EDGE_INSET) sx = parent.x - w - 1;
  sx = Math.max(
    MENU_EDGE_INSET,
    Math.min(sx, Config.VRAM_WIDTH - MENU_EDGE_INSET - w),
  );
  // Y: 子パネル内の最初のアイテムが親アイテムと同じ Y になるよう
  //    パネル上マージン (2px) 分だけ上にずらす
  let sy = iy - 2;
  sy = Math.max(
    MENU_EDGE_INSET,
    Math.min(sy, Config.VRAM_HEIGHT - MENU_EDGE_INSET - h),
  );

  menuStack.push({ items: children, x: sx, y: sy, w, h, hover: -1, parentIdx });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function drawMenuPanel(panel) {
  const { items, x, y, w, h, hover } = panel;
  // 背景との分離用アウトライン (1px, 背景色) → 本体の順で描画
  GPU.fillRoundRect(x - 1, y - 1, w + 2, h + 2, 1, 0);
  GPU.fillRoundRect(x, y, w, h, 1, 0);
  GPU.drawRoundRect(x, y, w, h, 1, 1);

  let iy = y + 2;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === "sep") {
      const sepY = iy + (MENU_SEPARATOR_HEIGHT >> 1);
      GPU.hline(x + 2, x + w - 3, sepY, 1);
      iy += MENU_SEPARATOR_HEIGHT;
      continue;
    }

    const label = _menuItemLabel(item);
    const isHover = i === hover;
    const tx = x + MENU_PADDING + MENU_CHECK_WIDTH;
    const iconY = iy + ((MENU_ITEM_HEIGHT - ICON_H) >> 1);

    // ホバー行は反転 (背景 fg / 前景 bg)、非ホバーは通常配色。
    const fg = isHover ? 0 : 1;
    if (isHover) GPU.fillRect(x + 2, iy, w - 4, MENU_ITEM_HEIGHT, 1);
    // チェックマーク (開いているアプリ / checked な action 項目)
    if (_itemChecked(item)) {
      drawIcon("check", x + MENU_PADDING, iconY, fg);
    }
    drawText(tx, iy + 3, label, fg);
    // サブメニュー矢印
    if (item.type === "sub") {
      drawIcon("arrow-right", x + w - MENU_PADDING - ICON_W, iconY, fg);
    }

    iy += MENU_ITEM_HEIGHT;
  }
}

export function drawMenu() {
  if (!menuOpen) return;
  for (const panel of menuStack) {
    drawMenuPanel(panel);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * マウス座標がどのパネル上にあるかを返す (-1 = どれでもない)。
 * 最前面 (最深階層) を優先する。
 */
export function hitTestMenuPanels(mx, my) {
  for (let d = menuStack.length - 1; d >= 0; d--) {
    const p = menuStack[d];
    if (mx >= p.x && mx < p.x + p.w && my >= p.y && my < p.y + p.h) return d;
  }
  return -1;
}

export function handleMenuInput(mx, my) {
  if (!menuOpen) return;

  const hitDepth = hitTestMenuPanels(mx, my);

  if (hitDepth < 0) {
    // どのパネルにもいない → 全ホバー解除 (サブメニューは閉じない)
    for (const p of menuStack) p.hover = -1;
    return;
  }

  const panel = menuStack[hitDepth];
  const localY = my - panel.y;
  const idx = itemIndexFromLocalY(panel.items, localY);
  panel.hover = idx;

  // このパネルより深いサブメニューの処理
  if (hitDepth < menuStack.length - 1) {
    // 深い階層の親アイテム上に戻ってきた場合は何もしない
    // 別のアイテムにホバーした場合はサブメニューを閉じる
    const childPanel = menuStack[hitDepth + 1];
    if (idx !== childPanel.parentIdx) {
      closeSubmenusFrom(hitDepth);
      // 新しいサブメニューを開く
      if (idx >= 0 && panel.items[idx].type === "sub") {
        openSubmenu(hitDepth, idx, panel.items[idx].children);
      }
    }
  } else {
    // 最深パネル上 → サブメニュー項目をホバーしたら開く
    if (idx >= 0 && panel.items[idx].type === "sub") {
      openSubmenu(hitDepth, idx, panel.items[idx].children);
    }
  }
}

export function handleMenuClick(mx, my) {
  if (!menuOpen) return;

  const hitDepth = hitTestMenuPanels(mx, my);
  if (hitDepth < 0) {
    // メニュー外クリック
    closeMenu();
    return;
  }

  const panel = menuStack[hitDepth];
  const localY = my - panel.y;
  const idx = itemIndexFromLocalY(panel.items, localY);
  if (idx < 0) {
    closeMenu();
    return;
  }

  const item = panel.items[idx];
  if (item.type === "app") {
    _deps.onMenuItem();
    _deps.toggleRegistered(item.entry);
    closeMenu();
  } else if (item.type === "action") {
    _deps.onMenuItem();
    // action は別ウィンドウを開く可能性があるので、メニューを先に閉じてから実行
    closeMenu();
    item.action();
  }
  // sub / sep をクリックしても何もしない (サブメニューは hover で開く)
}
