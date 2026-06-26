/**
 * @module lang/core/parser
 * parser.js — 構文解析。
 *
 * プログラムは2つの「形」を取る（自動判別）:
 *   - 場(field): 式1本（Tier0）。`f(x,y,t) =` ヘッダは任意。
 *   - 描画(draw): `draw { 文… }`（Tier1）。文は改行/`;` 区切り。
 *
 * 式 AST:  {t:'num'|'var'|'call'|'unary'|'bin', …}
 * 文 AST:  {t:'assign', name, expr} / {t:'repeat', count, idx, body} / {t:'cmd', name, args}
 */

import { tokenize, LangError } from "./lexer.js";

const PREC = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };

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

  // ── 文（描画モード） ──
  function skipSeps() {
    while (peek().type === "SEP") next();
  }
  function parseStmtList() {
    const stmts = [];
    while (true) {
      skipSeps();
      const tk = peek();
      if (tk.type === "RBRACE" || tk.type === "EOF") break;
      stmts.push(parseStmt());
      const after = peek().type;
      if (after !== "SEP" && after !== "RBRACE" && after !== "EOF")
        throw new LangError(`文の区切り（改行か ;）が必要です`, peek().pos);
    }
    return stmts;
  }
  function parseStmt() {
    const tk = peek();
    if (tk.type !== "ID") throw new LangError(`文が必要です`, tk.pos);
    if (tk.value === "repeat") return parseRepeat();
    if (toks[p + 1] && toks[p + 1].type === "EQ") {
      next(); // name
      next(); // =
      return { t: "assign", name: tk.value, expr: parseExpr(0), pos: tk.pos };
    }
    next(); // command name
    if (peek().type === "LP") {
      next();
      const args = parseArgs();
      expect("RP", "')'");
      return { t: "cmd", name: tk.value, args, pos: tk.pos };
    }
    return { t: "cmd", name: tk.value, args: [], pos: tk.pos };
  }
  function parseRepeat() {
    const tk = next(); // 'repeat'
    const count = parseExpr(0);
    let idx = null;
    if (peek().type === "ID" && peek().value === "as") {
      next();
      idx = expect("ID", "ループ変数名").value;
    }
    expect("LBRACE", "'{'");
    const body = parseStmtList();
    expect("RBRACE", "'}'");
    return { t: "repeat", count, idx, body, pos: tk.pos };
  }

  // ── 値ブロック（Tier0 拡張）: 代入/repeat の文 ＋ 最終の値式。 ──
  // draw の文と違い cmd は持たない（場の値計算用）。セル毎の反復・総和に使う。
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
    parseStmtList,
    parseFieldBlock,
    posRef: () => p,
  };
}

/** 描画プログラム `draw { … }` を解析。 */
function parseDraw(toks) {
  const ps = makeParser(toks);
  while (ps.peek().type === "SEP") ps.next();
  const tk = ps.expect("ID");
  if (tk.value !== "draw") throw new LangError(`draw が必要です`, tk.pos);
  ps.expect("LBRACE", "'{'");
  const body = ps.parseStmtList();
  ps.expect("RBRACE", "'}'");
  while (ps.peek().type === "SEP") ps.next();
  if (ps.peek().type !== "EOF")
    throw new LangError(`余分なトークン`, ps.peek().pos);
  return body;
}

/**
 * Tier2: 状態を持つ場 `field { … }` を解析。2 形態を許す:
 *   単一チャンネル(v1): `field { init: … step: … show: … }`（暗黙チャンネル s）
 *   多チャンネル(v2):  `field { Du = … ; u: { init: … step: … } v: { … } show: … }`
 * エントリ:
 *   `name = expr`           … 定数（フレーム単位で 1 回評価。t 可・x,y 不可）
 *   `name: { init: step: }` … チャンネル（セル毎のスカラー状態）
 *   `init:/step:/show: expr`… v1 セクション（単一チャンネル）/ show は共通
 * 返り値: { consts:[{name,expr}], channels:[{name,init,step}], show }。
 * v1 は channels=[{name:"s",…}] へ正規化（show 既定 = s）。
 */
