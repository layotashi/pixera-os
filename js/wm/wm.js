/**
 * @module wm/wm
 * wm.js — ウィンドウマネージャ
 *
 * OS 風のウィンドウシステムを提供する。
 * 各ウィンドウは矩形領域で表示され、マウスドラッグで移動・リサイズできる。
 *
 * ── 当たり判定 ──
 *   ヘッダー領域 (枠上辺の下〜区切り線) → 移動ドラッグ
 *   ボディ領域 (区切り線の下〜枠下辺の上) → 最前面昇格のみ
 *   境界線 ±1px ゾーン                    → リサイズドラッグ
 *   四隅 3×3px                            → 斜め方向リサイズ
 *
 * ── ダブルクリック判定 ──
 *   input.js の Input.hasInputEvent('dblclick', 0) でタイミングを判定し、
 *   lastXxxClickWin で同一ウィンドウ確認を行う。
 *   ヘッダーダブルクリック → 最大化トグル
 *   ボディダブルクリック → アプリに dblclick イベント伝播
 *   (境界線 DC autosize は廃止: ヘッダー右クリック → FIT TO CONTENT に集約)
 *
 * ── ウィンドウ右クリック (コンテキストメニュー) ──
 *   ヘッダー右クリック → FIT TO CONTENT / MAXIMIZE-RESTORE / CLOSE を表示。
 *   ボディ右クリック → アプリに "rdown" を伝播 (アプリ独自メニュー用)。
 *
 * ── ドラッグ (ウィンドウ移動) ──
 *   ヘッダークリックで move-pending モードに入り、
 *   input.js の Input.isDragging(0) が true になったら move モードに遷移する。
 *   (デッドゾーン 3px は input.js の DRAG_DEAD_ZONE で定義)
 *
 * ── リサイズ方向 (edges ビットフラグ) ──
 *   EDGE_LEFT=1 (左), EDGE_RIGHT=2 (右), EDGE_TOP=4 (上), EDGE_BOTTOM=8 (下)
 *   角は OR 合成: 左上=EDGE_LEFT|EDGE_TOP=5, 右下=EDGE_RIGHT|EDGE_BOTTOM=10 など
 *
 * ── スナップ ──
 *   移動ドロップ時にマウスが画面端にあるとスナップ配置される。
 *   上端=最大化, 左端=左半分, 右端=右半分。
 *   スナップ中のウィンドウを再ドラッグすると元のサイズに復帰する。
 *
 * ── ウィンドウスクロール ──
 *   scrollable: true オプションで仮想コンテンツ領域のスクロールを有効化。
 *   wmSetContentSize(id, virtualH) で仮想高さを設定し、
 *   WM が自動でスクロールバー描画・入力処理・座標オフセットを行う。
 *   scrollbar.js プリミティブを共通部品として使用。
 *
 *   scrollable ウィンドウは「コンテンツの自然サイズ」と「ウィンドウの最小サイズ」を
 *   分離して扱う:
 *     - 初期高さは自然サイズではなく work area 高さに自動クランプ (画面外はみ出し防止)
 *     - リサイズ下限は MIN_HEIGHT まで緩和 (縦スクロールで吸収できるため)
 *     - フォント/パディング変更時に自然サイズへ自動復元しない (ユーザーが選んだ h を維持)
 *   この分離により、コンテンツが画面より縦に大きい設定パネル等でも
 *   通常状態のままスクロールでアクセス可能になる。
 */

import * as Config from "../config.js";
import * as GPU from "../core/gpu.js";
import * as Input from "../core/input.js";
import { setCursor } from "../core/cursor.js";
import { drawIcon, ICON_W, ICON_H } from "../core/icon.js";
import { drawText, GLYPH_W, GLYPH_H } from "../core/font.js";
import { BAYER_4x4 } from "../core/dither.js";
import { FOCUS_MARGIN } from "../ui/ui_constants.js";
import * as Scroll from "../ui/scrollbar.js";
import * as Desktop from "./desktop.js";

// ── デスクトップ → WM コールバック注入 ──
Desktop.desktopSetTooltipCallback(wmSetTooltip);

// ── UI コールバック (循環依存回避のためコールバック注入) ──

/** @type {(() => void) | null} */
let _flushPopups = null;
/** @type {(() => boolean) | null} */
let _hasOpenPopup = null;
/** @type {(() => boolean) | null} */
let _hasTextInputFocus = null;

/**
 * UI モジュールからのコールバックを注入する。kernel.js が初期化時に呼ぶ。
 * @param {{ flushPopups: function, hasOpenPopup: function, hasTextInputFocus: function }} cbs
 */
export function wmSetUiCallbacks(cbs) {
  _flushPopups = cbs.flushPopups;
  _hasOpenPopup = cbs.hasOpenPopup;
  _hasTextInputFocus = cbs.hasTextInputFocus;
}

// ── SFX コールバック ──

/** @type {{ onOpen?:function, onClose?:function, onMaximize?:function, onMenu?:function, onMenuItem?:function }|null} */
let _sfxCallbacks = null;

/**
 * SFX コールバックを注入する。sfx.js が initSystemSfxHooks() で呼ぶ。
 * @param {{ onOpen?:function, onClose?:function, onMaximize?:function, onMenu?:function, onMenuItem?:function }} cbs
 */
export function wmSetSfxCallbacks(cbs) {
  _sfxCallbacks = cbs;
}

