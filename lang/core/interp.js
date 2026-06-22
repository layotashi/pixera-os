/**
 * @module lang/core/interp
 * interp.js — AST を評価する小さなインタプリタ。
 *
 * 変数 (x/y/t/seed 等) は env.vars で渡す。定数・関数は stdlib から解決。
 * Tier0 は副作用なしの純式。将来 Tier1/2 で文・状態を足す際もここを拡張する。
 */

import { LangError } from "./lexer.js";
import { CONSTS, FUNCS } from "../stdlib.js";

function applyBin(op, a, b, pos) {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
    case "%":
      return ((a % b) + b) % b;
    case "^":
      return Math.pow(a, b);
    default:
      throw new LangError(`未知の演算子 '${op}'`, pos);
  }
}

/**
 * @param {object} node  AST
 * @param {{vars: Record<string, number>}} env
 * @returns {number}
 */
export function evalNode(node, env) {
  switch (node.t) {
    case "num":
      return node.v;
    case "var":
      if (node.name in env.vars) return env.vars[node.name];
      if (node.name in CONSTS) return CONSTS[node.name];
      throw new LangError(`未知の名前 '${node.name}'`, node.pos);
    case "unary":
      return -evalNode(node.a, env);
    case "bin":
      return applyBin(
        node.op,
        evalNode(node.a, env),
        evalNode(node.b, env),
        node.pos,
      );
    case "call": {
      const fn = FUNCS[node.name];
      if (!fn) throw new LangError(`未知の関数 '${node.name}'`, node.pos);
      const args = node.args.map((a) => evalNode(a, env));
      return fn(...args);
    }
    default:
      throw new LangError(`未知のノード '${node.t}'`, 0);
  }
}
