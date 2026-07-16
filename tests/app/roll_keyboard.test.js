/**
 * roll_keyboard.test.js — ROLL 左端 1 段鍵盤のキーグリフ ASCII 仕様を検証する。
 *
 * 凡例 . = 背景(白) / # = 前景(黒)。gpu の fillRect / pset / drawCheckerboard を忠実に再現した
 * ピクセルバッファへ drawKeyGlyph を描き、白鍵 / 黒鍵 / 押下 (市松) の各仕様に一致するか確かめる。
 * 下枠は描かない (キー同士で罫線を共有 = 次キーの上枠が兼ねる) ので、下端は内側 (白) になる。
 */
import { describe, it, expect, vi } from "vitest";

const S = vi.hoisted(() => ({ buf: null, BW: 0, BH: 0 }));
vi.mock("@/core/gpu.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fillRect(x, y, w, h, c) {
      for (let j = y; j < y + h; j++)
        for (let i = x; i < x + w; i++)
          if (i >= 0 && i < S.BW && j >= 0 && j < S.BH) S.buf[j * S.BW + i] = c ? 1 : 0;
    },
    pset(x, y, c) {
      if (x >= 0 && x < S.BW && y >= 0 && y < S.BH) S.buf[y * S.BW + x] = c ? 1 : 0;
    },
    drawCheckerboard(x0, y0, w, h, c, phase = 0) {
      const target = (phase + x0 + y0) & 1;
      for (let y = y0; y < y0 + h; y++)
        for (let x = x0; x < x0 + w; x++)
          if (((x + y) & 1) === target && x >= 0 && x < S.BW && y >= 0 && y < S.BH)
            S.buf[y * S.BW + x] = c ? 1 : 0;
    },
  };
});

import { drawKeyGlyph } from "@/app/roll/roll.js";

const OW = 10; // ASCII のキー幅 (左枠1 + 白1 + 内部5 + 白1 + 右枠2)
function render(kind, oh = 8, tb = 1) {
  S.BW = OW;
  S.BH = oh;
  S.buf = new Uint8Array(OW * oh);
  drawKeyGlyph(0, 0, OW, oh, tb, kind);
}
const at = (x, y) => S.buf[y * S.BW + x];

describe("drawKeyGlyph — 枠 (全種共通)", () => {
  it("左枠 1px・右枠 2px (小節線)・上枠 tb がすべて黒", () => {
    render("white", 8, 1);
    for (let y = 0; y < 8; y++) {
      expect(at(0, y)).toBe(1); // 左枠 1px
      expect(at(8, y)).toBe(1); // 右枠 2px (col8)
      expect(at(9, y)).toBe(1); // 右枠 2px (col9)
    }
    for (let x = 0; x < OW; x++) expect(at(x, 0)).toBe(1); // 上枠 (tb=1)
  });

  it("上枠 tb=2 (オクターブ境界) は 2 行黒", () => {
    render("white", 9, 2);
    for (let x = 1; x < 8; x++) {
      expect(at(x, 0)).toBe(1);
      expect(at(x, 1)).toBe(1); // 2px 上枠
      expect(at(x, 2)).toBe(0); // その下は内側 (白)
    }
  });
});

describe("drawKeyGlyph — 白鍵", () => {
  it("内部 (枠の内側) が白で、黒塗りが無い", () => {
    render("white", 8, 1);
    for (let y = 1; y <= 7; y++)
      for (let x = 1; x <= 7; x++) expect(at(x, y)).toBe(0); // 内側は全て白
  });
});

describe("drawKeyGlyph — 黒鍵", () => {
  it("白 1px 余白の内側 (cols2-6) が黒塗り、周囲は白余白", () => {
    render("black", 8, 1); // 内側 rows1-7 / fill rows2-6, cols2-6
    // 白余白 (fill の外周 1px)
    for (let x = 1; x <= 7; x++) expect(at(x, 1)).toBe(0); // 上の白余白
    for (let y = 2; y <= 6; y++) {
      expect(at(1, y)).toBe(0); // 左の白余白
      expect(at(7, y)).toBe(0); // 右の白余白
    }
    // 黒塗り本体 (cols2-6, rows2-6)
    for (let y = 2; y <= 6; y++)
      for (let x = 2; x <= 6; x++) expect(at(x, y)).toBe(1);
  });
});

describe("drawKeyGlyph — 押下 (市松)", () => {
  it("内部が市松で四隅が黒 (位相は原点基準で不変)", () => {
    render("pressed", 8, 1); // fill rows2-6, cols2-6 (5x5)
    // 四隅は黒
    expect(at(2, 2)).toBe(1);
    expect(at(6, 2)).toBe(1);
    expect(at(2, 6)).toBe(1);
    expect(at(6, 6)).toBe(1);
    // 市松なので隣は白 (row2: #.#.#)
    expect(at(3, 2)).toBe(0);
    expect(at(4, 2)).toBe(1);
    expect(at(5, 2)).toBe(0);
    // row3 は 1 つずれる (.#.#.)
    expect(at(2, 3)).toBe(0);
    expect(at(3, 3)).toBe(1);
  });

  it("偶数寸法でも四隅は黒に補正される (ズーム倍率非依存)", () => {
    render("pressed", 9, 1); // fill rows2-7 (fh=6, 偶数), cols2-6
    expect(at(2, 2)).toBe(1);
    expect(at(6, 2)).toBe(1);
    expect(at(2, 7)).toBe(1); // 下辺 (偶数寸法でも黒へ補正)
    expect(at(6, 7)).toBe(1);
  });
});
