/**
 * wallpaper (tessera) — 常に画面いっぱい (Fill) で描くことのテスト。
 *
 * 壁紙の .tess は canvas の縦横比を無視し、画面解像度・アスペクトで場を再評価する
 * (レターボックス/マット無し)。非正方 VRAM (6x4) に 1:1 canvas の水平グラデ `x` を
 * 敷くと、旧「内接 (contain)」なら左右にマット列が残るが、Fill では全幅に x∈[0,1] が
 * 展開される。左端列 (x≈0) が全 0・右端列 (x≈1) が全 1 で、マット列が無いことを検証する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const _vram = new Uint8Array(24); // 6x4

vi.mock("@/config.js", () => ({
  VRAM_WIDTH: 6,
  VRAM_HEIGHT: 4,
  onResize: () => {},
}));

vi.mock("@/core/gpu.js", () => ({
  vram: _vram,
}));

vi.mock("@/core/vfs.js", () => ({
  readFile: () => null,
}));

vi.mock("@/core/storage.js", () => ({
  loadSolidBayerMode: () => null,
  loadSolidLevel: () => null,
  loadBgImageFillBit: () => 1, // マットが仮にあれば 1 (全 1) で残るので、その不在を検出できる
  loadBgMode: () => null, // init は solid のまま。tessera は setTessSource で明示的に敷く
  loadBgImagePath: () => null,
  loadBgTessSource: () => null,
  saveBgMode: () => {},
  saveBgTessSource: () => {},
  saveSolidLevel: () => {},
  saveSolidBayerMode: () => {},
}));

async function loadWallpaperModule() {
  vi.resetModules();
  return import("@/wallpaper.js");
}

describe("tessera wallpaper は常に画面いっぱい (Fill)", () => {
  beforeEach(() => _vram.fill(9)); // 未描画を検出できるよう 0/1 以外で汚しておく

  it("非正方 VRAM に 1:1 canvas の水平グラデを全幅展開する (左右マット無し)", async () => {
    const { initWallpaper, setTessSource, drawWallpaper } =
      await loadWallpaperModule();
    await initWallpaper();
    // canvas は 1:1 だが Fill なので 6x4 全体へ x∈[0,1] を敷く (dither size 2 既定)。
    expect(setTessSource("canvas: 100x100\nx")).toBe(true);
    drawWallpaper();

    // 列ごとの nx = 0, .2, .4, .6, .8, 1.0 を 2x2 Bayer でしきい値化した全 24 ビット。
    // prettier-ignore
    expect(Array.from(_vram)).toEqual([
      0, 0, 1, 0, 1, 1,
      0, 0, 0, 1, 0, 1,
      0, 0, 1, 0, 1, 1,
      0, 0, 0, 1, 0, 1,
    ]);
  });
});
