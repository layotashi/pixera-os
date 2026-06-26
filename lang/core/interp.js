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
      // env.funcs（場の近傍プリミティブ lap/nbr/sum8 等、現在セルに束縛）を
      // stdlib より優先して解決する。stdlib は純関数のまま保つ。
      const fn = (env.funcs && env.funcs[node.name]) || FUNCS[node.name];
      if (!fn) throw new LangError(`未知の関数 '${node.name}'`, node.pos);
      const args = node.args.map((a) => evalNode(a, env));
      return fn(...args);
    }
    case "fieldblock":
      // Tier0 値ブロック: 代入/repeat の文を実行（cmd は無い＝surface 不要）してから
      // 最終の値式を返す。セル毎の反復・総和（julia / quasic / metaball 等）に使う。
      execStmts(node.stmts, env, null);
      return evalNode(node.value, env);
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

// ━━ コンパイル（AST → クロージャ）━━
// 評価毎の switch 分岐／プロパティ参照を排し、子ノードのクロージャを 1 度だけ束ねる。
// per-pixel / per-cell の評価が桁違いに速くなる（julia 等の重い式が実用域に）。

/** 式 AST を `(env) => number` にコンパイルする。 */
export function compileExpr(node) {
  switch (node.t) {
    case "num": {
      const v = node.v;
      return () => v;
    }
    case "var": {
      const name = node.name,
        pos = node.pos;
      // 値は常に number ⇒ env.vars[name] が undefined なら「未束縛」。`in` を避けて高速化。
      if (name in CONSTS) {
        // pi/tau: 既定は定数。ただし同名代入があれば env.vars が優先（シャドウ可）。
        const cv = CONSTS[name];
        return (env) => {
          const v = env.vars[name];
          return v !== undefined ? v : cv;
        };
      }
      return (env) => {
        const v = env.vars[name];
        if (v !== undefined) return v;
        throw new LangError(`未知の名前 '${name}'`, pos);
      };
    }
    case "unary": {
      const a = compileExpr(node.a);
      return (env) => -a(env);
    }
    case "bin": {
      const a = compileExpr(node.a),
        b = compileExpr(node.b);
      switch (node.op) {
        case "+":
          return (env) => a(env) + b(env);
        case "-":
          return (env) => a(env) - b(env);
        case "*":
          return (env) => a(env) * b(env);
        case "/":
          return (env) => a(env) / b(env);
        case "%":
          return (env) => {
            const x = a(env),
              y = b(env);
            return ((x % y) + y) % y;
          };
        case "^":
          return (env) => Math.pow(a(env), b(env));
        default:
          throw new LangError(`未知の演算子 '${node.op}'`, node.pos);
      }
    }
    case "call": {
      const name = node.name,
        pos = node.pos,
        argFns = node.args.map(compileExpr),
        n = argFns.length;
      // stdlib 関数 (sin/cos/clamp/…) はコンパイル時に束縛＝毎回の解決を排す。
      // 場の近傍 (nbr/lap/sum8) のみ env.funcs 経由（実行時にセルへ束縛）で解決する。
      const staticFn = FUNCS[name];
      if (staticFn) {
        switch (n) {
          case 0:
            return () => staticFn();
          case 1: {
            const a0 = argFns[0];
            return (env) => staticFn(a0(env));
          }
          case 2: {
            const a0 = argFns[0],
              a1 = argFns[1];
            return (env) => staticFn(a0(env), a1(env));
          }
          case 3: {
            const a0 = argFns[0],
              a1 = argFns[1],
              a2 = argFns[2];
            return (env) => staticFn(a0(env), a1(env), a2(env));
          }
          case 4: {
            const a0 = argFns[0],
              a1 = argFns[1],
              a2 = argFns[2],
              a3 = argFns[3];
            return (env) => staticFn(a0(env), a1(env), a2(env), a3(env));
          }
          default:
            return (env) => {
              const a = new Array(n);
              for (let i = 0; i < n; i++) a[i] = argFns[i](env);
              return staticFn(...a);
            };
        }
      }
      // 近傍プリミティブ等: 実行時に env.funcs から解決（未知なら評価時に投げる）。
      return (env) => {
        const fn = env.funcs && env.funcs[name];
        if (!fn) throw new LangError(`未知の関数 '${name}'`, pos);
        const a = new Array(n);
        for (let i = 0; i < n; i++) a[i] = argFns[i](env);
        return fn(...a);
      };
    }
    case "fieldblock": {
      const stmtsFn = compileStmts(node.stmts),
        valFn = compileExpr(node.value);
      return (env) => {
        stmtsFn(env, null);
        return valFn(env);
      };
    }
    default:
      throw new LangError(`未知のノード '${node.t}'`, 0);
  }
}

/** 文の配列を `(env, surface) => void` にコンパイルする。 */
function compileStmts(stmts) {
  const fns = stmts.map(compileStmt);
  const n = fns.length;
  return (env, surface) => {
    for (let i = 0; i < n; i++) fns[i](env, surface);
  };
}

function compileStmt(s) {
  switch (s.t) {
    case "assign": {
      const name = s.name,
        exprFn = compileExpr(s.expr);
      return (env) => {
        env.vars[name] = exprFn(env);
      };
    }
    case "repeat": {
      const countFn = compileExpr(s.count),
        bodyFn = compileStmts(s.body),
        idx = s.idx;
      return (env, surface) => {
        let n = countFn(env) | 0;
        if (n < 0) n = 0;
        if (n > REPEAT_CAP) n = REPEAT_CAP;
        for (let k = 0; k < n; k++) {
          if (idx) env.vars[idx] = k;
          bodyFn(env, surface);
        }
      };
    }
    case "cmd":
      return compileCmd(s);
    default:
      throw new LangError(`未知の文 '${s.t}'`, s.pos ?? 0);
  }
}

function compileCmd(s) {
  const name = s.name,
    pos = s.pos,
    argFns = s.args.map(compileExpr),
    n = argFns.length;
  return (env, surface) => {
    const W = surface.width(),
      H = surface.height();
    switch (name) {
      case "clear":
        surface.clear(n ? argFns[0](env) : 0);
        return;
      case "stroke":
        surface.stroke(n ? argFns[0](env) : 1);
        return;
      case "point":
        if (n < 2) throw new LangError(`point(x, y) は引数2つ`, pos);
        surface.point(Math.round(argFns[0](env) * W), Math.round(argFns[1](env) * H));
        return;
      case "line":
        if (n < 4) throw new LangError(`line(x0,y0,x1,y1) は引数4つ`, pos);
        surface.line(
          Math.round(argFns[0](env) * W),
          Math.round(argFns[1](env) * H),
          Math.round(argFns[2](env) * W),
          Math.round(argFns[3](env) * H),
        );
        return;
      default:
        throw new LangError(`未知のコマンド '${name}'`, pos);
    }
  };
}

/** draw ブロックを `(surface, t, seed) => void` にコンパイルする。 */
export function compileDraw(body) {
  const fn = compileStmts(body);
  return (surface, t = 0, seed = 0) => {
    fn({ vars: { t, seed } }, surface);
  };
}
