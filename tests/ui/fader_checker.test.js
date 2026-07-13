/**
 * tests/ui/fader_checker.test.js — Fader の市松地の四隅位相が揃うことを検証する。
 *
 * 回帰防止: 高さの偶奇に依らず、四隅 (右上・左上・右下・左下) の市松位相が一致すること。
 * gpu.drawCheckerboard を忠実に再現したピクセルバッファに実物の draw() を描いて確かめる。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initPorts } from "@/ui/index.js";
import { Fader, FADER_W } from "@/ui/music/index.js";

let buf, BW, BH;
const at = (x, y) => buf[y * BW + x];

beforeAll(() => {
  initPorts({
    gpu: {
      fillRect(x, y, w, h, c) {
        for (let j = y; j < y + h; j++)
          for (let i = x; i < x + w; i++)
            if (i >= 0 && i < BW && j >= 0 && j < BH) buf[j * BW + i] = c ? 1 : 0;
      },
      drawRect(x, y, w, h, c) {
        for (let i = x; i < x + w; i++) {
          if (i >= 0 && i < BW) {
            if (y >= 0 && y < BH) buf[y * BW + i] = c;
            if (y + h - 1 >= 0 && y + h - 1 < BH) buf[(y + h - 1) * BW + i] = c;
          }
        }
        for (let j = y; j < y + h; j++) {
          if (j >= 0 && j < BH) {
            if (x >= 0 && x < BW) buf[j * BW + x] = c;
            if (x + w - 1 >= 0 && x + w - 1 < BW) buf[j * BW + x + w - 1] = c;
          }
        }
      },
      // gpu.js の drawCheckerboard を忠実に再現
      drawCheckerboard(x0, y0, w, h, c, phase = 0) {
        const target = (phase + x0 + y0) & 1;
        for (let y = y0; y < y0 + h; y++)
          for (let x = x0; x < x0 + w; x++)
            if (((x + y) & 1) === target && x >= 0 && x < BW && y >= 0 && y < BH)
              buf[y * BW + x] = c ? 1 : 0;
      },
      drawRoundRect() {},
      hline(x1, x2, y, c) {
        for (let x = x1; x <= x2; x++)
          if (x >= 0 && x < BW && y >= 0 && y < BH) buf[y * BW + x] = c;
      },
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

/** 実効高 (奇数化) */
const effH = (H) => (H & 1 ? H : H - 1);

/** 高さ H (value) のフェーダーを (0,0) に描き、バッファを更新する */
function render(H, value = 50) {
  BW = FADER_W;
  BH = H;
  buf = new Uint8Array(BW * BH);
  new Fader(0, 0, H, 0, 100, value, null).draw({ x: 0, y: 0 });
}

/** 市松の四隅ピクセル (枠 1px + マージン 1px の内側 = 2px インセット。実効高で下辺を測る) */
function cornerPhases(H) {
  render(H);
  const he = effH(H);
  return {
    tl: at(2, 2),
    tr: at(FADER_W - 3, 2),
    bl: at(2, he - 3),
    br: at(FADER_W - 3, he - 3),
  };
}

describe("Fader 市松の四隅位相", () => {
  for (const H of [72, 44, 60, 61]) {
    it(`高さ ${H}: 四隅の位相が揃う`, () => {
      const c = cornerPhases(H);
      expect(c.bl).toBe(c.tl); // 左下 = 左上
      expect(c.br).toBe(c.tr); // 右下 = 右上
      expect(c.tr).toBe(c.tl); // 上辺同士も一致 (全隅同相)
    });
  }

  it("枠と地の間に 1px の背景マージンがあり市松が枠に接しない", () => {
    // 枠 (x=0, x=FADER_W-1) の 1px 内側 (x=1, FADER_W-2) は常に背景であること
    const H = 72;
    render(H, 50);
    const he = effH(H);
    for (let y = 2; y < he - 2; y++) {
      expect(at(1, y)).toBe(0); // 左マージン
      expect(at(FADER_W - 2, y)).toBe(0); // 右マージン
    }
  });

  it("継ぎ目がない (連続した市松): 隣接行で同じ列が二重に点かない", () => {
    // つまみを上端 (value=max) に退避し、その下の市松を全行チェックする
    const H = 72;
    render(H, 100);
    const he = effH(H);
    const x = 2; // マージンの内側・グルーヴ (中央) を避けた市松列
    // つまみ (上端マージン込み 12px) の下から下枠の手前まで
    for (let y = 13; y < he - 2; y++) {
      expect(at(x, y)).not.toBe(at(x, y + 1)); // 継ぎ目 = 二重行があると失敗
    }
  });
});
