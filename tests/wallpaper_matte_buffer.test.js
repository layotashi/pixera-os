/**
 * wallpaper.js — renderWallpaperBuffer (CAPTURE のマット/額装用) テスト。
 *
 * drawWallpaper() が VRAM を直接更新するのに対し、renderWallpaperBuffer(w,h) は
 * 任意サイズの新規 1-bit バッファを返す (デスクトップ描画状態は変更しない)。
 * CAPTURE はこれを「ウィンドウ周囲の余白 (額装)」として敷き、対象を中央に置く。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const _vram = new Uint8Array(24); // 6x4 — 非破壊性の検出専用

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
  loadBgImageFillBit: () => 1,
  loadBgMode: () => null,
  loadBgImagePath: () => null,
  loadBgTessSource: () => null,
  saveBgMode: () => {},
  saveBgTessSource: () => {},
  saveSolidLevel: () => {},
  saveSolidBayerMode: () => {},
  saveBgImageFillBit: () => {},
  saveBgImagePath: () => {},
}));

async function loadWallpaperModule() {
  vi.resetModules();
  return import("@/wallpaper.js");
}

describe("renderWallpaperBuffer (CAPTURE マット用)", () => {
  beforeEach(() => _vram.fill(9)); // VRAM を 0/1 以外で汚し、非破壊性を検出可能に

  it("solid: level 0 は全 0、最大階調は全 1 (任意サイズ)", async () => {
    const { initWallpaper, setSolidLevel, renderWallpaperBuffer } =
      await loadWallpaperModule();
    await initWallpaper();

    setSolidLevel(0);
    const zero = renderWallpaperBuffer(10, 3);
    expect(zero.length).toBe(30);
    expect(Array.from(zero).every((b) => b === 0)).toBe(true);

    setSolidLevel(16);
    const one = renderWallpaperBuffer(10, 3);
    expect(Array.from(one).every((b) => b === 1)).toBe(true);
  });

  it("solid: 中間階調は 4x4 周期でタイルする (VRAM 幅に依存しない)", async () => {
    const { initWallpaper, setSolidLevel, renderWallpaperBuffer } =
      await loadWallpaperModule();
    await initWallpaper();
    setSolidLevel(8);

    const w = 9;
    const h = 5;
    const buf = renderWallpaperBuffer(w, h);
    expect(buf.length).toBe(w * h);
    // Bayer タイルは x/y ともに 4px 周期
    for (let y = 0; y < h; y++) {
      for (let x = 0; x + 4 < w; x++) {
        expect(buf[y * w + x]).toBe(buf[y * w + x + 4]);
      }
    }
    for (let y = 0; y + 4 < h; y++) {
      for (let x = 0; x < w; x++) {
        expect(buf[y * w + x]).toBe(buf[(y + 4) * w + x]);
      }
    }
    // 中間階調なので 0 と 1 が混在する
    expect(buf.includes(0)).toBe(true);
    expect(buf.includes(1)).toBe(true);
  });

  it("image: マットは下地ビット (fillBit) で一様に塗る", async () => {
    const {
      initWallpaper,
      setBackgroundMode,
      setImageFillBit,
      renderWallpaperBuffer,
    } = await loadWallpaperModule();
    await initWallpaper();
    setBackgroundMode("image");

    setImageFillBit(1);
    expect(Array.from(renderWallpaperBuffer(7, 3)).every((b) => b === 1)).toBe(
      true,
    );

    setImageFillBit(0);
    expect(Array.from(renderWallpaperBuffer(7, 3)).every((b) => b === 0)).toBe(
      true,
    );
  });

  it("tessera: 任意サイズにネイティブ再評価する (水平グラデ x は左端 0・右端 1)", async () => {
    const { initWallpaper, setTessSource, renderWallpaperBuffer } =
      await loadWallpaperModule();
    await initWallpaper();
    expect(setTessSource("canvas: 100x100\nx")).toBe(true);

    const w = 8;
    const h = 4;
    const buf = renderWallpaperBuffer(w, h);
    expect(buf.length).toBe(w * h);
    for (let y = 0; y < h; y++) {
      expect(buf[y * w + 0]).toBe(0); // x≈0
      expect(buf[y * w + (w - 1)]).toBe(1); // x≈1
    }
  });

  it("デスクトップ描画バッファ (VRAM) を変更しない", async () => {
    const { initWallpaper, setSolidLevel, renderWallpaperBuffer } =
      await loadWallpaperModule();
    await initWallpaper();
    setSolidLevel(8);

    renderWallpaperBuffer(12, 6);
    // _vram は beforeEach で 9 埋め。renderWallpaperBuffer は触れないはず
    expect(Array.from(_vram).every((b) => b === 9)).toBe(true);
  });
});