/** ポップアップ描画をフラッシュ (コールバック経由) */
function flushPopups() {
  if (_flushPopups) _flushPopups();
}
/** ポップアップが開いているか (コールバック経由) */
function hasOpenPopup() {
  return _hasOpenPopup ? _hasOpenPopup() : false;
}
/** テキスト入力にフォーカスがあるか (コールバック経由) */
function hasTextInputFocus() {
  return _hasTextInputFocus ? _hasTextInputFocus() : false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ヘッダー内コンテンツ高さ (グリフとアイコンの大きい方) */
let HEADER_CONTENT_H = Math.max(GLYPH_H, ICON_H);

/**
 * ヘッダーパディング (上下左右共通)。config.js から取得。
 * recalcDerivedConstants() でキャッシュを更新する。
 */
let HEADER_PADDING = Config.getHeaderPad();

/**
 * ヘッダー高さ (枠線除く。パディング上 + コンテンツ + パディング下)。
 * ES Module の live binding により、recalcDerivedConstants() で値が
 * 変更されるとインポート先でも最新値が参照される。
 */
export let HEADER_HEIGHT = HEADER_CONTENT_H + HEADER_PADDING * 2;

/**
 * コンテンツ領域の内側パディング (上下左右共通)。config.js から取得。
 * ES Module の live binding により、recalcDerivedConstants() で値が
 * 変更されるとインポート先でも最新値が参照される。
 */
export let CONTENT_PADDING = Config.getContentPad();

/** パディング / フォント変更時に派生定数を再計算する */
function recalcDerivedConstants() {
  HEADER_CONTENT_H = Math.max(GLYPH_H, ICON_H);
  HEADER_PADDING = Config.getHeaderPad();
  HEADER_HEIGHT = HEADER_CONTENT_H + HEADER_PADDING * 2;
  CONTENT_PADDING = Config.getContentPad();
  FOOTER_HEIGHT =
    FOOTER_SEPARATOR_HEIGHT + FOOTER_PADDING + GLYPH_H + FOOTER_PADDING;
  MENU_ITEM_HEIGHT = GLYPH_H + 6;
  ICON_SLOT = ICON_W + ICON_GAP;
  MENU_CHECK_WIDTH = ICON_W + 3;
  MENU_ARROW_WIDTH = ICON_W + 3;
  MIN_HEIGHT = BORDER + HEADER_HEIGHT + SEPARATOR_HEIGHT + 4 + BORDER;
}

/** 全ウィンドウのレイアウトを再計算する */
function recalcAllWindows() {
  for (const win of windows) {
    // スナップ中のウィンドウはスナップ領域を維持する (onMeasure で上書きしない)
    if (win.snapState === "none" && win.onMeasure) {
      const size = win.onMeasure();
      if (size) {
        const fit = calcWindowSize(size.w, size.h, win.footer, win._scrollable);
        // scrollable ウィンドウはユーザーが選んだサイズを維持する。
        // 自然サイズに勝手に戻すと、フォント切替・パディング変更のたびに
        // 窓が拡大してしまい UX として違和感が大きい。
        // 縦方向はスクロールで吸収できるため h を保持。
        // 幅は水平スクロール非対応なので、コンテンツ幅が縮んでも維持し、
        // 広がった場合のみ追従する。
        if (win._scrollable) {
          win.w = Math.max(win.w, fit.w);
        } else {
          win.w = fit.w;
          win.h = fit.h;
        }
      }
    }
    recalcLayout(win);
  }
}

// ── フレーム構成定数 ──
// ウィンドウ枠の各部品サイズ。recalcLayout / calcWindowSize で使用。

/** 外枠線の太さ (px) */
const BORDER = 1;
/** ヘッダー装飾余白 (px) — ヘッダー枠線と装飾矩形の間 */
const DECORATION_MARGIN = 1;
/** ヘッダー/ボディ区切り線の太さ (px) */
const SEPARATOR_HEIGHT = 1;
/** footer 区切り線の太さ (px) */
const FOOTER_SEPARATOR_HEIGHT = 1;
/** footer 内側パディング (上下左右各 2px) */
const FOOTER_PADDING = 2;

/** デフォルト footer 高さ: 区切り線(1) + パディング上(2) + グリフ + パディング下(2) */
export let FOOTER_HEIGHT =
  FOOTER_SEPARATOR_HEIGHT + FOOTER_PADDING + GLYPH_H + FOOTER_PADDING;

/**
 * コンテンツ幅からウィンドウ幅を算出する際の追加分 (px)。
 * 左右: 外枠(BORDER) × 2 = 2
 */
const FRAME_EXTRA_W = BORDER * 2; // 2

/**
 * コンテンツ高さからウィンドウ高さを算出する際の追加分 (px, HEADER_HEIGHT / CONTENT_PADDING / footer 除く)。
 * 上枠(BORDER) + 区切り線(SEPARATOR_HEIGHT) + 下枠(BORDER) = 3
 */
const FRAME_EXTRA_H = BORDER + SEPARATOR_HEIGHT + BORDER; // 3

/** ウィンドウの最小サイズ (枠込み) */
const MIN_WIDTH = 8;
let MIN_HEIGHT = BORDER + HEADER_HEIGHT + SEPARATOR_HEIGHT + 4 + BORDER; // 枠上 + ヘッダー + 区切り + ボディ最小4px + 枠下

/** リサイズ方向ビットフラグ */
const EDGE_LEFT = 1; // 左辺
const EDGE_RIGHT = 2; // 右辺
const EDGE_TOP = 4; // 上辺
const EDGE_BOTTOM = 8; // 下辺

/** アイコン間のマージン (px) */
const ICON_GAP = 6;

/** 1 個のアイコンが占めるスロット幅 (アイコン幅 + 左右マージン) */
let ICON_SLOT = ICON_W + ICON_GAP;

/** スナップ判定ゾーン幅 (画面短辺の約2%, 下限3px / 上限16px)。解像度変更時に再計算。 */
let SNAP_ZONE = Math.max(
  3,
  Math.min(16, (Math.min(Config.VRAM_WIDTH, Config.VRAM_HEIGHT) * 0.02) | 0),
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  作業領域 (タスクバー等のオフセット)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ウィンドウ配置可能領域の上端 Y。
 * タスクバー等の高さ分だけ下がる。スナップ・最大化で使用。
 */
let workAreaTop = 0;

/** workArea の上端を設定する */
export function wmSetWorkAreaTop(y) {
  workAreaTop = y;
  Desktop.desktopSetWorkAreaTop(y);
}

/** 現在の workArea 上端を返す */
function wmGetWorkAreaTop() {
  return workAreaTop;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  カスケード配置
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** カスケード開始マージン (画面端からの距離) */
const CASCADE_MARGIN = 10;
/** カスケード 1 段あたりのオフセット (右下方向) */
const CASCADE_STEP = 20;
/** 次のカスケード段数 (0-origin) */
let cascadeIndex = 0;

/**
 * カスケード位置を算出し、インデックスを進める。
 * 画面端に達したら折り返す。
 * @param {number} winW  ウィンドウ幅
 * @param {number} winH  ウィンドウ高さ
 * @returns {{ x: number, y: number }}
 */
function nextCascadePos(winW, winH) {
  const waTop = wmGetWorkAreaTop();
  // 画面内に収まる最大段数
  const maxByX = Math.max(
    1,
    ((Config.VRAM_WIDTH - winW - CASCADE_MARGIN) / CASCADE_STEP) | 0,
  );
  const maxByY = Math.max(
    1,
    ((Config.VRAM_HEIGHT - winH - waTop - CASCADE_MARGIN) / CASCADE_STEP) | 0,
  );
  const maxSteps = Math.max(1, Math.min(maxByX, maxByY));
  const step = cascadeIndex % maxSteps;
  cascadeIndex++;
  return {
    x: CASCADE_MARGIN + step * CASCADE_STEP,
    y: waTop + CASCADE_MARGIN + step * CASCADE_STEP,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィンドウ定義
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ウィンドウオブジェクトを生成する。
 * @param {number} x  左上 X
 * @param {number} y  左上 Y
 * @param {number} w  幅 (枠含む)
 * @param {number} h  高さ (枠含む)
 * @param {string} title タイトル文字列
 * @param {object} [opts] 追加オプション
 * @param {boolean} [opts.footer=false] footer 有効フラグ (true で標準 footer を表示)
 * @param {function|null} [opts.onDrawFooter=null] footer 描画コールバック (footerRect) => void
 * @param {function|null} [opts.onInputFooter=null] footer 入力コールバック (将来用)
 * @param {boolean} [opts.modal=false] モーダルウィンドウフラグ (他ウィンドウの入力をブロック)
 * @param {boolean} [opts.noResize=false] リサイズ無効
 * @param {boolean} [opts.noMaximize=false] 最大化無効
 * @param {boolean} [opts.scrollable=false] ウィンドウスクロール有効 (wmSetContentSize で仮想サイズを設定)。
 *   有効時は (a) 初期高さが自然サイズではなく work area 高さに自動クランプされ、
 *   (b) リサイズ下限が MIN_HEIGHT まで緩和され、
 *   (c) フォント/パディング変更時に自然サイズへ自動復元しなくなる。
 * @param {function|null} [opts.onBeforeClose=null] 閉じる前コールバック (() => boolean, false で閉じをキャンセル)
 * @returns {object} ウィンドウオブジェクト
 */
function createWindow(id, x, y, w, h, title, onDraw, onInput, onMeasure, opts) {
  const o = opts || {};
  const win = {
    id,
    x,
    y,
    w,
    h,
    title,
    onDraw: onDraw || null,
    onInput: onInput || null,
    onMeasure: onMeasure || null,
    restoreRect: null,
    snapState: "none",
    // ── footer (opt-in) ──
    footer: !!o.footer,
    onDrawFooter: o.onDrawFooter || null,
    onInputFooter: o.onInputFooter || null,
    // ── ウィンドウオプション (opt-in) ──
    modal: o.modal || false,
    noResize: o.noResize || false,
    noMaximize: o.noMaximize || false,
    onBeforeClose: o.onBeforeClose || null,
    // ── ABOUT パネル (opt-in) ──
    // about 文字列を持つウィンドウはヘッダ右クリックメニューに ABOUT が出て、
    // ボディが説明パネルに切り替わる。説明は「何か + 主要操作」を簡潔に。
    about: o.about || null,
    _aboutMode: false,
    // ── フォント変更時の再レイアウト (opt-in) ──
    onRelayout: o.onRelayout || null,
    // ── スクロール (opt-in) ──
    _scrollable: !!o.scrollable,
    _vScroll: null, // ScrollState (wmSetContentSize で初期化)
    _virtualH: 0, // 仮想コンテンツ高 (px)
    // ── レイアウトキャッシュ (recalcLayout で更新) ──
    _layout: null,
  };
  recalcLayout(win);
  return win;
}

// ── 安全なコールバック呼び出し (例外でメインループを止めない) ──

/** onDraw を try-catch で囲んで呼ぶ */
function safeOnDraw(win, contentRect) {
  try {
    win.onDraw(contentRect);
  } catch (e) {
    console.error(`[WM] onDraw error in "${win.title}":`, e);
  }
}

/** onInput を try-catch で囲んで呼ぶ */
function safeOnInput(win, ev) {
  // ABOUT パネル表示中 / ディゾルブ遷移中はアプリへ入力を渡さない
  // (背後の誤操作防止)。メニュー操作は WM 側で処理されるため影響しない。
  if (win._aboutMode || win._aboutAnim) return;
  try {
    win.onInput(ev);
  } catch (e) {
    console.error(`[WM] onInput error in "${win.title}":`, e);
  }
}

/** onDrawFooter を try-catch で囲んで呼ぶ */
function safeOnDrawFooter(win, footerRect) {
  try {
    win.onDrawFooter(footerRect);
  } catch (e) {
    console.error(`[WM] onDrawFooter error in "${win.title}":`, e);
  }
}

/** onInputFooter を try-catch で囲んで呼ぶ */
function safeOnInputFooter(win, ev) {
  try {
    win.onInputFooter(ev);
  } catch (e) {
    console.error(`[WM] onInputFooter error in "${win.title}":`, e);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  内部状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {object[]} */
const windows = [];

/** 次に発行するウィンドウ ID (単調増加、再利用しない) */
let nextWinId = 1;

// ── パディング / フォント変更リスナー ──
Config.onHeaderPadChange(() => {
  recalcDerivedConstants();
  recalcAllWindows();
});
Config.onContentPadChange(() => {
  recalcDerivedConstants();
  recalcAllWindows();
});
Config.onFontChange(() => {
  recalcDerivedConstants();
  // 各ウィンドウのウィジェット w/h を再計算 → Box.layout() で再配置
  for (const win of windows) {
    if (win.onRelayout) {
      try {
        win.onRelayout();
      } catch (e) {
        console.error(`[WM] onRelayout error in "${win.title}":`, e);
      }
    }
  }
  recalcAllWindows();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィンドウファクトリレジストリ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ウィンドウファクトリレジストリ。
 * @type {{ name:string, shortName:string|null, factory:()=>number, winId:number|null, modal:boolean, category:string|null, dev:boolean, hidden:boolean }[]}
 */
const registry = [];

/**
 * ウィンドウをファクトリとして登録する。
 * factory は呼ばれると wmOpen を実行し ID を返す。
 * @param {string} name  正式名称 (ウィンドウタイトル・メニューに使用)
 * @param {()=>number} factory  ウィンドウを作成する関数 (wmOpen の戻り値=ID を返すこと)
 * @param {object} [opts]
 * @param {string}  [opts.shortName] デスクトップアイコン用の短縮名 (最大7文字)。
 *                                   省略時は name を 7 文字で切り捨てた値を使用。
 * @param {boolean} [opts.modal]    モーダルウィンドウか
 * @param {string}  [opts.category] メニューカテゴリ (例: "GAMES", "CREATIVE>MUSIC")。
 *                                  ">" で区切ると N 階層のサブメニューになる。省略でトップレベル。
 * @param {boolean} [opts.dev]      開発専用アプリ。DEV_MODE=false 時にメニュー・アイコンから非表示。
 * @param {boolean} [opts.hidden]   メニューに表示しない（デスクトップアイコンのみ）。
 */
export function wmRegister(name, factory, opts = null) {
  registry.push({
    name,
    shortName: (opts && opts.shortName) || null,
    factory,
    winId: null,
    modal: (opts && opts.modal) || false,
    category: (opts && opts.category) || null,
    dev: (opts && opts.dev) || false,
    hidden: (opts && opts.hidden) || false,
  });
}

/** ファクトリの開閉をトグルする。開いていれば最前面へ、閉じていれば新規作成 */
function toggleRegistered(entry) {
  if (entry.modal) {
    // モーダル: 他のモーダルが開いていなければ新規作成
    if (_modalWinId !== null) return;
    const id = entry.factory();
    entry.winId = id;
    return;
  }
  if (entry.winId !== null) {
    // 開いている→最前面へ
    const idx = windows.findIndex((w) => w.id === entry.winId);
    if (idx >= 0) {
      bringToFront(idx);
    }
  } else {
    // 閉じている→ファクトリで生成
    const id = entry.factory();
    entry.winId = id;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  メニュー (タスクバー≡ / デスクトップ右クリック共用)
//  N 階層サブメニュー対応
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** メニューが開いているか */
let menuOpen = false;
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

/** モーダルウィンドウの ID (null = モーダルなし) */
let _modalWinId = null;

// ── メニューアイテム型 ──
// { type: 'app',    entry }                   — アプリ (リーフ)
// { type: 'sub',    label, children[] }       — サブメニュー (ブランチ)
// { type: 'action', label, action: () => * }  — 任意アクション (コンテキストメニュー用)
// { type: 'sep' }                             — セパレーター

/** メニューアイテムの表示ラベルを返す (sep は呼び出し側で除外しておく)。 */
function _menuItemLabel(item) {
  if (item.type === "app") return item.entry.name;
  return item.label;
}

/**
 * メニュースタック。各要素は1階層分のパネル情報。
 * @type {{ items: object[], x: number, y: number, w: number, h: number,
 *          hover: number, parentIdx: number }[]}
 */
let menuStack = [];

/**
 * レジストリからメニューツリーを構築する。
 * category 文字列を ">" で分割して N 階層に対応。
 *
 * 並び順: 非階層アプリ (アルファベット順) → セパレーター →
 *           サブメニュー (アルファベット順)。
 * dev フラグ付きアプリは DEV_MODE=false 時に除外。
 * hidden フラグ付きアプリはメニューに表示しない。
 */
function buildMenuTree() {
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

function openMenu(x, y) {
  openContextMenu(buildMenuTree(), x, y);
}

/**
 * 任意のアイテム配列でコンテキストメニューを開く。
 * デスクトップ launcher (openMenu)、ウィンドウヘッダー右クリック、将来の
 * アイコン右クリック等で共通利用する基盤 API。
 */
function openContextMenu(items, x, y) {
  const { w, h } = calcPanelSize(items);
  // 画面内に収まるよう補正
  const px = Math.max(0, Math.min(x, Config.VRAM_WIDTH - w));
  const py = Math.max(0, Math.min(y, Config.VRAM_HEIGHT - h));
  menuStack = [{ items, x: px, y: py, w, h, hover: -1, parentIdx: -1 }];
  menuOpen = true;
  if (_sfxCallbacks?.onMenu) _sfxCallbacks.onMenu();
}

function closeMenu() {
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

  // X: 親の右端 + 2px 余白。画面外なら左側に出す
  let sx = parent.x + parent.w + 1;
  if (sx + w > Config.VRAM_WIDTH) sx = parent.x - w - 1;
  // Y: 子パネル内の最初のアイテムが親アイテムと同じ Y になるよう
  //    パネル上マージン (2px) 分だけ上にずらす
  let sy = iy - 2;
  if (sy + h > Config.VRAM_HEIGHT) sy = Math.max(0, Config.VRAM_HEIGHT - h);
  if (sy < 0) sy = 0;

  menuStack.push({ items: children, x: sx, y: sy, w, h, hover: -1, parentIdx });
}

// ── 描画 ──

function drawMenuPanel(panel) {
  const { items, x, y, w, h, hover } = panel;
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

    if (isHover) {
      GPU.fillRect(x + 2, iy, w - 4, MENU_ITEM_HEIGHT, 1);
      // チェックマーク (開いているアプリ)
      if (
        item.type === "app" &&
        !item.entry.modal &&
        item.entry.winId !== null
      ) {
        drawIcon("check", x + MENU_PADDING, iconY, 0);
      }
      drawText(tx, iy + 3, label, 0);
      // サブメニュー矢印
      if (item.type === "sub") {
        drawIcon("arrow-right", x + w - MENU_PADDING - ICON_W, iconY, 0);
      }
    } else {
      if (
        item.type === "app" &&
        !item.entry.modal &&
        item.entry.winId !== null
      ) {
        drawIcon("check", x + MENU_PADDING, iconY, 1);
      }
      drawText(tx, iy + 3, label, 1);
      if (item.type === "sub") {
        drawIcon("arrow-right", x + w - MENU_PADDING - ICON_W, iconY, 1);
      }
    }

    iy += MENU_ITEM_HEIGHT;
  }
}

function drawMenu() {
  if (!menuOpen) return;
  for (const panel of menuStack) {
    drawMenuPanel(panel);
  }
}

// ── 入力 ──

/**
 * マウス座標がどのパネル上にあるかを返す (-1 = どれでもない)。
 * 最前面 (最深階層) を優先する。
 */
function hitTestMenuPanels(mx, my) {
  for (let d = menuStack.length - 1; d >= 0; d--) {
    const p = menuStack[d];
    if (mx >= p.x && mx < p.x + p.w && my >= p.y && my < p.y + p.h) return d;
  }
  return -1;
}

function handleMenuInput(mx, my) {
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

function handleMenuClick(mx, my) {
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
    if (_sfxCallbacks?.onMenuItem) _sfxCallbacks.onMenuItem();
    toggleRegistered(item.entry);
    closeMenu();
  } else if (item.type === "action") {
    if (_sfxCallbacks?.onMenuItem) _sfxCallbacks.onMenuItem();
    // action は別ウィンドウを開く可能性があるので、メニューを先に閉じてから実行
    closeMenu();
    item.action();
  }
  // sub / sep をクリックしても何もしない (サブメニューは hover で開く)
}

/** 操作対象のウィンドウインデックス (-1 = なし) */
let activeIndex = -1;

/** 現在の操作モード: "none" | "move-pending" | "move" | "resize" */
let mode = "none";

/** 移動ドラッグ: マウス座標 - ウィンドウ左上 */
let dragOffX = 0;
let dragOffY = 0;

/** リサイズドラッグ: 方向ビットフラグ (EDGE_LEFT|EDGE_RIGHT|EDGE_TOP|EDGE_BOTTOM の組合せ) */
let resizeEdges = 0;

/** リサイズドラッグ: 開始時のマウス座標とウィンドウ矩形 */
let resizeStartMX = 0;
let resizeStartMY = 0;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartW = 0;
let resizeStartH = 0;

/** スナッププレビュー: ドラッグ中の配置先矩形 (null = 非表示) */
let snapPreview = null;

/**
 * ダブルクリック検出: 前回クリックしたウィンドウ (同一ウィンドウ判定用)。
 * タイミング判定は input.js の Input.hasInputEvent('dblclick', 0) に委譲する。
 */
let lastHeaderClickWin = null;
let lastBodyClickWin = null;

// ── 解像度変更対応 ──
Config.onResize(() => {
  // SNAP_ZONE を新しい解像度に合わせて再計算
  SNAP_ZONE = Math.max(
    3,
    Math.min(16, (Math.min(Config.VRAM_WIDTH, Config.VRAM_HEIGHT) * 0.02) | 0),
  );

  // はみ出したウィンドウ・スナップウィンドウを新しい画面に合わせる
  for (const win of windows) {
    // スナップ中のウィンドウはスナップ領域を再計算
    const waTop = workAreaTop;
    if (win.snapState === "maximized") {
      win.x = 0;
      win.y = waTop;
      win.w = Config.VRAM_WIDTH;
      win.h = Config.VRAM_HEIGHT - waTop;
    } else if (win.snapState === "snap-left") {
      win.x = 0;
      win.y = waTop;
      win.w = (Config.VRAM_WIDTH / 2) | 0;
      win.h = Config.VRAM_HEIGHT - waTop;
    } else if (win.snapState === "snap-right") {
      const half = (Config.VRAM_WIDTH / 2) | 0;
      win.x = half;
      win.y = waTop;
      win.w = Config.VRAM_WIDTH - half;
      win.h = Config.VRAM_HEIGHT - waTop;
    } else {
      // 通常ウィンドウ: はみ出しを制約
      if (win.x + win.w > Config.VRAM_WIDTH)
        win.x = Math.max(0, Config.VRAM_WIDTH - win.w);
      if (win.y + win.h > Config.VRAM_HEIGHT)
        win.y = Math.max(waTop, Config.VRAM_HEIGHT - win.h);
    }
    recalcLayout(win);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  当たり判定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 点 (px, py) がウィンドウ内部 (枠を除いた領域) に含まれるか。
 */
function hitTestInner(win, px, py) {
  return (
    px > win.x && py > win.y && px < win.x + win.w - 1 && py < win.y + win.h - 1
  );
}

/**
 * 点 (px, py) がヘッダー領域に含まれるか。
 * ヘッダー: 枠上辺の 1px 下 〜 区切り線の直上
 */
function hitTestHeader(win, px, py) {
  const h = win._layout.headerRect;
  return px > h.x && px < h.x + h.w && py >= h.y && py < h.y + h.h;
}

/**
 * ヘッダーアイコン (close/maximize/minimize) のヒットテスト。
 * クリック座標がいずれかのアイコン矩形内なら名前を返す。なければ null。
 */
function hitTestHeaderIcon(win, px, py) {
  const iconY = win._layout.iconY;
  const baseX = win._layout.iconBaseX;

  // close
  const closeX = baseX - ICON_W;
  if (
    closeX > win.x &&
    px >= closeX &&
    px < closeX + ICON_W &&
    py >= iconY &&
    py < iconY + ICON_H
  ) {
    return "close";
  }
  // maximize / restore (noMaximize ウィンドウでは無効)
  if (!win.noMaximize) {
    const maxX = closeX - ICON_SLOT;
    if (
      maxX > win.x &&
      px >= maxX &&
      px < maxX + ICON_W &&
      py >= iconY &&
      py < iconY + ICON_H
    ) {
      return "maximize";
    }
  }
  return null;
}

/**
 * 点 (px, py) がボディ領域 (コンテンツ + footer) に含まれるか。
 * ボディ: 区切り線の下 〜 枠下辺の 1px 上
 */
function hitTestBody(win, px, py) {
  const L = win._layout;
  return (
    px > win.x &&
    px < win.x + win.w - 1 &&
    py > L.sepY &&
    py < win.y + win.h - 1
  );
}

/**
 * 点 (px, py) が footer 領域 (footer 区切り線以下〜枠下辺) に含まれるか。
 * footer が無効なウィンドウでは常に false。
 */
function hitTestFooter(win, px, py) {
  if (!win.footer) return false;
  const L = win._layout;
  return (
    px > win.x &&
    px < win.x + win.w - 1 &&
    py > L.footerSepY &&
    py < win.y + win.h - 1
  );
}

/**
 * イベント座標を footer ローカル座標に変換する。
 */
function toFooterLocalCoords(win, mx, my) {
  const fr = win._layout.footerRect;
  return { lx: mx - fr.x, ly: my - fr.y };
}

/**
 * 点 (px, py) がウィンドウの境界線ゾーン (±1px) にあるか判定し、
 * ヒットした辺をビットフラグで返す (0 = ヒットなし)。
 *
 * - 角: 3×3px の正方形領域 (2辺の OR → 斜めリサイズ)
 * - 辺: 境界線を中心とした幅 3px の線状領域
 */
function hitTestBorder(win, px, py) {
  const x0 = win.x;
  const y0 = win.y;
  const x1 = win.x + win.w - 1;
  const y1 = win.y + win.h - 1;

  // 拡張境界 (±1px) の外なら即棄却
  if (px < x0 - 1 || px > x1 + 1 || py < y0 - 1 || py > y1 + 1) return 0;

  // 内部領域 (全辺から 2px 以上内側) ならリサイズ対象外
  if (px > x0 + 1 && px < x1 - 1 && py > y0 + 1 && py < y1 - 1) return 0;

  // ゾーン内 → どの辺に近いかを判定
  let edges = 0;
  if (px <= x0 + 1) edges |= EDGE_LEFT;
  if (px >= x1 - 1) edges |= EDGE_RIGHT;
  if (py <= y0 + 1) edges |= EDGE_TOP;
  if (py >= y1 - 1) edges |= EDGE_BOTTOM;
  return edges;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  辺ビットフラグ → カーソル名
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * リサイズ辺ビットフラグを対応するカーソル種別名に変換する。
 */
function edgesToCursor(edges) {
  const l = edges & EDGE_LEFT;
  const r = edges & EDGE_RIGHT;
  const t = edges & EDGE_TOP;
  const b = edges & EDGE_BOTTOM;
  if ((l && t) || (r && b)) return "resize-nwse";
  if ((r && t) || (l && b)) return "resize-nesw";
  if (l || r) return "resize-ew";
  if (t || b) return "resize-ns";
  return "default";
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィンドウ昇格 (最前面へ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function bringToFront(i) {
  if (i < windows.length - 1) {
    const win = windows.splice(i, 1)[0];
    windows.push(win);
    return windows.length - 1;
  }
  return i;
}

/** ウィンドウ i を最背面に送る。新しい最前面のインデックスを返す */
function sendToBack(i) {
  if (i > 0) {
    const win = windows.splice(i, 1)[0];
    windows.unshift(win);
  }
  return windows.length - 1;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  スナップ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * マウス座標からスナップ先の矩形を返す。
 * スナップゾーン外なら null。
 * @returns {{ x:number, y:number, w:number, h:number, state:string }|null}
 */
function getSnapRect(mx, my) {
  const waTop = workAreaTop;
  const maxH = Config.VRAM_HEIGHT - waTop;
  if (my < waTop + SNAP_ZONE) {
    return {
      x: 0,
      y: waTop,
      w: Config.VRAM_WIDTH,
      h: maxH,
      state: "maximized",
    };
  }
  if (mx < SNAP_ZONE) {
    return {
      x: 0,
      y: waTop,
      w: (Config.VRAM_WIDTH / 2) | 0,
      h: maxH,
      state: "snap-left",
    };
  }
  if (mx >= Config.VRAM_WIDTH - SNAP_ZONE) {
    const half = (Config.VRAM_WIDTH / 2) | 0;
    return {
      x: half,
      y: waTop,
      w: Config.VRAM_WIDTH - half,
      h: maxH,
      state: "snap-right",
    };
  }
  return null;
}

/**
 * スナップ配置を適用する。ドロップ時のマウス座標で判定。
 * @returns {boolean} スナップが適用された場合 true
 */
function trySnap(win, mx, my) {
  const snap = getSnapRect(mx, my);
  if (!snap) return false;
  // restoreRect はドラッグ開始時に既に保存済み
  win.x = snap.x;
  win.y = snap.y;
  win.w = snap.w;
  win.h = snap.h;
  win.snapState = snap.state;
  recalcLayout(win);
  return true;
}

/**
 * restoreRect にスナップ前のサイズを保存する。
 * 既にスナップ中 (restoreRect が存在する) なら上書きしない。
 */
function savePreSnapRect(win) {
  if (!win.restoreRect) {
    win.restoreRect = { x: win.x, y: win.y, w: win.w, h: win.h };
  }
}

/**
 * スナップ中のウィンドウを元サイズに復帰させ、
 * ドラッグオフセットを再計算する。
 * @returns {{ offX: number, offY: number }} 新しいドラッグオフセット
 */
function unsnap(win, mx, my) {
  const r = win.restoreRect;
  // マウスの相対位置を元のウィンドウ幅に比例させる
  const ratioX = (mx - win.x) / win.w;
  const ratioY = (my - win.y) / win.h;
  win.w = r.w;
  win.h = r.h;
  // 復帰後のウィンドウ位置: マウスが同じ相対位置に来るように
  win.x = (mx - ratioX * r.w) | 0;
  win.y = (my - ratioY * r.h) | 0;
  win.restoreRect = null;
  win.snapState = "none";
  recalcLayout(win);
  return {
    offX: mx - win.x,
    offY: my - win.y,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  レイアウト算出
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ウィンドウの全レイアウト矩形を (x, y, w, h) から一括算出し、
 * win._layout にキャッシュする。
 *
 * 呼び出しタイミング:
 *   - createWindow 直後
 *   - ウィンドウの x/y/w/h が変化するたび (移動・リサイズ・スナップ)
 *
 * 構成図 (footer あり時):
 *   win.y     ┌──────────────────────────┐  BORDER (1px)
 *             │ ┌──────────────────────┐ │  DECORATION_MARGIN (装飾矩形, ヘッダーのみ)
 *             │ │    HEADER (HEADER_HEIGHT) │ │
 *             │ └──────────────────────┘ │
 *   sepY      │──────── 区切り線 ────────│  SEPARATOR_HEIGHT (1px)
 *             │  CONTENT_PADDING             │
 *             │    ┌── contentRect ──┐   │
 *             │    │                 │   │
 *             │    └─────────────────┘   │
 *             │  CONTENT_PADDING             │
 *   footerSepY│──────── 区切り線 ────────│  FOOTER_SEPARATOR_HEIGHT (1px) ← footer ありの場合のみ
 *             │    footer (FOOTER_HEIGHT)  │
 *   win.y+h   └──────────────────────────┘  BORDER (1px)
 *
 * scrollable=true の場合:
 *   ボディ領域の右端にスクロールバーが張り付き、その左側にコンテンツゾーンが置かれる。
 *   CONTENT_PADDING はコンテンツゾーン内に適用される (スクロールバーの外側には適用しない)。
 *   明色枠線 (ウィンドウ外枠 + sep + ヘッダー区切り線) の内側に
 *   上下左右 1px の暗色余白を挟み、その内部に thumb を描画する。
 *
 *   sepY      │──────── 区切り線 ────────────────────│ SEPARATOR_HEIGHT
 *             │                               ┊     │
 *             │  PAD ┌ contentRect ┐ PAD  sep ┊ ██  │ ← thumb (1px inset)
 *             │      │             │       ┊  ┊ ██  │
 *             │  PAD └─────────────┘ PAD  sep ┊     │
 *             │                               ┊     │
 *             ├─── content zone ──────────┤─sb area─┤
 *             ├──────────── body area ──────────────┤
 */
function recalcLayout(win) {
  const fx = win.x;
  const fy = win.y;
  const fw = win.w;
  const fh = win.h;
  const footerH = win.footer ? FOOTER_HEIGHT : 0;

  // ── header ──
  const headerX = fx + BORDER;
  const headerY = fy + BORDER;
  const headerW = fw - BORDER * 2;

  // ── 区切り線 Y ──
  const sepY = fy + BORDER + HEADER_HEIGHT;

  // ── ヘッダー装飾矩形 (header 内側、枠と装飾の間に 1px 隙間) ──
  const decoX = fx + BORDER + DECORATION_MARGIN;
  const decoY = fy + BORDER + DECORATION_MARGIN;
  const decoW = fw - (BORDER + DECORATION_MARGIN) * 2;
  const decoH = HEADER_HEIGHT - DECORATION_MARGIN * 2;

  // ── タイトル / アイコン Y ──
  const titleX = fx + BORDER + HEADER_PADDING;
  const titleY =
    fy + BORDER + HEADER_PADDING + ((HEADER_CONTENT_H - GLYPH_H) >> 1);
  const iconY =
    fy + BORDER + HEADER_PADDING + ((HEADER_CONTENT_H - ICON_H) >> 1);
  const iconBaseX = fx + fw - BORDER - HEADER_PADDING;

  // ── content (区切り線の下から CONTENT_PADDING を取った領域) ──
  //
  // scrollable=true の場合:
  //   ボディ右端にスクロールバースロット (Scroll.SCROLLBAR_SLOT_WIDTH) が張り付く。
  //   構成 (左→右): content | sep(1) | dark(1) | thumb | dark(1) | border
  //   sbReserve = Scroll.SCROLLBAR_SLOT_WIDTH
  //   contentW  = ボディ幅 - sbReserve - CONTENT_PADDING*2
  //
  // scrollable=false: sbReserve=0
  //
  // contentTop / contentBottom / contentH は calcWindowSize の逆演算。
  const sbReserve = win._scrollable ? Scroll.SCROLLBAR_SLOT_WIDTH : 0;
  const contentTop = sepY + SEPARATOR_HEIGHT + CONTENT_PADDING;
  const contentBottom =
    footerH > 0
      ? fy + fh - BORDER - footerH - CONTENT_PADDING
      : fy + fh - BORDER - CONTENT_PADDING;
  const contentX = fx + BORDER + CONTENT_PADDING;
  const contentY = contentTop;
  const contentW = Math.max(
    0,
    fw - BORDER * 2 - CONTENT_PADDING * 2 - sbReserve,
  );
  const contentH = Math.max(0, contentBottom - contentTop);

  // ── スクロールバー・スロット矩形 (scrollable=true) ──
  // Scroll.drawVScrollbarSlot に渡すスロット領域。
  // 内部で sep, dark margin, thumb を描画する。
  let scrollbarRect = null;
  if (win._scrollable) {
    const slotTop = sepY + SEPARATOR_HEIGHT;
    const slotBottom =
      footerH > 0 ? fy + fh - BORDER - footerH : fy + fh - BORDER;
    scrollbarRect = {
      x: fx + fw - BORDER - Scroll.SCROLLBAR_SLOT_WIDTH,
      y: slotTop,
      w: Scroll.SCROLLBAR_SLOT_WIDTH,
      h: Math.max(0, slotBottom - slotTop),
    };
  }

  // ── スクロール状態の viewport 更新 ──
  if (win._scrollable && win._vScroll) {
    Scroll.scrollSetViewport(win._vScroll, contentH);
  }

  // ── footer (opt-in) ──
  // footerRect はパディング内側 (テキスト描画可能領域) を返す。
  // 区切り線(FOOTER_SEPARATOR_HEIGHT) と上下左右の余白(FOOTER_PADDING) は WM が管理する。
  let footerRect = null;
  let footerSepY = 0;
  if (footerH > 0) {
    footerSepY = fy + fh - BORDER - footerH;
    // footer はウィンドウ枠の内側 (BORDER) から FOOTER_PADDING を取った領域
    const footerX = fx + BORDER + FOOTER_PADDING;
    const footerW = fw - (BORDER + FOOTER_PADDING) * 2;
    footerRect = {
      x: footerX,
      y: footerSepY + FOOTER_SEPARATOR_HEIGHT + FOOTER_PADDING,
      w: Math.max(0, footerW),
      h: Math.max(0, footerH - FOOTER_SEPARATOR_HEIGHT - FOOTER_PADDING * 2),
    };
  }

  win._layout = {
    // ヘッダー領域 (枠内側、区切り線上まで)
    headerRect: { x: headerX, y: headerY, w: headerW, h: HEADER_HEIGHT },
    // ヘッダー装飾矩形 (GPU.fillRect 用)
    decoRect: { x: decoX, y: decoY, w: decoW, h: decoH },
    // タイトル描画位置
    titleX,
    titleY,
    // アイコン描画 Y 位置 / 右端基準 X
    iconY,
    iconBaseX,
    // ヘッダー/ボディ区切り線 Y
    sepY,
    // コンテンツ描画領域
    contentRect: { x: contentX, y: contentY, w: contentW, h: contentH },
    // スクロールバー矩形 (scrollable=true の場合のみ, null = スクロール無効)
    scrollbarRect,
    // footer 区切り線 Y (footer 有効時のみ)
    footerSepY,
    // footer 描画領域 (null = footer 無効)
    footerRect,
  };
}

/**
 * コンテンツサイズからウィンドウの外寸 (w, h) を算出する。
 * wmOpen / border ダブルクリック等で共通使用。
 * 外部からは wmCalcWindowSize としてもアクセス可能。
 *
 * 計算式 (recalcLayout の逆演算):
 *   w = cw + BORDER*2 + CONTENT_PADDING*2 + sbReserve
 *   h = ch + BORDER + SEPARATOR_HEIGHT + BORDER + HEADER_HEIGHT + CONTENT_PADDING*2 + (footer ? FOOTER_HEIGHT : 0)
 *
 * scrollable=true の場合、ボディ右端のスクロールバースロット (Scroll.SCROLLBAR_SLOT_WIDTH) を加算する。
 *
 * @param {number} cw  コンテンツ幅
 * @param {number} ch  コンテンツ高さ
 * @param {boolean} [footer=false] footer 有効フラグ
 * @param {boolean} [scrollable=false] スクロール可能ウィンドウか
 * @returns {{ w:number, h:number }}
 */
export function calcWindowSize(cw, ch, footer = false, scrollable = false) {
  const sbReserve = scrollable ? Scroll.SCROLLBAR_SLOT_WIDTH : 0;
  const footerH = footer ? FOOTER_HEIGHT : 0;
  return {
    w: Math.max(
      MIN_WIDTH,
      cw + FRAME_EXTRA_W + CONTENT_PADDING * 2 + sbReserve,
    ),
    h: Math.max(
      MIN_HEIGHT,
      ch + FRAME_EXTRA_H + HEADER_HEIGHT + CONTENT_PADDING * 2 + footerH,
    ),
  };
}

/** @deprecated wmCalcWindowSize として re-export するためのエイリアス */
export { calcWindowSize as wmCalcWindowSize };

/**
 * ウィンドウのボディ内側 (コンテンツ描画可能領域) を返す。
 * recalcLayout で算出済みのキャッシュを返す。
 * @param {object} win  ウィンドウオブジェクト
 * @returns {{ x:number, y:number, w:number, h:number }}
 */
function getContentRect(win) {
  return win._layout.contentRect;
}

/**
 * イベント座標をコンテンツローカル座標に変換する。
 * スクロール可能ウィンドウではスクロール分を加算して仮想座標を返す。
 */
function toLocalCoords(win, mx, my) {
  const cr = getContentRect(win);
  const scrollY = win._scrollable && win._vScroll ? win._vScroll.offset : 0;
  return { lx: mx - cr.x, ly: my - cr.y + scrollY };
}

/**
 * マウス座標がウィンドウスクロールバー領域内かどうかを判定する。
 */
function hitTestWindowScrollbar(win, mx, my) {
  if (!win._scrollable || !win._vScroll) return false;
  const sb = win._layout.scrollbarRect;
  if (!sb) return false;
  const th = Scroll.vScrollbarSlotThumbArea(sb.x, sb.y, sb.h);
  return mx >= th.x && mx < th.x + th.w && my >= th.y && my < th.y + th.h;
}

/**
 * ウィンドウのコンテンツ描画可能領域を取得する。
 * @param {number} id  ウィンドウ ID
 * @returns {{ x:number, y:number, w:number, h:number }|null}
 */
export function wmGetContentRect(id) {
  const win = windows.find((w) => w.id === id);
  if (!win) return null;
  return getContentRect(win);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  公開 API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 登録済みファクトリ一覧を返す (デスクトップアイコン生成等に使用)。
 * @returns {{ name: string, modal: boolean, category: string|null }[]}
 */
export function wmGetRegistry() {
  return registry.map((e) => ({
    name: e.name,
    shortName: e.shortName,
    modal: e.modal,
    category: e.category,
    dev: e.dev,
  }));
}

/**
 * 登録済みのすべてのウィンドウを開く (デバッグ用).
 */
function wmOpenAll() {
  for (const entry of registry) {
    if (entry.winId === null) {
      entry.winId = entry.factory();
    }
  }
}

/**
 * 名前を指定してウィンドウを開く。既に開いている場合は何もしない。
 * @param {string} name  wmRegister で登録した名前
 */
export function wmOpenByName(name) {
  const entry = registry.find((e) => e.name === name);
  if (entry && entry.winId === null) {
    entry.winId = entry.factory();
  }
}

/**
 * 名前を指定してウィンドウを開くか最前面に移動する。
 * 閉じていれば開き、開いていれば最前面へ移動する。
 * @param {string} name  wmRegister で登録した名前
 */
export function wmOpenOrFocus(name) {
  const entry = registry.find((e) => e.name === name);
  if (entry) toggleRegistered(entry);
}

/**
 * scrollable ウィンドウの初期サイズを work area の SCROLL_INIT_RATIO 倍へ
 * クランプする。
 *
 * クランプしないと画面外にはみ出し、かつ contentRect.h == virtualH となって
 * スクロールバーが出ない (= 最大化するまで下部に到達不可) という矛盾が発生する。
 * 100% でなく ~85% にすることで画面上下に余白を作り、圧迫感を緩和する。
 *
 * @returns {{ w: number, h: number, clamped: boolean }} clamped: 高さが clamp されたか
 */
const SCROLL_INIT_RATIO = 0.85;
function clampScrollableInitSize(w, h) {
  const workAreaH = Config.VRAM_HEIGHT - workAreaTop;
  const maxH = Math.floor(workAreaH * SCROLL_INIT_RATIO);
  let clamped = false;
  if (h > maxH) {
    h = maxH;
    clamped = true;
  }
  if (w > Config.VRAM_WIDTH) w = Config.VRAM_WIDTH;
  return { w, h, clamped };
}

/**
 * ウィンドウを「ちょうど良いサイズ」(自然サイズ、scrollable は ratio クランプ後)
 * にリサイズし、現在の中心位置を保ったまま再配置する。最後に画面内クランプ。
 * 右クリックメニューの "FIT TO CONTENT" から呼ばれる。
 */
function fitWindowToContent(win) {
  if (!win.onMeasure || win.noResize) return;
  const size = win.onMeasure();
  const fit = calcWindowSize(size.w, size.h, win.footer, win._scrollable);
  let newW = fit.w;
  let newH = fit.h;
  if (win._scrollable) {
    const c = clampScrollableInitSize(newW, newH);
    newW = c.w;
    newH = c.h;
  }
  // 中心保持で新位置算出 → 画面内クランプ
  const cx = win.x + win.w / 2;
  const cy = win.y + win.h / 2;
  let newX = Math.floor(cx - newW / 2);
  let newY = Math.floor(cy - newH / 2);
  newX = Math.max(0, Math.min(newX, Config.VRAM_WIDTH - newW));
  newY = Math.max(workAreaTop, Math.min(newY, Config.VRAM_HEIGHT - newH));
  win.x = newX;
  win.y = newY;
  win.w = newW;
  win.h = newH;
  win.restoreRect = null;
  win.snapState = "none";
  recalcLayout(win);
}

/**
 * ウィンドウヘッダー右クリック用のコンテキストメニューアイテムを構築する。
 * noResize / noMaximize の指定に応じて該当項目を省略する。
 */
function buildWindowContextMenu(win) {
  const items = [];
  if (win.onMeasure && !win.noResize) {
    items.push({
      type: "action",
      label: "FIT TO CONTENT",
      action: () => fitWindowToContent(win),
    });
  }
  if (!win.noMaximize) {
    items.push({
      type: "action",
      label: win.restoreRect ? "RESTORE" : "MAXIMIZE",
      action: () => toggleMaximize(win),
    });
  }
  if (win.about) {
    items.push({
      type: "action",
      label: win._aboutMode ? "HIDE ABOUT" : "ABOUT",
      action: () => _startAboutTransition(win, !win._aboutMode),
    });
  }
  if (items.length > 0) items.push({ type: "sep" });
  items.push({
    type: "action",
    label: "CLOSE",
    action: () => {
      if (win.onBeforeClose && !win.onBeforeClose()) return;
      wmClose(win.id);
    },
  });
  return items;
}

/**
 * ウィンドウを追加する。配列の末尾が最前面。
 * w, h に 0 を指定すると onMeasure から自動算出する。
 * x, y に負値を指定するとカスケード自動配置になる。
 * 座標は常に画面内にクランプされる。
 * @param {number} x  左上 X (負値でカスケード自動配置)
 * @param {number} y  左上 Y (負値でカスケード自動配置)
 * @param {number} w  幅 (0 で自動算出)
 * @param {number} h  高さ (0 で自動算出)
 * @param {string} [title=""] タイトル文字列
 * @param {function|null} [onDraw=null] コンテンツ描画コールバック (contentRect) => void
 * @param {function|null} [onInput=null] 入力コールバック ({ localX, localY, type }) => void
 * @param {function|null} [onMeasure=null] コンテンツサイズ測定コールバック () => { w, h }
 * @param {object} [opts] 追加オプション ({ footer, onDrawFooter, onInputFooter, modal, noResize, noMaximize, onBeforeClose })
 * @returns {number} ウィンドウ ID (一意の識別子)
 */
export function wmOpen(
  x,
  y,
  w,
  h,
  title = "",
  onDraw = null,
  onInput = null,
  onMeasure = null,
  opts = null,
) {
  const footer = !!(opts && opts.footer);
  const scrollable = !!(opts && opts.scrollable);
  // w=0 or h=0 なら onMeasure で自動算出
  let scrollableClamped = false;
  if (onMeasure && (w === 0 || h === 0)) {
    const size = onMeasure();
    const fit = calcWindowSize(size.w, size.h, footer, scrollable);
    if (w === 0) w = fit.w;
    if (h === 0) h = fit.h;
    if (scrollable) {
      const c = clampScrollableInitSize(w, h);
      w = c.w;
      h = c.h;
      scrollableClamped = c.clamped;
    }
  }

  // 自動カスケード配置 (x < 0 で opt-in)
  if (x < 0) {
    const waTop = wmGetWorkAreaTop();
    if (opts && opts.center) {
      // 画面中央配置
      x = ((Config.VRAM_WIDTH - w) / 2) | 0;
      y = (waTop + (Config.VRAM_HEIGHT - waTop - h) / 2) | 0;
    } else if (scrollableClamped) {
      // scrollable で work area より大きく、初期高がクランプされた場合は
      // cascade ではなく画面中央に置く。上下対称な余白で「映える」配置に。
      const workAreaH = Config.VRAM_HEIGHT - waTop;
      x = ((Config.VRAM_WIDTH - w) / 2) | 0;
      y = waTop + Math.floor((workAreaH - h) / 2);
    } else {
      const pos = nextCascadePos(w, h);
      x = pos.x;
      y = pos.y;
    }
  }

  // クランプ: ウィンドウが画面内に収まるよう補正
  const waTop = wmGetWorkAreaTop();
  x = Math.max(
    0,
    Math.min(x, Config.VRAM_WIDTH - Math.min(w, Config.VRAM_WIDTH)),
  );
  y = Math.max(
    waTop,
    Math.min(y, Config.VRAM_HEIGHT - Math.min(h, Config.VRAM_HEIGHT - waTop)),
  );

  const id = nextWinId++;
  const win = createWindow(
    id,
    x,
    y,
    w,
    h,
    title,
    onDraw,
    onInput,
    onMeasure,
    opts,
  );
  windows.push(win);
  if (win.modal) _modalWinId = id;
  if (_sfxCallbacks?.onOpen) _sfxCallbacks.onOpen();
  return id;
}

/**
 * ウィンドウを閉じる (配列から完全に削除)。
 * @param {number} id  wmOpen が返した ID
 */
export function wmClose(id) {
  const idx = windows.findIndex((w) => w.id === id);
  if (idx < 0) return;
  if (_sfxCallbacks?.onClose) _sfxCallbacks.onClose();
  windows.splice(idx, 1);
  if (activeIndex === idx) {
    activeIndex = -1;
    mode = "none";
  } else if (activeIndex > idx) activeIndex--;
  // モーダル解除
  if (id === _modalWinId) _modalWinId = null;
  // ファクトリの参照をクリア
  const entry = registry.find((e) => e.winId === id);
  if (entry) entry.winId = null;
}

/**
 * 全ウィンドウのタイトルと状態を取得する。
 * @returns {{ id:number, title:string }[]}
 */
export function wmGetWindowList() {
  return windows.map((w) => ({
    id: w.id,
    title: w.title,
  }));
}

/**
 * 指定IDのウィンドウの枠込み矩形を返す。
 * @param {number} id  ウィンドウ ID
 * @returns {{ x:number, y:number, w:number, h:number }|null}
 */
export function wmGetWindowRect(id) {
  const win = windows.find((w) => w.id === id);
  if (!win) return null;
  return { x: win.x, y: win.y, w: win.w, h: win.h };
}

/** 指定IDが最前面のウィンドウかどうか */
export function wmIsFocused(idOrTitle) {
  if (windows.length === 0) return false;
  const w = windows[windows.length - 1];
  return typeof idOrTitle === "string"
    ? w.title === idOrTitle
    : w.id === idOrTitle;
}

/**
 * ウィンドウのタイトルを変更する。
 * @param {number} id     ウィンドウ ID
 * @param {string} title  新しいタイトル
 */
export function wmSetTitle(id, title) {
  const win = windows.find((w) => w.id === id);
  if (win) win.title = title;
}

/** 指定IDのウィンドウを最前面に持ってくる */
export function wmFocus(id) {
  const idx = windows.findIndex((w) => w.id === id);
  if (idx >= 0) bringToFront(idx);
}

/** モーダルウィンドウが開いているかどうかを返す */
export function wmIsModalOpen() {
  return _modalWinId !== null;
}

// ── スクロール API ──

/**
 * スクロール可能ウィンドウの仮想コンテンツサイズを設定する。
 * cotnentRect より大きい場合にスクロールバーが有効になる。
 * @param {number} id    ウィンドウ ID
 * @param {number} virtualH  仮想コンテンツ高さ (px)
 */
export function wmSetContentSize(id, virtualH) {
  const win = windows.find((w) => w.id === id);
  if (!win || !win._scrollable) return;
  win._virtualH = virtualH;
  if (!win._vScroll) {
    const cr = getContentRect(win);
    win._vScroll = Scroll.createScrollState(cr.h, virtualH);
  } else {
    Scroll.scrollSetContent(win._vScroll, virtualH);
  }
}

/**
 * ウィンドウの現在のスクロール位置を返す。
 * @param {number} id  ウィンドウ ID
 * @returns {{ x:number, y:number }}
 */
export function wmGetScroll(id) {
  const win = windows.find((w) => w.id === id);
  if (!win) return { x: 0, y: 0 };
  return { x: 0, y: win._vScroll ? win._vScroll.offset : 0 };
}

/**
 * 毎フレームの入力処理。kernel → update の前に呼ぶ。
 *
 * 左ボタン押下時に最前面から探索:
 *   1. 境界線ヒット → リサイズモード
 *   2. 内部ヒット   → 移動モード (スナップ中なら先に復帰)
 * 移動ドロップ時に画面端ならスナップ配置。
 * 左ボタンを離すと操作終了。
 */
export function wmUpdate() {
  const mx = Input.mouseX();
  const my = Input.mouseY();

  // ── ツールチップ: 前フレームのテキストを保持してリセット ──
  tooltipPrevText = tooltipText;
  tooltipText = null;

  // ── モーダルウィンドウ (他ウィンドウの入力をブロック) ──
  if (_modalWinId !== null) {
    const modalWin = windows.find((w) => w.id === _modalWinId);
    if (modalWin) {
      // モーダルを常に最前面に保持
      const mi = windows.indexOf(modalWin);
      if (mi !== windows.length - 1) {
        activeIndex = bringToFront(mi);
      }
      // モーダルのみに入力を処理 (Ctrl+F6, メニュー, 他ウィンドウは全てブロック)
      if (Input.mouseButtonDown(0)) {
        const fi = windows.length - 1;
        if (hitTestHeader(modalWin, mx, my)) {
          handleHeaderClick(fi, mx, my);
        } else if (hitTestBody(modalWin, mx, my)) {
          handleBodyClick(fi, mx, my);
        }
        // モーダル外のクリックは無視
      }
      handleDrag(mx, my);
      propagateBodyEvents(mx, my);
      handleMouseRelease(mx, my);
      updateCursorShape(mx, my);
      return;
    }
  }

  // ── Ctrl+F6 / Ctrl+Shift+F6 でウィンドウ切替 ──
  if (windows.length > 1) {
    if (Input.ctrlDown("F6")) {
      // 正順: 最前面を最背面に送り、新しい最前面をアクティブに
      activeIndex = sendToBack(windows.length - 1);
      Desktop.desktopBlur();
    } else if (Input.ctrlShiftDown("F6")) {
      // 逆順: 最背面を最前面に
      activeIndex = bringToFront(0);
      Desktop.desktopBlur();
    }
  }

  // ── メニュー処理 ──
  if (menuOpen) handleMenuInput(mx, my);
  if (menuOpen && Input.mouseButtonDown(0)) {
    handleMenuClick(mx, my);
    return;
  }

  // ── 右クリック: デスクトップ → メニュー / ウィンドウボディ → rdown 伝播 ──
  if (Input.mouseButtonDown(2)) {
    handleRightClick(mx, my);
  }

  // ── 左クリック: ウィンドウ操作開始 ──
  if (Input.mouseButtonDown(0)) handleLeftClick(mx, my);

  // ── 中ボタンクリック: コンテンツへ伝播 ──
  if (Input.mouseButtonDown(1)) handleMiddleClick(mx, my);

  // ── ドラッグ中の移動/リサイズ ──
  handleDrag(mx, my);

  // ── ボディへのイベント伝播 (wheel / hover / held / up / rheld / rup) ──
  propagateBodyEvents(mx, my);

  // ── マウスアップ: 操作終了 ──
  handleMouseRelease(mx, my);

  // ── デスクトップアイコン ドラッグ・ショートカット処理 ──
  Desktop.desktopUpdate(mx, my);

  // ── デスクトップアイコンのホバー ──
  handleDesktopHover(mx, my);

  // ── カーソル種別更新 ──
  updateCursorShape(mx, my);
}

// ── wmUpdate サブ関数 ──

/**
 * 右クリック処理。
 * - メニューが開いている → 閉じる
 * - ウィンドウボディ上 → 最前面昇格 + "rdown" イベントをアプリに伝播
 * - デスクトップ上 → 右クリックメニュー表示
 */
function handleRightClick(mx, my) {
  if (menuOpen) {
    closeMenu();
    return;
  }
  // 作業領域外 (タスクバー等) では何もしない
  if (my < workAreaTop) return;

  // ウィンドウボディ上 → アプリに rdown を伝播
  for (let i = windows.length - 1; i >= 0; i--) {
    const win = windows[i];
    if (hitTestBody(win, mx, my)) {
      const newIdx = bringToFront(i);
      const target = windows[newIdx];
      if (target.onInput) {
        const { lx, ly } = toLocalCoords(target, mx, my);
        safeOnInput(target, {
          localX: lx,
          localY: ly,
          type: "rdown",
          ctrl: Input.mouseHasCtrl(),
          shift: Input.mouseHasShift(),
        });
      }
      return;
    }
    // ヘッダー → ウィンドウコンテキストメニュー
    if (hitTestHeader(win, mx, my)) {
      bringToFront(i);
      const target = windows[windows.length - 1];
      openContextMenu(buildWindowContextMenu(target), mx, my);
      return;
    }
    // 境界線上は何もしない (リサイズは左ボタン drag のみ。DC autosize は廃止)
    if (hitTestBorder(win, mx, my) !== 0) {
      return;
    }
  }

  // ウィンドウ外 → デスクトップメニュー
  openMenu(mx, my);
}

/** 左クリック: ポップアップ伝播 / タスクバー / ウィンドウ操作開始 */
function handleLeftClick(mx, my) {
  // ウィンドウがクリックされた場合に備えてデスクトップフォーカスを仮解除。
  // Desktop.desktopHandleInput に到達した場合はそこで再設定される。
  Desktop.desktopBlur();

  // ポップアップが開いている場合: 最前面ウィンドウに伝播
  if (hasOpenPopup() && windows.length > 0) {
    const front = windows[windows.length - 1];
    if (front && front.onInput) {
      const { lx, ly } = toLocalCoords(front, mx, my);
      safeOnInput(front, {
        localX: lx,
        localY: ly,
        type: "down",
        ctrl: Input.mouseHasCtrl(),
        shift: Input.mouseHasShift(),
      });
    }
    return;
  }

  // 作業領域外 (タスクバー等) のクリックはウィンドウに伝播しない
  if (my < workAreaTop) return;

  // ウィンドウヒットテスト (最前面から)
  for (let i = windows.length - 1; i >= 0; i--) {
    const win = windows[i];

    // 1) 境界線ヒット
    const edges = hitTestBorder(win, mx, my);
    if (edges) {
      handleBorderClick(i, edges, mx, my);
      return;
    }

    // 2) ヘッダーヒット
    if (hitTestHeader(win, mx, my)) {
      handleHeaderClick(i, mx, my);
      return;
    }

    // 3) ボディヒット
    if (hitTestBody(win, mx, my)) {
      handleBodyClick(i, mx, my);
      return;
    }
  }

  // ウィンドウにヒットしなかった → デスクトップアイコン判定
  Desktop.desktopHandleInput(mx, my, wmOpenByName);
}

/** 境界線クリック: ダブルクリックで自動リサイズ / シングルクリックでリサイズ開始 */
function handleBorderClick(i, edges, mx, my) {
  activeIndex = bringToFront(i);
  const target = windows[activeIndex];

  // noResize ウィンドウではリサイズ不可 (最前面昇格のみ)
  if (target.noResize) return;

  // 自動リサイズはヘッダー右クリック → FIT TO CONTENT に集約。境界線 DC は廃止。
  mode = "resize";
  resizeEdges = edges;
  resizeStartMX = mx;
  resizeStartMY = my;
  const w = windows[activeIndex];
  resizeStartX = w.x;
  resizeStartY = w.y;
  resizeStartW = w.w;
  resizeStartH = w.h;
}

/** 最大化 ↔ 復帰をトグルする共通処理 */
function toggleMaximize(win) {
  if (win.restoreRect) {
    const r = win.restoreRect;
    win.x = r.x;
    win.y = r.y;
    win.w = r.w;
    win.h = r.h;
    win.restoreRect = null;
    win.snapState = "none";
  } else {
    savePreSnapRect(win);
    win.x = 0;
    win.y = workAreaTop;
    win.w = Config.VRAM_WIDTH;
    win.h = Config.VRAM_HEIGHT - workAreaTop;
    win.snapState = "maximized";
  }
  recalcLayout(win);
  if (_sfxCallbacks?.onMaximize) _sfxCallbacks.onMaximize();
}

/** ヘッダークリック: アイコン / ダブルクリック最大化 / 移動開始 */
function handleHeaderClick(i, mx, my) {
  activeIndex = bringToFront(i);
  const target = windows[activeIndex];

  // アイコンクリック (ドラッグより優先)
  const icon = hitTestHeaderIcon(target, mx, my);
  if (icon === "close") {
    if (target.onBeforeClose && !target.onBeforeClose()) return;
    wmClose(target.id);
    return;
  }
  if (icon === "maximize") {
    toggleMaximize(target);
    return;
  }

  // ダブルクリック: input.js のタイミング判定 + 同一ウィンドウ確認
  if (
    !target.noMaximize &&
    lastHeaderClickWin === target &&
    Input.hasInputEvent("dblclick", 0)
  ) {
    lastHeaderClickWin = null;
    toggleMaximize(target);
    return;
  }
  lastHeaderClickWin = target;

  mode = "move-pending";
  dragOffX = mx - target.x;
  dragOffY = my - target.y;
}

/** ボディクリック: 最前面昇格 + ダブルクリック / 通常 down 伝播 */
function handleBodyClick(i, mx, my) {
  const newIdx = bringToFront(i);
  const target = windows[newIdx];

  // スクロールバー領域クリック → スクロールバー入力処理
  if (hitTestWindowScrollbar(target, mx, my)) {
    const sb = target._layout.scrollbarRect;
    const th = Scroll.vScrollbarSlotThumbArea(sb.x, sb.y, sb.h);
    Scroll.handleVScrollInput(target._vScroll, "down", my, th.y, th.h);
    wmRequestCursor("drag-v");
    return;
  }

  // footer クリック → onInputFooter があれば footer にルーティング
  if (hitTestFooter(target, mx, my) && target.onInputFooter) {
    const { lx, ly } = toFooterLocalCoords(target, mx, my);
    safeOnInputFooter(target, {
      localX: lx,
      localY: ly,
      type: "down",
      ctrl: Input.mouseHasCtrl(),
      shift: Input.mouseHasShift(),
    });
    return;
  }

  if (!target.onInput) return;

  const { lx, ly } = toLocalCoords(target, mx, my);

  // ダブルクリック: input.js のタイミング判定 + 同一ウィンドウ確認
  if (lastBodyClickWin === target && Input.hasInputEvent("dblclick", 0)) {
    lastBodyClickWin = null;
    // down を先に伝播してからダブルクリックを送る
    safeOnInput(target, {
      localX: lx,
      localY: ly,
      type: "down",
      ctrl: Input.mouseHasCtrl(),
      shift: Input.mouseHasShift(),
    });
    safeOnInput(target, {
      localX: lx,
      localY: ly,
      type: "dblclick",
      ctrl: Input.mouseHasCtrl(),
      shift: Input.mouseHasShift(),
    });
  } else {
    lastBodyClickWin = target;
    safeOnInput(target, {
      localX: lx,
      localY: ly,
      type: "down",
      ctrl: Input.mouseHasCtrl(),
      shift: Input.mouseHasShift(),
    });
  }
}

/** 中ボタンクリック: ウィンドウを最前面にしてコンテンツへ mdown を伝播 */
function handleMiddleClick(mx, my) {
  if (my < workAreaTop) return;
  for (let i = windows.length - 1; i >= 0; i--) {
    const win = windows[i];
    if (hitTestBody(win, mx, my)) {
      const newIdx = bringToFront(i);
      const target = windows[newIdx];
      if (target.onInput) {
        const { lx, ly } = toLocalCoords(target, mx, my);
        safeOnInput(target, {
          localX: lx,
          localY: ly,
          type: "mdown",
          ctrl: Input.mouseHasCtrl(),
          shift: Input.mouseHasShift(),
        });
      }
      return;
    }
  }
}

/** ドラッグ中の移動/リサイズ処理 */
function handleDrag(mx, my) {
  if (activeIndex < 0 || !Input.mouseButtonHeld(0)) return;
  const win = windows[activeIndex];

  // move-pending → input.js のドラッグ判定 (DRAG_DEAD_ZONE=3px) で move に遷移
  if (mode === "move-pending" && Input.isDragging(0)) {
    mode = "move";
    savePreSnapRect(win);
    if (win.snapState !== "none") {
      const off = unsnap(win, mx, my);
      dragOffX = off.offX;
      dragOffY = off.offY;
      win.restoreRect = { x: win.x, y: win.y, w: win.w, h: win.h };
    }
  }

  if (mode === "move") {
    win.x = mx - dragOffX;
    win.y = my - dragOffY;
    recalcLayout(win);
    // モーダルウィンドウはスナップ不可
    snapPreview = win.modal ? null : getSnapRect(mx, my);
  }

  if (mode === "resize") {
    const dx = mx - resizeStartMX;
    const dy = my - resizeStartMY;

    let minW = MIN_WIDTH;
    let minH = MIN_HEIGHT;
    if (win.onMeasure) {
      const size = win.onMeasure();
      const fit = calcWindowSize(size.w, size.h, win.footer, win._scrollable);
      minW = fit.w;
      minH = fit.h;
    }
    // scrollable ウィンドウは縦方向の最小高さを onMeasure で縛らない。
    // 縦スクロールでコンテンツより小さくしても破綻しないため、
    // 枠 + ヘッダー + ボディ最小 4px (MIN_HEIGHT) まで縮められる。
    // 幅は水平スクロール非対応のため引き続き onMeasure 由来の値で縛る。
    if (win._scrollable) {
      minH = MIN_HEIGHT;
    }

    if (resizeEdges & EDGE_RIGHT) win.w = Math.max(minW, resizeStartW + dx);
    if (resizeEdges & EDGE_LEFT) {
      const newW = Math.max(minW, resizeStartW - dx);
      win.x = resizeStartX + resizeStartW - newW;
      win.w = newW;
    }
    if (resizeEdges & EDGE_BOTTOM) win.h = Math.max(minH, resizeStartH + dy);
    if (resizeEdges & EDGE_TOP) {
      const newH = Math.max(minH, resizeStartH - dy);
      win.y = resizeStartY + resizeStartH - newH;
      win.h = newH;
    }
    recalcLayout(win);
  }
}

/** ボディへのイベント伝播 (wheel / hover / held / up / rheld / rup) */
function propagateBodyEvents(mx, my) {
  if (mode !== "none" || windows.length === 0) return;

  let front = windows[windows.length - 1];

  // ホイール: カーソル下のウィンドウに送る (focus-follows-wheel)
  const wy = Input.wheelY();
  const wx = Input.wheelX();
  if (wy !== 0 || wx !== 0) {
    for (let i = windows.length - 1; i >= 0; i--) {
      const win = windows[i];
      if (hitTestBody(win, mx, my)) {
        if (win !== front) {
          bringToFront(i);
          front = windows[windows.length - 1];
        }
        // ウィジェット優先: まずアプリに wheel を渡す。
        // ウィジェットが消費しなかった場合のみウィンドウスクロール。
        // Ctrl+Wheel はズーム等の用途のためウィンドウスクロールをスキップ。
        const { lx, ly } = toLocalCoords(win, mx, my);
        const ev = {
          localX: lx,
          localY: ly,
          type: "wheel",
          deltaX: wx,
          deltaY: wy,
          ctrl: Input.wheelHasCtrl(),
          alt: Input.wheelHasAlt(),
          shift: Input.wheelHasShift(),
          consumed: false,
        };
        if (win.onInput) safeOnInput(win, ev);
        if (
          !ev.consumed &&
          win._scrollable &&
          win._vScroll &&
          Scroll.scrollNeeded(win._vScroll) &&
          !Input.wheelHasCtrl()
        ) {
          // ウィンドウスクロール単位は px。ホイール delta (典型値: 100/clk on
          // Windows、trackpad では小さい連続値) を ~1/6 してスクロール量に変換する。
          // 最低 1px を保証してトラックパッドの微細な操作も拾う。
          if (wy !== 0) {
            const step =
              Math.sign(wy) * Math.max(1, Math.round(Math.abs(wy) / 6));
            Scroll.scrollBy(win._vScroll, step);
          }
        }
        break;
      }
    }
  }

  if (front) {
    const { lx, ly } = toLocalCoords(front, mx, my);
    const onBody = hitTestBody(front, mx, my);
    const onFooter = hitTestFooter(front, mx, my);
    const popupOpen = hasOpenPopup();
    const tbFocus = hasTextInputFocus();

    // ── スクロールバーのドラッグ追従 / リリース ──
    if (
      front._scrollable &&
      front._vScroll &&
      Scroll.scrollIsDragging(front._vScroll)
    ) {
      const sb = front._layout.scrollbarRect;
      const th = Scroll.vScrollbarSlotThumbArea(sb.x, sb.y, sb.h);
      if (Input.mouseButtonHeld(0)) {
        Scroll.handleVScrollInput(front._vScroll, "held", my, th.y, th.h);
      }
      if (Input.mouseButtonUp(0)) {
        Scroll.handleVScrollInput(front._vScroll, "up", my, th.y, th.h);
      }
      wmRequestCursor("drag-v");
      return; // スクロールバードラッグ中はコンテンツ入力をブロック
    }

    // ── スクロールバーホバー → drag-v カーソル ──
    if (
      front._scrollable &&
      front._vScroll &&
      hitTestWindowScrollbar(front, mx, my) &&
      !Input.mouseButtonDown(0) &&
      !Input.mouseButtonHeld(0)
    ) {
      wmRequestCursor("drag-v");
    }

    // ── footer イベントルーティング (onInputFooter がある場合) ──
    if (onFooter && front.onInputFooter) {
      const { lx: flx, ly: fly } = toFooterLocalCoords(front, mx, my);
      if (Input.mouseButtonHeld(0)) {
        safeOnInputFooter(front, {
          localX: flx,
          localY: fly,
          type: "held",
          ctrl: Input.mouseHasCtrl(),
          shift: Input.mouseHasShift(),
        });
      } else if (
        !Input.mouseButtonDown(0) &&
        !Input.mouseButtonHeld(0) &&
        !Input.mouseButtonUp(0)
      ) {
        safeOnInputFooter(front, { localX: flx, localY: fly, type: "hover" });
      }
      if (Input.mouseButtonUp(0)) {
        safeOnInputFooter(front, {
          localX: flx,
          localY: fly,
          type: "up",
          ctrl: Input.mouseHasCtrl(),
          shift: Input.mouseHasShift(),
        });
      }
      return; // footer イベントは onInputFooter で消費
    }

    if (front.onInput) {
      if (Input.mouseButtonHeld(0) && (onBody || popupOpen || tbFocus)) {
        safeOnInput(front, {
          localX: lx,
          localY: ly,
          type: "held",
          ctrl: Input.mouseHasCtrl(),
          shift: Input.mouseHasShift(),
        });
      } else if (
        !Input.mouseButtonDown(0) &&
        !Input.mouseButtonHeld(0) &&
        (onBody || popupOpen || tbFocus)
      ) {
        safeOnInput(front, { localX: lx, localY: ly, type: "hover" });
      }
      if (Input.mouseButtonUp(0) && (onBody || popupOpen || tbFocus)) {
        safeOnInput(front, {
          localX: lx,
          localY: ly,
          type: "up",
          ctrl: Input.mouseHasCtrl(),
          shift: Input.mouseHasShift(),
        });
      }

      // ── 中ボタン: ドラッグ / アップ ──
      if (Input.mouseButtonHeld(1) && (onBody || popupOpen || tbFocus)) {
        safeOnInput(front, {
          localX: lx,
          localY: ly,
          type: "mheld",
          ctrl: Input.mouseHasCtrl(),
          shift: Input.mouseHasShift(),
        });
      }
      if (Input.mouseButtonUp(1) && (onBody || popupOpen || tbFocus)) {
        safeOnInput(front, {
          localX: lx,
          localY: ly,
          type: "mup",
          ctrl: Input.mouseHasCtrl(),
          shift: Input.mouseHasShift(),
        });
      }

      // ── 右ボタン: ドラッグ / アップ ──
      if (Input.mouseButtonHeld(2) && (onBody || popupOpen || tbFocus)) {
        safeOnInput(front, {
          localX: lx,
          localY: ly,
          type: "rheld",
          ctrl: Input.mouseHasCtrl(),
          shift: Input.mouseHasShift(),
        });
      }
      if (Input.mouseButtonUp(2) && (onBody || popupOpen || tbFocus)) {
        safeOnInput(front, {
          localX: lx,
          localY: ly,
          type: "rup",
          ctrl: Input.mouseHasCtrl(),
          shift: Input.mouseHasShift(),
        });
      }
    }
  }
}

/**
 * デスクトップアイコンのホバー処理。
 * マウスボタンが離れていてメニューが閉じているとき、
 * どのウィンドウ上にもいなければツールチップを表示する。
 */
let _desktopIconHover = false;
function handleDesktopHover(mx, my) {
  _desktopIconHover = false;
  if (
    Input.mouseButtonDown(0) ||
    Input.mouseButtonHeld(0) ||
    Input.mouseButtonUp(0)
  )
    return;
  if (menuOpen) return;
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i];
    if (mx >= w.x && mx < w.x + w.w && my >= w.y && my < w.y + w.h) return;
  }
  _desktopIconHover = Desktop.desktopHandleHover(mx, my);
}

/** マウスボタンリリース: スナップ判定 + 操作モードリセット */
function handleMouseRelease(mx, my) {
  if (!Input.mouseButtonUp(0)) return;
  if (mode === "move" && activeIndex >= 0) {
    const win = windows[activeIndex];
    // モーダルウィンドウはスナップ不可
    if (!win.modal && trySnap(win, mx, my)) {
      // snapped
    } else {
      win.restoreRect = null;
      win.snapState = "none";
    }
  }
  activeIndex = -1;
  mode = "none";
  snapPreview = null;
}

/** コンテンツ領域からのカーソルオーバーライド (毎フレームリセット) */
let contentCursorOverride = null;

/**
 * コンテンツ領域のカーソルをリクエストする。
 * hover ハンドラ内で呼ぶと updateCursorShape で反映される。
 * @param {string} name  カーソル名 ("resize-ew" など)
 */
export function wmRequestCursor(name) {
  contentCursorOverride = name;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ツールチップ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ツールチップテキスト (null = 非表示, '\n' で複数行) */
let tooltipText = null;

/** ツールチップ表示ディレイ (同じテキストがセットされ続けたフレーム数) */
let tooltipFrames = 0;
let tooltipPrevText = null;

/** ツールチップ表示までのディレイフレーム数 */
const TOOLTIP_DELAY = 20;

/** ツールチップのパディング (px) */
const TOOLTIP_PADDING = 4;

/** ツールチップのカーソルからのオフセット (px) */
const TOOLTIP_OFFSET_X = 12;
const TOOLTIP_OFFSET_Y = 12;

/**
 * ツールチップテキストをセットする。
 * hover ハンドラ内で毎フレーム呼ぶ。呼ばなければ自動消去。
 * '\n' で改行可能。
 * @param {string} text  ツールチップテキスト
 */
export function wmSetTooltip(text) {
  tooltipText = text;
}

/** カーソル種別をドラッグモード / ホバー状態に応じて更新 */
function updateCursorShape(mx, my) {
  if (Desktop.desktopIsDragging()) {
    setCursor("move");
    return;
  }
  if (mode === "move" || mode === "move-pending") {
    setCursor("move");
  } else if (mode === "resize") {
    setCursor(edgesToCursor(resizeEdges));
  } else {
    let cursorName = "default";

    // メニュー上ならポインター
    if (menuOpen) {
      if (hitTestMenuPanels(mx, my) >= 0) {
        cursorName = "pointer";
      }
    }

    // ウィンドウ上のカーソル判定
    if (cursorName === "default") {
      for (let i = windows.length - 1; i >= 0; i--) {
        const edges = hitTestBorder(windows[i], mx, my);
        if (edges) {
          // noResize ウィンドウではリサイズカーソルを表示しない
          cursorName = windows[i].noResize ? "default" : edgesToCursor(edges);
          break;
        }
        if (hitTestHeader(windows[i], mx, my)) {
          cursorName = hitTestHeaderIcon(windows[i], mx, my)
            ? "pointer"
            : "move";
          break;
        }
        if (hitTestBody(windows[i], mx, my)) {
          cursorName = contentCursorOverride || "default";
          break;
        }
      }
    }

    // デスクトップアイコン上ならポインター
    if (cursorName === "default" && _desktopIconHover) {
      cursorName = "pointer";
    }

    setCursor(cursorName);
  }
  contentCursorOverride = null;
}

/** ツールチップを描画する。ディレイ後にカーソル付近にボックスを表示。 */
function drawTooltip() {
  // ディレイカウンタ更新
  if (tooltipText !== null && tooltipText === tooltipPrevText) {
    tooltipFrames++;
  } else {
    tooltipFrames = 0;
  }
  if (tooltipText === null || tooltipFrames < TOOLTIP_DELAY) return;
  if (_modalWinId !== null) return;

  const mx = Input.mouseX();
  const my = Input.mouseY();
  const lines = tooltipText.split("\n");
  const maxChars = Math.max(...lines.map((l) => l.length));
  const tw = maxChars * (GLYPH_W + 1) - 1;
  const lineH = GLYPH_H + 2;
  const th = lines.length * lineH - 2;
  const boxW = tw + TOOLTIP_PADDING * 2;
  const boxH = th + TOOLTIP_PADDING * 2;

  // 位置: カーソル右下、画面外にはみ出さないよう補正
  let tx = mx + TOOLTIP_OFFSET_X;
  let ty = my + TOOLTIP_OFFSET_Y;
  if (tx + boxW >= Config.VRAM_WIDTH) tx = mx - boxW - 4;
  if (ty + boxH >= Config.VRAM_HEIGHT) ty = my - boxH - 4;
  tx = Math.max(0, tx);
  ty = Math.max(0, ty);

  // 描画 (GPU.fillRoundRect で四隅を透過)
  GPU.fillRoundRect(tx, ty, boxW, boxH, 1, 0);
  GPU.drawRoundRect(tx, ty, boxW, boxH, 1, 1);
  for (let i = 0; i < lines.length; i++) {
    drawText(
      tx + TOOLTIP_PADDING,
      ty + TOOLTIP_PADDING + i * lineH,
      lines[i],
      1,
    );
  }
}

/**
 * 全ウィンドウを描画する。背面 (配列先頭) から前面 (末尾) へ順に描く。
 */
export function wmDraw() {
  // ── デスクトップアイコン (壁紙の上、ウィンドウの下) ──
  Desktop.desktopDraw();

  // ── スナッププレビュー (全ウィンドウの背面) ──
  if (snapPreview) {
    const sp = snapPreview;
    // 背景を暗色で塗り潰し (角丸四隅の透過防止 + 余白の下地)
    GPU.fillRect(sp.x, sp.y, sp.w, sp.h, 0);
    // 角丸ボーダー (1px)
    GPU.drawRoundRect(sp.x, sp.y, sp.w, sp.h, 1, 1);
    // ボーダー内側 1px 余白を空けて市松模様
    GPU.drawCheckerboard(sp.x + 2, sp.y + 2, sp.w - 4, sp.h - 4, 1);
  }

  for (const win of windows) {
    drawWindowFrame(win);
  }

  // ── メニュー ──
  drawMenu();

  // ── ポップアップ (全ウィンドウの上にクリップなしで描画) ──
  flushPopups();

  // ── ツールチップ (最前面) ──
  drawTooltip();
}

/**
 * 指定ウィンドウだけを原点 (0,0) に描画する。
 * スクリーンショット用キャプチャバッファへの単独描画に使う。
 * 通常の wmDraw() とは異なり、メニュー等は描画しない。
 * @param {number} id  ウィンドウ ID
 */
export function wmDrawSingleWindow(id) {
  const win = windows.find((w) => w.id === id);
  if (!win) return;

  // 座標を一時的にオフセット (ウィンドウ左上 → 0,0)
  const origX = win.x;
  const origY = win.y;
  win.x = 0;
  win.y = 0;
  recalcLayout(win); // 一時座標用レイアウトを再計算

  drawWindowFrame(win);

  // 座標を復元してレイアウトを元に戻す
  win.x = origX;
  win.y = origY;
  recalcLayout(win);
}

/**
 * ウィンドウのフレーム (枠線・ヘッダー・コンテンツ・footer) を描画する。
 * wmDraw / wmDrawSingleWindow から共通で呼ばれる。
 *
 * 前提: win._layout が recalcLayout() で最新に更新済みであること。
 * レイアウトの再計算は w/h/x/y 変更時のみ行う。
 */
/**
 * テキストを最大文字数で折り返す。明示的な改行 (\n) は段落区切りとして尊重し、
 * 各段落を単語境界で wrap する。maxChars を超える単語はハード分割する。
 * @returns {string[]} 行の配列
 */
function _wrapText(text, maxChars) {
  const out = [];
  for (const para of String(text).split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (line === "") {
        line = word;
      } else if ((line + " " + word).length <= maxChars) {
        line += " " + word;
      } else {
        out.push(line);
        line = word;
      }
      while (line.length > maxChars) {
        out.push(line.slice(0, maxChars));
        line = line.slice(maxChars);
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * ABOUT パネルを描画する。ボディ背景は drawWindowFrame 冒頭で塗り済み。
 * 「ABOUT」見出し + 区切り線 + 折り返した説明 + 下部に復帰ヒント。
 */
function drawAboutPanel(win, cr) {
  const pad = 5;
  const x = cr.x + pad;
  const lineH = GLYPH_H + 3;
  let y = cr.y + pad;

  drawText(x, y, "ABOUT", 1);
  y += GLYPH_H + 2;
  GPU.hline(cr.x + 2, cr.x + cr.w - 3, y, 1);
  y += 4;

  const maxChars = Math.max(1, Math.floor((cr.w - pad * 2) / (GLYPH_W + 1)));
  for (const line of _wrapText(win.about, maxChars)) {
    drawText(x, y, line, 1);
    y += lineH;
  }

  // 下部の復帰ヒント (右クリックメニューで HIDE ABOUT)
  const hint = "RIGHT-CLICK TO RETURN";
  drawText(x, cr.y + cr.h - GLYPH_H - 1, hint, 1);
}

// ── ABOUT ⇄ ボディの dither ディゾルブ遷移 ──

/** ディゾルブのフレーム数 (60fps で約 0.2 秒。ディザの texture が見える程度) */
const ABOUT_ANIM_FRAMES = 12;

/** ディゾルブ遷移を開始する (既に遷移中なら無視) */
function _startAboutTransition(win, toMode) {
  if (win._aboutAnim) return;
  win._aboutAnim = { to: toMode, t: 0, cw: 0, ch: 0, from: null, toBuf: null };
}

/** content rect の現在のピクセルをバッファにコピーする */
function _snapshotRect(cr) {
  const buf = new Uint8Array(cr.w * cr.h);
  for (let yy = 0; yy < cr.h; yy++) {
    for (let xx = 0; xx < cr.w; xx++) {
      buf[yy * cr.w + xx] = GPU.pget(cr.x + xx, cr.y + yy);
    }
  }
  return buf;
}

/** 指定した面 (about or ボディ) を content rect に描画する (スナップショット用) */
function _renderAboutFace(win, cr, aboutMode) {
  GPU.fillRect(cr.x, cr.y, cr.w, cr.h, 0);
  GPU.setClip(cr.x, cr.y, cr.w, cr.h);
  if (aboutMode) {
    drawAboutPanel(win, cr);
  } else if (win.onDraw) {
    const scrollY = win._scrollable && win._vScroll ? win._vScroll.offset : 0;
    const drawCr = scrollY
      ? { x: cr.x, y: cr.y - scrollY, w: cr.w, h: cr.h }
      : cr;
    safeOnDraw(win, drawCr);
  }
  GPU.resetClip();
}

/**
 * ABOUT ⇄ ボディのディゾルブを 1 フレーム描画する。
 * 初回に from/to 両面をスナップショットし、以降は Bayer 閾値を進めて合成する。
 */
function _drawAboutTransition(win, cr) {
  const anim = win._aboutAnim;
  // content rect サイズが遷移中に変わったら (リサイズ等) 即座に確定する
  if (anim.from && (cr.w !== anim.cw || cr.h !== anim.ch)) {
    win._aboutMode = anim.to;
    win._aboutAnim = null;
    return;
  }
  if (!anim.from) {
    anim.cw = cr.w;
    anim.ch = cr.h;
    _renderAboutFace(win, cr, win._aboutMode); // FROM = 現在の面
    anim.from = _snapshotRect(cr);
    _renderAboutFace(win, cr, anim.to); // TO = 遷移先の面
    anim.toBuf = _snapshotRect(cr);
  }
  // Bayer 4x4 (0..15) を閾値に、t に応じて from→to を ordered dither で混ぜる
  const thr = Math.round(anim.t * 17); // 0 → 全 from, 17 → 全 to
  for (let yy = 0; yy < cr.h; yy++) {
    const brow = BAYER_4x4[yy & 3]; // BAYER_4x4 は [row][col] の 2 次元配列
    for (let xx = 0; xx < cr.w; xx++) {
      const idx = yy * cr.w + xx;
      const v = brow[xx & 3] < thr ? anim.toBuf[idx] : anim.from[idx];
      GPU.pset(cr.x + xx, cr.y + yy, v);
    }
  }
  anim.t += 1 / ABOUT_ANIM_FRAMES;
  if (anim.t >= 1) {
    win._aboutMode = anim.to;
    win._aboutAnim = null;
  }
}

function drawWindowFrame(win) {
  const L = win._layout;

  // 内部領域を背景色 (0) で角丸塗りつぶし
  GPU.fillRoundRect(win.x + 1, win.y + 1, win.w - 2, win.h - 2, 1, 0);
  // 境界線を前景色 (1) で角丸描画
  GPU.drawRoundRect(win.x, win.y, win.w, win.h, 1, 1);

  // ── ヘッダー / ボディ区切り線 ──
  GPU.hline(win.x + 1, win.x + win.w - 2, L.sepY, 1);

  // ── ヘッダー内側装飾矩形 (明色塗りつぶし) ──
  GPU.fillRect(L.decoRect.x, L.decoRect.y, L.decoRect.w, L.decoRect.h, 1);

  // ── タイトル文字列 (ヘッダー左寄せ) ──
  if (win.title) {
    drawText(L.titleX, L.titleY, win.title, 0);
  }

  // ── タイトルバー右端にアイコンを描画 ──
  // 右端から close, maximize/restore の順に配置
  const closeX = L.iconBaseX - ICON_W;
  if (closeX > win.x) drawIcon("close", closeX, L.iconY, 0);

  if (!win.noMaximize) {
    const maxX = closeX - ICON_SLOT;
    if (maxX > win.x) {
      const maxIcon = win.snapState === "maximized" ? "restore" : "maximize";
      drawIcon(maxIcon, maxX, L.iconY, 0);
    }
  }

  // ── コンテンツ描画: ディゾルブ遷移 > ABOUT パネル > アプリ ──
  const cr = L.contentRect;
  if (win._aboutAnim) {
    if (cr.w > 0 && cr.h > 0) _drawAboutTransition(win, cr);
  } else if (win._aboutMode && win.about) {
    if (cr.w > 0 && cr.h > 0) {
      GPU.setClip(cr.x, cr.y, cr.w, cr.h);
      drawAboutPanel(win, cr);
      GPU.resetClip();
    }
  } else if (win.onDraw) {
    if (cr.w > 0 && cr.h > 0) {
      // スクロール可能ウィンドウ: contentRect.y をスクロール分だけ上へずらす
      const scrollY = win._scrollable && win._vScroll ? win._vScroll.offset : 0;
      const drawCr = scrollY
        ? { x: cr.x, y: cr.y - scrollY, w: cr.w, h: cr.h }
        : cr;
      // フォーカスブラケットのためにクリップを拡張。
      // CONTENT_PADDING を超えないようにクランプ (ヘッダー/枠線へのはみ出し防止)
      const clipMargin = Math.min(FOCUS_MARGIN, CONTENT_PADDING);
      GPU.setClip(
        cr.x - clipMargin,
        cr.y - clipMargin,
        cr.w + clipMargin * 2,
        cr.h + clipMargin * 2,
      );
      safeOnDraw(win, drawCr);
      GPU.resetClip();
    }
  }

  // ── ウィンドウスクロールバー描画 (opt-in) ──
  // scrollbarRect はスロット矩形 — Scroll.drawVScrollbarSlot が sep + dark + thumb を描画
  if (win._scrollable && win._vScroll && L.scrollbarRect) {
    const sb = L.scrollbarRect;
    Scroll.drawVScrollbarSlot(win._vScroll, sb.x, sb.y, sb.h);
  }

  // ── footer 描画 (opt-in) ──
  if (L.footerRect && win.onDrawFooter) {
    // footer 区切り線
    GPU.hline(win.x + 1, win.x + win.w - 2, L.footerSepY, 1);
    // footer 描画コールバック
    const fr = L.footerRect;
    if (fr.w > 0 && fr.h > 0) {
      GPU.setClip(fr.x, fr.y, fr.w, fr.h);
      safeOnDrawFooter(win, fr);
      GPU.resetClip();
    }
  }
}

