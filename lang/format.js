/**
 * @module lang/format
 * format.js — TESS 専用ソース整形。
 *
 * TESS の identity は **40桁**（レトロ機の画面幅）。整形はこの制約を尊重する。
 * トークン列を行（row）へまとめ、正準な空白・インデント・**40桁折り返し**で出し直す。
 * 字句エラー時はソースをそのまま返す（壊れたコードは整形しない＝安全）。
 *
 * 整形の規則:
 *   - 二項 `+ -` は前後 1 スペース、`* / % ^` は詰める（優先順位ベース）。`f(`/単項 `-` は詰め。
 *   - `{` で字下げ +1、`}` で −1（`}` は単独行）。`;`/改行は「1 文 1 行」へ畳む。空行は 1 行残す。
 *   - **(A) 40桁折り返し**: 40桁超の式を、低優先 `+ -` で改行し演算子を継続行頭へ出す
 *     （`(`/`+`/`)` の縦レール）。改行は `()` の内側（深度≥1）でのみ安全＝lexer が文区切り
 *     にしないため。深度0の長い和は (A2) グルーピング括弧を補ってから折る（値は不変・括弧追加）。
 *   - **(B) ディレクティブ整列**: 連続するディレクティブを正準順
 *     （canvas→pad→fps→period→seed→view）へ並べ替え、コロンを揃える（設定盤化）。
 *   - **(C) 代入整列**: 同深度で連続する `name = …` の `=` を揃える（40桁を超えない範囲でのみ）。
 *   - **(E) コメント正規化**: `//x` → `// x`（先頭 1 スペース）。本文・ブロックコメントは不変。
 *
 * トークン再出力なので数値字面（`1.0` `.5`）とコメントは保持。A2 のみ括弧を追加するため
 * 「同一トークン」ではなく「同一**値**」を保証する（折り返しに必要な最小限の括弧）。
 */
import { tokenize } from "./core/lexer.js";

const INDENT = "  ";
const WIDTH = 40; // TESS の桁数（折り返しの目標幅）
const TIGHT = new Set(["*", "/", "%", "^"]);
// ディレクティブ正準順（HEADER 規約: キャンバス→時間→seed→view）。
const DIR_ORDER = new Map(
  ["canvas", "pad", "fps", "period", "seed", "view"].map((d, i) => [d, i]),
);
const ALLOW_PAREN_INSERT = true; // (A2) 深度0の長い和に括弧を補って折る

/** その位置で演算子が単項になりうるか（直前トークン種がオペランド待ちか） */
function operandExpected(prev) {
  return (
    prev === null ||
    prev === "OP" ||
    prev === "UNARYOP" ||
    prev === "LP" ||
    prev === "COMMA" ||
    prev === "EQ" ||
    prev === "COLON" ||
    prev === "LBRACE"
  );
}

// ── トークン列 → 1 行（インデント無し）。優先順位ベースの空白規則 ──────────────
function renderInline(toks) {
  let line = "";
  let prev = null;
  const append = (text, sb, type) => {
    if (prev !== null && sb) line += " ";
    line += text;
    prev = type;
  };
  for (const tk of toks) {
    const ty = tk.type;
    if (ty === "OP") {
      const unary =
        (tk.value === "-" || tk.value === "+") && operandExpected(prev);
      if (unary) {
        append(tk.value, !(prev === "LP" || prev === "UNARYOP"), "UNARYOP");
      } else {
        const tight = TIGHT.has(tk.value);
        append(tk.value, !tight, tight ? "OP_TIGHT" : "OP");
      }
      continue;
    }
    let text;
    switch (ty) {
      case "NUM":
        text = tk.raw;
        break;
      case "LP":
        text = "(";
        break;
      case "RP":
        text = ")";
        break;
      case "COMMA":
        text = ",";
        break;
      case "EQ":
        text = "=";
        break;
      case "COLON":
        text = ":";
        break;
      default:
        text = tk.value; // ID / COMMENT
    }
    let sb;
    switch (ty) {
      case "RP":
      case "COMMA":
      case "COLON":
        sb = false;
        break;
      case "LP":
        sb = !(
          prev === "ID" ||
          prev === "RP" ||
          prev === "LP" ||
          prev === "UNARYOP" ||
          prev === "OP_TIGHT"
        );
        break;
      case "EQ":
        sb = true;
        break;
      default: // NUM / ID / COMMENT
        sb = !(prev === "LP" || prev === "UNARYOP" || prev === "OP_TIGHT");
        // `1920x1080`: 高さ ID は直前 NUM へ密着（式中で NUM+ID は構文上現れない）。
        if (ty === "ID" && prev === "NUM" && /^x\d/.test(tk.value)) sb = false;
    }
    append(text, sb, ty);
  }
  return line;
}

