/**
 * @module wm/win_layout
 * win_layout.js — ウィンドウ枠の寸法定数とレイアウト算出 (純粋)
 *
 * ウィンドウの外寸 (w/h) ⇄ 内部各領域 (header / content / footer /
 * scrollbar) の相互変換を担う。フレーム構成定数 (BORDER 等) と、
 * フォント / パディング変更で変わる派生定数 (HEADER_HEIGHT 等) の
 * live binding をここから供給する。
 *
 * wm.js からは一方向に import される (wm → win_layout)。描画・入力・
 * ウィンドウ状態は持たず、与えられた win オブジェクトの x/y/w/h から
 * win._layout を算出するのみ。
 *
 * ── live binding ──
 *   HEADER_HEIGHT / CONTENT_PADDING / FOOTER_HEIGHT / MIN_HEIGHT /
 *   HEADER_PADDING / HEADER_CONTENT_H は recalcLayoutConstants() で
 *   更新され、ES Module の live binding により import 先へ即時反映される。
 */

import * as Config from "../config.js";
import { GLYPH_H } from "../core/font.js";
import { ICON_H } from "../core/icon.js";
import * as Scroll from "../ui/scrollbar.js";
import { FOCUS_MARGIN } from "../ui/ui_constants.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  派生定数 (フォント / パディング変更で変わる)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ヘッダー内コンテンツ高さ (グリフとアイコンの大きい方) */
export let HEADER_CONTENT_H = Math.max(GLYPH_H, ICON_H);

/** ヘッダーパディング (上下左右共通)。config.js から取得。 */
export let HEADER_PADDING = Config.getHeaderPad();

/** ヘッダー高さ (枠線除く。パディング上 + コンテンツ + パディング下)。 */
export let HEADER_HEIGHT = HEADER_CONTENT_H + HEADER_PADDING * 2;

/** コンテンツ領域の内側パディング (上下左右共通)。config.js から取得。 */
export let CONTENT_PADDING = Config.getContentPad();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  フレーム構成定数
//  ウィンドウ枠の各部品サイズ。recalcLayout / calcWindowSize で使用。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 外枠線の太さ (px) */
export const BORDER = 1;
/** ヘッダー装飾余白 (px) — ヘッダー枠線と装飾矩形の間 */
export const DECORATION_MARGIN = 1;
/** ヘッダー/ボディ区切り線の太さ (px) */
export const SEPARATOR_HEIGHT = 1;
/** footer 区切り線の太さ (px) */
export const FOOTER_SEPARATOR_HEIGHT = 1;
/** footer 内側パディング (上下左右各 2px) */
export const FOOTER_PADDING = 2;

/** デフォルト footer 高さ: 区切り線(1) + パディング上(2) + グリフ + パディング下(2) */
export let FOOTER_HEIGHT =
  FOOTER_SEPARATOR_HEIGHT + FOOTER_PADDING + GLYPH_H + FOOTER_PADDING;

/**
 * コンテンツ幅からウィンドウ幅を算出する際の追加分 (px)。
 * 左右: 外枠(BORDER) × 2 = 2
 */
export const FRAME_EXTRA_W = BORDER * 2; // 2

/**
 * コンテンツ高さからウィンドウ高さを算出する際の追加分 (px, HEADER_HEIGHT / CONTENT_PADDING / footer 除く)。
 * 上枠(BORDER) + 区切り線(SEPARATOR_HEIGHT) + 下枠(BORDER) = 3
 */
export const FRAME_EXTRA_H = BORDER + SEPARATOR_HEIGHT + BORDER; // 3

/** ウィンドウの最小サイズ (枠込み) */
export const MIN_WIDTH = 8;
export let MIN_HEIGHT = BORDER + HEADER_HEIGHT + SEPARATOR_HEIGHT + 4 + BORDER; // 枠上 + ヘッダー + 区切り + ボディ最小4px + 枠下

/**
 * パディング / フォント変更時にレイアウト派生定数を再計算する。
 * menu 系や ICON_SLOT 等の非レイアウト定数は wm.js 側で別途更新する。
 */
