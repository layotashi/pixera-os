/**
 * wm/win_layout.js — ウィンドウ寸法算出のテスト
 *
 * calcWindowSize (コンテンツ寸法 → 外寸) と recalcLayout (外寸 → 内部矩形) が
 * 互いに逆演算であること (characterization) を検証する。B-1 の wm.js 分割で
 * これらのレイアウト算出が win_layout.js へ移った際の挙動不変の安全網。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── モック: config ──
vi.mock("@/config.js", () => ({
  VRAM_WIDTH: 480,
  VRAM_HEIGHT: 360,
  getHeaderPad: () => 8,
  getContentPad: () => 6,
}));

// ── モック: font / icon ──
vi.mock("@/core/font.js", () => ({ GLYPH_H: 7 }));
vi.mock("@/core/icon.js", () => ({ ICON_H: 9 }));

// ── モック: scrollbar ──
vi.mock("@/ui/scrollbar.js", () => ({
  SCROLLBAR_SLOT_WIDTH: 6,
  scrollSetViewport: vi.fn(),
}));

import {
  calcWindowSize,
  recalcLayout,
  recalcLayoutConstants,
} from "@/wm/win_layout.js";

beforeEach(() => {
  recalcLayoutConstants();
});

/** 与えた外寸で win を作り recalcLayout してコンテンツ矩形を返す */
function contentOf(w, h, footer, chrome) {
  const win = {
    x: 0,
    y: 0,
    w,
    h,
    footer,
    _chrome: chrome,
    _scrollable: false,
    _vScroll: null,
    fullscreen: false,
  };
  recalcLayout(win);
  return win._layout.contentRect;
}

describe("calcWindowSize ⇄ recalcLayout の逆演算", () => {
  // footer / chrome の 4 組合せで、十分大きい cw/ch なら
  // calcWindowSize の外寸から recalcLayout したコンテンツ寸法が cw/ch に戻る。
  const cases = [
    { footer: false, chrome: false },
    { footer: true, chrome: false },
    { footer: false, chrome: true },
    { footer: true, chrome: true },
  ];

  for (const { footer, chrome } of cases) {
    it(`footer=${footer} chrome=${chrome} で cw/ch が保存される`, () => {
      const cw = 200;
      const ch = 150;
      const { w, h } = calcWindowSize(cw, ch, footer, chrome);
      const cr = contentOf(w, h, footer, chrome);
      expect(cr.w).toBe(cw);
      expect(cr.h).toBe(ch);
    });
  }

  it("最小サイズを下回る要求は MIN_WIDTH / MIN_HEIGHT にクランプされる", () => {
    // 枠のオーバーヘッドを打ち消すため負のコンテンツ寸法で clamp を発火させる
    const { w, h } = calcWindowSize(-100, -100, false, false);
    expect(w).toBe(8); // MIN_WIDTH
    // MIN_HEIGHT = BORDER + HEADER_HEIGHT(=9+8*2=25) + SEP + 4 + BORDER = 32
    expect(h).toBe(32);
  });

  it("chrome はスクロールバースロット幅ぶん外寸が縦横とも広い", () => {
    const plain = calcWindowSize(200, 150, false, false);
    const chrome = calcWindowSize(200, 150, false, true);
    // 右端の V スロット + 下端の H スロットで幅・高さ双方に SLOT を加算する。
    expect(chrome.w - plain.w).toBe(6); // SCROLLBAR_SLOT_WIDTH
    expect(chrome.h - plain.h).toBe(6); // SCROLLBAR_SLOT_WIDTH
  });

  it("chrome ウィンドウは V/H スロット + コーナー矩形を算出する", () => {
    const { w, h } = calcWindowSize(200, 150, false, true);
    const win = {
      x: 0,
      y: 0,
      w,
      h,
      footer: false,
      _chrome: true,
      _scrollable: false,
      _vScroll: null,
      fullscreen: false,
    };
    recalcLayout(win);
    const L = win._layout;
    expect(L.scrollbarRect).not.toBeNull();
    expect(L.hScrollbarRect).not.toBeNull();
    expect(L.scrollCornerRect).not.toBeNull();
    // V スロットは右端フラッシュ、H スロットは下端フラッシュ、コーナーは交差部。
    expect(L.scrollbarRect.x).toBe(win.x + win.w - 1 - 6);
    expect(L.hScrollbarRect.y).toBe(win.y + win.h - 1 - 6);
    expect(L.scrollCornerRect.x).toBe(L.scrollbarRect.x);
    expect(L.scrollCornerRect.y).toBe(L.hScrollbarRect.y);
    // V スロットは下端を SLOT 分空け、H スロットは右端を SLOT 分空ける。
    expect(L.scrollbarRect.h).toBe(L.hScrollbarRect.y - L.scrollbarRect.y);
    expect(L.hScrollbarRect.w).toBe(L.scrollbarRect.x - L.hScrollbarRect.x);
  });

  it("chrome=false (モーダル等) はスロット矩形を持たない", () => {
    const { w, h } = calcWindowSize(200, 150, false, false);
    const cr = contentOf(w, h, false, false);
    expect(cr.w).toBe(200);
    // recalcLayout 経由でスロット矩形が null であることを確認
    const win = {
      x: 0,
      y: 0,
      w,
      h,
      footer: false,
      _chrome: false,
      _scrollable: false,
      _vScroll: null,
      fullscreen: false,
    };
    recalcLayout(win);
    expect(win._layout.scrollbarRect).toBeNull();
    expect(win._layout.hScrollbarRect).toBeNull();
    expect(win._layout.scrollCornerRect).toBeNull();
  });

  it("footer は FOOTER_HEIGHT ぶん外寸が高い", () => {
    const plain = calcWindowSize(200, 150, false, false);
    const withFooter = calcWindowSize(200, 150, true, false);
    // FOOTER_HEIGHT = SEP(1) + PAD(2) + GLYPH_H(7) + PAD(2) = 12
    expect(withFooter.h - plain.h).toBe(12);
    expect(withFooter.w).toBe(plain.w);
  });
});