// ── 括弧ツリー（深度を保持して折り返し位置を判断するため）────────────────────
// node = {t:"tok", tk} | {t:"paren", kids:node[]}
function parenTree(toks) {
  let i = 0;
  function list(stopAtRP) {
    const out = [];
    while (i < toks.length) {
      const tk = toks[i];
      if (tk.type === "LP") {
        i++;
        out.push({ t: "paren", kids: list(true) });
      } else if (tk.type === "RP") {
        if (stopAtRP) {
          i++;
          return out;
        }
        out.push({ t: "tok", tk });
        i++;
      } else {
        out.push({ t: "tok", tk });
        i++;
      }
    }
    return out;
  }
  return list(false);
}

function flatten(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.t === "tok") out.push(n.tk);
    else {
      out.push({ type: "LP" });
      for (const k of flatten(n.kids)) out.push(k);
      out.push({ type: "RP" });
    }
  }
  return out;
}
const renderNodes = (nodes) => renderInline(flatten(nodes));

/** ノード列の「直前種」（operandExpected 用）。paren はオペランド＝RP 相当。 */
function prevTypeOf(node) {
  if (node.t === "paren") return "RP";
  return node.tk.type === "OP" ? "OP" : node.tk.type;
}

const ADD = new Set(["+", "-"]);
const MUL = new Set(["*", "/", "%"]);

/** opset の二項演算子でノード列を分割（演算子は後続セグメントの先頭に残す）。 */
function splitTopBy(nodes, opset) {
  const segs = [];
  let cur = [];
  let prev = null;
  for (const n of nodes) {
    const isOp =
      n.t === "tok" && n.tk.type === "OP" && opset.has(n.tk.value);
    // `* / %` は常に二項。`+ -` は直前がオペランドのときだけ二項（単項は割らない）。
    const binary = isOp && (!ADD.has(n.tk.value) || !operandExpected(prev));
    if (binary) {
      if (cur.length) segs.push(cur);
      cur = [n];
      prev = "OP";
    } else {
      cur.push(n);
      prev = prevTypeOf(n);
    }
  }
  if (cur.length) segs.push(cur);
  return segs;
}

/** 低優先（`+ -`）を先に試し、無ければ高優先（`* / %`）で割る。 */
function splitTop(nodes) {
  const add = splitTopBy(nodes, ADD);
  return add.length > 1 ? add : splitTopBy(nodes, MUL);
}

const isBreakable = (nodes) => splitTop(nodes).length > 1;
const maxLen = (lines) => Math.max(...lines.map((l) => l.length));

/** nodes[pi]（paren）を演算子先頭レールで折る。長いセグメントは layout で再帰。 */
function breakAtParen(nodes, pi, indent, prefix) {
  const head = indent + prefix;
  const pre = nodes.slice(0, pi);
  const paren = nodes[pi];
  const post = nodes.slice(pi + 1);
  const rail = head + renderNodes(pre); // `(` が立つ桁
  const railIndent = " ".repeat(rail.length);
  const segs = splitTop(paren.kids);
  const lines = [];
  segs.forEach((seg, si) => {
    let linePrefix;
    let segNodes;
    if (si === 0) {
      linePrefix = rail + "( ";
      segNodes = seg;
    } else {
      linePrefix = railIndent + seg[0].tk.value + " "; // 先頭は演算子
      segNodes = seg.slice(1);
    }
    const segInline = linePrefix + renderNodes(segNodes);
    if (segInline.length <= WIDTH) {
      lines.push(segInline);
    } else {
      const sub = layout(segNodes, " ".repeat(linePrefix.length), "");
      sub[0] = linePrefix + sub[0].slice(linePrefix.length);
      lines.push(...sub);
    }
  });
  // 閉じ括弧は独立行。後続（`*0.25 + 0.5` 等）を続ける。RP 始まりで `+` を二項に保つ。
  lines.push(railIndent + renderInline([{ type: "RP" }].concat(flatten(post))));
  return lines;
}

