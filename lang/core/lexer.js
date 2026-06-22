/**
 * @module lang/core/lexer
 * lexer.js — Tier0 式言語の字句解析。
 *
 * トークン: NUM(数値) / ID(識別子) / OP(+ - * / % ^) / LP RP COMMA / EOF
 * 位置 (pos) を各トークンに持たせ、エラー表示に使う。
 */

/** @typedef {{type:string, value?:(number|string), pos:number}} Token */

const OPS = new Set(["+", "-", "*", "/", "%", "^"]);

export class LangError extends Error {
  constructor(message, pos) {
    super(message);
    this.name = "LangError";
    this.pos = pos;
  }
}

/**
 * ソース文字列をトークン列へ。
 * @param {string} src
 * @returns {Token[]}
 */
export function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  const isDigit = (c) => c >= "0" && c <= "9";
  const isIdStart = (c) => /[a-zA-Z_]/.test(c);
  const isIdPart = (c) => /[a-zA-Z0-9_]/.test(c);

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    const start = i;
    // コメント: `//` 行末まで / `/* ... */` ブロック
    if (c === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      if (i >= n) throw new LangError("ブロックコメント /* が閉じていません", start);
      i += 2;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      let s = "";
      while (i < n && (isDigit(src[i]) || src[i] === ".")) s += src[i++];
      if ((s.match(/\./g) || []).length > 1)
        throw new LangError(`不正な数値 '${s}'`, start);
      toks.push({ type: "NUM", value: parseFloat(s), pos: start });
      continue;
    }
    if (isIdStart(c)) {
      let s = "";
      while (i < n && isIdPart(src[i])) s += src[i++];
      toks.push({ type: "ID", value: s, pos: start });
      continue;
    }
    if (OPS.has(c)) {
      toks.push({ type: "OP", value: c, pos: start });
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ type: "LP", pos: start });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ type: "RP", pos: start });
      i++;
      continue;
    }
    if (c === ",") {
      toks.push({ type: "COMMA", pos: start });
      i++;
      continue;
    }
    if (c === "=") {
      toks.push({ type: "EQ", pos: start });
      i++;
      continue;
    }
    throw new LangError(`予期しない文字 '${c}'`, start);
  }
  toks.push({ type: "EOF", pos: n });
  return toks;
}