describe("padding:none (win._noPad)", () => {
  it("contentRect が内側パディング無しでボディ端まで広がる", () => {
    const padded = contentOf(200, 150, false, false); // 既定 (CONTENT_PADDING=6)
    const noPadWin = {
      x: 0,
      y: 0,
      w: 200,
      h: 150,
      footer: false,
      _scrollable: false,
      _vScroll: null,
      fullscreen: false,
      _noPad: true,
    };
    recalcLayout(noPadWin);
    const none = noPadWin._layout.contentRect;
    // CONTENT_PADDING(=6) ぶん、左右・上下で 12px 広い
    expect(none.w - padded.w).toBe(12);
    expect(none.h - padded.h).toBe(12);
    // 左上も padding ぶん外側 (原点が枠寄り)
    expect(padded.x - none.x).toBe(6);
    expect(padded.y - none.y).toBe(6);
  });

  it("calcWindowSize は contentPad=0 で padding ぶん小さくなる", () => {
    const def = calcWindowSize(200, 150, false, false);
    const none = calcWindowSize(200, 150, false, false, 0);
    expect(def.w - none.w).toBe(12);
    expect(def.h - none.h).toBe(12);
  });
});

describe("contentClipRect — アプリ onDraw のクリップ領域", () => {
  // アプリの onDraw は contentClipRect にクリップされる。フォーカスブラケット
  // (ウィジェット外側へ FOCUS_MARGIN=2 px 張り出す) を切らないよう contentRect を
  // 外へ広げるが、広げる量はウィンドウの実パディングを上限にクランプされ、
  // ヘッダー区切り線・外枠へは決して食い込まない。
  const makeWin = (noPad) => {
    const win = {
      x: 0,
      y: 0,
      w: 200,
      h: 150,
      footer: false,
      _chrome: false,
      _scrollable: false,
      _vScroll: null,
      fullscreen: false,
      _noPad: !!noPad,
    };
    recalcLayout(win);
    return win;
  };

  it("padding あり窓は contentRect を FOCUS_MARGIN(=2) ぶん外へ広げる", () => {
    // clipMargin = min(FOCUS_MARGIN=2, pad=6) = 2
    const { contentRect: cr, contentClipRect: clip } = makeWin(false)._layout;
    expect(cr.x - clip.x).toBe(2);
    expect(cr.y - clip.y).toBe(2);
    expect(clip.w - cr.w).toBe(4);
    expect(clip.h - cr.h).toBe(4);
  });

  it("padding あり窓のクリップもボディ内に収まる (ヘッダー/枠を侵さない)", () => {
    const win = makeWin(false);
    const { contentClipRect: clip, sepY } = win._layout;
    expect(clip.y).toBeGreaterThan(sepY); // 上端は区切り線より下
    expect(clip.x).toBeGreaterThanOrEqual(win.x + 1); // 左端は外枠 (BORDER) 内
  });

  it("padding:none 窓のクリップは contentRect ちょうど (はみ出し 0)", () => {
    // clipMargin = min(FOCUS_MARGIN=2, pad=0) = 0 → 広げない
    const { contentRect: cr, contentClipRect: clip } = makeWin(true)._layout;
    expect(clip).toEqual(cr);
  });

  it("padding:none 窓のクリップはヘッダー区切り線・外枠へ食い込まない (回帰)", () => {
    // 回帰: 以前は pad に依らず FOCUS_MARGIN ぶん常に広げていたため、pad=0 の窓
    // (ROLL/NOTEPAD/AQUARIA) で onDraw がヘッダー・外枠へはみ出していた。
    const win = makeWin(true);
    const { contentClipRect: clip, sepY } = win._layout;
    expect(clip.y).toBe(sepY + 1); // ちょうどボディ上端 (SEPARATOR_HEIGHT ぶん下)
    expect(clip.x).toBe(win.x + 1); // ちょうど外枠 (BORDER) の内側
  });
});