/**
 * ノード列を 40桁で折り返して物理行配列にする（indent/prefix は 1 行目の先頭）。
 * 改行は paren の内側でのみ起き、文区切りにならない（深度0の式は括弧を補ってから折る）。
 * 候補（折らない案 / 既存の各 paren を折る案 / 深度0を括弧で包む A2 案）を出し、
 * 「40桁に収まる案を優先 → 同点なら最小行数」で選ぶ。これで WAVE 系は最短（既存 paren）、
 * moire 系は A2、折っても収まらない式（smoothstep 等）はそのまま 1 行、と使い分く。
 */
function layout(nodes, indent, prefix) {
  const head = indent + prefix;
  const inline = head + renderNodes(nodes);
  const candidates = [[inline]]; // 折らない案（折っても収まらないなら最小行数で勝つ）
  if (inline.length <= WIDTH) return [inline];

  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].t === "paren" && isBreakable(nodes[i].kids))
      candidates.push(breakAtParen(nodes, i, indent, prefix));
  }
  // (A2) 深度0に割れる演算子がある（が安全に折れない）→ 全体を括弧で包んでから折る。
  const alreadyWrapped = nodes.length === 1 && nodes[0].t === "paren";
  if (ALLOW_PAREN_INSERT && isBreakable(nodes) && !alreadyWrapped)
    candidates.push(breakAtParen([{ t: "paren", kids: nodes }], 0, indent, prefix));

  candidates.sort((a, b) => {
    const af = maxLen(a) <= WIDTH;
    const bf = maxLen(b) <= WIDTH;
    if (af !== bf) return af ? -1 : 1; // 収まる案を優先
    return a.length - b.length || maxLen(a) - maxLen(b); // 同点は最小行数→最短幅
  });
  return candidates[0];
}

// ── コメント正規化（E）: `//x` → `// x`。ブロック `/* */` は不変 ──────────────
function normComment(v) {
  if (v.startsWith("//")) {
    const rest = v.slice(2).replace(/^[ \t]+/, "");
    return rest.length ? "// " + rest : "//";
  }
  return v;
}

// ── トークン列 → 行（row）。SEP/BLANK/`{`/`}` で構造を組む ────────────────────
function makeRow(toks, depth) {
  // 単独行コメント（行全体がコメント）は正規化して comment 行に。
  if (toks.length === 1 && toks[0].type === "COMMENT") {
    return { kind: "comment", depth, text: normComment(toks[0].value) };
  }
  let trail = null;
  let body = toks;
  if (toks.length > 1 && toks[toks.length - 1].type === "COMMENT") {
    trail = toks[toks.length - 1];
    body = toks.slice(0, -1);
  }
  const k = body[0].value;
  if (
    body[0].type === "ID" &&
    body[1] &&
    body[1].type === "COLON" &&
    DIR_ORDER.has(String(k).toLowerCase())
  ) {
    return {
      kind: "directive",
      depth,
      keyRaw: k,
      key: String(k).toLowerCase(),
      valueToks: body.slice(2),
      trail,
    };
  }
  if (body[0].type === "ID" && body[1] && body[1].type === "EQ") {
    return { kind: "assign", depth, name: k, rhsToks: body.slice(2), trail };
  }
  return { kind: "expr", depth, toks: body, trail };
}

function buildRows(toks) {
  const rows = [];
  let depth = 0;
  let cur = [];
  const flushCur = () => {
    if (cur.length) {
      rows.push(makeRow(cur, depth));
      cur = [];
    }
  };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    const ty = tk.type;
    if (ty === "EOF") break;
    if (ty === "SEP") {
      // パーサと同じ継続判定: 直前が二項演算子（`a +\n b`）か、次の非SEPが演算子
      // （`a\n + b`）なら SEP は「式の継続」＝行を割らない。さもなくば文の区切り。
      const last = cur[cur.length - 1];
      const dangling = last && last.type === "OP";
      let j = i + 1;
      while (j < toks.length && toks[j].type === "SEP") j++;
      const nextOp = toks[j] && toks[j].type === "OP";
      if (cur.length && (dangling || nextOp)) continue;
      flushCur();
      continue;
    }
    if (ty === "BLANK") {
      flushCur();
      rows.push({ blank: true });
      continue;
    }
    if (ty === "LBRACE") {
      rows.push({ kind: "open", depth, toks: cur }); // `repeat … {`
      cur = [];
      depth++;
      continue;
    }
    if (ty === "RBRACE") {
      flushCur();
      depth = Math.max(0, depth - 1);
      rows.push({ kind: "close", depth });
      continue;
    }
    cur.push(tk);
  }
  flushCur();
  return rows;
}

