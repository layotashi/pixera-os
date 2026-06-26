/**
 * @module lang/format
 * format.js — ソース整形（トークン再出力）。
 *
 * AST を介さず、トークン列を正準な空白・インデントで出し直す。**意味は変えない**
 * （同じトークン＝同じ括弧・同じ数値字面）。コメントは保持。**行の折り返しはしない**
 * （数式は一息で読むのが正義。40桁は world-style の指針として別管理）。
 * 字句エラー時はソースをそのまま返す（壊れたコードは整形しない＝安全）。
 *
 * 規則:
 *   - `{` で字下げ +1、`}` で −1（`}` は単独行）。`;`/改行は「1 文 1 行」へ畳む。
 *   - 二項 `+ -` は前後 1 スペース、`* / % ^` は詰める（優先順位ベース）。
 *   - `,` の後・`name = `・`init:` の後 に 1 スペース。
 *   - `f(` / `( )` / 単項 `-` は詰める。空行は畳む。
 *   - インデントは 2 スペース（低解像度に合わせて緊密に）。
 */
import { tokenize } from "./core/lexer.js";

const INDENT = "  ";

// 優先順位ベースの空白: 高優先の `* / % ^` は詰め（a*b）、低優先の二項 `+ -` は空ける
// （a + b）。低解像度（〜40桁）で項のまとまりが見え、式が一息で読める書きぶりになる。
const TIGHT = new Set(["*", "/", "%", "^"]);

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

  let depth = 0;
  let line = "";
  let prev = null; // 現在行で最後に出したトークン種（行頭は null）
  const out = [];

  const startLine = () => {
    line = INDENT.repeat(depth);
    prev = null;
  };
  const flush = () => out.push(line.replace(/\s+$/, ""));
  const hasContent = () => line.trim() !== "";
  const append = (text, spaceBefore, type) => {
    if (prev !== null && spaceBefore) line += " ";
    line += text;
    prev = type;
  };

  startLine();

  for (const tk of toks) {
    const ty = tk.type;
    if (ty === "EOF") break;

    if (ty === "SEP") {
      if (hasContent()) {
        flush();
        startLine();
      }
      continue;
    }
    if (ty === "BLANK") {
      // 空行を 1 行だけ残す（連続空行は lexer が 1 個に畳んでいる）。
      if (hasContent()) {
        flush();
        startLine();
      }
      out.push("");
      continue;
    }
    if (ty === "LBRACE") {
      append("{", prev !== null, "LBRACE");
      flush();
      depth++;
      startLine();
      continue;
    }
    if (ty === "RBRACE") {
      if (hasContent()) flush();
      depth = Math.max(0, depth - 1);
      startLine();
      line += "}";
      prev = "RBRACE";
      continue;
    }
    if (ty === "OP") {
      const unary =
        (tk.value === "-" || tk.value === "+") && operandExpected(prev);
      if (unary) {
        append(tk.value, !(prev === "LP" || prev === "UNARYOP"), "UNARYOP");
      } else {
        // 高優先は前後とも詰める（OP_TIGHT）。低優先は前後に 1 スペース（OP）。
        const tight = TIGHT.has(tk.value);
        append(tk.value, !tight, tight ? "OP_TIGHT" : "OP");
      }
      continue;
    }

    // NUM / ID / LP / RP / COMMA / EQ / COLON / COMMENT
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
        // `canvas: 1920x1080` は NUM(1920)+ID("x1080") に字句化される。高さ ID は
        // 直前の NUM へ密着させ `1920x1080` の見た目を保つ（式中で NUM+ID は構文上現れない）。
        if (ty === "ID" && prev === "NUM" && /^x\d/.test(tk.value)) sb = false;
    }
    append(text, sb, ty);
  }
  if (hasContent()) flush();

  // 先頭/末尾の空行を除去
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}
