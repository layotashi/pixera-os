/**
 * @module lang/core/parser
 * parser.js — 構文解析。
 *
 * プログラムは場 f(x,y,t) を表す**式 1 本**。`f(x,y,t) =` ヘッダは任意。
 * 値ブロック（代入 / repeat を並べ、最後に値の式を 1 つ）も書ける。
 *
 * 式 AST:  {t:'num'|'var'|'call'|'unary'|'bin'|'fieldblock', …}
 * 文 AST:  {t:'assign', name, expr} / {t:'repeat', count, idx, body}
 */

import { tokenize, LangError } from "./lexer.js";
import { CONSTS } from "../stdlib.js";

const PREC = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };

/**
 * ディレクティブ値の定数式を畳む（数値・定数 pi/tau・四則）。変数/関数は不可。
 * `period: tau` `period: 2*pi` `pad: 0` 等を 1 つの数値へ解決する。
 */
function evalConstExpr(node, pos) {
  switch (node.t) {
    case "num":
      return node.v;
    case "var":
      if (node.name in CONSTS) return CONSTS[node.name];
      throw new LangError(`'${node.name}' は定数ではありません（pi/tau か数値）`, node.pos ?? pos);
    case "unary":
      return -evalConstExpr(node.a, pos);
    case "bin": {
      const a = evalConstExpr(node.a, pos),
        b = evalConstExpr(node.b, pos);
      switch (node.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "%": return ((a % b) + b) % b;
        case "^": return Math.pow(a, b);
      }
    }
    // eslint-disable-next-line no-fallthrough
    default:
      throw new LangError(`ディレクティブ値に使えない式です`, pos);
  }
}

/** 装飾ヘッダ `name(args) =` を検出し直後の index を返す（無ければ 0）。 */
function skipOptionalHeader(toks) {
  if (toks[0].type !== "ID" || !toks[1] || toks[1].type !== "LP") return 0;
  let j = 2;
  if (toks[j] && toks[j].type === "RP") {
    return toks[j + 1] && toks[j + 1].type === "EQ" ? j + 2 : 0;
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

/** トークン配列上で動くパーサ本体（式・文を共有）。 */
function makeParser(toks, start = 0) {
  let p = start;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (type, what) => {
    if (peek().type !== type)
      throw new LangError(`${what ?? type} が必要です`, peek().pos);
    return next();
  };

  // ── 式 ──
  function parseExpr(minPrec) {
    let lhs = parseUnary();
    while (true) {
      // 改行(SEP)を跨いで次の二項演算子を覗く。演算子なら「式の継続」として SEP を
      // 飛ばす（`sin(x)\n + 1` 等）。演算子でなければ SEP は文の区切りとして残す。
      let q = p;
      while (toks[q] && toks[q].type === "SEP") q++;
      const tk = toks[q];
      if (!tk || tk.type !== "OP") break;
      const prec = PREC[tk.value];
      if (prec < minPrec) break;
      p = q + 1; // SEP 群と演算子を消費
      while (toks[p] && toks[p].type === "SEP") p++; // 演算子直後の改行も飛ばす（`a +\n b`）
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
      const a = parseExpr(PREC["^"]); // 単項は ^ より緩い
      return tk.value === "-" ? { t: "unary", op: "-", a } : a;
    }
    return parsePrimary();
  }
  function parseArgs() {
    const args = [];
    if (peek().type !== "RP") {
      args.push(parseExpr(0));
      while (peek().type === "COMMA") {
        next();
        args.push(parseExpr(0));
      }
    }
    return args;
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
        const args = parseArgs();
        expect("RP", "')'");
        return { t: "call", name: tk.value, args, pos: tk.pos };
      }
      return { t: "var", name: tk.value, pos: tk.pos };
    }
    throw new LangError(`式が必要です`, tk.pos);
  }

  // ── 値ブロック: 代入 / repeat の文 ＋ 最終の値式（場の値計算用）。 ──
  function skipSeps() {
    while (peek().type === "SEP") next();
  }
  // セル毎の反復・総和（julia の脱出時間、N 個の総和など）に使う。
  function parseValueStmt() {
    const tk = peek();
    if (tk.type !== "ID")
      throw new LangError(`代入 / repeat が必要です`, tk.pos);
    if (tk.value === "repeat") return parseValueRepeat();
    if (toks[p + 1] && toks[p + 1].type === "EQ") {
      next(); // name
      next(); // =
      return { t: "assign", name: tk.value, expr: parseExpr(0), pos: tk.pos };
    }
    throw new LangError(`代入 / repeat が必要です（値の式は最後に1つ）`, tk.pos);
  }
  function parseValueStmtList() {
    const stmts = [];
    while (true) {
      skipSeps();
      const tk = peek();
      if (tk.type === "RBRACE" || tk.type === "EOF") break;
      stmts.push(parseValueStmt());
      const after = peek().type;
      if (after !== "SEP" && after !== "RBRACE" && after !== "EOF")
        throw new LangError(`文の区切り（改行か ;）が必要です`, peek().pos);
    }
    return stmts;
  }
  function parseValueRepeat() {
    const tk = next(); // 'repeat'
    const count = parseExpr(0);
    let idx = null;
    if (peek().type === "ID" && peek().value === "as") {
      next();
      idx = expect("ID", "ループ変数名").value;
    }
    expect("LBRACE", "'{'");
    const body = parseValueStmtList();
    expect("RBRACE", "'}'");
    return { t: "repeat", count, idx, body, pos: tk.pos };
  }
  /** [代入/repeat]* ＋ 最終の値式 → { stmts, value }。 */
  function parseFieldBlock() {
    const stmts = [];
    let value = null;
    while (true) {
      skipSeps();
      const tk = peek();
      if (tk.type === "EOF") break;
      const isStmt =
        tk.type === "ID" &&
        (tk.value === "repeat" || (toks[p + 1] && toks[p + 1].type === "EQ"));
      if (isStmt) {
        if (value !== null)
          throw new LangError(`値の式は最後に 1 つだけ置きます`, tk.pos);
        stmts.push(parseValueStmt());
      } else {
        if (value !== null)
          throw new LangError(`値の式は最後に 1 つだけ置きます`, tk.pos);
        value = parseExpr(0);
      }
      const after = peek().type;
      if (after !== "SEP" && after !== "EOF")
        throw new LangError(`文の区切り（改行か ;）が必要です`, peek().pos);
    }
    if (value === null)
      throw new LangError(`場の値（最後の式）が必要です`, peek().pos);
    return { stmts, value };
  }

  return {
    peek,
    next,
    expect,
    parseExpr,
    parseFieldBlock,
    posRef: () => p,
  };
}

