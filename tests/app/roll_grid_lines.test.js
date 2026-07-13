/**
 * roll_grid_lines.test.js — ROLL の時間方向 (縦) グリッド線の階層と点線位相を検証する。
 *
 * 仕様:
 *   小節線 = 2px 実線 / 拍線 = 1px 実線 / ステップ (拍より細かい) = 1px 点線。
 *   点線は各セル内寸の上端から 1px おきに点を打ち、隙間が横罫線の行に重なる。位相は
 *   ズーム (cellH 可変) でも保たれる。
 *
 * 点線位相を司る drawStepDots を gpu プリミティブ経由で実バッファ (vram) へ描き、pget で
 * 1px ずつ読んでユーザー提供の ASCII 仕様と完全一致 (diff 0) することを確かめる。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { drawStepDots } from "@/app/roll/roll.js";
import { fillRect, pget } from "@/core/gpu.js";

/** (x0..x1, y0..y1) の矩形を "#"(=1)/"."(=0) の行文字列配列にする */
function readAscii(x0, y0, x1, y1) {
  const lines = [];
  for (let y = y0; y <= y1; y++) {
    let s = "";
    for (let x = x0; x <= x1; x++) s += pget(x, y) ? "#" : ".";
    lines.push(s);
  }
  return lines;
}

describe("ROLL 縦グリッド — ステップ点線の位相 (drawStepDots)", () => {
  beforeEach(() => fillRect(0, 0, 32, 24, 0)); // 検証域を背景 0 でクリア

  it("ユーザー ASCII 仕様と完全一致する (点線の隙間が横線に重なる)", () => {
    // 仕様の再現: 幅 9 × 高さ 11。縦点線 2 本 (x=1,7)、横実線 2 本 (y=1,9)。
    // 横線に挟まれた内寸は 7px (y=2..8)。点線は内寸上端から 1px おき (偶数行) に乗るので、
    // 隙間 (奇数行) が横線 (y=1,9) に一致する。
    const SPEC = [
      ".#.....#.",
      "#########",
      ".#.....#.",
      ".........",
      ".#.....#.",
      ".........",
      ".#.....#.",
      ".........",
      ".#.....#.",
      "#########",
      ".#.....#.",
    ];
    // 3 帯の内寸: 上 (…y=0)、中央 (y=2..8)、下 (y=10…)。いずれも ch=7。
    const interiorY = [-6, 2, 10];
    drawStepDots(1, 0, interiorY, 3, 7);
    drawStepDots(7, 0, interiorY, 3, 7);
    // 横罫線 (全幅) を後から重ねる。点線は内寸のみに乗るため交点で衝突しない。
    fillRect(0, 1, 9, 1, 1);
    fillRect(0, 9, 9, 1, 1);

    expect(readAscii(0, 0, 8, 10)).toEqual(SPEC);
  });

  it("内寸上端の行に点が乗り、その 1px 下 (隙間) は空く", () => {
    drawStepDots(3, 0, [4], 1, 8);
    expect(pget(3, 4)).toBe(1); // 内寸上端 = 点
    expect(pget(3, 5)).toBe(0); // 次の行 = 隙間
    expect(pget(3, 6)).toBe(1); // 1px おき
    expect(pget(3, 7)).toBe(0);
  });

  it("cellH が偶数 (ズーム後) でも横線の行 (内寸の外) は隙間のまま", () => {
    // 内寸 y=2.. (ch=8, 偶数)。上の横線 y=1、下の横線 y=10 の行には点を打たない。
    drawStepDots(5, 0, [2], 1, 8);
    expect(pget(5, 1)).toBe(0); // 上の横線行
    expect(pget(5, 10)).toBe(0); // 下の横線行
    expect([2, 4, 6, 8].every((y) => pget(5, y) === 1)).toBe(true); // 内寸は 1px おきに点
    expect([3, 5, 7, 9].every((y) => pget(5, y) === 0)).toBe(true); // その隙間
  });
});
