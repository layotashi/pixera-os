/**
 * wm/text_wrap.js — 単語折返しのテスト (characterization)
 *
 * ツールチップ (旧 wrapTooltip) と ABOUT (旧 _wrapText) を統合した wrapText の
 * 挙動を固定する。段落 (\n)・単語境界・ハード分割・空段落保持を検証。
 */
import { describe, it, expect } from "vitest";
import { wrapText } from "@/wm/text_wrap.js";

describe("wrapText", () => {
  it("max 以内の 1 行はそのまま返す", () => {
    expect(wrapText("HELLO WORLD", 40)).toEqual(["HELLO WORLD"]);
  });

  it("max を超える行は単語境界で折り返す", () => {
    // 各語 3 文字 + 空白。max=7 → "AAA BBB"(7) で改行
    expect(wrapText("AAA BBB CCC", 7)).toEqual(["AAA BBB", "CCC"]);
  });

  it("明示的な改行は段落区切りとして尊重する", () => {
    expect(wrapText("LINE1\nLINE2", 40)).toEqual(["LINE1", "LINE2"]);
  });

  it("空段落は空行として保持する", () => {
    expect(wrapText("A\n\nB", 40)).toEqual(["A", "", "B"]);
  });

  it("max を超える 1 語はハード分割する", () => {
    expect(wrapText("ABCDEFGH", 3)).toEqual(["ABC", "DEF", "GH"]);
  });

  it("行に既存語がある状態での長すぎる語も分割される", () => {
    // "AB" の後に長語 → "AB" を確定してから分割
    expect(wrapText("AB CDEFG", 3)).toEqual(["AB", "CDE", "FG"]);
  });

  it("複数空白は 1 語区切りとして畳む", () => {
    expect(wrapText("A   B", 40)).toEqual(["A B"]);
  });

  it("ABOUT 風の複数文をラップする", () => {
    const text = "SYSTEM SETTINGS: DISPLAY, EFFECTS, THEME.";
    const lines = wrapText(text, 20);
    // 各行が 20 文字以内で、結合すると語順が保たれる
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(20);
    expect(lines.join(" ")).toBe(text);
  });
});
