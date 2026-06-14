/**
 * core/pixel_grid.js — 表示エフェクト (Vignette + Diagonal scanline) のテスト。
 *
 * 注: 旧 Pixel Grid (CELL=3) / Glow / Noise は撤廃済み (BACKLOG 参照)。
 * ファイル名は移行期のため pixel_grid.test.js のまま。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  rebuildLut,
  applyVramRgba,
  applyVramIndexed,
  getDisplayPalette,
  applyVignette,
  setDiagEnabled,
} from "@/core/pixel_grid.js";

const FG = [0x33, 0xff, 0x00]; // P1 Green
const BG = [0x00, 0x12, 0x00];

beforeEach(() => {
  setDiagEnabled(true);
  rebuildLut(FG, BG);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  applyVramRgba — 1:1 RGBA 展開
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("applyVramRgba", () => {
  it("出力サイズが VRAM と同じ (CELL 拡大なし)", () => {
    const w = 4,
      h = 3;
    const vram = new Uint8Array(w * h);
    const out = new Uint32Array(w * h);
    applyVramRgba(out, vram, w, h, 0);
    expect(out.length).toBe(w * h);
  });

  it("全消灯 VRAM に fg ドット色は含まれない", () => {
    const w = 4,
      h = 4;
    const vram = new Uint8Array(w * h);
    const out = new Uint32Array(w * h);
    applyVramRgba(out, vram, w, h, 0);
    const fgPacked = FG[0] | (FG[1] << 8) | (FG[2] << 16) | 0xff000000;
    for (let i = 0; i < out.length; i++) {
      expect(out[i] >>> 0).not.toBe(fgPacked >>> 0);
    }
  });

  it("全点灯 VRAM に bg ドット色は含まれない", () => {
    const w = 4,
      h = 4;
    const vram = new Uint8Array(w * h).fill(1);
    const out = new Uint32Array(w * h);
    applyVramRgba(out, vram, w, h, 0);
    const bgPacked = BG[0] | (BG[1] << 8) | (BG[2] << 16) | 0xff000000;
    for (let i = 0; i < out.length; i++) {
      expect(out[i] >>> 0).not.toBe(bgPacked >>> 0);
    }
  });

  it("VRAM 値 0 はドット位置で bg 色になる", () => {
    const w = 1,
      h = 1;
    const vram = new Uint8Array([0]);
    const out = new Uint32Array(1);
    // diagOff を 1000 にして dh[base]=0 (斜線なし) になる位置にする
    setDiagEnabled(false);
    rebuildLut(FG, BG);
    applyVramRgba(out, vram, w, h, 0);
    const bgPacked = (BG[0] | (BG[1] << 8) | (BG[2] << 16) | 0xff000000) >>> 0;
    expect(out[0] >>> 0).toBe(bgPacked);
  });

  it("VRAM 値 1 はドット位置で fg 色になる", () => {
    const w = 1,
      h = 1;
    const vram = new Uint8Array([1]);
    const out = new Uint32Array(1);
    setDiagEnabled(false);
    rebuildLut(FG, BG);
    applyVramRgba(out, vram, w, h, 0);
    const fgPacked = (FG[0] | (FG[1] << 8) | (FG[2] << 16) | 0xff000000) >>> 0;
    expect(out[0] >>> 0).toBe(fgPacked);
  });

  it("diagOff の変更で出力が変わる (Diagonal ON 時)", () => {
    const w = 16,
      h = 16;
    const vram = new Uint8Array(w * h).fill(1);
    const out1 = new Uint32Array(w * h);
    const out2 = new Uint32Array(w * h);
    applyVramRgba(out1, vram, w, h, 0);
    applyVramRgba(out2, vram, w, h, 3);
    let diffs = 0;
    for (let i = 0; i < out1.length; i++) {
      if (out1[i] !== out2[i]) diffs++;
    }
    expect(diffs).toBeGreaterThan(0);
  });

  it("Diagonal OFF 時は diagOff を変えても出力が変わらない", () => {
    setDiagEnabled(false);
    rebuildLut(FG, BG);
    const w = 16,
      h = 16;
    const vram = new Uint8Array(w * h).fill(1);
    const out1 = new Uint32Array(w * h);
    const out2 = new Uint32Array(w * h);
    applyVramRgba(out1, vram, w, h, 0);
    applyVramRgba(out2, vram, w, h, 7);
    for (let i = 0; i < out1.length; i++) {
      expect(out1[i]).toBe(out2[i]);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  applyVramIndexed (GIF 経路)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("applyVramIndexed", () => {
  it("出力サイズが VRAM と同じ", () => {
    const w = 8,
      h = 6;
    const vram = new Uint8Array(w * h);
    const result = applyVramIndexed(vram, w, h, 0);
    expect(result.width).toBe(w);
    expect(result.height).toBe(h);
    expect(result.data.length).toBe(w * h);
  });

  it("出力値が 0-3 の範囲内 (4 色 indexed)", () => {
    const w = 8,
      h = 6;
    const vram = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) vram[i] = i & 1;
    const result = applyVramIndexed(vram, w, h, 5);
    for (let i = 0; i < result.data.length; i++) {
      expect(result.data[i]).toBeGreaterThanOrEqual(0);
      expect(result.data[i]).toBeLessThanOrEqual(3);
    }
  });

  it("Diagonal OFF 時は出力が v ∈ {0, 1} に収まる", () => {
    setDiagEnabled(false);
    rebuildLut(FG, BG);
    const w = 8,
      h = 6;
    const vram = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) vram[i] = i & 1;
    const result = applyVramIndexed(vram, w, h, 0);
    // 斜線インデックス (2, 3) が出ないとは限らない (gap も無いので)。
    // ただし LUT 上 2=bg, 3=fg なので、palette 解決後は 2 色のみ。
    const pal = getDisplayPalette(FG, BG);
    expect(pal[2]).toEqual(BG);
    expect(pal[3]).toEqual(FG);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  getDisplayPalette (4 色 GIF パレット)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("getDisplayPalette", () => {
  it("4 エントリを返す", () => {
    const pal = getDisplayPalette(FG, BG);
    expect(pal.length).toBe(4);
  });

  it("各エントリが [R, G, B] の 3 要素配列", () => {
    const pal = getDisplayPalette(FG, BG);
    for (const entry of pal) {
      expect(entry.length).toBe(3);
      for (const ch of entry) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(255);
      }
    }
  });

  it("index 0 は bg 色", () => {
    const pal = getDisplayPalette(FG, BG);
    expect(pal[0]).toEqual(BG);
  });

  it("index 1 は fg 色", () => {
    const pal = getDisplayPalette(FG, BG);
    expect(pal[1]).toEqual(FG);
  });

  it("index 2 は bg + diag 暗化", () => {
    const pal = getDisplayPalette(FG, BG);
    // BG=[0,18,0], diagDarkness=0.20, dm=0.80 → [0, round(18*0.80), 0] = [0, 14, 0]
    expect(pal[2][0]).toBe(0);
    expect(pal[2][1]).toBeLessThan(BG[1]);
    expect(pal[2][2]).toBe(0);
  });

  it("index 3 は fg + diag 暗化", () => {
    const pal = getDisplayPalette(FG, BG);
    expect(pal[3][1]).toBeLessThan(FG[1]);
  });

  it("Diagonal OFF 時は 2/3 が 0/1 と同じになる", () => {
    setDiagEnabled(false);
    const pal = getDisplayPalette(FG, BG);
    expect(pal[2]).toEqual(BG);
    expect(pal[3]).toEqual(FG);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  applyVignette
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("applyVignette", () => {
  it("中心付近のピクセルは変化しない", () => {
    const w = 101,
      h = 101;
    const pixels = new Uint8Array(w * h * 4);
    const cx = 50,
      cy = 50;
    const idx = (cy * w + cx) * 4;
    pixels[idx] = 255;
    pixels[idx + 1] = 255;
    pixels[idx + 2] = 255;
    pixels[idx + 3] = 255;
    applyVignette(pixels, w, h);
    expect(pixels[idx]).toBe(255);
    expect(pixels[idx + 1]).toBe(255);
    expect(pixels[idx + 2]).toBe(255);
  });

  it("角のピクセルは暗化される", () => {
    const w = 100,
      h = 100;
    const pixels = new Uint8Array(w * h * 4);
    for (const [x, y] of [
      [0, 0],
      [99, 0],
      [0, 99],
      [99, 99],
    ]) {
      const idx = (y * w + x) * 4;
      pixels[idx] = 255;
      pixels[idx + 1] = 255;
      pixels[idx + 2] = 255;
      pixels[idx + 3] = 255;
    }
    applyVignette(pixels, w, h);
    for (const [x, y] of [
      [0, 0],
      [99, 0],
      [0, 99],
      [99, 99],
    ]) {
      const idx = (y * w + x) * 4;
      expect(pixels[idx]).toBeLessThan(255);
    }
  });

  it("アルファチャンネルは変更されない", () => {
    const w = 10,
      h = 10;
    const pixels = new Uint8Array(w * h * 4);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    applyVignette(pixels, w, h);
    for (let i = 3; i < pixels.length; i += 4) {
      expect(pixels[i]).toBe(255);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  rebuildLut (パレット切替)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("rebuildLut", () => {
  it("パレット変更に追従する", () => {
    const w = 2,
      h = 2;
    const vram = new Uint8Array(w * h).fill(1);
    const out1 = new Uint32Array(w * h);
    rebuildLut(FG, BG);
    applyVramRgba(out1, vram, w, h, 0);

    const newFg = [0xff, 0x00, 0x00];
    const newBg = [0x00, 0x00, 0xff];
    rebuildLut(newFg, newBg);
    const out2 = new Uint32Array(w * h);
    applyVramRgba(out2, vram, w, h, 0);

    let diffs = 0;
    for (let i = 0; i < out1.length; i++) {
      if (out1[i] !== out2[i]) diffs++;
    }
    expect(diffs).toBeGreaterThan(0);
  });
});
