/**
 * @module lang/core/parser
 * parser.js — Tier0 式言語の構文解析（precedence climbing）。
 *
 * 文法:
 *   expr    := unary (OP expr)*        // 優先順位は PREC、^ は右結合
 *   unary   := ('-'|'+') unary | primary
 *   primary := NUM | ID | ID '(' args ')' | '(' expr ')'
 *   args    := (expr (',' expr)*)?
 *
 * AST ノード:
 *   {t:'num', v}
 *   {t:'var', name, pos}
 *   {t:'call', name, args, pos}
 *   {t:'unary', op, a}
 *   {t:'bin', op, a, b}
 */

import { tokenize, LangError } from "./lexer.js";

const PREC = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };

/**
 * 任意の装飾ヘッダ `name(args) =` を検出し、その直後のインデックスを返す（無ければ 0）。
 * 例: `f(x, y, t) = sin(x)` の `f(x, y, t) =` 部分を読み飛ばす。中身は検証せず装飾扱い。
 */
function skipOptionalHeader(toks) {
  if (toks[0].type !== "ID" || !toks[1] || toks[1].type !== "LP") return 0;
  let j = 2;
  if (toks[j] && toks[j].type === "RP") {
    return toks[j + 1] && toks[j + 1].type === "EQ" ? j + 2 : 0; // name() =
  }
  while (true) {
    if (!toks[j] || toks[j].type !== "ID") return 0;
    j++;
    if (toks[j] && toks[j].type === "COMMA") {
      j++;
      continue;
    }
    break;
  }
  return toks[j] &&
    toks[j].type === "RP" &&
    toks[j + 1] &&
    toks[j + 1].type === "EQ"
    ? j + 2
    : 0;
}

/**
 * @param {string} src
 * @returns {object} AST ルートノード
 */
export function parse(src) {
  const toks = tokenize(src);
  let p = skipOptionalHeader(toks); // `f(x,y,t) =` があれば読み飛ばす
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (type, what) => {
    if (peek().type !== type)
      throw new LangError(`${what} が必要です`, peek().pos);
    return next();
  };

  function parseExpr(minPrec) {
    let lhs = parseUnary();
    while (true) {
      const tk = peek();
      if (tk.type !== "OP") break;
      const prec = PREC[tk.value];
      if (prec < minPrec) break;
      next();
      const rightAssoc = tk.value === "^";
      const rhs = parseExpr(rightAssoc ? prec : prec + 1);
      lhs = { t: "bin", op: tk.value, a: lhs, b: rhs };
    }
    return lhs;
  }

  function parseUnary() {
    const tk = peek();
    if (tk.type === "OP" && (tk.value === "-" || tk.value === "+")) {
      next();
      // 単項マイナスは ^ より緩く結合する（-2^2 = -(2^2) = -4。Python と同じ）。
      // 演算対象を ^ の優先度で読むことで、右側の ^ が先に結合する。
      const a = parseExpr(PREC["^"]);
      return tk.value === "-" ? { t: "unary", op: "-", a } : a;
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tk = peek();
    if (tk.type === "NUM") {
      next();
      return { t: "num", v: tk.value };
    }
    if (tk.type === "LP") {
      next();
      const e = parseExpr(0);
      expect("RP", "')'");
      return e;
    }
    if (tk.type === "ID") {
      next();
      if (peek().type === "LP") {
        next();
        const args = [];
        if (peek().type !== "RP") {
          args.push(parseExpr(0));
          while (peek().type === "COMMA") {
            next();
            args.push(parseExpr(0));
          }
        }
        expect("RP", "')'");
        return { t: "call", name: tk.value, args, pos: tk.pos };
      }
      return { t: "var", name: tk.value, pos: tk.pos };
    }
    throw new LangError(`式が必要です`, tk.pos);
  }

  const ast = parseExpr(0);
  if (peek().type !== "EOF")
    throw new LangError(`余分なトークン`, peek().pos);
  return ast;
}
