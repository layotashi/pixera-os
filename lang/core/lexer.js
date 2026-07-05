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
 * @param {object} [opts]
 * @param {boolean} [opts.comments=false] true でコメントを COMMENT トークンとして
 *   保持する（フォーマッタ用）。既定 false（パーサはコメントを見ない＝従来どおり）。
 * @returns {Token[]}
 */
export function tokenize(src, opts = {}) {
  const keepComments = !!opts.comments;
  const toks = [];
  let i = 0;
  let parenDepth = 0; // `()` の入れ子。括弧内では改行を区切りにしない（式の継続）。
  const n = src.length;
  const isDigit = (c) => c >= "0" && c <= "9";
  const isIdStart = (c) => /[a-zA-Z_]/.test(c);
  const isIdPart = (c) => /[a-zA-Z0-9_]/.test(c);

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    // 文の区切り（改行 / セミコロン）。連続は 1 つに畳む。先頭は無視。
    // 括弧 `()` の中では区切りにしない＝改行で式を跨いでもよい（演算子・カンマ・開き
    // 括弧の後／閉じ括弧の前での改行が通る）。format モード（keepComments）では
    // 「行区切り済みのさらなる改行」= 空行を BLANK として 1 個だけ保持する。
    if (c === "\n" || c === ";") {
      if (parenDepth > 0) {
        i++;
        continue;
      }
      const last = toks.length ? toks[toks.length - 1].type : null;
      if (toks.length && last !== "SEP" && last !== "BLANK") {
        toks.push({ type: "SEP", pos: i });
      } else if (keepComments && c === "\n" && last === "SEP") {
        toks.push({ type: "BLANK", pos: i });
      }
      i++;
      continue;
    }
    const start = i;
    // コメント: `//` 行末まで / `/* ... */` ブロック
    if (c === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      if (keepComments)
        toks.push({ type: "COMMENT", value: src.slice(start, i), pos: start });
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      if (i >= n) throw new LangError("ブロックコメント /* が閉じていません", start);
      i += 2;
      if (keepComments)
        toks.push({ type: "COMMENT", value: src.slice(start, i), pos: start });
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      let s = "";
      while (i < n && (isDigit(src[i]) || src[i] === ".")) s += src[i++];
      if ((s.match(/\./g) || []).length > 1)
        throw new LangError(`不正な数値 '${s}'`, start);
      // raw（元の字面）も保持: フォーマッタが 1.0 や .5 を変えずに出すため。
      toks.push({ type: "NUM", value: parseFloat(s), raw: s, pos: start });
      continue;
    }
    if (isIdStart(c)) {
      let s = "";
      while (i < n && isIdPart(src[i])) s += src[i++];
      // 言語は大小文字を区別しない（PIXERA は大文字表示が前提＝`CANVAS` と `canvas` が
      // 同じ見た目になるため、識別子は小文字へ畳んで一致させる）。整形(keepComments)では
      // 元の字面を保つ（保存テキストの大小を変えない＝表示と一致）。
      toks.push({ type: "ID", value: keepComments ? s : s.toLowerCase(), pos: start });
      continue;
    }
    if (OPS.has(c)) {
      toks.push({ type: "OP", value: c, pos: start });
      i++;
      continue;
    }
    if (c === "(") {
      parenDepth++;
      toks.push({ type: "LP", pos: start });
      i++;
      continue;
    }
    if (c === ")") {
      if (parenDepth > 0) parenDepth--;
      toks.push({ type: "RP", pos: start });
      i++;
      continue;
    }
    if (c === "{") {
      toks.push({ type: "LBRACE", pos: start });
      i++;
      continue;
    }
    if (c === "}") {
      toks.push({ type: "RBRACE", pos: start });
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
    if (c === ":") {
      toks.push({ type: "COLON", pos: start });
      i++;
      continue;
    }
    throw new LangError(`予期しない文字 '${c}'`, start);
  }
  toks.push({ type: "EOF", pos: n });
  return toks;
}