// ── (B) ディレクティブ整列: 正準順 + コロン揃え ──────────────────────────────
function renderDirective(d, maxKey) {
  const valStr = renderNodes(parenTree(d.valueToks));
  const valueCol = maxKey + 2; // key + ":" + 1スペース（最長キー基準）
  let s = d.keyRaw + ":";
  s += " ".repeat(Math.max(1, valueCol - s.length)) + valStr;
  if (d.trail) s += " " + normComment(d.trail.value);
  return INDENT.repeat(d.depth) + s;
}

// ── (C) 代入整列: 同深度連続グループの `=` を 40桁内でのみ揃える ───────────────
function renderAssignRow(r, alignWidth) {
  const indent = INDENT.repeat(r.depth);
  const name = r.name.padEnd(alignWidth);
  const prefix = name + " = ";
  const rhs = parenTree(r.rhsToks);
  if (r.trail) {
    return [
      indent + prefix + renderNodes(rhs) + " " + normComment(r.trail.value),
    ];
  }
  return layout(rhs, indent, prefix);
}

function renderAssignGroup(group) {
  const alignWidth = Math.max(...group.map((r) => r.name.length));
  // 揃えても 40桁を超えないときだけ整列（超えるなら素のまま＝折り返しに委ねる）。
  const fits = group.every((r) => {
    const w =
      INDENT.repeat(r.depth).length +
      alignWidth +
      3 + // " = "
      renderNodes(parenTree(r.rhsToks)).length +
      (r.trail ? 1 + normComment(r.trail.value).length : 0);
    return w <= WIDTH;
  });
  const useW = fits ? alignWidth : 0;
  const out = [];
  for (const r of group) out.push(...renderAssignRow(r, Math.max(useW, r.name.length)));
  return out;
}

/**
 * ソースを整形して返す。字句エラー時はそのまま返す。
 * @param {string} src
 * @returns {string}
 */
export function format(src) {
  let toks;
  try {
    toks = tokenize(src, { comments: true });
  } catch {
    return src; // 壊れたコードは触らない
  }
  const rows = buildRows(toks);
  const out = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.blank) {
      out.push("");
      continue;
    }
    if (r.kind === "directive") {
      // 連続ディレクティブを 1 つの「設定盤」として並べ替え + コロン揃え（B）。
      let j = i;
      while (j < rows.length && rows[j].kind === "directive") j++;
      const run = rows
        .slice(i, j)
        .sort((a, b) => DIR_ORDER.get(a.key) - DIR_ORDER.get(b.key));
      const maxKey = Math.max(...run.map((d) => d.keyRaw.length));
      for (const d of run) out.push(renderDirective(d, maxKey));
      i = j - 1;
      continue;
    }
    if (r.kind === "assign") {
      // 同深度で連続する代入を 1 グループとして `=` 揃え（C）。
      let j = i;
      while (j < rows.length && rows[j].kind === "assign" && rows[j].depth === r.depth)
        j++;
      out.push(...renderAssignGroup(rows.slice(i, j)));
      i = j - 1;
      continue;
    }
    if (r.kind === "comment") {
      out.push(INDENT.repeat(r.depth) + r.text);
      continue;
    }
    if (r.kind === "open") {
      out.push(INDENT.repeat(r.depth) + renderInline(r.toks) + " {");
      continue;
    }
    if (r.kind === "close") {
      out.push(INDENT.repeat(r.depth) + "}");
      continue;
    }
    // expr
    const indent = INDENT.repeat(r.depth);
    if (r.trail) {
      out.push(indent + renderInline(r.toks) + " " + normComment(r.trail.value));
      continue;
    }
    out.push(...layout(parenTree(r.toks), indent, ""));
  }

  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}