function parseCells(toks) {
  const ps = makeParser(toks);
  const RESERVED = new Set(["init", "step", "show"]);
  // エントリ区切りは 改行/`;`（SEP）または `,`。インライン `{ init: …, step: … }` 用。
  const isSep = (t) => t === "SEP" || t === "COMMA";
  while (isSep(ps.peek().type)) ps.next();
  const head = ps.expect("ID");
  if (head.value !== "field") throw new LangError(`field が必要です`, head.pos);
  ps.expect("LBRACE", "'{'");

  const consts = [];
  const channels = [];
  const sec = {}; // v1 セクション (init/step/show)
  const seenChan = new Set();

  const endEntry = () => {
    const after = ps.peek().type;
    if (!isSep(after) && after !== "RBRACE")
      throw new LangError(`区切り（改行 / ; / ,）が必要です`, ps.peek().pos);
  };

  while (true) {
    while (isSep(ps.peek().type)) ps.next();
    if (ps.peek().type === "RBRACE") break;
    const nameTk = ps.expect("ID", "定数 / チャンネル / init/step/show");
    const name = nameTk.value;
    const kind = ps.peek().type;

    if (kind === "EQ") {
      // 定数: name = expr
      ps.next();
      consts.push({ name, expr: ps.parseExpr(0) });
      endEntry();
      continue;
    }
    if (kind !== "COLON")
      throw new LangError(`'=' か ':' が必要です`, ps.peek().pos);
    ps.next(); // ':'

    if (ps.peek().type === "LBRACE") {
      // チャンネルブロック: name: { init: … step: … }
      if (RESERVED.has(name))
        throw new LangError(`'${name}' はチャンネル名に使えません`, nameTk.pos);
      if (seenChan.has(name))
        throw new LangError(`チャンネル '${name}' が重複しています`, nameTk.pos);
      seenChan.add(name);
      ps.next(); // '{'
      const ch = { name, init: null, step: null };
      while (true) {
        while (isSep(ps.peek().type)) ps.next();
        if (ps.peek().type === "RBRACE") break;
        const sTk = ps.expect("ID", "init/step");
        if (sTk.value !== "init" && sTk.value !== "step")
          throw new LangError(
            `チャンネル '${name}' に未知のセクション '${sTk.value}'（init/step）`,
            sTk.pos,
          );
        if (ch[sTk.value])
          throw new LangError(`'${sTk.value}' が重複しています`, sTk.pos);
        ps.expect("COLON", "':'");
        ch[sTk.value] = ps.parseExpr(0);
        const a = ps.peek().type;
        if (!isSep(a) && a !== "RBRACE")
          throw new LangError(`区切り（改行 / ; / ,）が必要です`, ps.peek().pos);
      }
      ps.expect("RBRACE", "'}'");
      if (!ch.init)
        throw new LangError(`チャンネル '${name}' に init: が必要です`, nameTk.pos);
      if (!ch.step)
        throw new LangError(`チャンネル '${name}' に step: が必要です`, nameTk.pos);
      channels.push(ch);
      endEntry();
      continue;
    }

    // v1 セクション: init/step/show: expr
    if (!RESERVED.has(name))
      throw new LangError(
        `未知のセクション '${name}'（init/step/show か、チャンネルは name: {…}）`,
        nameTk.pos,
      );
    if (sec[name])
      throw new LangError(`セクション '${name}' が重複しています`, nameTk.pos);
    sec[name] = ps.parseExpr(0);
    endEntry();
  }

  ps.expect("RBRACE", "'}'");
  while (ps.peek().type === "SEP") ps.next();
  if (ps.peek().type !== "EOF")
    throw new LangError(`余分なトークン`, ps.peek().pos);

  // ── 組み立て ──
  if (sec.init || sec.step) {
    // 単一チャンネル (v1)
    if (channels.length)
      throw new LangError(
        `単一チャンネル (init/step) とチャンネルブロックは混在できません`,
        head.pos,
      );
    if (!sec.init) throw new LangError(`init: が必要です`, head.pos);
    if (!sec.step) throw new LangError(`step: が必要です`, head.pos);
    return {
      consts,
      channels: [{ name: "s", init: sec.init, step: sec.step }],
      show: sec.show || { t: "var", name: "s", pos: head.pos },
    };
  }
  // 多チャンネル (v2)
  if (channels.length === 0)
    throw new LangError(
      `チャンネル (name: { init / step }) か init/step が必要です`,
      head.pos,
    );
  if (!sec.show)
    throw new LangError(`多チャンネルでは show: が必要です`, head.pos);
  return { consts, channels, show: sec.show };
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
const DIRECTIVE_NAMES = new Set(["view", "size", "pixel", "pad", "fps", "seed", "loop"]);

/**
 * トップレベル（brace 深さ 0）の設定ディレクティブを抽出する。
 * Tessera は 1-bit 表示・出力サイズ・乱数まで**コードで宣言**できる（recipe 自己完結）。
 *   - `view: <mode>(<numbers>)` … 表示方式と数値パラメータ
 *   - `size: <W>x<H>`（または `<W> <H>`） … 出力外寸
 *   - `pixel: <N>` / `pad: <N>` / `fps: <N>` / `seed: <N>` / `loop: <秒>` … スカラー設定
 *     （`pixel` = 1 アートピクセルの物理px ＝ 粗さ。`view: dither(...)` の DITHER 方式とは別物。
 *      `loop` = アニメの周期秒。プレビューは t を [0,loop) で周回し GIF/MP4 もシームレスループ）
 * コアはこれらを**不透明なデータ**として持つだけ（既定値・範囲クランプ・適用はホスト責務）。
 * `field{}` の channel 構文（`u: {…}`）はブレース内（depth>0）なので衝突しない。
 * @returns {{ config: object, rest: object[] }} config={view,size,pixel,pad,fps,seed,loop}（未指定は null）
 */
function extractDirectives(toks) {
  const config = { view: null, size: null, pixel: null, pad: null, fps: null, seed: null, loop: null };
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
    } else if (name === "size") {
      // `1920x1080` は NUM(1920)+ID("x1080") に字句化される。`1920 1080` も許す。
      const w = toks[j];
      if (!w || w.type !== "NUM")
        throw new LangError(`size: は 幅 高さ（例 1920x1080）`, colonPos);
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
        throw new LangError(`size: 高さが必要です（例 1920x1080 / 1920 1080）`, w.pos);
      }
      config.size = { w: w.value, h };
    } else {
      // pixel / pad / fps / seed / loop: スカラー数値
      const nt = toks[j];
      if (!nt || nt.type !== "NUM")
        throw new LangError(`${name}: は数値です`, colonPos);
      j++;
      config[name] = nt.value;
    }

    for (let k = i; k < j; k++) consumed.add(k);
    if (toks[j] && toks[j].type === "SEP") consumed.add(j); // 直後の区切りも畳む
    i = j - 1; // 消費分をスキップ
  }
  const rest = toks.filter((_, idx) => !consumed.has(idx));
  return { config, rest };
}

/** プログラム全体を解析し形を判別して返す（設定ディレクティブ付き）。 */
export function parseProgram(src) {
  const { config, rest } = extractDirectives(tokenize(src));
  const view = config.view; // 後方互換（既存は prog.view を参照）
  const hasBlock = (kw) =>
    rest.some(
      (t, i) =>
        t.type === "ID" &&
        t.value === kw &&
        rest[i + 1] &&
        rest[i + 1].type === "LBRACE",
    );
  if (hasBlock("draw")) return { kind: "draw", body: parseDraw(rest), view, config };
  if (hasBlock("field")) return { kind: "cells", ...parseCells(rest), view, config };
  return { kind: "field", expr: parseExprTokens(rest), view, config };
}
