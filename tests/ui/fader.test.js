/**
 * tests/ui/fader.test.js — 垂直フェーダー (音楽制作系ウィジェット) の値ロジック。
 *
 * 対象: クランプ・整数丸め・onChange 発火・デフォルト復帰、および
 * 上下ドラッグ / ホイールでの値マッピング (上端 = max, 下端 = min)。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initPorts } from "@/ui/index.js";
import { Fader, FADER_W } from "@/ui/music/index.js";

// ── 描画呼び出しの記録 (幾何検証用) ──
const calls = { drawRect: [], fillRect: [], hline: [] };
function resetCalls() {
  calls.drawRect = [];
  calls.fillRect = [];
  calls.hline = [];
}

// ── ポートのスタブ注入 (draw のスモークに drawCheckerboard 等が要る) ──
beforeAll(() => {
  initPorts({
    gpu: {
      fillRect: (x, y, w, h, c) => calls.fillRect.push({ x, y, w, h, c }),
      drawRoundRect() {},
      drawRect: (x, y, w, h, c) => calls.drawRect.push({ x, y, w, h, c }),
      drawCheckerboard() {},
      hline: (x1, x2, y, c) => calls.hline.push({ x1, x2, y, c }),
      vline() {},
      pset() {},
      setClip() {},
      resetClip() {},
      pushClip() {},
      popClip() {},
    },
    font: { GLYPH_W: 5, GLYPH_H: 7, drawText() {} },
    icon: { ICON_W: 7, ICON_H: 7, drawIcon() {} },
    input: {
      keyDown: () => false,
      keyHeld: () => false,
      getCharQueue: () => [],
      getPasteText: () => "",
      mouseHasShift: () => false,
      ctrlDown: () => false,
    },
    textIcon: { drawTextIcon() {} },
    dither: { BAYER_4x4: [], BAYER_8x8: [] },
  });
});

/** down イベントを送る (localX は幅の中央、localY は指定) */
function press(fader, localY, shift = false) {
  fader.update({
    type: "down",
    localX: fader.x + (FADER_W >> 1),
    localY,
    shift,
  });
}

describe("Fader — 構築", () => {
  it("幅は FADER_W 固定、高さはアプリ指定", () => {
    const f = new Fader(0, 0, 44, 0, 100, 50);
    expect(f.w).toBe(FADER_W);
    expect(f.h).toBe(44);
  });

  it("初期値は min/max にクランプされる", () => {
    expect(new Fader(0, 0, 44, 0, 100, 150).value).toBe(100);
    expect(new Fader(0, 0, 44, 0, 100, -20).value).toBe(0);
  });

  it("min/max が整数なら整数モード", () => {
    const f = new Fader(0, 0, 44, 0, 100, 50);
    expect(f._isInt).toBe(true);
  });

  it("cursorName は drag-v", () => {
    expect(new Fader(0, 0, 44, 0, 100, 50).cursorName).toBe("drag-v");
  });
});

describe("Fader — ドラッグの値マッピング (上=max, 下=min)", () => {
  // 奇数高で使う (実効高=指定高)。マージン 1px ぶん内側で止まるので
  // travelTop = y+MARGIN+5 = 6, travelBottom = y+h-MARGIN-11+5 = 38 (h=45)
  it("上端をつかむと max になる", () => {
    const f = new Fader(0, 0, 45, 0, 100, 50);
    press(f, 6);
    expect(f.value).toBe(100);
  });

  it("下端をつかむと min になる", () => {
    const f = new Fader(0, 0, 45, 0, 100, 50);
    press(f, 38);
    expect(f.value).toBe(0);
  });

  it("中央をつかむと中間値になる", () => {
    const f = new Fader(0, 0, 45, 0, 100, 0);
    press(f, Math.round((6 + 38) / 2)); // = 22
    expect(f.value).toBeGreaterThan(40);
    expect(f.value).toBeLessThan(60);
  });

  it("枠外の down では反応しない (dragging にならない)", () => {
    const f = new Fader(0, 0, 45, 0, 100, 50);
    f.update({ type: "down", localX: 10, localY: 100, shift: false });
    expect(f.dragging).toBe(false);
    expect(f.value).toBe(50);
  });
});

