/**
 * wm/menu.js — メニューツリー構築のテスト (characterization)
 *
 * buildMenuTree(registry) の dev/hidden/modal 除外・カテゴリ階層化・並び順を
 * 検証する。B-1 で menu.js を wm.js から分離した際の挙動不変の安全網。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── DEV_MODE をテストから可変にするための保持変数 ──
let _devMode = false;

vi.mock("@/config.js", () => ({
  get DEV_MODE() {
    return _devMode;
  },
  VRAM_WIDTH: 480,
  VRAM_HEIGHT: 360,
}));

// ── 描画系は buildMenuTree では未使用 (モジュール読込のためモック) ──
vi.mock("@/core/gpu.js", () => ({
  fillRoundRect: vi.fn(),
  drawRoundRect: vi.fn(),
  fillRect: vi.fn(),
  hline: vi.fn(),
}));
vi.mock("@/core/font.js", () => ({
  drawText: vi.fn(),
  GLYPH_W: 5,
  GLYPH_H: 7,
}));
vi.mock("@/core/icon.js", () => ({
  drawIcon: vi.fn(),
  ICON_W: 8,
  ICON_H: 8,
}));

import { buildMenuTree } from "@/wm/menu.js";

/** エントリ生成ヘルパ */
function entry(name, opts = {}) {
  return { name, winId: null, category: null, ...opts };
}

/** items からトップレベルの app 名 / sub ラベル / sep を平坦化 */
function shape(items) {
  return items.map((it) =>
    it.type === "sep"
      ? "---"
      : it.type === "sub"
        ? `[${it.label}]`
        : it.entry.name,
  );
}

beforeEach(() => {
  _devMode = false;
});

describe("buildMenuTree", () => {
  it("hidden エントリはメニューから除外される", () => {
    const reg = [entry("ALPHA"), entry("SECRET", { hidden: true })];
    expect(shape(buildMenuTree(reg))).toEqual(["ALPHA"]);
  });

  it("dev エントリは DEV_MODE=false で除外される", () => {
    const reg = [entry("ALPHA"), entry("DEVTOOL", { dev: true })];
    expect(shape(buildMenuTree(reg))).toEqual(["ALPHA"]);
  });

  it("dev エントリは DEV_MODE=true で表示される (アルファベット順)", () => {
    _devMode = true;
    const reg = [entry("ZED"), entry("DEVTOOL", { dev: true })];
    expect(shape(buildMenuTree(reg))).toEqual(["DEVTOOL", "ZED"]);
  });

  it("非階層アプリはアルファベット順に並ぶ", () => {
    const reg = [entry("CHARLIE"), entry("ALPHA"), entry("BRAVO")];
    expect(shape(buildMenuTree(reg))).toEqual(["ALPHA", "BRAVO", "CHARLIE"]);
  });

  it("category はサブメニューになり、アプリの後にセパレーター区切りで並ぶ", () => {
    const reg = [
      entry("ROOTAPP"),
      entry("PAINT", { category: "CREATIVE" }),
      entry("TESSERA", { category: "CREATIVE" }),
    ];
    const items = buildMenuTree(reg);
    expect(shape(items)).toEqual(["ROOTAPP", "---", "[CREATIVE]"]);
    // サブメニュー内はアルファベット順
    const sub = items.find((it) => it.type === "sub");
    expect(sub.children.map((c) => c.entry.name)).toEqual(["PAINT", "TESSERA"]);
  });

  it("category は > で N 階層にネストする", () => {
    const reg = [entry("BREAK", { category: "GAMES>ARCADE" })];
    const items = buildMenuTree(reg);
    const games = items.find((it) => it.type === "sub");
    expect(games.label).toBe("GAMES");
    const arcade = games.children.find((c) => c.type === "sub");
    expect(arcade.label).toBe("ARCADE");
    expect(arcade.children[0].entry.name).toBe("BREAK");
  });

  it("modal エントリはセパレーター付きで末尾に置かれる", () => {
    const reg = [entry("ALPHA"), entry("DIALOG", { modal: true })];
    expect(shape(buildMenuTree(reg))).toEqual(["ALPHA", "---", "DIALOG"]);
  });

  it("production サブメニューは dev 専用サブメニューより前に並ぶ", () => {
    _devMode = true;
    const reg = [
      entry("EXP", { category: "LAB", dev: true }),
      entry("PAINT", { category: "CREATIVE" }),
    ];
    // CREATIVE (production) → sep → LAB (all-dev) の順
    expect(shape(buildMenuTree(reg))).toEqual(["[CREATIVE]", "---", "[LAB]"]);
  });

  it("空レジストリは空配列を返す", () => {
    expect(buildMenuTree([])).toEqual([]);
  });
});
