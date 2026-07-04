/**
 * core/tess_host.js — Tessera ディレクティブ解決のテスト
 *
 * resolveTessConfig / resolveView の既定値・クランプ・fps スナップ・
 * view フォールバックを検証する。tessera プレビュー/書き出しと壁紙が同一の
 * 実効設定になることの安全網 (B-3)。
 */
import { describe, it, expect } from "vitest";
import {
  resolveTessConfig,
  resolveView,
  TAU,
  PERIOD_CAP_S,
  MODE_PARAMS,
} from "@/core/tess_host.js";

describe("resolveTessConfig 既定値", () => {
  it("空 config は既定へ倒れる", () => {
    const r = resolveTessConfig({});
    expect(r.sizeW).toBe(1080);
    expect(r.sizeH).toBe(1080);
    expect(r.pixel).toBe(8);
    expect(r.pad).toBe(80);
    expect(r.fps).toBe(20);
    expect(r.seed).toBe(0);
    expect(r.period).toBe(TAU);
    expect(r.aspect).toBe(1);
    expect(r.viewMode).toBe("dither");
  });
});

describe("resolveTessConfig クランプ", () => {
  it("canvas は 16..4096 にクランプ", () => {
    expect(resolveTessConfig({ canvas: { w: 10000, h: 5 } }).sizeW).toBe(4096);
    expect(resolveTessConfig({ canvas: { w: 10000, h: 5 } }).sizeH).toBe(16);
  });

  it("seed は 0..999999 にクランプ", () => {
    expect(resolveTessConfig({ seed: -5 }).seed).toBe(0);
    expect(resolveTessConfig({ seed: 2000000 }).seed).toBe(999999);
  });

  it("period は 0.1..PERIOD_CAP_S にクランプ", () => {
    expect(resolveTessConfig({ period: 100 }).period).toBe(PERIOD_CAP_S);
    expect(resolveTessConfig({ period: 0.01 }).period).toBeCloseTo(0.1);
  });

  it("pad は各辺がアートを潰さない範囲にクランプ", () => {
    // canvas 128 → base 16、pad は各辺 art≥4 を残すため padMax=(16-4)/2*8=48
    const r = resolveTessConfig({ canvas: { w: 128, h: 128 }, pad: 9999 });
    expect(r.pad).toBe(48);
  });
});

describe("resolveTessConfig fps スナップ", () => {
  it("最も近い候補にスナップ", () => {
    expect(resolveTessConfig({ fps: 17 }).fps).toBe(20);
    expect(resolveTessConfig({ fps: 7 }).fps).toBe(5);
    expect(resolveTessConfig({ fps: 40 }).fps).toBe(50);
  });
});

describe("resolveTessConfig aspect", () => {
  it("clamp 後の sizeW/sizeH 比で算出", () => {
    expect(resolveTessConfig({ canvas: { w: 1920, h: 1080 } }).aspect).toBeCloseTo(
      1920 / 1080,
    );
  });
});

describe("resolveView", () => {
  it("view 無しは dither + 既定パラメータ", () => {
    const v = resolveView(undefined);
    expect(v.mode).toBe("dither");
    expect(v.params).toEqual(MODE_PARAMS);
  });

  it("field_render 方式は args[0] をパラメータへ写す", () => {
    const v = resolveView({ mode: "hatch", args: [8] });
    expect(v.mode).toBe("hatch");
    expect(v.params.hatchPitch).toBe(8);
  });

  it("braille は ditherSize を使う", () => {
    const v = resolveView({ mode: "braille", args: [3] });
    expect(v.mode).toBe("braille");
    expect(v.params.ditherSize).toBe(3);
  });

  it("field_render 外の mode (ascii) は dither へフォールバック", () => {
    expect(resolveView({ mode: "ascii", args: [] }).mode).toBe("dither");
  });

  it("既定 MODE_PARAMS を破壊しない (コピーを返す)", () => {
    resolveView({ mode: "hatch", args: [99] });
    expect(MODE_PARAMS.hatchPitch).toBe(4);
  });
});
