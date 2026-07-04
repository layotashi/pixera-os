/**
 * @module ui/scrollbar
 * scrollbar.js — スクロールバー プリミティブ
 *
 * スクロール状態の管理・描画・入力処理を単一モジュールに集約する。
 * ListBox / TreeView / TextArea およびウィンドウスクロール (wm.js) が
 * 共通のスクロール部品として使用する。
 *
 * ── 設計原則 ──
 *   1. 単位非依存: offset / viewport / content は行数でもピクセル数でもよい
 *   2. ステートレス描画: drawVScrollbar / drawHScrollbar は毎フレーム呼ぶ
 *   3. 副作用は state への書き込みのみ (ports.js 経由の描画を除く)
 *   4. consumed フラグ: 入力を消費したかどうかを呼び出し元に通知
 *
 * ── スクロールバーの見た目仕様 ──
 *   スクロールバーは「スロット」と呼ぶ矩形領域に描画される。
 *   スロットの構成 (垂直の場合、左から右へ):
 *
 *     sep(1px) │ 暗色(1px) │ thumb(SCROLLBAR_W) │ 暗色(1px)
 *     ├────────────── SCROLLBAR_SLOT_WIDTH (= SCROLLBAR_W + 3) ──────────┤
 *
 *   上下方向も同様に 1px の暗色余白 (SCROLLBAR_MARGIN) が入る。
 *   この仕様は drawVScrollbarSlot / drawHScrollbarSlot が一元管理し、
 *   呼び出し側はスロット矩形を渡すだけでよい。
 *
 *   スクロール可能かつトラックが十分長い時は、両端に ▲▼ / ◀▶ の
 *   ステッパーボタンを出す。ボタンは 9x9 (スロット内幅いっぱい) の矩形に
 *   矢印を中央配置し、サム領域とは区切り線 (BTN_SEP) で隔てる。クリックで
 *   1 段 (縦1行/横1桁)、押しっぱなしでオートリピート、押下中は反転表示。
 *   短いバー・非スクロール時はボタン無し。ボタンの有無・当たり判定・区切り線・
 *   サム区間は trackLayout() が単一管理する。
 *
 * ── スクロール状態 (ScrollState) ──
 *   {
 *     offset:   number,  // 現在のスクロール位置 (0-based)
 *     viewport: number,  // 表示領域サイズ (行数 or px)
 *     content:  number,  // コンテンツ全体サイズ (行数 or px)
 *     _thumbDrag:      boolean, // サムをドラッグ中か
 *     _dragStartPos:   number,  // ドラッグ開始時のマウス座標
 *     _dragStartOffset:number,  // ドラッグ開始時の offset
 *   }
 *
 * ── 使い方 ──
 *   const vs = createScrollState(visibleRows, items.length);
 *   // 描画 (高レベル — 推奨):
 *   drawVScrollbarSlot(vs, slotX, slotY, slotH);
 *   // 描画 (低レベル — thumb のみ):
 *   drawVScrollbar(vs, thumbX, thumbY, thumbH);
 *   // 入力:
 *   const { consumed } = handleVScrollInput(vs, evType, mouseY, thumbY, thumbH);
 *   // 値の読み取り:
 *   const startIdx = vs.offset;
 */

import { fillRect, vline, hline, pset } from "./ports.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** スクロールバーの太さ (px) */
export const SCROLLBAR_W = 7;

/**
 * 明色枠線と thumb 間の暗色余白 (px)。
 * thumb の上下左右に均等に適用される。
 */
export const SCROLLBAR_MARGIN = 1;

/**
 * スクロールバーが占有する総幅/総高 (px)。
 * sep(1) + margin(1) + thumb(SCROLLBAR_W) + margin(1) = SCROLLBAR_W + 3。
 * 呼び出し側が contentW 等からスクロールバー分を差し引く際に使う。
 */
export const SCROLLBAR_SLOT_WIDTH = SCROLLBAR_W + SCROLLBAR_MARGIN * 2 + 1;

/** サムの最小サイズ (px) */
const THUMB_MIN = 5;

/**
 * ステッパーボタン 1 セルの一辺 (px)。スロット内幅 (sep を除く = SCROLLBAR_W +
 * margin*2 = 9) と同じ 9x9 の正方形セル。セル内で反転領域は 7x7 (上下左右 1px 余白)、
 * キャレットは 5x5 相当を中央に置く (サム 7px と同じ「1px 余白付き」の見た目に揃える)。
 * scrollBy(±step) でスクロール軸方向に 1 段 (縦=1行 / 横=1桁) 動かす。
 */