/**
 * トークン列から Tier0 の場を解析。`f(x,y,t)=` ヘッダは読み飛ばす。
 * 値ブロック（代入/repeat ＋ 最終式）を許す（SEP は文の区切りなので残す）。
 * 文が無ければ素の式 AST を、有れば { t:"fieldblock", stmts, value } を返す。
 */
function parseExprTokens(toks) {
  // ヘッダ判定は SEP 無しの並びで行う（ヘッダは 1 行に収まる）。
  const headerEnd = skipOptionalHeader(toks.filter((x) => x.type !== "SEP"));
  // ヘッダぶんの実トークン数だけ生トークン側も進める（SEP を跨がない前提）。
  let start = 0;
  if (headerEnd > 0) {
    let seen = 0;
    while (start < toks.length && seen < headerEnd) {
      if (toks[start].type !== "SEP") seen++;
      start++;
    }
  }
  const ps = makeParser(toks, start);
  const block = ps.parseFieldBlock();
  if (ps.peek().type !== "EOF")
    throw new LangError(`余分なトークン`, ps.peek().pos);
  return block.stmts.length === 0
    ? block.value
    : { t: "fieldblock", stmts: block.stmts, value: block.value };
}

/** 場の式1本を解析（SEP は無視）。`f(x,y,t)=` ヘッダは読み飛ばす。 */
export function parse(src) {
  return parseExprTokens(tokenize(src));
}

/** トップレベル・ディレクティブ名（`name: value` 形式。本体の前後どこでも・各1個）。 */
const DIRECTIVE_NAMES = new Set(["view", "canvas", "pad", "fps", "seed", "period"]);

