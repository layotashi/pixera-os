/**
 * tests/ui/link.test.js — Link ウィジェットのテスト。
 *
 * 検証: サイズ算出 / クリック発火 (down→up 同一ヒット) / 点線・実線下線。
 * 点線は「下線行のローカル x が偶数のみ点灯」= 両端対称であることを確認する。
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { initPorts } from "@/ui/index.js";
import { Link } from "@/ui/widgets/Link.js";

const rec = { hline: [], pset: [], text: [] };

beforeAll(() => {
  initPorts({
    gpu: {
      fillRect() {},
      drawRoundRect() {},
      drawRect() {},
      hline(...a) {
        rec.hline.push(a);
      },
      vline() {},
      pset(...a) {
        rec.pset.push(a);
      },
      setClip() {},
      resetClip() {},
      pushClip() {},
      popClip() {},
    },
    font: {
      GLYPH_W: 5,
      GLYPH_H: 5,
      drawText(...a) {
        rec.text.push(a);
      },
    },
    icon: { ICON_W: 7, ICON_H: 7, drawIcon() {} },
    input: {
      keyDown() {
        return false;
      },
      keyHeld() {
        return false;
      },
      getCharQueue() {
        return [];
      },
      getPasteText() {
        return "";
      },
      mouseHasShift() {
        return false;
      },
      ctrlDown() {
        return false;
      },
    },
    textIcon: { drawTextIcon() {} },
    dither: { BAYER_4x4: [], BAYER_8x8: [] },
  });
});

beforeEach(() => {
  rec.hline.length = 0;
  rec.pset.length = 0;
  rec.text.length = 0;
});

describe("Link", () => {
  it("w/h がテキストから計算される (w=6N-1, h=GLYPH_H+2)", () => {
    const a = new Link(0, 0, "ABC");
    expect(a.w).toBe(3 * 6 - 1); // 17
    expect(a.h).toBe(5 + 2); // 文字 5 + 余白 1 + 下線 1
  });

  it("down→up (両方ヒット) で onClick が発火する", () => {
    let clicked = 0;
    const a = new Link(0, 0, "ABC", () => clicked++);
    a.update({ type: "down", localX: 1, localY: 1 });
    a.update({ type: "up", localX: 1, localY: 1 });
    expect(clicked).toBe(1);
  });

  it("up がリンク外なら onClick は発火しない", () => {
    let clicked = 0;
    const a = new Link(0, 0, "ABC", () => clicked++);
    a.update({ type: "down", localX: 1, localY: 1 });
    a.update({ type: "up", localX: 999, localY: 999 });
    expect(clicked).toBe(0);
  });

  it("通常時は点線: 下線行はローカル x 偶数のみ点灯し両端対称", () => {
    const a = new Link(0, 0, "ABC"); // _textW=17, 下線 y=6
    a.draw({ x: 0, y: 0 });
    const under = rec.pset
      .filter((c) => c[1] === 6)
      .map((c) => c[0])
      .sort((p, q) => p - q);
    expect(under[0]).toBe(0); // 左端点灯
    expect(under[under.length - 1]).toBe(16); // 右端点灯 (_textW-1)
    expect(under.every((x) => x % 2 === 0)).toBe(true);
    expect(rec.hline.length).toBe(0); // 実線は引かない
  });

  it("ホバー時は実線下線 (点線 pset なし)", () => {
    const a = new Link(0, 0, "ABC");
    a.update({ type: "hover", localX: 1, localY: 1 }); // hover on
    a.draw({ x: 0, y: 0 });
    expect(rec.hline).toContainEqual([0, 16, 6, 1]); // 実線 0..16 at y=6
    const under = rec.pset.filter((c) => c[1] === 6);
    expect(under.length).toBe(0);
  });
});
