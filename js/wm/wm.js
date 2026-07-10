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
 *   標準 chrome 窓は既定で WM 管理の縦横スクロールを持つ (scrollable, 既定 ON)。
 *   仮想コンテンツ寸法は onMeasure (自然サイズ) から毎フレーム同期し (syncScrollContent)、
 *   ウィンドウが自然サイズより小さい軸でバーが機能する。WM が描画・入力処理・座標オフセット
 *   (縦横) を自動で行う。scrollbar.js プリミティブを共通部品として使用。
 *   (onMeasure を持たず自前で仮想寸法を決める窓は wmSetContentSize でも設定できる。)
 *
 *   scrollable 窓は「コンテンツの自然サイズ」と「ウィンドウの実サイズ」を分離して扱う:
 *     - 初期/再フィットは work area にクランプ (自然サイズが収まれば fit = maximize と一致)
 *     - リサイズ下限は MIN_WIDTH / MIN_HEIGHT まで緩和 (内容は縦横スクロールで巡るので切れない)
 *     - フォント/パディング変更時は自然サイズへ再フィット (work area クランプ付き)
 *   この分離により、画面より大きいコンテンツ (設定パネル等) でもスクロールでアクセスでき、
 *   ウィンドウを自由に縮めても内容が失われない。
 */

import * as Config from "../config.js";
import * as GPU from "../core/gpu.js";
import * as Input from "../core/input.js";
import { setCursor } from "../core/cursor.js";
import { drawIcon, ICON_W, ICON_H } from "../core/icon.js";
import { drawText, GLYPH_H, textWidth } from "../core/font.js";
import { FOCUS_MARGIN } from "../ui/ui_constants.js";
import * as Scroll from "../ui/scrollbar.js";
import * as Desktop from "./desktop.js";
import {
  BORDER,
  SEPARATOR_HEIGHT,
  FOOTER_SEPARATOR_HEIGHT,
  FOOTER_PADDING,
  MIN_WIDTH,
  MIN_HEIGHT,
  HEADER_HEIGHT,
  HEADER_PADDING,
  CONTENT_PADDING,
  FOOTER_HEIGHT,
  recalcLayout,
  calcWindowSize,
  recalcLayoutConstants,
} from "./win_layout.js";
import {
  menuOpen,
  openMenu,
  openContextMenu,
  closeMenu,
  drawMenu,
  hitTestMenuPanels,
  handleMenuInput,
  handleMenuClick,
  menuRecalcConstants,
  menuSetDeps,
} from "./menu.js";
import { wmSetTooltip, tooltipBeginFrame, drawTooltip } from "./tooltip.js";
import {
  drawAboutPanel,
  startAboutTransition,
  drawAboutTransition,
  aboutSetDeps,
} from "./about.js";

// フレーム構成定数・レイアウト算出は win_layout.js が SSoT。
// 旧来 wm.js から re-export していた公開定数/関数は互換のため再輸出する。
export { HEADER_HEIGHT, CONTENT_PADDING, FOOTER_HEIGHT, calcWindowSize };
// wmSetTooltip は tooltip.js が実体。index.js / kernel が参照するため再輸出。
export { wmSetTooltip };

// ── デスクトップ → WM コールバック注入 ──
Desktop.desktopSetTooltipCallback(wmSetTooltip);

// ── UI コールバック (循環依存回避のためコールバック注入) ──

/** @type {(() => void) | null} */
let _flushPopups = null;
/** @type {(() => boolean) | null} */
let _hasOpenPopup = null;
/** @type {(() => boolean) | null} */
let _hasTextInputFocus = null;
/** @type {((sx:number, sy:number, ev:object) => boolean) | null} */
let _dispatchPopupInput = null;

/**
 * UI モジュールからのコールバックを注入する。kernel.js が初期化時に呼ぶ。
 * @param {{ flushPopups: function, hasOpenPopup: function, hasTextInputFocus: function, dispatchPopupInput: function }} cbs
 */
export function wmSetUiCallbacks(cbs) {
  _flushPopups = cbs.flushPopups;
  _hasOpenPopup = cbs.hasOpenPopup;
  _hasTextInputFocus = cbs.hasTextInputFocus;
  _dispatchPopupInput = cbs.dispatchPopupInput;
}

// ── SFX コールバック ──

/** @type {{ onOpen?:function, onClose?:function, onMaximize?:function, onMenu?:function, onMenuItem?:function }|null} */
let _sfxCallbacks = null;

/**
 * SFX コールバックを注入する。system_sfx.js が initSystemSfxHooks() で呼ぶ。
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
/**
 * 展開中ポップアップの所有グループへ画面座標イベントを直接配信 (コールバック経由)。
 * @returns {boolean} 配信したら true (所有グループ未登録なら false)
 */
