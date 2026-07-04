/**
 * @module wm/text_wrap
 * text_wrap.js — テキストの単語折返し (ツールチップ / ABOUT パネル共通)
 *
 * 明示的な改行 (\n) を段落区切りとして尊重し、各段落を単語境界で
 * maxChars 以内に畳む。maxChars を超える単語はハード分割する。
 * 空段落は空行として保持する。
 *
 * 呼び出し側が用途に応じた maxChars を算出して渡す
 * (ツールチップの VRAM 幅クランプ等は呼び出し側の責務)。
 */

/**
 * @param {string} text     折り返す文字列 (\n 区切りで段落)
 * @param {number} maxChars 1 行の最大文字数 (1 以上)
 * @returns {string[]} 折り返し済みの行配列
 */
export function wrapText(text, maxChars) {
  const out = [];
  for (const para of String(text).split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (line === "") {
        line = word;
      } else if ((line + " " + word).length <= maxChars) {
        line += " " + word;
      } else {
        out.push(line);
        line = word;
      }
      while (line.length > maxChars) {
        out.push(line.slice(0, maxChars));
        line = line.slice(maxChars);
      }
    }
    if (line) out.push(line);
  }
  return out;
}