describe("Fader — onChange / ホイール / ダブルクリック", () => {
  it("値が変わったら onChange が新値で呼ばれる", () => {
    let got = null;
    const f = new Fader(0, 0, 45, 0, 100, 50, (v) => (got = v));
    press(f, 5);
    expect(got).toBe(100);
  });

  it("同値なら onChange は呼ばれない", () => {
    let calls = 0;
    const f = new Fader(0, 0, 45, 0, 100, 100, () => calls++);
    press(f, 5); // すでに max
    expect(calls).toBe(0);
  });

  it("ホイール上で増加・下で減少 (整数ステップ)", () => {
    const f = new Fader(0, 0, 45, 0, 100, 50);
    f.update({ type: "wheel", localX: 10, localY: 20, deltaY: -1 });
    expect(f.value).toBe(55); // step = max(1, 100*0.05) = 5
    f.update({ type: "wheel", localX: 10, localY: 20, deltaY: 1 });
    expect(f.value).toBe(50);
  });

  it("ダブルクリックでデフォルト値に戻る", () => {
    const f = new Fader(0, 0, 45, 0, 100, 30);
    press(f, 5); // 100 に変更
    expect(f.value).toBe(100);
    f.update({ type: "dblclick", localX: 10, localY: 20 });
    expect(f.value).toBe(30); // 構築時の値がデフォルト
  });
});

describe("Fader — 非整数レンジ / 描画スモーク", () => {
  it("非整数レンジでは丸めない", () => {
    const f = new Fader(0, 0, 45, 0, 1.5, 0.5);
    expect(f._isInt).toBe(false);
    press(f, 22);
    expect(Number.isInteger(f.value)).toBe(false);
  });

  it("draw が例外を投げない (各値位置・偶奇高)", () => {
    const cr = { x: 0, y: 0 };
    for (const H of [45, 44]) {
      const f = new Fader(2, 2, H, 0, 100, 50);
      for (const v of [0, 25, 50, 75, 100]) {
        f.value = v;
        expect(() => f.draw(cr)).not.toThrow();
      }
    }
  });
});

describe("Fader — ASCII 仕様の幾何 (描画呼び出しで検証)", () => {
  const H = 45; // 奇数高: 実効高=指定高 (端密着の検証を明快にする)
  const cr = { x: 0, y: 0 };
  const THUMB_W = FADER_W - 4; // 枠1+マージン1 を左右で除いた 21
  // つまみは fillRect のフットプリント (21w×11h) で識別。フェーダー枠は drawRect(25w×Hh)
  const isThumb = (r) => r.w === THUMB_W && r.h === 11;
  const isFrame = (r) => r.w === FADER_W && r.h === H;

  it("フェーダー枠は四辺 1px (drawRect が全幅×全高)", () => {
    resetCalls();
    new Fader(0, 0, H, 0, 100, 50).draw(cr);
    expect(calls.drawRect.some(isFrame)).toBe(true);
  });

  it("max でつまみ上端が上端マージン (y+1) に密着", () => {
    resetCalls();
    new Fader(3, 7, H, 0, 100, 100).draw(cr);
    const thumb = calls.fillRect.find(isThumb);
    expect(thumb.y).toBe(7 + 1); // ay + MARGIN
  });

  it("min でつまみ下端が下端マージン (y+h-2) に密着", () => {
    resetCalls();
    new Fader(3, 7, H, 0, 100, 0).draw(cr);
    const thumb = calls.fillRect.find(isThumb);
    expect(thumb.y + thumb.h - 1).toBe(7 + H - 1 - 1); // ay + h-1 - MARGIN
  });

  it("つまみは 21w×11h・枠から左右 2px 内側、グリップ線は 19px で左右 3px 内側", () => {
    resetCalls();
    new Fader(0, 0, H, 0, 100, 50).draw(cr);
    const thumb = calls.fillRect.find(isThumb);
    expect(thumb.w).toBe(THUMB_W);
    expect(thumb.h).toBe(11);
    expect(thumb.x).toBe(2); // 枠1 + マージン1 内側
    // グリップ線 = 最後の hline。全幅 25 に対し x1=3, x2=21 (幅 19)
    const grip = calls.hline[calls.hline.length - 1];
    expect(grip.x1).toBe(3);
    expect(grip.x2).toBe(FADER_W - 1 - 3);
  });

  it("グルーヴは幅 5px・溝(前景くり抜き) 3px = 壁 1px ずつ", () => {
    resetCalls();
    new Fader(0, 0, H, 0, 100, 50).draw(cr);
    // 反転配色: グルーヴ壁 = 幅 5 の fillRect(c=0)、内側くり抜き = 幅 3 の fillRect(c=1)
    const slot = calls.fillRect.find((r) => r.w === 5 && r.c === 0);
    const hollow = calls.fillRect.find((r) => r.w === 3 && r.c === 1);
    expect(slot).toBeTruthy();
    expect(hollow).toBeTruthy();
    // 溝は中央: 左壁 1px → hollow.x = slot.x + 1
    expect(hollow.x).toBe(slot.x + 1);
  });
});
