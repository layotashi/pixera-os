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

// ━━ 描画モード（Tier1）: 文・コマンドの実行 ━━

/** repeat の暴走防止上限（1フレームの反復総数）。 */
const REPEAT_CAP = 2_000_000;

/**
 * draw ブロックを実行し、surface に描画命令を発行する。
 * 変数は 1 つのスコープ (env.vars) を共有（repeat 本体も同じスコープ）。
 * @param {object[]} body  文の配列
 * @param {object} surface サーフェス契約
 * @param {number} t  時間（秒）
 * @param {number} seed
 */
export function execDraw(body, surface, t = 0, seed = 0) {
  const env = { vars: { t, seed } };
  execStmts(body, env, surface);
}

function execStmts(stmts, env, surface) {
  for (const s of stmts) execStmt(s, env, surface);
}

function execStmt(s, env, surface) {
  switch (s.t) {
    case "assign":
      env.vars[s.name] = evalNode(s.expr, env);
      return;
    case "repeat": {
      let n = evalNode(s.count, env) | 0;
      if (n < 0) n = 0;
      if (n > REPEAT_CAP) n = REPEAT_CAP;
      for (let k = 0; k < n; k++) {
        if (s.idx) env.vars[s.idx] = k;
        execStmts(s.body, env, surface);
      }
      return;
    }
    case "cmd":
      execCmd(s, env, surface);
      return;
    default:
      throw new LangError(`未知の文 '${s.t}'`, s.pos ?? 0);
  }
}

function execCmd(s, env, surface) {
  const a = s.args.map((x) => evalNode(x, env));
  const W = surface.width();
  const H = surface.height();
  const px = (v) => Math.round(v * W); // [0,1] → ピクセル
  const py = (v) => Math.round(v * H);
  switch (s.name) {
    case "clear":
      surface.clear(a.length ? a[0] : 0);
      return;
    case "stroke":
      surface.stroke(a.length ? a[0] : 1);
      return;
    case "point":
      if (a.length < 2) throw new LangError(`point(x, y) は引数2つ`, s.pos);
      surface.point(px(a[0]), py(a[1]));
      return;
    case "line":
      if (a.length < 4) throw new LangError(`line(x0,y0,x1,y1) は引数4つ`, s.pos);
      surface.line(px(a[0]), py(a[1]), px(a[2]), py(a[3]));
      return;
    default:
      throw new LangError(`未知のコマンド '${s.name}'`, s.pos);
  }
}