const SCROLLBAR_BTN = SCROLLBAR_W + SCROLLBAR_MARGIN * 2;

/** ボタン領域とサム領域を隔てる区切り線の太さ (px)。 */
const BTN_SEP = 1;

/** 端ゾーンの消費量: ボタンセル(9) + 区切り線(1) + サム余白(1) = 11px。 */
const END_ZONE = SCROLLBAR_BTN + BTN_SEP + SCROLLBAR_MARGIN;

/**
 * ボタンを出す最小トラック長 (px)。両端ゾーン + 最小サムが収まらない短い
 * トラックではボタンを出さず、従来どおりサムのみ表示する (小窓での破綻回避)。
 */
const MIN_TRACK_FOR_BUTTONS = END_ZONE * 2 + THUMB_MIN;

/** ボタン押しっぱなしオートリピート: 初動から反復開始までの hold フレーム数。 */
const BTN_REPEAT_DELAY = 20;

/** ボタン押しっぱなしオートリピート: 反復間隔 (フレーム)。 */
const BTN_REPEAT_INTERVAL = 3;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ファクトリ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * スクロール状態を生成する。
 * @param {number} viewport  表示領域サイズ (行数 or px)
 * @param {number} content   コンテンツ全体サイズ (行数 or px)
 * @returns {object} ScrollState
 */