export function recalcLayoutConstants() {
  HEADER_CONTENT_H = Math.max(GLYPH_H, ICON_H);
  HEADER_PADDING = Config.getHeaderPad();
  HEADER_HEIGHT = HEADER_CONTENT_H + HEADER_PADDING * 2;
  CONTENT_PADDING = Config.getContentPad();
  FOOTER_HEIGHT =
    FOOTER_SEPARATOR_HEIGHT + FOOTER_PADDING + GLYPH_H + FOOTER_PADDING;
  MIN_HEIGHT = BORDER + HEADER_HEIGHT + SEPARATOR_HEIGHT + 4 + BORDER;
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
export function recalcLayout(win) {
  // ── フルスクリーン: chrome 無しで全 VRAM がコンテンツ ──
  // ヒットテストが誤爆しないよう headerRect は空、sepY は -1 (全域が body 扱い)。
  if (win.fullscreen) {
    win.x = 0;
    win.y = 0;
    win.w = Config.VRAM_WIDTH;
    win.h = Config.VRAM_HEIGHT;
    win._layout = {
      headerRect: { x: 0, y: 0, w: 0, h: 0 },
      decoRect: { x: 0, y: 0, w: 0, h: 0 },
      titleX: 0,
      titleY: 0,
      iconY: 0,
      iconBaseX: 0,
      sepY: -1,
      contentRect: { x: 0, y: 0, w: Config.VRAM_WIDTH, h: Config.VRAM_HEIGHT },
      // フルスクリーンはパディングが無く、はみ出す枠/ヘッダーも無いため
      // クリップは content そのもの (フォーカスマージンの張り出し無し)。
      contentClipRect: {
        x: 0,
        y: 0,
        w: Config.VRAM_WIDTH,
        h: Config.VRAM_HEIGHT,
      },
      scrollbarRect: null,
      hScrollbarRect: null,
      scrollCornerRect: null,
      footerSepY: 0,
      footerRect: null,
    };
    if (win._scrollable && win._vScroll) {
      Scroll.scrollSetViewport(win._vScroll, Config.VRAM_HEIGHT);
    }
    return;
  }

  const fx = win.x;
  const fy = win.y;
  const fw = win.w;
  const fh = win.h;
  const footerH = win.footer ? FOOTER_HEIGHT : 0;
  // ボディ内側パディング: padding:"none" のウィンドウ (NOTEPAD/AQUARIA 等の
  // 画面端まで描くアプリ) は 0、それ以外は config の CONTENT_PADDING。
  const pad = win._noPad ? 0 : CONTENT_PADDING;

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

  // ── body / content / スクロールバー領域 ──
  //
  // _chrome=true のウィンドウは、ボディ右端に縦スクロールバースロット、ボディ下端に
  // 横スクロールバースロットを**常時**確保する (Pixera 標準 UI: レトロ GUI の意匠として
  // スクロール可否によらず縦横バー + ステッパー + コーナーを出す)。バーは常に機能し得る:
  // コンテンツが収まっていれば 100% 全長 (今スクロール不要)、はみ出せばその軸でスクロールする
  // (_scrollable の WM 管理スクロール、またはアプリが _vScroll/_hScroll を差し替えた場合)。
  // SLOT = sep(1) + dark(1) + thumb(7) + dark(1)。
  //
  //   構成 (横): content | pad | V-slot(SLOT) | border
  //   構成 (縦): content | pad | H-slot(SLOT) | (footer | border)
  //   V/H が交わる右下 SLOT×SLOT は押下不能のコーナー (V/H の交差部フィラー)。
  //   footer は H バーの下に全幅で残る。
  //
  // _chrome=false (モーダルダイアログ等) は従来どおりスロット無し (content がボディ全域)。
  const SLOT = Scroll.SCROLLBAR_SLOT_WIDTH;
  const reserve = win._chrome ? SLOT : 0;

  // ボディ矩形 (枠内側・区切り線の下 〜 footer 区切り線 or 枠下辺)
  const bodyLeft = fx + BORDER;
  const bodyTop = sepY + SEPARATOR_HEIGHT;
  const bodyRight = fx + fw - BORDER;
  const bodyBottom = footerH > 0 ? fy + fh - BORDER - footerH : fy + fh - BORDER;
  const bodyW = bodyRight - bodyLeft;
  const bodyH = bodyBottom - bodyTop;

  // content: ボディからスロット分 (右・下) と pad を除いた領域。
  // contentW/H は calcWindowSize の逆演算。
  const contentX = bodyLeft + pad;
  const contentY = bodyTop + pad;
  const contentW = Math.max(0, bodyW - reserve - pad * 2);
  const contentH = Math.max(0, bodyH - reserve - pad * 2);

  // ── アプリ描画用クリップ矩形 ──
  // アプリの onDraw は contentRect にクリップされるが、フォーカスブラケットは
  // 各ウィジェットの外側へ FOCUS_MARGIN px 張り出して描かれるため、その分だけ
  // クリップを外側へ広げる。ただし広げる量はウィンドウの**実際の**内側パディング
  // (pad: padding:"none" は 0) を超えないようクランプする。超えて広げると
  // ヘッダー区切り線・外枠へコンテンツがはみ出す (padding:"none" 窓の onDraw が
  // スクロール等で content 端を越えて描いた分が枠外へ漏れる) ため。
  // pad=0 の窓は contentRect ちょうどにクリップされ、一切はみ出さない。
  const clipMargin = Math.min(FOCUS_MARGIN, pad);
  const contentClipRect = {
    x: contentX - clipMargin,
    y: contentY - clipMargin,
    w: contentW + clipMargin * 2,
    h: contentH + clipMargin * 2,
  };

  // ── スクロールバー・スロット / コーナー矩形 (_chrome=true のみ) ──
  // Scroll.drawVScrollbarSlot / drawHScrollbarSlot / drawScrollCorner へ渡す。
  // V スロットは下端を SLOT 分空け、H スロットは右端を SLOT 分空けて、交差部にコーナーを置く。
  let scrollbarRect = null;
  let hScrollbarRect = null;
  let scrollCornerRect = null;
  if (win._chrome) {
    scrollbarRect = {
      x: bodyRight - SLOT,
      y: bodyTop,
      w: SLOT,
      h: Math.max(0, bodyH - SLOT),
    };
    hScrollbarRect = {
      x: bodyLeft,
      y: bodyBottom - SLOT,
      w: Math.max(0, bodyW - SLOT),
      h: SLOT,
    };
    scrollCornerRect = {
      x: bodyRight - SLOT,
      y: bodyBottom - SLOT,
      w: SLOT,
      h: SLOT,
    };
  }

  // ── WM 管理スクロール (_scrollable) の viewport 更新 (縦横) ──
  // 仮想コンテンツ幅/高 (content) は wm.js が onMeasure 由来で設定する。ここでは
  // 現在の表示領域 (viewport) のみ両軸で同期する。アプリ管理バー (NOTEPAD,
  // _scrollable=false) の状態には触れない。
  if (win._scrollable) {
    if (win._vScroll) Scroll.scrollSetViewport(win._vScroll, contentH);
    if (win._hScroll) Scroll.scrollSetViewport(win._hScroll, contentW);
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
    // アプリ onDraw 用クリップ矩形 (contentRect をフォーカスマージン分だけ
    // 実パディングを上限に外側へ広げたもの。padding:"none" は contentRect と一致)
    contentClipRect,
    // 縦スクロールバースロット矩形 (_chrome=true のみ, null = chrome 無し)
    scrollbarRect,
    // 横スクロールバースロット矩形 (_chrome=true のみ, null = chrome 無し)
    hScrollbarRect,
    // V/H 交差コーナー矩形 (_chrome=true のみ, null = chrome 無し)
    scrollCornerRect,
    // footer 区切り線 Y (footer 有効時のみ)
    footerSepY,
    // footer 描画領域 (null = footer 無効)
    footerRect,
  };
}

/**
 * コンテンツサイズからウィンドウの外寸 (w, h) を算出する。
 * wmOpen / border ダブルクリック等で共通使用。
 *
 * 計算式 (recalcLayout の逆演算):
 *   w = cw + BORDER*2 + CONTENT_PADDING*2 + slotReserve
 *   h = ch + BORDER + SEPARATOR_HEIGHT + BORDER + HEADER_HEIGHT + CONTENT_PADDING*2
 *       + (footer ? FOOTER_HEIGHT : 0) + slotReserve
 *
 * chrome=true の場合、ボディ右端の縦スクロールバースロットと下端の横スクロールバー
 * スロット (各 Scroll.SCROLLBAR_SLOT_WIDTH) を幅・高さ双方に加算する。これにより
 * 標準 UI のバーを足してもコンテンツ描画領域が縮まない (ウィンドウが SLOT 分広がる)。
 *
 * @param {number} cw  コンテンツ幅
 * @param {number} ch  コンテンツ高さ
 * @param {boolean} [footer=false] footer 有効フラグ
 * @param {boolean} [chrome=false] 標準スクロールバー chrome を持つウィンドウか
 * @param {number} [contentPad=CONTENT_PADDING] ボディ内側パディング (padding:none は 0)
 * @returns {{ w:number, h:number }}
 */
export function calcWindowSize(
  cw,
  ch,
  footer = false,
  chrome = false,
  contentPad = CONTENT_PADDING,
) {
  const slotReserve = chrome ? Scroll.SCROLLBAR_SLOT_WIDTH : 0;
  const footerH = footer ? FOOTER_HEIGHT : 0;
  return {
    w: Math.max(MIN_WIDTH, cw + FRAME_EXTRA_W + contentPad * 2 + slotReserve),
    h: Math.max(
      MIN_HEIGHT,
      ch + FRAME_EXTRA_H + HEADER_HEIGHT + contentPad * 2 + footerH + slotReserve,
    ),
  };
}

