/**
 * @module lang/core/interp
 * interp.js — AST を JS ソースへ変換し `new Function` でネイティブ化するコンパイラ。
 *
 * 変数 (x/y/t/seed・チャンネル値・定数) は env.vars、場の近傍 (nbr/lap/sum8) は
 * env.funcs で渡す。stdlib の純関数・定数はコンパイル時に解決する。
 *
 * 設計: ツリー走査インタプリタを廃し、式は JS の式へ、repeat は実 for ループへ、
 * 変数はローカル変数（オブジェクト経由のハッシュ参照を排除）へ落とす。V8 が JIT し、
 * 走査評価の数十倍速い（julia 等の重い値ブロックが実用域に）。評価対象は常に
 * ユーザ自身が書いた .tess ソース＝外部入力は無く、`new Function` の利用は安全。
 */

import { LangError } from "./lexer.js";
import { CONSTS, FUNCS } from "../stdlib.js";

/** repeat の暴走防止上限（1フレームの反復総数）。 */
const REPEAT_CAP = 2_000_000;

// ━━ 生成コードへ渡すランタイムヘルパ ━━
const fmod = (a, b) => ((a % b) + b) % b; // `%` は床剰余（負も周回）
function unknownName(name, pos) {
  throw new LangError(`未知の名前 '${name}'`, pos);
}
function unknownFunc(name, pos) {
  throw new LangError(`未知の関数 '${name}'`, pos);
}

let _uid = 0; // 生成コード内の一時名を一意化（ループカウンタ等）
const q = (s) => JSON.stringify(s); // 文字列リテラルを安全に埋め込む
const jsNum = (v) => (v < 0 ? `(${v})` : `${v}`); // 負数は隣接演算子との結合を避け括弧で包む

/**
 * ブロック内（同一フラットスコープ）で代入される名前を集める。
 * repeat 本体は同スコープなので潜るが、ネストした値ブロックは別スコープなので潜らない。
 */
function blockAssigns(stmts, set = new Set()) {
  for (const s of stmts) {
    if (s.t === "assign") set.add(s.name);
    else if (s.t === "repeat") {
      if (s.idx) set.add(s.idx);
      blockAssigns(s.body, set);
    }
  }
  return set;
}

/**
 * 式 AST → JS ソース文字列。
 * @param {object} node
 * @param {Set<string>[]} scopes  内側ほど後方の、代入済み名スコープ
 * @param {Map<string,number>} free  自由変数（読むが代入しない）→ 初出 pos を蓄積
 */
function genExpr(node, scopes, free) {
  switch (node.t) {
    case "num":
      return jsNum(node.v);
    case "var": {
      const name = node.name;
      for (let i = scopes.length - 1; i >= 0; i--)
        if (scopes[i].has(name)) return `_${name}`; // ローカル（いずれかのブロックが代入）
      if (!free.has(name)) free.set(name, node.pos); // 自由変数（env / 定数から解決）
      return `_${name}`;
    }
    case "unary":
      return `(-${genExpr(node.a, scopes, free)})`;
    case "bin": {
      const a = genExpr(node.a, scopes, free),
        b = genExpr(node.b, scopes, free);
      if (node.op === "^") return `Math.pow(${a},${b})`;
      if (node.op === "%") return `M(${a},${b})`;
      return `(${a}${node.op}${b})`;
    }
    case "call": {
      const args = node.args.map((x) => genExpr(x, scopes, free)).join(",");
      // stdlib 関数はコンパイル時に F へ束縛。近傍 (nbr/lap/sum8) のみ env.funcs 経由。
      if (FUNCS[node.name]) return `F[${q(node.name)}](${args})`;
      return `(env.funcs&&env.funcs[${q(node.name)}]||UF(${q(node.name)},${node.pos}))(${args})`;
    }
    case "fieldblock": {
      // 値ブロック: 代入/repeat を実行してから最終値を返す。IIFE で独自スコープを作る。
      const assigned = blockAssigns(node.stmts);
      scopes.push(assigned);
      let decls = "";
      for (const name of assigned) decls += `let _${name}=env.vars[${q(name)}];`;
      let body = "";
      for (const s of node.stmts) body += genStmt(s, scopes, free);
      const val = genExpr(node.value, scopes, free);
      scopes.pop();
      return `(()=>{${decls}${body}return ${val};})()`;
    }
    default:
      throw new LangError(`未知のノード '${node.t}'`, 0);
  }
}