/**
 * トップレベル（brace 深さ 0）の設定ディレクティブを抽出する。
 * Tessera は 1-bit 表示・出力サイズ・乱数まで**コードで宣言**できる（recipe 自己完結）。
 *   - `view: <mode>(<numbers>)` … 表示方式と数値パラメータ
 *   - `canvas: <W>x<H>`（または `<W> <H>`） … 出力解像度（外寸px）
 *   - `pad: <N>` / `fps: <N>` / `seed: <N>` / `period: <秒>` … スカラー設定
 *     （`period` = アニメの周期秒。プレビューは t を [0,period) で周回し GIF/MP4 もシームレスループ）
 * コアはこれらを**不透明なデータ**として持つだけ（既定値・範囲クランプ・適用はホスト責務）。
 * repeat の `{…}` 内（depth>0）は走査しない（ディレクティブは常にトップレベル）。
 * @returns {{ config: object, rest: object[] }} config={view,canvas,pad,fps,seed,period}（未指定は null）
 */
function extractDirectives(toks) {
  const config = { view: null, canvas: null, pad: null, fps: null, seed: null, period: null };
  const consumed = new Set();
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === "LBRACE") { depth++; continue; }
    if (t.type === "RBRACE") { depth--; continue; }
    if (depth !== 0) continue;
    if (t.type !== "ID" || !DIRECTIVE_NAMES.has(t.value)) continue;
    if (!toks[i + 1] || toks[i + 1].type !== "COLON") continue;
    const name = t.value;
    const colonPos = toks[i + 1].pos;
    let j = i + 2;

    if (name === "view") {
      const modeTk = toks[j];
      if (!modeTk || modeTk.type !== "ID")
        throw new LangError(`view: の方式名が必要です`, colonPos);
      j++;
      if (!toks[j] || toks[j].type !== "LP")
        throw new LangError(`view: 方式の後に '(' が必要です`, modeTk.pos);
      j++;
      const args = [];
      if (toks[j] && toks[j].type !== "RP") {
        while (true) {
          const nt = toks[j];
          if (!nt || nt.type !== "NUM")
            throw new LangError(`view: の引数は数値です`, nt ? nt.pos : modeTk.pos);
          args.push(nt.value);
          j++;
          if (toks[j] && toks[j].type === "COMMA") { j++; continue; }
          break;
        }
      }
      if (!toks[j] || toks[j].type !== "RP")
        throw new LangError(`view: ')' が必要です`, modeTk.pos);
      j++;
      config.view = { mode: modeTk.value, args };
    } else if (name === "canvas") {
      // `1920x1080` は NUM(1920)+ID("x1080") に字句化される。`1920 1080` も許す。
      const w = toks[j];
      if (!w || w.type !== "NUM")
        throw new LangError(`canvas: は 幅 高さ（例 1920x1080）`, colonPos);
      j++;
      const nx = toks[j];
      let h;
      if (nx && nx.type === "ID" && /^x\d+$/.test(nx.value)) {
        h = parseInt(nx.value.slice(1), 10);
        j++;
      } else if (nx && nx.type === "NUM") {
        h = nx.value;
        j++;
      } else {
        throw new LangError(`canvas: 高さが必要です（例 1920x1080 / 1920 1080）`, w.pos);
      }
      config.canvas = { w: w.value, h };
    } else {
      // pad / fps / seed / period: 定数式（数値 / pi / tau / 2*pi 等）。
      // SEP までを式とみなし、本体へ食い込まないよう EOF 付きスライスで解析→定数評価。
      let m = j;
      const valToks = [];
      while (toks[m] && toks[m].type !== "SEP" && toks[m].type !== "EOF") {
        valToks.push(toks[m]);
        m++;
      }
      if (valToks.length === 0)
        throw new LangError(`${name}: の値が必要です`, colonPos);
      valToks.push({ type: "EOF", pos: valToks[valToks.length - 1].pos });
      const sp = makeParser(valToks, 0);
      let node;
      try {
        node = sp.parseExpr(0);
      } catch {
        throw new LangError(`${name}: の値が不正です`, colonPos);
      }
      if (sp.peek().type !== "EOF")
        throw new LangError(`${name}: の値が不正です`, sp.peek().pos);
      config[name] = evalConstExpr(node, colonPos);
      j = m;
    }

    for (let k = i; k < j; k++) consumed.add(k);
    if (toks[j] && toks[j].type === "SEP") consumed.add(j); // 直後の区切りも畳む
    i = j - 1; // 消費分をスキップ
  }
  const rest = toks.filter((_, idx) => !consumed.has(idx));
  return { config, rest };
}

/** プログラム全体（場の式 ＋ 設定ディレクティブ）を解析して返す。 */
export function parseProgram(src) {
  const { config, rest } = extractDirectives(tokenize(src));
  return { expr: parseExprTokens(rest), config };
}
