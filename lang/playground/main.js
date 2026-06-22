/**
 * @module lang/playground/main
 * main.js — playground の配線。textarea のソースを compile し（場/描画を自動判別）、
 * 毎フレーム描く。編集は即反映（ライブリロード）、エラーはインライン表示。
 */
import { compile as compileSource } from "../runtime.js";
import { makeCanvasSurface } from "./canvas-surface.js";

// 正方形: x,y がともに [0,1] なので、縦横を等スケールにすると式の意味が素直に出る
// （dist() の等高線が真円になる等）。
const W = 160,
  H = 160,
  SCALE = 4;
const FG = [255, 122, 0]; // SYNESTA オレンジ
const BG = [10, 6, 0];

const canvas = document.getElementById("screen");
const editor = document.getElementById("code");
const errEl = document.getElementById("err");
const seedEl = document.getElementById("seed");
const surface = makeCanvasSurface(canvas, W, H, SCALE, FG, BG);

let program = null;

function compile() {
  try {
    program = compileSource(editor.value);
    errEl.textContent = "";
    errEl.classList.remove("on");
  } catch (e) {
    program = null;
    const pos = e.pos != null ? `  (pos ${e.pos})` : "";
    errEl.textContent = `✗ ${e.message}${pos}`;
    errEl.classList.add("on");
  }
}

let t0 = performance.now();
function frame() {
  if (program) {
    const t = (performance.now() - t0) / 1000;
    const seed = Number(seedEl.value) || 0;
    try {
      program.render(surface, t, seed);
    } catch (e) {
      program = null;
      errEl.textContent = `✗ ${e.message}`;
      errEl.classList.add("on");
    }
  }
  requestAnimationFrame(frame);
}

let debounce;
editor.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(compile, 150);
});
document.querySelectorAll("[data-ex]").forEach((b) =>
  b.addEventListener("click", () => {
    editor.value = b.dataset.ex;
    compile();
  }),
);

// ── Ctrl+/ (Mac: ⌘+/) で行コメントのトグル（VSCode 流） ──
function toggleLineComment() {
  const text = editor.value;
  const selS = editor.selectionStart;
  const selE = editor.selectionEnd;

  // 対象行の範囲（選択が触れた行すべて。終端がちょうど行頭ならその行は除外）
  const startLineBegin = text.lastIndexOf("\n", selS - 1) + 1;
  let effEnd = selE;
  if (selE > selS && text[selE - 1] === "\n") effEnd = selE - 1;
  let endLineEnd = text.indexOf("\n", effEnd);
  if (endLineEnd === -1) endLineEnd = text.length;

  const before = text.slice(0, startLineBegin);
  const block = text.slice(startLineBegin, endLineEnd);
  const after = text.slice(endLineEnd);
  const lines = block.split("\n");

  const nonEmpty = lines.filter((l) => l.trim() !== "");
  const allCommented =
    nonEmpty.length > 0 && nonEmpty.every((l) => /^\s*\/\//.test(l));

  // 各行を変換しつつ、挿入/削除の位置と量を記録（カーソル補正用）
  const edits = [];
  let acc = startLineBegin;
  const out = lines.map((l) => {
    const m = l.match(/^(\s*)(.*)$/);
    const indent = m[1],
      rest = m[2];
    const at = acc + indent.length;
    let nl = l;
    if (allCommented) {
      const um = rest.match(/^\/\/( ?)(.*)$/);
      if (um) {
        nl = indent + um[2];
        edits.push({ at, delta: -(2 + um[1].length) });
      }
    } else if (rest !== "") {
      nl = indent + "// " + rest;
      edits.push({ at, delta: 3 });
    }
    acc += l.length + 1; // +1 は改行ぶん
    return nl;
  });

  editor.value = before + out.join("\n") + after;

  const adjust = (p) => {
    let np = p;
    for (const ed of edits) {
      if (ed.delta > 0) {
        if (ed.at <= p) np += ed.delta;
      } else {
        const removed = -ed.delta;
        if (ed.at + removed <= p) np += ed.delta;
        else if (ed.at < p) np = ed.at;
      }
    }
    return np;
  };
  editor.selectionStart = adjust(selS);
  editor.selectionEnd = adjust(selE);
  compile();
}

editor.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "/") {
    e.preventDefault();
    toggleLineComment();
  }
});

editor.value = "sin(x*8 - t) * cos(y*8 + t*1.3) * 0.5 + 0.5";
compile();
requestAnimationFrame(frame);