/** 文 AST → JS ソース文字列（assign / repeat / cmd）。 */
function genStmt(s, scopes, free) {
  switch (s.t) {
    case "assign":
      return `_${s.name}=${genExpr(s.expr, scopes, free)};`;
    case "repeat": {
      const cnt = genExpr(s.count, scopes, free);
      const ctr = `__i${_uid++}`;
      const setIdx = s.idx ? `_${s.idx}=${ctr};` : ""; // 走査と同じく末尾で n-1 を残す
      let body = "";
      for (const st of s.body) body += genStmt(st, scopes, free);
      return (
        `{let __n=(${cnt})|0;if(__n<0)__n=0;else if(__n>${REPEAT_CAP})__n=${REPEAT_CAP};` +
        `for(let ${ctr}=0;${ctr}<__n;${ctr}++){${setIdx}${body}}}`
      );
    }
    case "cmd":
      return genCmd(s, scopes, free);
    default:
      throw new LangError(`未知の文 '${s.t}'`, s.pos ?? 0);
  }
}

/** 描画コマンド AST → JS ソース文字列（surface 呼び出し）。引数数は生成時に検査。 */
function genCmd(s, scopes, free) {
  const a = s.args.map((x) => genExpr(x, scopes, free));
  switch (s.name) {
    case "clear":
      return `surface.clear(${a.length ? a[0] : 0});`;
    case "stroke":
      return `surface.stroke(${a.length ? a[0] : 1});`;
    case "point":
      if (a.length < 2) throw new LangError(`point(x, y) は引数2つ`, s.pos);
      return `surface.point(Math.round((${a[0]})*W),Math.round((${a[1]})*H));`;
    case "line":
      if (a.length < 4) throw new LangError(`line(x0,y0,x1,y1) は引数4つ`, s.pos);
      return `surface.line(Math.round((${a[0]})*W),Math.round((${a[1]})*H),Math.round((${a[2]})*W),Math.round((${a[3]})*H));`;
    default:
      throw new LangError(`未知のコマンド '${s.name}'`, s.pos);
  }
}

/** 自由変数 1 つの宣言（env.vars 優先。定数 pi/tau は既定値、未束縛は評価時に投げる）。 */
function freeDecl(name, pos) {
  const k = q(name);
  if (name in CONSTS)
    return `const _${name}=(env.vars[${k}]!==undefined?env.vars[${k}]:${CONSTS[name]});`;
  return `const _${name}=(env.vars[${k}]!==undefined?env.vars[${k}]:UN(${k},${pos}));`;
}

/**
 * 式 AST を `(env) => number` にコンパイルする（JS ソース → new Function）。
 * env.vars が入力（x/y/t/seed・チャンネル・定数）、env.funcs が近傍プリミティブ。
 */
export function compileExpr(node) {
  _uid = 0;
  const free = new Map();
  const code = genExpr(node, [], free);
  let pre = "";
  for (const [name, pos] of free) pre += freeDecl(name, pos);
  // eslint-disable-next-line no-new-func
  const fn = new Function("env", "F", "M", "UF", "UN", `${pre}return ${code};`);
  return (env) => fn(env, FUNCS, fmod, unknownFunc, unknownName);
}

/**
 * draw ブロックを `(surface, t, seed) => void` にコンパイルする。
 * 変数は 1 つのフラットスコープ（repeat 本体も同じ）。t/seed は自由変数。
 */
export function compileDraw(body) {
  _uid = 0;
  const free = new Map();
  const assigned = blockAssigns(body);
  const scopes = [assigned];
  let stmts = "";
  for (const s of body) stmts += genStmt(s, scopes, free);
  let decls = "";
  for (const name of assigned) decls += `let _${name};`;
  let pre = "";
  for (const [name, pos] of free) pre += freeDecl(name, pos);
  const code = `const W=surface.width(),H=surface.height();${pre}${decls}${stmts}`;
  // eslint-disable-next-line no-new-func
  const fn = new Function("env", "surface", "F", "M", "UF", "UN", code);
  return (surface, t = 0, seed = 0) =>
    fn({ vars: { t, seed } }, surface, FUNCS, fmod, unknownFunc, unknownName);
}
