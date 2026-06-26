/**
 * wallpaper.js — 画像背景の未カバー領域 fill テスト
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const _vram = new Uint8Array(16);
const _files = new Map();

let _savedBgMode = null;
let _savedBgImagePath = null;
let _savedBgImageFillBit = null;
let _loadedBgMode = null;
let _loadedBgImagePath = null;
let _loadedBgImageFillBit = null;

vi.mock("@/config.js", () => ({
  VRAM_WIDTH: 4,
  VRAM_HEIGHT: 4,
  onResize: () => {},
}));

vi.mock("@/core/gpu.js", () => ({
  vram: _vram,
}));

vi.mock("@/core/vfs.js", () => ({
  readFile: (path) => _files.get(path) ?? null,
}));

vi.mock("@/core/storage.js", () => ({
  loadSolidBayerMode: () => null,
  loadSolidLevel: () => null,
  loadBgMode: () => _loadedBgMode,
  loadBgImagePath: () => _loadedBgImagePath,
  loadBgImageFillBit: () => _loadedBgImageFillBit,
  saveBgMode: (mode) => {
    _savedBgMode = mode;
  },
  saveBgImagePath: (path) => {
    _savedBgImagePath = path;
  },
  saveBgImageFillBit: (bit) => {
    _savedBgImageFillBit = bit;
  },
  saveSolidLevel: () => {},
  saveSolidBayerMode: () => {},
}));

async function loadWallpaperModule() {
  vi.resetModules();
  return import("@/wallpaper.js");
}

function resetState() {
  _vram.fill(0);
  _files.clear();
  _savedBgMode = null;
  _savedBgImagePath = null;
  _savedBgImageFillBit = null;
  _loadedBgMode = null;
  _loadedBgImagePath = null;
  _loadedBgImageFillBit = null;
}

describe("image wallpaper fill bit", () => {
  beforeEach(resetState);

  it("Image 背景で画像が覆わない領域を fill bit で埋める", async () => {
    _loadedBgMode = "image";
    _loadedBgImagePath = "/Pictures/Wallpapers/test.pbm";
    _loadedBgImageFillBit = 1;
    _files.set(_loadedBgImagePath, "P1\n2 2\n1 0\n0 1\n");

    const { initWallpaper, drawWallpaper } = await loadWallpaperModule();
    await initWallpaper();
    drawWallpaper();

    expect(Array.from(_vram)).toEqual([
      1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1,
    ]);
  });

  it("fill bit を切り替えると保存し、既存画像の未カバー領域も更新する", async () => {
    _loadedBgMode = "image";
    _loadedBgImagePath = "/Pictures/Wallpapers/test.pbm";
    _loadedBgImageFillBit = 1;
    _files.set(_loadedBgImagePath, "P1\n2 2\n1 0\n0 1\n");

    const { initWallpaper, drawWallpaper, setImageFillBit, getImageFillBit } =
      await loadWallpaperModule();
    await initWallpaper();
    setImageFillBit(0);
    drawWallpaper();

    expect(getImageFillBit()).toBe(0);
    expect(_savedBgImageFillBit).toBe(0);
    expect(Array.from(_vram)).toEqual([
      0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0,
    ]);
  });
});