function dispatchPopupInput(sx, sy, ev) {
  return _dispatchPopupInput ? _dispatchPopupInput(sx, sy, ev) : false;
}
/** テキスト入力にフォーカスがあるか (コールバック経由) */
function hasTextInputFocus() {
  return _hasTextInputFocus ? _hasTextInputFocus() : false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * パディング / フォント変更時に派生定数を再計算する。
 * レイアウト系 (HEADER_HEIGHT 等) は win_layout.js、menu 系は menu.js に
 * 委譲し、ここでは ICON_SLOT のみ更新する。
 */
function recalcDerivedConstants() {
  recalcLayoutConstants();
  menuRecalcConstants();
  ICON_SLOT = ICON_W + ICON_GAP;
}

/** 全ウィンドウのレイアウトを再計算する */
function recalcAllWindows() {
  for (const win of windows) {
    // スナップ中/フルスクリーンのウィンドウは領域を維持する (onMeasure で上書きしない)
    if (win.snapState === "none" && !win.fullscreen && win.onMeasure) {
      const size = win.onMeasure();
      if (size) {
        const fit = calcWindowSize(
          size.w,
          size.h,
          win.footer,
          win._chrome,
          win._noPad ? 0 : CONTENT_PADDING,
        );
        // フォント / パディング変更時は自然サイズへ再フィットする (内容にちょうど合わせ、
        // 上下左右対称な余白を保つ)。WM 管理スクロール窓も再フィットするが、work area を
        // 超える分はスクロールで吸収するため初期サイズと同じく縦横をクランプする。
        if (win._scrollable) {
          const c = clampScrollableInitSize(fit.w, fit.h);
          win.w = c.w;
          win.h = c.h;
        } else {
          win.w = fit.w;
          win.h = fit.h;
        }
      }
    }
    recalcLayout(win);
  }
}

// フレーム構成定数 (BORDER / SEPARATOR_HEIGHT / FOOTER_HEIGHT /
// MIN_WIDTH / MIN_HEIGHT / HEADER_HEIGHT / CONTENT_PADDING 等) と
// recalcLayout / calcWindowSize は win_layout.js へ分離し、冒頭で import 済み。

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
export function wmGetWorkAreaTop() {
  return workAreaTop;
}

/**
 * 画面端からウィンドウ本体 (境界線) までの最小距離。
 * 内訳: 背景との分離用アウトライン 1px + 背景透過マージン 1px。
 */
const WINDOW_EDGE_INSET = 2;

/**
 * ウィンドウ位置 (x, y) を、アウトライン+透過マージン込みで画面内に収まるよう補正する。
 * w, h 自体は変更しない (呼び出し側の意図したサイズを尊重する)。
 * スナップ・最大化・フルスクリーンは画面端に密着させる仕様のため対象外 (呼び出し側で個別処理)。
 */
function clampWindowPos(x, y, w, h) {
  const waTop = wmGetWorkAreaTop();
  const maxW = Math.max(0, Config.VRAM_WIDTH - WINDOW_EDGE_INSET * 2);
  const maxH = Math.max(0, Config.VRAM_HEIGHT - waTop - WINDOW_EDGE_INSET * 2);
  const effW = Math.min(w, maxW);
  const effH = Math.min(h, maxH);
  const cx = Math.max(
    WINDOW_EDGE_INSET,
    Math.min(x, Config.VRAM_WIDTH - WINDOW_EDGE_INSET - effW),
  );
  const cy = Math.max(
    waTop + WINDOW_EDGE_INSET,
    Math.min(y, Config.VRAM_HEIGHT - WINDOW_EDGE_INSET - effH),
  );
  return { x: cx, y: cy };
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
 * @param {boolean} [opts.scrollable] WM 管理の縦横ウィンドウスクロール。省略時は chrome 窓で ON。
 *   仮想コンテンツ寸法は onMeasure (自然サイズ) から導出し、ウィンドウが自然サイズより小さい軸で
 *   バーが機能してスクロールする。初期/再フィット時は work area にクランプされる。アプリが自前
 *   スクロールを持つ場合は wmAttachScroll が false へ移譲する。
 * @param {boolean} [opts.chrome] 標準スクロールバー chrome (縦横バー + ステッパー + コーナーを常時表示)。
 *   省略時はモーダル以外で ON。ボディ端にスロットを確保しウィンドウを SLOT 分広げる。
 *   バーはレトロ GUI の意匠として常設し、コンテンツがはみ出す軸で機能してスクロールする
 *   (全長サムは「今スクロール不要」を表すだけで、非機能な飾りではない)。
 * @param {function|null} [opts.onBeforeClose=null] 閉じる前コールバック (() => boolean, false で閉じをキャンセル)
 * @returns {object} ウィンドウオブジェクト
 */
function createWindow(id, x, y, w, h, title, onDraw, onInput, onMeasure, opts) {
  const o = opts || {};
  // 標準スクロールバー chrome とその WM 管理スクロール。
  //   chrome: モーダル以外は既定 ON (ボディ端に縦横バー + ステッパー + コーナー)。
  //   scrollable: chrome 窓では既定で縦横スクロールを WM が管理する。opts.scrollable で
  //   明示上書きでき、アプリが自前スクロールを持つ場合は wmAttachScroll がアプリ管理へ移譲する。
  const chrome =
    o.chrome !== undefined ? !!o.chrome : !o.modal || o.scrollable === true;
  const scrollable = o.scrollable !== undefined ? !!o.scrollable : chrome;
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
    // ── フルスクリーン (F11 / wmSetFullscreen) ──
    // chrome (枠/ヘッダー/footer) 無しで全 VRAM をコンテンツにする。解除で _fsRestore に復帰。
    fullscreen: false,
    _fsRestore: null,
    // ── footer (opt-in) ──
    footer: !!o.footer,
    onDrawFooter: o.onDrawFooter || null,
    onInputFooter: o.onInputFooter || null,
    // ── ウィンドウオプション (opt-in) ──
    modal: o.modal || false,
    noResize: o.noResize || false,
    noMaximize: o.noMaximize || false,
    // ボディ内側パディング: padding:"none" で contentRect の内側余白を 0 にする
    // (NOTEPAD/AQUARIA 等の画面端まで描く/配置するアプリ用)。既定は CONTENT_PADDING。
    _noPad: o.padding === "none",
    onBeforeClose: o.onBeforeClose || null,
    // ── ABOUT パネル (opt-in) ──
    // about 文字列を持つウィンドウはヘッダ右クリックメニューに ABOUT が出て、
    // ボディが説明パネルに切り替わる。説明は「何か + 主要操作」を簡潔に。
    about: o.about || null,
    _aboutMode: false,
    // ── フォント変更時の再レイアウト (opt-in) ──
    onRelayout: o.onRelayout || null,
    // ── スクロール / 標準スクロールバー chrome ──
    // _chrome: Pixera 標準 UI。ボディ端に縦横スクロールバー + ステッパー + コーナーを
    //   常時表示し、スロット分ウィンドウを広げる (レトロ GUI の意匠として常設)。
    // _scrollable: WM が縦横スクロールを管理する (chrome 窓の既定)。仮想コンテンツ寸法は
    //   onMeasure から導出し、ウィンドウが自然サイズより小さいときにバーが機能してスクロールする。
    //   アプリ管理スクロール (wmAttachScroll, 例 NOTEPAD) の窓は false へ移譲される。
    // _vScroll/_hScroll: スクロール状態。初期は 100%(=スクロール不要) で、コンテンツが
    //   ビューポートを超えると機能する。全長サムは「今スクロール不要」を表すだけで非機能ではない。
    // _vStep/_hStep: ステッパーボタン 1 クリックのスクロール量 (既定 px、行/桁単位のアプリは 1)。
    _scrollable: scrollable,
    _chrome: chrome,
    _vScroll: null,
    _hScroll: null,
    _vStep: WIN_SCROLL_BTN_STEP,
    _hStep: WIN_SCROLL_BTN_STEP,
    _virtualH: 0, // 仮想コンテンツ高 (px, _scrollable の WM 管理縦スクロール用)
    // ── レイアウトキャッシュ (recalcLayout で更新) ──
    _layout: null,
  };
  if (win._chrome) {
    // 縦横スクロールバー状態。初期は 100% (viewport==content=1 でスクロール不要)。
    // 実寸は syncScrollContent が onMeasure から毎フレーム更新する。
    win._vScroll = Scroll.createScrollState(1, 1);
    win._hScroll = Scroll.createScrollState(1, 1);
  }
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
 * @param {boolean} [opts.noIcon]   デスクトップアイコンを作らない（ランチャメニューのみ）。
 *                                  OS 情報窓 (ABOUT / WELCOME) 等、デスクトップに常駐させない窓に使う。
 * @param {boolean} [opts.system]   ランチャ最下部の「システム」セクションに置く
 *                                  (WELCOME / ABOUT)。並びは登録順 = app.js の import 順。
 * @param {string}  [opts.openLabel] デスクトップアイコン右クリックメニューの主アクション
 *   (起動) のラベル。省略時は "OPEN"。アプリの性質に合わせて上書きする (例: AQUARIA="RUN")。
 * @param {(entry:object)=>object[]} [opts.iconMenu] デスクトップアイコン右クリックメニューに
 *   追加するアプリ固有項目を返す関数。共通基盤が組む OPEN と CLOSE の間に挿入される
 *   (メニュー全体を返すのではなく、固有項目のみ)。
 * @param {(entry:object)=>boolean} [opts.isRunning] アプリが起動中かの判定。省略時は
 *   entry.winId !== null。CLOSE 項目の表示可否に使う (例: AQUARIA はデスクトップモードも含める)。
 * @param {(entry:object)=>void} [opts.onClose] CLOSE 項目の終了処理。省略時は
 *   起動中ウィンドウを wmClose する。固有の後始末が要るアプリで上書きする。
 * @param {(entry:object)=>void} [opts.launch] 起動ハンドラ。指定するとダブルクリック
 *   (wmOpenByName) 時に factory ではなくこれを呼ぶ (モード付き起動などに使う)。
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
    noIcon: (opts && opts.noIcon) || false,
    system: (opts && opts.system) || false,
    openLabel: (opts && opts.openLabel) || null,
    iconMenu: (opts && opts.iconMenu) || null,
    isRunning: (opts && opts.isRunning) || null,
    onClose: (opts && opts.onClose) || null,
    launch: (opts && opts.launch) || null,
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

// ── メニュー基盤への依存注入 ──
// registry / toggleRegistered / システム SFX を menu.js へ渡す。
// SFX は _sfxCallbacks が boot 後に差し替わるため、都度 deref するラッパで渡す。
menuSetDeps({
  registry,
  toggleRegistered,
  onMenu: () => _sfxCallbacks?.onMenu?.(),
  onMenuItem: () => _sfxCallbacks?.onMenuItem?.(),
});

// ── ABOUT パネルへの依存注入 ──
// ディゾルブ遷移中に「ボディ面」を描くため safeOnDraw を渡す。
aboutSetDeps({ drawContent: safeOnDraw });

/** モーダルウィンドウの ID (null = モーダルなし) */
let _modalWinId = null;

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
    // スナップ中のウィンドウはスナップ領域を再計算 (getSnapRect と同じ式)
    const snap = snapRectFor(win.snapState);
    if (snap) {
      win.x = snap.x;
      win.y = snap.y;
      win.w = snap.w;
      win.h = snap.h;
    } else {
      // 通常ウィンドウ: はみ出しを制約 (アウトライン+透過マージン込み)
      const c = clampWindowPos(win.x, win.y, win.w, win.h);
      win.x = c.x;
      win.y = c.y;
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
  if (win.fullscreen) return false; // フルスクリーンにヘッダーは無い
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
  if (win.fullscreen) return true; // フルスクリーンは全域が body (マウスは常に画面内)
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
  if (!win.footer || win.fullscreen) return false; // フルスクリーンに footer は無い
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
  if (win.fullscreen) return 0; // フルスクリーンはリサイズ境界を持たない
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
 * 実画面端に接する辺にだけ設ける背景ハロー幅 (px)。
 * drawWindowFrame は枠の外側 1px に背景色のアウトラインを描くため、
 * スナップ/最大化時も実画面端との間に同じ 1px を残してハローを連続させる。
 * ウィンドウ同士が直接隣接する内側境界 (snap-left/snap-right 間) には
 * ハローを入れず、枠線同士を密着させる。
 */
const SCREEN_EDGE_HALO = 1;

/**
 * ドラッグ中のスナッププレビュー (離す前の表示) 専用の実画面端マージン (px)。
 * ドロップ後の実配置は SCREEN_EDGE_HALO (1px, drawWindowFrame のハローに一致) の
 * ままにし、プレビューだけ見やすいよう大きめの余白を取る。
 */
const SNAP_PREVIEW_MARGIN = 5;

/**
 * スナップ状態名から配置矩形を返す。現在の work area / 解像度に基づく。
 * ドロップ時 (getSnapRect) と解像度変更時 (Config.onResize) が共有する
 * 単一の矩形式。state が "none" / 不明なら null。
 * @param {string} state  "maximized" | "snap-left" | "snap-right"
 * @param {number} [edgeMargin=SCREEN_EDGE_HALO]  実画面端 (上下左右の外側) からのマージン (px)。
 *   プレビュー表示 (getSnapRect の呼び出し元) だけ SNAP_PREVIEW_MARGIN を渡す。
 * @param {number} [centerMargin=0]  snap-left/snap-right の分割線 (画面中央側) に設けるマージン (px)。
 *   ドロップ時の実配置は 0 のまま (2 枚が直接隣接し、二重枠で連続させる)。
 *   プレビューだけ edgeMargin と同じ値を渡し、四辺すべて均等マージンに見せる。
 * @returns {{ x:number, y:number, w:number, h:number }|null}
 */
function snapRectFor(state, edgeMargin = SCREEN_EDGE_HALO, centerMargin = 0) {
  const waTop = workAreaTop;
  const mid = Config.VRAM_WIDTH >> 1;
  const y0 = waTop + edgeMargin;
  const innerH = Config.VRAM_HEIGHT - waTop - edgeMargin * 2;
  switch (state) {
    case "maximized":
      return {
        x: edgeMargin,
        y: y0,
        w: Config.VRAM_WIDTH - edgeMargin * 2,
        h: innerH,
      };
    case "snap-left":
      return {
        x: edgeMargin,
        y: y0,
        w: mid - centerMargin - edgeMargin,
        h: innerH,
      };
    case "snap-right": {
      const x = mid + centerMargin;
      return { x, y: y0, w: Config.VRAM_WIDTH - edgeMargin - x, h: innerH };
    }
    default:
      return null;
  }
}

/**
 * マウス座標からスナップ先の矩形 (state 付き) を返す。
 * スナップゾーン外なら null。上端=最大化を優先し、次に左端・右端。
 * @param {number} [edgeMargin=SCREEN_EDGE_HALO]  snapRectFor に渡す実画面端マージン (px)
 * @param {number} [centerMargin=0]  snapRectFor に渡す中央側マージン (px)
 * @returns {{ x:number, y:number, w:number, h:number, state:string }|null}
 */
function getSnapRect(mx, my, edgeMargin = SCREEN_EDGE_HALO, centerMargin = 0) {
  let state = null;
  if (my < workAreaTop + SNAP_ZONE) state = "maximized";
  else if (mx < SNAP_ZONE) state = "snap-left";
  else if (mx >= Config.VRAM_WIDTH - SNAP_ZONE) state = "snap-right";
  const rect = snapRectFor(state, edgeMargin, centerMargin);
  return rect && { ...rect, state };
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

/**
 * snap-left / snap-right が隣接配置されている場合の中央境界線を補修する。
 *
 * drawWindowFrame は各ウィンドウ毎に「背景アウトライン(1px, 背景色) →
 * 前景枠線」の順で描画するため、2 枚が隣接していると後から描画される側の
 * 背景アウトラインが先に描画された側の前景枠線を上書きしてしまう
 * (描画順依存で片側の枠線が消える)。
 * 双方の内側境界を前景色で再描画し、2px の隣接縦線として見えるようにする。
 * 上下端 1px (角丸の欠け) はそのまま残し、透過ピクセルの扱いには触れない。
 */
function repairSnapSeam() {
  const leftWin = windows.find((w) => w.snapState === "snap-left");
  const rightWin = windows.find((w) => w.snapState === "snap-right");
  if (!leftWin || !rightWin) return;
  // 実際に隣接していない場合は対象外 (手動リサイズ等でズレた場合)
  if (leftWin.x + leftWin.w !== rightWin.x) return;

  const seamLeftX = leftWin.x + leftWin.w - 1; // Lwin 側の枠線 (前景)
  const seamRightX = rightWin.x; // Rwin 側の枠線 (前景)
  const y0 = Math.max(leftWin.y, rightWin.y) + 1;
  const y1 = Math.min(leftWin.y + leftWin.h, rightWin.y + rightWin.h) - 2;
  if (y0 > y1) return;
  GPU.vline(seamLeftX, y0, y1, 1);
  GPU.vline(seamRightX, y0, y1, 1);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  コンテンツ矩形アクセス / 座標変換
//  (フレーム構成定数・recalcLayout・calcWindowSize は win_layout.js へ分離)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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
/**
 * WM 管理スクロール窓の仮想コンテンツ寸法 (縦横) を onMeasure から同期する。
 * 毎フレーム呼ぶ: 自然サイズ (onMeasure) を content、現在の表示領域を viewport とし、
 * ウィンドウが自然サイズより小さい軸のバーが機能してスクロールする。onMeasure を
 * 持たない窓 (アプリ管理スクロール等) には触れない (アプリ / recalcLayout が管理)。
 */
function syncScrollContent(win) {
  if (!win._scrollable || !win.onMeasure || !win._layout) return;
  const m = win.onMeasure();
  if (!m) return;
  const cr = win._layout.contentRect;
  if (win._vScroll) {
    Scroll.scrollSetViewport(win._vScroll, cr.h);
    Scroll.scrollSetContent(win._vScroll, m.h);
  }
  if (win._hScroll) {
    Scroll.scrollSetViewport(win._hScroll, cr.w);
    Scroll.scrollSetContent(win._hScroll, m.w);
  }
}

function toLocalCoords(win, mx, my) {
  const cr = getContentRect(win);
  const scrollX = win._scrollable && win._hScroll ? win._hScroll.offset : 0;
  const scrollY = win._scrollable && win._vScroll ? win._vScroll.offset : 0;
  return { lx: mx - cr.x + scrollX, ly: my - cr.y + scrollY };
}

/** 点 (x,y) が矩形 a に含まれるか (a が null/undefined なら false)。 */
function ptInRect(a, x, y) {
  return !!a && x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h;
}

/**
 * 縦スクロールバースロットの当たり判定領域を返す (chrome 無し / スロット無しは null)。
 */
function vScrollHitArea(win) {
  const sb = win._layout && win._layout.scrollbarRect;
  return sb ? Scroll.vScrollbarSlotThumbArea(sb.x, sb.y, sb.h) : null;
}

/**
 * 横スクロールバースロットの当たり判定領域を返す (chrome 無し / スロット無しは null)。
 */
function hScrollHitArea(win) {
  const hb = win._layout && win._layout.hScrollbarRect;
  return hb ? Scroll.hScrollbarSlotThumbArea(hb.x, hb.y, hb.w) : null;
}

/**
 * ボディ down が標準スクロールバー chrome に当たったか判定し、当たれば入力を処理して
 * true を返す (コンテンツへ伝播させない)。機能バー (scrollNeeded=true) はスクロールし、
 * スクロール不要のバー (100% 全長) / コーナーはクリックを飲むだけ (何もしない)。
 */
function handleScrollbarDown(win, mx, my) {
  if (!win._chrome || !win._layout) return false;
  const va = vScrollHitArea(win);
  if (ptInRect(va, mx, my)) {
    if (win._vScroll && Scroll.scrollNeeded(win._vScroll)) {
      Scroll.handleVScrollInput(
        win._vScroll,
        "down",
        my,
        va.y,
        va.h,
        win._vStep,
      );
      wmRequestCursor("drag-v");
    }
    return true;
  }
  const ha = hScrollHitArea(win);
  if (ptInRect(ha, mx, my)) {
    if (win._hScroll && Scroll.scrollNeeded(win._hScroll)) {
      Scroll.handleHScrollInput(
        win._hScroll,
        "down",
        mx,
        ha.x,
        ha.w,
        win._hStep,
      );
      wmRequestCursor("drag-h");
    }
    return true;
  }
  // コーナー (押下不能の V/H 交差部フィラー) — クリックを飲むだけ
  if (ptInRect(win._layout.scrollCornerRect, mx, my)) return true;
  return false;
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
    noIcon: e.noIcon,
    system: e.system,
  }));
}

/**
 * 名前を指定してウィンドウを開く。既に開いている場合は何もしない。
 * @param {string} name  wmRegister で登録した名前
 */
export function wmOpenByName(name) {
  const entry = registry.find((e) => e.name === name);
  if (!entry) return;
  // 起動ハンドラを持つアプリ (モード付き起動など) はそちらへ委譲する。
  if (entry.launch) {
    entry.launch(entry);
    return;
  }
  if (entry.winId === null) {
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
 * WM 管理スクロール窓の初期 / 再フィットサイズを work area (画面 − タスクバー) に
 * クランプする。自然サイズが work area 内なら無改変で「内容にちょうど合う (= fit to
 * content = maximize と一致)」外寸になり、超える分だけスクロールで巡れる。
 *
 * クランプしないと画面外へはみ出し、かつ contentRect == 自然サイズ となって
 * スクロールバーが機能しない (= 最大化するまで端に到達不可) という矛盾が生じる。
 *
 * @returns {{ w: number, h: number, clamped: boolean }} clamped: いずれかの軸が clamp されたか
 */

/**
 * ウィンドウスクロールは px 単位。ステッパーボタン 1 クリックは 1 行ぶん
 * (≒ 文字高 + 行間) をスクロールさせる。既定 step=1 では 1px しか動かず不自然なため。
 */
const WIN_SCROLL_BTN_STEP = GLYPH_H + 1;
function clampScrollableInitSize(w, h) {
  const workAreaH = Config.VRAM_HEIGHT - workAreaTop;
  let clamped = false;
  if (h > workAreaH) {
    h = workAreaH;
    clamped = true;
  }
  if (w > Config.VRAM_WIDTH) {
    w = Config.VRAM_WIDTH;
    clamped = true;
  }
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
  const fit = calcWindowSize(size.w, size.h, win.footer, win._chrome);
  let newW = fit.w;
  let newH = fit.h;
  if (win._scrollable) {
    const c = clampScrollableInitSize(newW, newH);
    newW = c.w;
    newH = c.h;
  }
  // 中心保持で新位置算出 → 画面内クランプ (アウトライン+透過マージン込み)
  const cx = win.x + win.w / 2;
  const cy = win.y + win.h / 2;
  const newPos = clampWindowPos(
    Math.floor(cx - newW / 2),
    Math.floor(cy - newH / 2),
    newW,
    newH,
  );
  win.x = newPos.x;
  win.y = newPos.y;
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
  items.push({
    type: "action",
    label: "FULLSCREEN",
    action: () => setFullscreen(win, true),
  });
  if (win.about) {
    items.push({
      type: "action",
      label: win._aboutMode ? "HIDE ABOUT" : "ABOUT",
      action: () => startAboutTransition(win, !win._aboutMode),
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
 * デスクトップアイコン右クリック用のコンテキストメニューを構築する (全アイコン共通)。
 * 構成: 主アクション (起動) → アプリ固有項目 → CLOSE (起動中のみ)。
 *   - 主アクション: ラベルは entry.openLabel || "OPEN"。ダブルクリックと同じ
 *     wmOpenByName 経由で起動する (entry.launch を尊重するため)。
 *   - アプリ固有項目: entry.iconMenu(entry) が返す配列 (あれば) をセパレーター付きで挿入。
 *   - CLOSE: entry.isRunning (省略時 winId!==null) が真のときのみ。終了処理は
 *     entry.onClose (省略時 wmClose(winId))。
 * registry に無いアイコン (表示スタブ等) は entry=undefined でも OPEN のみで成立する。
 * @param {string} name  デスクトップアイコンのアプリ名
 * @param {object|undefined} entry  対応する registry エントリ (無ければ undefined)
 */
function buildIconContextMenu(name, entry) {
  const items = [
    {
      type: "action",
      label: (entry && entry.openLabel) || "OPEN",
      action: () => wmOpenByName(name),
    },
  ];

  if (entry && entry.iconMenu) {
    const extra = entry.iconMenu(entry);
    if (extra && extra.length > 0) items.push({ type: "sep" }, ...extra);
  }

  const running = entry
    ? entry.isRunning
      ? entry.isRunning(entry)
      : entry.winId !== null
    : false;
  if (running) {
    items.push(
      { type: "sep" },
      {
        type: "action",
        label: "CLOSE",
        action: () =>
          entry.onClose ? entry.onClose(entry) : wmClose(entry.winId),
      },
    );
  }

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
  const modal = !!(opts && opts.modal);
  // 標準スクロールバー chrome と WM 管理スクロール (createWindow と同じ導出)。
  // chrome はモーダル以外で既定 ON、scrollable は chrome 窓で既定 ON。
  const chrome =
    opts && opts.chrome !== undefined
      ? !!opts.chrome
      : !modal || (opts && opts.scrollable === true);
  const scrollable =
    opts && opts.scrollable !== undefined ? !!opts.scrollable : chrome;
  const contentPad = opts && opts.padding === "none" ? 0 : CONTENT_PADDING;
  const SLOT = Scroll.SCROLLBAR_SLOT_WIDTH;
  // 明示指定された外寸か (onMeasure 自動算出でない) を先に記録しておく。
  const wExplicit = w !== 0;
  const hExplicit = h !== 0;
  // w=0 or h=0 なら onMeasure で自動算出
  let scrollableClamped = false;
  if (onMeasure && (w === 0 || h === 0)) {
    const size = onMeasure();
    const fit = calcWindowSize(size.w, size.h, footer, chrome, contentPad);
    if (w === 0) w = fit.w;
    if (h === 0) h = fit.h;
    if (scrollable) {
      const c = clampScrollableInitSize(w, h);
      w = c.w;
      h = c.h;
      scrollableClamped = c.clamped;
    }
  }
  // 明示指定された外寸には標準 chrome のスロット分を加える (onMeasure 経由は
  // calcWindowSize が加算済み)。chrome を足してもコンテンツ描画領域が縮まない。
  if (chrome) {
    if (wExplicit) w += SLOT;
    if (hExplicit) h += SLOT;
  }

  // タイトルがヘッダのアイコン (×・最大化) と衝突しない最小幅を保証する。
  // 窓幅が内容のみで決まると、内容より長いタイトル (例: ダイアログの
  // "! IMPORTANT !") が × ボタンに食い込んで「! IMPORTANTX!」と潰れる。
  {
    const noMax = !!(opts && opts.noMaximize);
    const iconsW = ICON_W + (noMax ? 0 : ICON_SLOT);
    const minTitleW =
      BORDER * 2 + HEADER_PADDING * 2 + textWidth(title) + ICON_GAP + iconsW;
    if (w < minTitleW) w = minTitleW;
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

  // クランプ: ウィンドウが画面内に収まるよう補正 (アウトライン+透過マージン込み)
  {
    const pos = clampWindowPos(x, y, w, h);
    x = pos.x;
    y = pos.y;
  }

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
 * スクロール可能ウィンドウの仮想コンテンツ高さ (縦) を明示設定する。
 * contentRect より大きい場合に縦バーが機能する。
 *
 * 標準では onMeasure から毎フレーム自動導出される (syncScrollContent) ため通常は不要。
 * onDraw の描画直前に最新の自然高を確実に反映したいアプリ (SETTINGS / AQUARIA
 * PREFERENCES) が併用している。同フレームでは後に呼ばれた側 (onDraw のこの API) が優先。
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
  return {
    x: win._hScroll ? win._hScroll.offset : 0,
    y: win._vScroll ? win._vScroll.offset : 0,
  };
}

/**
 * アプリ管理のスクロール状態を標準スクロールバー chrome に接続する。
 *
 * 自前のスクロール (行・桁単位など) を持つアプリ (例: NOTEPAD) が、WM の縦横バーへ
 * その状態をそのまま描画・操作させるための橋渡し。WM はここで渡された ScrollState を
 * 「表示・ドラッグ・ステッパー」のためだけに読み書きし、viewport / content の同期や
 * ホイール・座標変換はアプリ側 (_scrollable=false のため WM が触れない) が担う。
 *
 * @param {number} id  ウィンドウ ID
 * @param {object} [o] 接続オプション
 * @param {object|null} [o.v]      縦スクロール状態 (ScrollState)。省略時は据え置き。
 * @param {object|null} [o.h]      横スクロール状態 (ScrollState)。省略時は据え置き。
 * @param {number} [o.vStep]  縦ステッパー 1 クリックの量 (単位はアプリ依存, 既定 1 行等)。
 * @param {number} [o.hStep]  横ステッパー 1 クリックの量。
 */
export function wmAttachScroll(id, o = {}) {
  const win = windows.find((w) => w.id === id);
  if (!win) return;
  // アプリがスクロールを所有する = WM 管理スクロール (座標変換 / ホイール /
  // 仮想寸法同期) を無効化する。以後 WM はバーの表示・ドラッグ・ステッパーのみ担い、
  // viewport/content 同期とコンテンツの平行移動はアプリが自前で行う (例: NOTEPAD)。
  win._scrollable = false;
  if (o.v !== undefined) win._vScroll = o.v;
  if (o.h !== undefined) win._hScroll = o.h;
  if (o.vStep !== undefined) win._vStep = o.vStep;
  if (o.hStep !== undefined) win._hStep = o.hStep;
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

  // ── WM 管理スクロール窓の仮想寸法を onMeasure から同期 (入力・描画の前に確定) ──
  for (const win of windows) syncScrollContent(win);

  // ── ツールチップ: 前フレームのテキストを保持してリセット ──
  tooltipBeginFrame();

  // ── F11: 最前面ウィンドウのフルスクリーン切替 (OS ショートカット) ──
  // モーダル表示中は無効。解除も F11 (アプリが Esc 等を独自に割り当ててもよい)。
  if (Input.keyDown("F11") && _modalWinId === null && windows.length > 0) {
    setFullscreen(
      windows[windows.length - 1],
      !windows[windows.length - 1].fullscreen,
    );
  }

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

  // ── デスクトップアイコン (最前面がフルスクリーンなら覆われていて操作不能) ──
  const frontFullscreen =
    windows.length > 0 && windows[windows.length - 1].fullscreen;
  if (!frontFullscreen) {
    Desktop.desktopUpdate(mx, my, wmOpenByName);
    handleDesktopHover(mx, my);
  }

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
      // ABOUT パネル表示中はボディ右クリックでも戻る (左右どちらでも復帰)
      if (target._aboutMode && !target._aboutAnim) {
        startAboutTransition(target, false);
        return;
      }
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

  // ウィンドウ外 → デスクトップアイコン上なら共通コンテキストメニュー
  // (対象アイコンを選択してから開く)、空白ならランチャーメニュー。
  const iconName = Desktop.desktopRightClickSelect(mx, my);
  if (iconName) {
    const entry = registry.find((e) => e.name === iconName);
    openContextMenu(buildIconContextMenu(iconName, entry), mx, my);
    return;
  }
  openMenu(mx, my);
}

/** 左クリック: ポップアップ伝播 / タスクバー / ウィンドウ操作開始 */
function handleLeftClick(mx, my) {
  // ウィンドウがクリックされた場合に備えてデスクトップフォーカスを仮解除。
  // Desktop.desktopHandleInput に到達した場合はそこで再設定される。
  Desktop.desktopBlur();

  // ポップアップが開いている場合: 所有グループへ直接配信 (領域分岐を介さない)。
  // ポップアップは全面オーバーレイ描画なので、入力も全面で受ける (描画と対称)。
  if (hasOpenPopup() && windows.length > 0) {
    const evBase = {
      type: "down",
      ctrl: Input.mouseHasCtrl(),
      shift: Input.mouseHasShift(),
    };
    if (!dispatchPopupInput(mx, my, evBase)) {
      // フォールバック: 所有グループ未登録時は従来どおり最前面 onInput へ
      const front = windows[windows.length - 1];
      if (front && front.onInput) {
        const { lx, ly } = toLocalCoords(front, mx, my);
        safeOnInput(front, { ...evBase, localX: lx, localY: ly });
      }
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

// ── フルスクリーン (F11 / API) ──
// スナップ最大化とは別軸: chrome (枠/ヘッダー/footer) ごと消して全 VRAM をコンテンツにする。
// snapState は温存するので、解除すると元の状態 (通常 / maximized) にそのまま戻る。

/** フルスクリーンの設定/解除。 */
function setFullscreen(win, on) {
  if (win.fullscreen === !!on) return;
  if (on) {
    win._fsRestore = { x: win.x, y: win.y, w: win.w, h: win.h };
    win.fullscreen = true;
    // ABOUT パネルは chrome の一部なので閉じる (復帰手段のヘッダーが消えるため)
    win._aboutMode = false;
    win._aboutAnim = null;
    const i = windows.indexOf(win);
    if (i >= 0) activeIndex = bringToFront(i);
  } else {
    win.fullscreen = false;
    const r = win._fsRestore;
    if (r) {
      win.x = r.x;
      win.y = r.y;
      win.w = r.w;
      win.h = r.h;
    }
    win._fsRestore = null;
  }
  recalcLayout(win);
}

/**
 * ウィンドウのフルスクリーンを設定する (公開 API)。
 * @param {number} id
 * @param {boolean} on
 */
export function wmSetFullscreen(id, on) {
  const win = windows.find((w) => w.id === id);
  if (win) setFullscreen(win, on);
}

/** ウィンドウのフルスクリーンをトグルする (公開 API)。 */
export function wmToggleFullscreen(id) {
  const win = windows.find((w) => w.id === id);
  if (win) setFullscreen(win, !win.fullscreen);
}

/** ウィンドウがフルスクリーンか (公開 API)。 */
export function wmIsFullscreen(id) {
  const win = windows.find((w) => w.id === id);
  return !!(win && win.fullscreen);
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
    const r = snapRectFor("maximized");
    win.x = r.x;
    win.y = r.y;
    win.w = r.w;
    win.h = r.h;
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

  // ABOUT パネル表示中にボディをクリック → アプリへ戻る (ディゾルブ)。
  // 「CLICK TO RETURN」ヒントの通りの直感的な復帰。遷移中は無視。
  if (target._aboutMode && !target._aboutAnim) {
    startAboutTransition(target, false);
    return;
  }

  // スクロールバー chrome (縦/横/コーナー) クリック → 処理して伝播を止める
  if (handleScrollbarDown(target, mx, my)) return;

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
    // モーダル / 最大化禁止 (noMaximize) ウィンドウはスナップ不可。
    // snap (maximized/snap-left/snap-right) はシステム管理サイズへのリサイズなので、
    // 最大化を禁じた窓は端ドラッグでも snap させない (ボタン/ダブルクリック/メニューと統一)。
    snapPreview =
      win.modal || win.noMaximize
        ? null
        : getSnapRect(mx, my, SNAP_PREVIEW_MARGIN, SNAP_PREVIEW_MARGIN);
  }

  if (mode === "resize") {
    const dx = mx - resizeStartMX;
    const dy = my - resizeStartMY;

    let minW = MIN_WIDTH;
    let minH = MIN_HEIGHT;
    // WM 管理スクロール窓は縦横スクロールが下限を吸収するため、枠 + ヘッダー +
    // ボディ最小 (MIN_WIDTH / MIN_HEIGHT) まで自由に縮められる (内容はスクロールで巡る)。
    // スクロール非対応 (モーダル / アプリ管理スクロール) で onMeasure を持つ窓のみ、
    // 内容が切れないよう自然サイズを下限にする。
    if (win.onMeasure && !win._scrollable) {
      const size = win.onMeasure();
      const fit = calcWindowSize(size.w, size.h, win.footer, win._chrome);
      minW = fit.w;
      minH = fit.h;
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

/**
 * ポップアップ展開中の継続イベント (wheel / hover / held / up) を、所有グループへ
 * 直接配信する。ポップアップは全面オーバーレイ描画なので、入力もアプリの領域
 * ルーティングを介さず全面で受ける (描画と入力の対称化)。これにより、ポップアップが
 * ウィジェット領域外 (例: TESSERA の PREVIEW) へ張り出しても、はみ出した項目を
 * 確実にホバー/クリックできる。down は handleLeftClick で配信する。
 * @returns {boolean} 所有グループへ配信したら true
 */
function dispatchPopupBodyEvents(mx, my) {
  let dispatched = false;
  const wy = Input.wheelY();
  const wx = Input.wheelX();
  if (wy !== 0 || wx !== 0) {
    dispatched =
      dispatchPopupInput(mx, my, {
        type: "wheel",
        deltaX: wx,
        deltaY: wy,
        ctrl: Input.wheelHasCtrl(),
        alt: Input.wheelHasAlt(),
        shift: Input.wheelHasShift(),
        consumed: false,
      }) || dispatched;
  }
  if (Input.mouseButtonHeld(0)) {
    dispatched =
      dispatchPopupInput(mx, my, {
        type: "held",
        ctrl: Input.mouseHasCtrl(),
        shift: Input.mouseHasShift(),
      }) || dispatched;
  } else if (!Input.mouseButtonDown(0)) {
    // 静止フレームでも毎フレーム hover を流す (展開中のキーボード操作も update 内で拾う)
    dispatched = dispatchPopupInput(mx, my, { type: "hover" }) || dispatched;
  }
  if (Input.mouseButtonUp(0)) {
    dispatched =
      dispatchPopupInput(mx, my, {
        type: "up",
        ctrl: Input.mouseHasCtrl(),
        shift: Input.mouseHasShift(),
      }) || dispatched;
  }
  return dispatched;
}

/** ボディへのイベント伝播 (wheel / hover / held / up / rheld / rup) */
function propagateBodyEvents(mx, my) {
  if (mode !== "none" || windows.length === 0) return;

  // ポップアップ展開中: 全入力を所有グループへ直接配信して終了 (領域分岐を介さない)。
  // 所有グループ未登録 (フォールバック) のときのみ従来の onInput 伝播へ落ちる。
  if (hasOpenPopup() && dispatchPopupBodyEvents(mx, my)) return;

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
        if (!ev.consumed && win._scrollable && !Input.wheelHasCtrl()) {
          // ウィンドウスクロール単位は px。ホイール delta (典型値: 100/clk on
          // Windows、trackpad では小さい連続値) を ~1/6 してスクロール量に変換する。
          // 最低 1px を保証してトラックパッドの微細な操作も拾う。
          // Shift+縦ホイールは横スクロールに回す (横 delta を持たないマウス向け)。
          const toStep = (d) => Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / 6));
          const shift = Input.wheelHasShift();
          const hDelta = wx !== 0 ? wx : shift ? wy : 0;
          const vDelta = shift && wx === 0 ? 0 : wy;
          if (
            win._hScroll &&
            Scroll.scrollNeeded(win._hScroll) &&
            hDelta !== 0
          ) {
            Scroll.scrollBy(win._hScroll, toStep(hDelta));
          }
          if (
            win._vScroll &&
            Scroll.scrollNeeded(win._vScroll) &&
            vDelta !== 0
          ) {
            Scroll.scrollBy(win._vScroll, toStep(vDelta));
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

    // ── スクロールバーのドラッグ追従 / リリース (縦・横) ──
    const vDragging =
      front._chrome &&
      front._vScroll &&
      Scroll.scrollIsDragging(front._vScroll);
    const hDragging =
      front._chrome &&
      front._hScroll &&
      Scroll.scrollIsDragging(front._hScroll);
    if (vDragging || hDragging) {
      if (vDragging) {
        const va = vScrollHitArea(front);
        if (va) {
          if (Input.mouseButtonHeld(0)) {
            Scroll.handleVScrollInput(
              front._vScroll,
              "held",
              my,
              va.y,
              va.h,
              front._vStep,
            );
          }
          if (Input.mouseButtonUp(0)) {
            Scroll.handleVScrollInput(front._vScroll, "up", my, va.y, va.h);
          }
        }
      }
      if (hDragging) {
        const ha = hScrollHitArea(front);
        if (ha) {
          if (Input.mouseButtonHeld(0)) {
            Scroll.handleHScrollInput(
              front._hScroll,
              "held",
              mx,
              ha.x,
              ha.w,
              front._hStep,
            );
          }
          if (Input.mouseButtonUp(0)) {
            Scroll.handleHScrollInput(front._hScroll, "up", mx, ha.x, ha.w);
          }
        }
      }
      wmRequestCursor(vDragging ? "drag-v" : "drag-h");
      return; // スクロールバードラッグ中はコンテンツ入力をブロック
    }

    // ── スクロールバーホバー → drag-v / drag-h カーソル (機能バーのみ) ──
    if (front._chrome && !Input.mouseButtonDown(0) && !Input.mouseButtonHeld(0)) {
      const va = vScrollHitArea(front);
      const ha = hScrollHitArea(front);
      if (
        ptInRect(va, mx, my) &&
        front._vScroll &&
        Scroll.scrollNeeded(front._vScroll)
      ) {
        wmRequestCursor("drag-v");
      } else if (
        ptInRect(ha, mx, my) &&
        front._hScroll &&
        Scroll.scrollNeeded(front._hScroll)
      ) {
        wmRequestCursor("drag-h");
      }
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
      } else if (!Input.mouseButtonDown(0) && !Input.mouseButtonHeld(0)) {
        // hover は前面ウィンドウへ毎フレーム送る（マウス位置に依らない）。これにより
        // onInput でキーボードをポーリングするアプリ（ダイアログの OK/CANCEL 選択、
        // 矢印移動・Enter 確定など）がマウスを乗せなくても動作する。lx/ly が枠外でも
        // 各ウィジェットは hitTest で弾くので hover ハイライトは出ない。
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
    // モーダル / 最大化禁止 (noMaximize) ウィンドウはスナップ不可 (handleDrag と同条件)
    if (!win.modal && !win.noMaximize && trySnap(win, mx, my)) {
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
//  カーソル形状
//  (ツールチップは tooltip.js、ABOUT パネルは about.js へ分離)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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

/**
 * 全ウィンドウを描画する。背面 (配列先頭) から前面 (末尾) へ順に描く。
 */
export function wmDraw() {
  // 最前面がフルスクリーンなら全 VRAM を覆うので、下 (デスクトップ・背面窓) は描かない。
  const frontFullscreen =
    windows.length > 0 && windows[windows.length - 1].fullscreen;

  if (frontFullscreen) {
    drawWindowFrame(windows[windows.length - 1]);
  } else {
    // ── デスクトップアイコン (壁紙の上、ウィンドウの下) ──
    Desktop.desktopDraw();

    // ── スナッププレビュー (全ウィンドウの背面) ──
    if (snapPreview) {
      const sp = snapPreview;
      // 背景との分離用ハロー (1px, 背景色) — drawWindowFrame と同じ構造。
      // 角丸四隅の透過防止 + 内側全域の下地塗りも兼ねる。
      GPU.fillRoundRect(sp.x - 1, sp.y - 1, sp.w + 2, sp.h + 2, 1, 0);
      // 角丸ボーダー (1px)
      GPU.drawRoundRect(sp.x, sp.y, sp.w, sp.h, 1, 1);
      // ボーダー内側 1px 余白を空けて市松模様
      GPU.drawCheckerboard(sp.x + 2, sp.y + 2, sp.w - 4, sp.h - 4, 1);
    }

    for (const win of windows) {
      drawWindowFrame(win);
    }

    // ── snap-left/snap-right 隣接時の中央境界線補修 ──
    repairSnapSeam();
  }

  // ── メニュー ──
  drawMenu();

  // ── ポップアップ (全ウィンドウの上にクリップなしで描画) ──
  flushPopups();

  // ── ツールチップ (最前面) ──
  drawTooltip(_modalWinId !== null);
}

/**
 * 指定ウィンドウだけを原点 (offX, offY) に描画する。
 * スクリーンショット用キャプチャバッファへの単独描画に使う。
 * 通常の wmDraw() とは異なり、メニュー等は描画しない。
 *
 * offX/offY は CAPTURE のマット合成で使う: 壁紙を敷いた下地の上に
 * ウィンドウを余白 (pad) 分だけずらして描くことで、四辺均等の額装を作る。
 * 省略時は原点 (0,0) = マット無しの従来動作。
 * @param {number} id  ウィンドウ ID
 * @param {number} [offX=0]  描画左上 X (マット余白)
 * @param {number} [offY=0]  描画左上 Y (マット余白)
 */
export function wmDrawSingleWindow(id, offX = 0, offY = 0) {
  const win = windows.find((w) => w.id === id);
  if (!win) return;

  // 座標を一時的にオフセット (ウィンドウ左上 → offX,offY)
  const origX = win.x;
  const origY = win.y;
  win.x = offX;
  win.y = offY;
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
function drawWindowFrame(win) {
  // ── フルスクリーン: chrome 無し。全面を下地色で塗り、コンテンツのみ描く ──
  if (win.fullscreen) {
    const cr = win._layout.contentRect;
    GPU.fillRect(cr.x, cr.y, cr.w, cr.h, 0);
    if (win.onDraw) {
      GPU.setClip(cr.x, cr.y, cr.w, cr.h);
      safeOnDraw(win, cr);
      GPU.resetClip();
    }
    return;
  }

  const L = win._layout;

  // 背景との分離用アウトライン (1px, 背景色)
  GPU.fillRoundRect(win.x - 1, win.y - 1, win.w + 2, win.h + 2, 1, 0);
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
    if (cr.w > 0 && cr.h > 0) drawAboutTransition(win, cr);
  } else if (win._aboutMode && win.about) {
    if (cr.w > 0 && cr.h > 0) {
      GPU.setClip(cr.x, cr.y, cr.w, cr.h);
      drawAboutPanel(win, cr);
      GPU.resetClip();
    }
  } else if (win.onDraw) {
    if (cr.w > 0 && cr.h > 0) {
      // スクロール可能ウィンドウ: contentRect を縦横スクロール分だけずらす
      // (アプリは自然座標に描き、WM が offset ぶん平行移動 + クリップする)。
      const scrollX = win._scrollable && win._hScroll ? win._hScroll.offset : 0;
      const scrollY = win._scrollable && win._vScroll ? win._vScroll.offset : 0;
      const drawCr =
        scrollX || scrollY
          ? { x: cr.x - scrollX, y: cr.y - scrollY, w: cr.w, h: cr.h }
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

  // ── 標準スクロールバー chrome 描画 (縦・横・コーナー) ──
  // _chrome ウィンドウは常に縦横バー + ステッパー + コーナーを描く (レトロ GUI の意匠)。
  // スクロール不要 (win._vScroll/_hScroll が 100% 全長) でも機能 (スクロール可) でも
  // drawVScrollbarSlot / drawHScrollbarSlot が同じ見た目で描画する。
  if (win._chrome && !win.fullscreen) {
    if (L.scrollbarRect) {
      const sb = L.scrollbarRect;
      Scroll.drawVScrollbarSlot(win._vScroll, sb.x, sb.y, sb.h);
    }
    if (L.hScrollbarRect) {
      const hb = L.hScrollbarRect;
      Scroll.drawHScrollbarSlot(win._hScroll, hb.x, hb.y, hb.w);
    }
    if (L.scrollCornerRect) {
      const cc = L.scrollCornerRect;
      Scroll.drawScrollCorner(win._vScroll, cc.x, cc.y);
    }
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

