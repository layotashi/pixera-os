/**
 * roll_grid.test.js — ROLL のステップグリッド編集モデル。
 *
 * コア操作 (クリック配置 / クリック削除 / 横ドラッグで長さ / ホイールスクロール) の
 * 純粋ロジックを検証する。描画 (draw) は呼ばず、handleInput のみを対象にする
 * (grid.js の設計上、編集は描画に依存しない = テスト可能)。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { RollGrid, CELL_W, ROW_H, KEY_COL_W, RULER_H } from "@/app/roll/grid.js";

/** (col, midi) をローカル座標 (コンテンツ原点) に変換する。scroll は 0 前提 */
function cellToLocal(col, midi) {
  const row = 127 - midi;
  return {
    localX: KEY_COL_W + col * CELL_W + 1,
    localY: RULER_H + row * ROW_H + 1,
  };
}

/** down → up を同一セルで送る (= クリック) */
function click(grid, col, midi) {
  const p = cellToLocal(col, midi);
  grid.handleInput({ type: "down", ...p });
  grid.handleInput({ type: "up", ...p });
}

describe("RollGrid 編集モデル", () => {
  let grid, audition;

  beforeEach(() => {
    audition = vi.fn();
    grid = new RollGrid({ audition });
    grid.vScroll.offset = 0;
    grid.hScroll.offset = 0;
  });

  it("空セルのクリックで 1 ステップのノートを配置し試聴する", () => {
    click(grid, 4, 60);
    expect(grid.notes).toHaveLength(1);
    expect(grid.notes[0]).toMatchObject({ pitch: 60, start: 4, len: 1 });
    expect(audition).toHaveBeenCalledWith(60);
  });

  it("既存ノートのクリックで削除する (トグル)", () => {
    click(grid, 4, 60);
    expect(grid.notes).toHaveLength(1);
    click(grid, 4, 60);
    expect(grid.notes).toHaveLength(0);
  });

  it("横ドラッグで長さをセル単位に伸ばす", () => {
    const down = cellToLocal(4, 60);
    grid.handleInput({ type: "down", ...down });
    const held = cellToLocal(6, 60);
    grid.handleInput({ type: "held", ...held });
    grid.handleInput({ type: "up", ...held });
    expect(grid.notes).toHaveLength(1);
    expect(grid.notes[0]).toMatchObject({ start: 4, len: 3 }); // 4,5,6 = 3 ステップ
  });

  it("既存ノートをドラッグ(長さ変更)したときは削除しない", () => {
    click(grid, 4, 60); // 配置
    // 既存ノート上で down → 横ドラッグ → up
    const down = cellToLocal(4, 60);
    grid.handleInput({ type: "down", ...down });
    const held = cellToLocal(7, 60);
    grid.handleInput({ type: "held", ...held });
    grid.handleInput({ type: "up", ...held });
    expect(grid.notes).toHaveLength(1);
    expect(grid.notes[0].len).toBe(4); // 削除されず長さ変更
  });

  it("別ピッチ・別ステップには独立したノートが増える", () => {
    click(grid, 0, 60);
    click(grid, 2, 64);
    click(grid, 4, 67);
    expect(grid.notes).toHaveLength(3);
  });

  it("鍵盤列 (col 左) のクリックはノートを作らず試聴のみ", () => {
    grid.handleInput({ type: "down", localX: 2, localY: RULER_H + 67 * ROW_H + 1 });
    expect(grid.notes).toHaveLength(0);
    expect(audition).toHaveBeenCalledWith(60);
  });

  it("ホイールで縦スクロールする", () => {
    const before = grid.vScroll.offset;
    grid.vScroll.content = 128;
    grid.vScroll.viewport = 20; // scrollBy がクランプできるよう最大量を持たせる
    grid.handleInput({ type: "wheel", localX: 40, localY: 40, deltaY: 1 });
    expect(grid.vScroll.offset).toBeGreaterThan(before);
  });

  it("Ctrl+ホイールはズーム用に透過しスクロールしない", () => {
    grid.vScroll.content = 128;
    grid.vScroll.viewport = 20;
    const before = grid.vScroll.offset;
    grid.handleInput({ type: "wheel", localX: 40, localY: 40, deltaY: 1, ctrl: true });
    expect(grid.vScroll.offset).toBe(before);
  });
});
