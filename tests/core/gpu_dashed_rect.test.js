/**
 * core/gpu.js — drawDashedRect (ラバーバンド/マーキーの破線矩形) のジオメトリ検証
 *
 * 仕様 (ROLL / デスクトップ共通): 3px 実線 + 3px 空白の 6px 周期ダッシュ。線は 1px の
 * 前景色 (黒=1)、各実線ぶんを 1px の背景色 (白=0) ハローで囲う。空白部は描かない (透過)。
 * アニメーション・色反転なし。実バッファ (vram) へ描いて pget で 1 ピクセルずつ検証する。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { drawDashedRect, fillRect, pget } from "@/core/gpu.js";

/** 検証領域 (角から離れた上辺の 2 本目のダッシュ周辺) を背景色 v で塗る */
function fillBg(v) {
  fillRect(0, 0, 80, 60, v);
}

describe("drawDashedRect — 破線マーキーのジオメトリ", () => {
  // 角の影響を避けるため十分に広い矩形。左上 = (10,10)。
  // 上辺の黒ダッシュは x=10,16,22,... (周期 6, 各 3px)。2 本目 = x16..18 (内部)。
  const draw = () => drawDashedRect(10, 10, 40, 25);

  it("黒の実線は 3px・線の行 (y=10) に乗る", () => {
    fillBg(0);
    draw();
    // 2 本目のダッシュ = x16,17,18 が黒 (=1)
    expect(pget(16, 10)).toBe(1);
    expect(pget(17, 10)).toBe(1);
    expect(pget(18, 10)).toBe(1);
    // ダッシュの外 (線の行より 2px 上) は描かれない
    expect(pget(16, 8)).toBe(0);
  });

  it("各実線を白 (0) ハローが囲む", () => {
    fillBg(1); // 背景を全て黒に → 白ハロー (0) が明確に判別できる
    draw();
    // 黒の実線は残る (=1)
    expect(pget(16, 10)).toBe(1);
    // 上下のハロー (線の 1px 外周) は白 (=0)
    expect(pget(16, 9)).toBe(0);
    expect(pget(16, 11)).toBe(0);
    // 左右のハロー (実線 x16..18 の 1px 外) も白 (=0)
    expect(pget(15, 10)).toBe(0);
    expect(pget(19, 10)).toBe(0);
  });

  it("空白 (3px 間隔の中央) は透過 = 背景がそのまま残る", () => {
    fillBg(1);
    draw();
    // 隣り合うダッシュ (x10 と x16, x16 と x22) のハローの間 1px は透過。
    // x14 (ハロー x9..13 と x15..19 の間), x20 (x15..19 と x21..25 の間)。
    expect(pget(14, 10)).toBe(1);
    expect(pget(20, 10)).toBe(1);
    // ハローの外側 (線から 2px 離れた行) も透過
    expect(pget(16, 12)).toBe(1);
  });

  it("左辺にも縦の破線 (1px 幅・3px 長) が出る", () => {
    fillBg(1);
    draw();
    // 左辺 x=10。縦ダッシュ y=10,16,22。2 本目 = y16..18 (内部)。
    expect(pget(10, 16)).toBe(1);
    expect(pget(10, 17)).toBe(1);
    expect(pget(10, 18)).toBe(1);
    // 左右のハロー (x9, x11) は白
    expect(pget(9, 16)).toBe(0);
    expect(pget(11, 16)).toBe(0);
  });

  it("2 点の順序に依らず同じ矩形を描く (正規化)", () => {
    fillBg(0);
    drawDashedRect(40, 25, 10, 10); // 始点/終点を入れ替え
    expect(pget(16, 10)).toBe(1); // 上辺 2 本目のダッシュは同じ位置
    expect(pget(10, 16)).toBe(1); // 左辺 2 本目のダッシュも同じ位置
  });
});