export function createScrollState(viewport, content) {
  return {
    offset: 0,
    viewport,
    content,
    _thumbDrag: false,
    _dragStartPos: 0,
    _dragStartOffset: 0,
    /** ステッパーボタン押下中: -1=上/左, 0=なし, +1=下/右 */
    _btnHeld: 0,
    /** ボタン押下継続フレーム数 (オートリピート判定用) */
    _btnRepeat: 0,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  クエリ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * スクロール可能な最大 offset を返す。
 * @param {object} s  ScrollState
 * @returns {number}
 */
export function scrollMaxOffset(s) {
  return Math.max(0, s.content - s.viewport);
}

/**
 * スクロールバーの表示が必要かどうかを返す。
 * @param {object} s  ScrollState
 * @returns {boolean}
 */
export function scrollNeeded(s) {
  return s.content > s.viewport;
}

/**
 * スクロールバーがマウスを掴んでいるか (サムドラッグ中 or ステッパーボタン押下中)。
 * 消費者はこれを見て「バー外へ出ても held/up を送り続ける」既存プラミングを流用でき、
 * ボタンのオートリピート継続とバー外リリースの後始末が同じ経路で処理される。
 * @param {object} s  ScrollState
 * @returns {boolean}
 */
export function scrollIsDragging(s) {
  return s._thumbDrag || s._btnHeld !== 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ミューテーション
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * offset を delta 分だけ変化させる (クランプ付き)。
 * @param {object} s      ScrollState
 * @param {number} delta  変化量 (正=下/右、負=上/左)
 */
export function scrollBy(s, delta) {
  const max = scrollMaxOffset(s);
  s.offset = Math.max(0, Math.min(max, s.offset + delta));
}

/**
 * offset を直接設定する (クランプ付き)。
 * @param {object} s       ScrollState
 * @param {number} offset  新しい offset
 */
export function scrollTo(s, offset) {
  const max = scrollMaxOffset(s);
  s.offset = Math.max(0, Math.min(max, offset));
}

/**
 * 指定インデックスが表示領域内に収まるよう offset を調整する。
 * @param {object} s      ScrollState
 * @param {number} index  表示したいインデックス (0-based)
 */
export function scrollEnsureVisible(s, index) {
  if (index < s.offset) {
    s.offset = index;
  }
  if (index >= s.offset + s.viewport) {
    s.offset = index - s.viewport + 1;
  }
}

/**
 * content サイズ変更時に offset をクランプする。
 * @param {object} s        ScrollState
 * @param {number} content  新しいコンテンツサイズ
 */
export function scrollSetContent(s, content) {
  s.content = content;
  const max = scrollMaxOffset(s);
  if (s.offset > max) s.offset = max;
}

/**
 * viewport サイズ変更時に offset をクランプする。
 * @param {object} s         ScrollState
 * @param {number} viewport  新しい表示領域サイズ
 */
export function scrollSetViewport(s, viewport) {
  s.viewport = viewport;
  const max = scrollMaxOffset(s);
  if (s.offset > max) s.offset = max;
}

/**
 * ドラッグ / ボタン押下状態を強制リセットする (リリース・フォーカス喪失時など)。
 * @param {object} s  ScrollState
 */
export function scrollDragReset(s) {
  s._thumbDrag = false;
  s._btnHeld = 0;
  s._btnRepeat = 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  サムジオメトリ (内部)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * サムの位置・サイズを算出する。
 * @param {object} s          ScrollState
 * @param {number} trackStart トラック開始座標 (px)
 * @param {number} trackLen   トラック長さ (px)
 * @returns {{ pos:number, size:number, trackRange:number }|null}
 *          スクロール不要なら null
 */
function thumbGeom(s, trackStart, trackLen) {
  const max = scrollMaxOffset(s);
  if (max <= 0) return null;
  const ratio = s.viewport / s.content;
  const size = Math.max(THUMB_MIN, (trackLen * ratio) | 0);
  const trackRange = trackLen - size;
  const pos = (trackStart + trackRange * (s.offset / max)) | 0;
  return { pos, size, trackRange };
}

/**
 * トラック (サム走行域) をステッパーボタンとサム区間に分割する。描画と入力で
 * 同じ分割を使い、ボタン当たり判定とサム位置がズレないようにする単一の真実。
 * ボタンは「スクロール可能 (scrollNeeded) かつトラックが十分長い」時だけ出す。
 * @param {object} s          ScrollState
 * @param {number} trackStart トラック開始座標 (px, スクロール軸)
 * @param {number} trackLen   トラック長さ (px)
 * @returns {{ showButtons:boolean, aStart:number, bStart:number,
 *             sepA:number, sepB:number, thumbStart:number, thumbLen:number }}
 */
function trackLayout(s, trackStart, trackLen) {
  if (!scrollNeeded(s) || trackLen < MIN_TRACK_FOR_BUTTONS) {
    // ボタン無し: サムはスロット内で上下(左右) 1px 余白を取って走る (従来挙動)。
    return {
      showButtons: false,
      aStart: 0,
      bStart: 0,
      sepA: 0,
      sepB: 0,
      thumbStart: trackStart + SCROLLBAR_MARGIN,
      thumbLen: trackLen - SCROLLBAR_MARGIN * 2,
    };
  }
  return {
    showButtons: true,
    aStart: trackStart, // 上/左ボタンセル開始
    bStart: trackStart + trackLen - SCROLLBAR_BTN, // 下/右ボタンセル開始
    sepA: trackStart + SCROLLBAR_BTN, // 上/左ボタン直後の区切り線
    sepB: trackStart + trackLen - SCROLLBAR_BTN - BTN_SEP, // 下/右ボタン直前の区切り線
    // サムは区切り線からさらに 1px 余白 (SCROLLBAR_MARGIN) 内側で走らせ、
    // 上下端でもボタンと繋がって見えないようにする。
    thumbStart: trackStart + END_ZONE,
    thumbLen: trackLen - END_ZONE * 2,
  };
}

/**
 * 9x9 ボタンセル (bx,by=左上) の中央に 5px キャレット三角形 (▲▼◀▶) を色 c で描く。
 * キャレットは 5x3 (▲▼) / 3x5 (◀▶)＝中央 (bx+4,by+4) 対称。7x7 反転領域の内側に
 * さらに 1px 余白が残る大きさにして、反転時に矢印が枠へ潰れないようにする。
 */
function drawArrow(dir, bx, by, c) {
  if (dir === "up") {
    pset(bx + 4, by + 3, c);
    hline(bx + 3, bx + 5, by + 4, c);
    hline(bx + 2, bx + 6, by + 5, c);
  } else if (dir === "down") {
    hline(bx + 2, bx + 6, by + 3, c);
    hline(bx + 3, bx + 5, by + 4, c);
    pset(bx + 4, by + 5, c);
  } else if (dir === "left") {
    pset(bx + 3, by + 4, c);
    vline(bx + 4, by + 3, by + 5, c);
    vline(bx + 5, by + 2, by + 6, c);
  } else {
    // right
    vline(bx + 3, by + 2, by + 6, c);
    vline(bx + 4, by + 3, by + 5, c);
    pset(bx + 5, by + 4, c);
  }
}

/**
 * ステッパーボタンを描く。押下中は反転領域 (9x9 セル内に 1px 余白の 7x7=サムと
 * 同寸) を塗り潰し、キャレットを抜き文字にして反転表示する。
 */
function drawButton(dir, bx, by, pressed) {
  if (pressed) {
    fillRect(bx + 1, by + 1, SCROLLBAR_W, SCROLLBAR_W, 1); // 7x7 反転領域 (1px 余白)
    drawArrow(dir, bx, by, 0);
  } else {
    drawArrow(dir, bx, by, 1);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 垂直スクロールバーを描画する。
 * トラック左端に区切り線 (vline) を引き、サムを fillRect で描画。
 * @param {object} s  ScrollState
 * @param {number} x  スクロールバー左端 X
 * @param {number} y  スクロールバー上端 Y (= トラック開始)
 * @param {number} h  スクロールバー高さ (= トラック長さ)
 */
export function drawVScrollbar(s, x, y, h) {
  const geom = thumbGeom(s, y, h);
  if (!geom) {
    // スクロール不要: トラック全体を明色で埋める (全コンテンツ表示中)
    fillRect(x, y, SCROLLBAR_W, h, 1);
    return;
  }
  fillRect(x, geom.pos, SCROLLBAR_W, geom.size, 1);
}

/**
 * 垂直スクロールバーの区切り線を描画する。
 * ウィジェット枠 ↔ スクロールバー間の境界線。
 * @param {number} x   区切り線 X
 * @param {number} y1  上端 Y
 * @param {number} y2  下端 Y
 */
export function drawVScrollSep(x, y1, y2) {
  vline(x, y1, y2, 1);
}

/**
 * 水平スクロールバーを描画する。
 * トラック上端に区切り線 (hline) を引き、サムを fillRect で描画。
 * @param {object} s  ScrollState
 * @param {number} x  スクロールバー左端 X (= トラック開始)
 * @param {number} y  スクロールバー上端 Y
 * @param {number} w  スクロールバー幅 (= トラック長さ)
 */
export function drawHScrollbar(s, x, y, w) {
  const geom = thumbGeom(s, x, w);
  if (!geom) {
    // スクロール不要: トラック全体を明色で埋める
    fillRect(x, y, w, SCROLLBAR_W, 1);
    return;
  }
  fillRect(geom.pos, y, geom.size, SCROLLBAR_W, 1);
}

/**
 * 水平スクロールバーの区切り線を描画する。
 * @param {number} x1  左端 X
 * @param {number} x2  右端 X
 * @param {number} y   区切り線 Y
 */
export function drawHScrollSep(x1, x2, y) {
  hline(x1, x2, y, 1);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  高レベル描画 (スロット単位)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// スクロールバーの見た目仕様 (sep + 暗色余白 + thumb) を一元管理する。
// 呼び出し側はスロット矩形を渡すだけでよく、内部レイアウトを知る必要がない。

/**
 * 垂直スクロールバーをスロット単位で描画する。
 *
 * スロットは以下の構造を持つ (左から右へ):
 *   sep(1px) │ 暗色余白(SCROLLBAR_MARGIN) │ thumb(SCROLLBAR_W) │ 暗色余白(SCROLLBAR_MARGIN)
 *
 * 上下方向にも SCROLLBAR_MARGIN の暗色余白が入る。
 *
 * @param {object} s  ScrollState
 * @param {number} x  スロット左端 X (sep の X 座標)
 * @param {number} y  スロット上端 Y
 * @param {number} h  スロット高さ
 */
export function drawVScrollbarSlot(s, x, y, h) {
  // sep 線
  vline(x, y, y + h - 1, 1);
  if (h <= 0) return;
  const btnX = x + 1; // ボタンはスロット内幅いっぱい (9px, sep の右) にフラッシュ
  const thumbX = x + 1 + SCROLLBAR_MARGIN; // サムは内側に 1px inset (7px)
  const L = trackLayout(s, y, h); // ボタンはスロット端にフラッシュ、余白はサム側で
  if (L.showButtons) {
    drawButton("up", btnX, L.aStart, s._btnHeld === -1);
    drawButton("down", btnX, L.bStart, s._btnHeld === 1);
    // ボタン領域とサム領域を隔てる区切り線
    hline(btnX, btnX + SCROLLBAR_BTN - 1, L.sepA, 1);
    hline(btnX, btnX + SCROLLBAR_BTN - 1, L.sepB, 1);
  }
  drawVScrollbar(s, thumbX, L.thumbStart, L.thumbLen);
}

/**
 * 水平スクロールバーをスロット単位で描画する。
 *
 * スロットは以下の構造を持つ (上から下へ):
 *   sep(1px) │ 暗色余白(SCROLLBAR_MARGIN) │ thumb(SCROLLBAR_W) │ 暗色余白(SCROLLBAR_MARGIN)
 *
 * 左右方向にも SCROLLBAR_MARGIN の暗色余白が入る。
 *
 * @param {object} s  ScrollState
 * @param {number} x  スロット左端 X
 * @param {number} y  スロット上端 Y (sep の Y 座標)
 * @param {number} w  スロット幅
 */
export function drawHScrollbarSlot(s, x, y, w) {
  // sep 線
  hline(x, x + w - 1, y, 1);
  if (w <= 0) return;
  const btnY = y + 1; // ボタンはスロット内高いっぱい (9px, sep の下) にフラッシュ
  const thumbY = y + 1 + SCROLLBAR_MARGIN; // サムは内側に 1px inset (7px)
  const L = trackLayout(s, x, w); // ボタンはスロット端にフラッシュ、余白はサム側で
  if (L.showButtons) {
    drawButton("left", L.aStart, btnY, s._btnHeld === -1);
    drawButton("right", L.bStart, btnY, s._btnHeld === 1);
    // ボタン領域とサム領域を隔てる区切り線
    vline(L.sepA, btnY, btnY + SCROLLBAR_BTN - 1, 1);
    vline(L.sepB, btnY, btnY + SCROLLBAR_BTN - 1, 1);
  }
  drawHScrollbar(s, L.thumbStart, thumbY, L.thumbLen);
}

/**
 * drawVScrollbarSlot のスロット内側 (sep を除いた 9px 幅 × スロット全高) を返す。
 * 入力処理はこの矩形で当たり判定し、trackY=y / trackH=h を handleVScrollInput へ渡す。
 * ボタンはスロット端にフラッシュ配置されるため、当たり判定・トラックともスロット全高で
 * 扱う (サム側の 1px 余白は trackLayout が内部で処理する)。
 *
 * @param {number} slotX  スロット左端 X (sep の X)
 * @param {number} slotY  スロット上端 Y
 * @param {number} slotH  スロット高さ
 * @returns {{ x:number, y:number, w:number, h:number }}
 */
export function vScrollbarSlotThumbArea(slotX, slotY, slotH) {
  return {
    x: slotX + 1, // sep の右 = 内側領域の左端
    y: slotY,
    w: SCROLLBAR_SLOT_WIDTH - 1, // 内側 9px (ボタン=フル幅 / サム=inset)
    h: Math.max(0, slotH),
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力処理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 垂直スクロールバーの入力を処理する。
 * サムのクリック・ドラッグ・トラック直クリック (ジャンプ) を扱う。
 * ホイールは含まない (呼び出し元で scrollBy を直接使用)。
 *
 * @param {object} s         ScrollState
 * @param {string} evType    イベント種別 ("down" | "held" | "up")
 * @param {number} mousePos  マウス Y 座標 (ローカル座標)
 * @param {number} trackY    トラック上端 Y (ローカル座標)
 * @param {number} trackH    トラック高さ (px)
 * @param {number} [step=1]  ステッパーボタン 1 クリックのスクロール量 (縦=1行)
 * @returns {{ consumed: boolean }}  入力を消費したかどうか
 */
export function handleVScrollInput(s, evType, mousePos, trackY, trackH, step = 1) {
  return _handleSlotInput(s, evType, mousePos, trackY, trackH, step);
}

/**
 * 水平スクロールバーの入力を処理する。
 * @param {object} s         ScrollState
 * @param {string} evType    イベント種別 ("down" | "held" | "up")
 * @param {number} mousePos  マウス X 座標 (ローカル座標)
 * @param {number} trackX    トラック左端 X (ローカル座標)
 * @param {number} trackW    トラック幅 (px)
 * @param {number} [step=1]  ステッパーボタン 1 クリックのスクロール量 (横=1桁)
 * @returns {{ consumed: boolean }}  入力を消費したかどうか
 */
export function handleHScrollInput(s, evType, mousePos, trackX, trackW, step = 1) {
  return _handleSlotInput(s, evType, mousePos, trackX, trackW, step);
}

/**
 * スロット入力の共通実装 (方向非依存)。両端ボタン (クリック/オートリピート) を
 * 先に処理し、それ以外 (サムドラッグ / トラックジャンプ) は縮んだサム区間へ委譲する。
 * ボタン非表示時は従来どおりトラック全体で _handleScrollInput を呼ぶ。
 * @param {object} s          ScrollState
 * @param {string} evType     "down" | "held" | "up"
 * @param {number} mousePos   マウス座標 (スクロール軸)
 * @param {number} trackStart トラック開始座標
 * @param {number} trackLen   トラック長さ
 * @param {number} step       ボタン 1 クリックのスクロール量
 * @returns {{ consumed: boolean }}
 */
function _handleSlotInput(s, evType, mousePos, trackStart, trackLen, step) {
  const L = trackLayout(s, trackStart, trackLen);
  if (L.showButtons) {
    const onA = mousePos >= L.aStart && mousePos < L.aStart + SCROLLBAR_BTN;
    const onB = mousePos >= L.bStart && mousePos < L.bStart + SCROLLBAR_BTN;

    // ボタン押下 → 即 1 段スクロールし、押下状態を掴む (オートリピート開始)
    if (evType === "down" && (onA || onB)) {
      const dir = onA ? -1 : 1;
      scrollBy(s, dir * step);
      s._btnHeld = dir;
      s._btnRepeat = 0;
      return { consumed: true };
    }
    // 押しっぱなし → ボタン上に留まる間だけ、ディレイ後に一定間隔で反復
    if (evType === "held" && s._btnHeld !== 0) {
      const stillOnBtn =
        (s._btnHeld === -1 && onA) || (s._btnHeld === 1 && onB);
      if (stillOnBtn) {
        s._btnRepeat++;
        if (
          s._btnRepeat >= BTN_REPEAT_DELAY &&
          (s._btnRepeat - BTN_REPEAT_DELAY) % BTN_REPEAT_INTERVAL === 0
        ) {
          scrollBy(s, s._btnHeld * step);
        }
      }
      return { consumed: true };
    }
    if (evType === "up" && s._btnHeld !== 0) {
      s._btnHeld = 0;
      s._btnRepeat = 0;
      return { consumed: true };
    }
  }
  // ボタン以外 → 縮んだサム区間 (ボタン非表示時はトラック全体) で処理
  return _handleScrollInput(s, evType, mousePos, L.thumbStart, L.thumbLen);
}

/**
 * スクロールバー入力処理の共通実装 (方向非依存)。
 * @param {object} s         ScrollState
 * @param {string} evType    イベント種別
 * @param {number} mousePos  マウス座標 (スクロール方向)
 * @param {number} trackStart  トラック開始座標
 * @param {number} trackLen    トラック長さ
 * @returns {{ consumed: boolean }}
 */
function _handleScrollInput(s, evType, mousePos, trackStart, trackLen) {
  const max = scrollMaxOffset(s);

  // ── クリック: サム上ならドラッグ開始、トラック空白ならジャンプ+ドラッグ開始 ──
  if (evType === "down" && max > 0) {
    const geom = thumbGeom(s, trackStart, trackLen);
    if (!geom) return { consumed: false };

    const onThumb = mousePos >= geom.pos && mousePos < geom.pos + geom.size;

    if (!onThumb && geom.trackRange > 0) {
      // トラック空白クリック → サム中心がクリック位置に来るようジャンプ
      const clickRatio =
        (mousePos - trackStart - geom.size / 2) / geom.trackRange;
      scrollTo(s, Math.round(clickRatio * max));
    }

    s._thumbDrag = true;
    s._dragStartPos = mousePos;
    s._dragStartOffset = s.offset;
    return { consumed: true };
  }

  // ── サム ドラッグ中 ──
  if (evType === "held" && s._thumbDrag) {
    const geom = thumbGeom(s, trackStart, trackLen);
    if (geom && geom.trackRange > 0) {
      const delta = mousePos - s._dragStartPos;
      const dScroll = (delta / geom.trackRange) * max;
      scrollTo(s, Math.round(s._dragStartOffset + dScroll));
    }
    return { consumed: true };
  }

  // ── サム ドラッグ終了 ──
  if (evType === "up" && s._thumbDrag) {
    s._thumbDrag = false;
    return { consumed: true };
  }

  return { consumed: false };
}

