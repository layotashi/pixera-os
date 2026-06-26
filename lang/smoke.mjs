/**
 * smoke.mjs — node 動作確認（ブラウザ不要）。
 *   node lang/smoke.mjs
 * 式の評価・stdlib・エラー位置・場のレンダリング（ASCII プレビュー）を確認する。
 */
import { compileField, compile } from "./runtime.js";
import { ditherField, makeBufferSurface } from "./surface.js";
import { format } from "./format.js";
import { LangError } from "./core/lexer.js";

let pass = 0,
  fail = 0;
const approx = (a, b, e = 1e-6) => Math.abs(a - b) < e;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
  }
}

// 1) 算術と優先順位
{
  const f = compileField("1 + 2 * 3 ^ 2");
  check("precedence 1+2*3^2 = 19", approx(f.sample(0, 0, 0), 19));
}
// 2) 単項マイナス・右結合
{
  const f = compileField("-2 ^ 2");
  check("unary/right-assoc -2^2 = -4", approx(f.sample(0, 0, 0), -4));
}
// 3) 変数と stdlib
{
  const f = compileField("sin(x * TAU)");
  check("sin(x*TAU) at x=0.25 ~ 1", approx(f.sample(0.25, 0, 0), 1, 1e-9));
}
// 4) noise が [0,1] に収まる
{
  const f = compileField("noise(x*8, y*8)");
  let okRange = true;
  for (let i = 0; i < 50; i++) {
    const v = f.sample(Math.random(), Math.random(), 0);
    if (v < -0.01 || v > 1.01) okRange = false;
  }
  check("noise in [0,1]", okRange);
}
// 5) エラー位置
{
  let caught = null;
  try {
    compileField("1 + ");
  } catch (e) {
    caught = e;
  }
  check("syntax error reported", caught instanceof LangError);
}
{
  let caught = null;
  try {
    compileField("foo(1)").sample(0, 0, 0);
  } catch (e) {
    caught = e;
  }
  check("unknown function error", caught instanceof LangError);
}

// 5a3) f(x,y,t) = 式 のヘッダを読み飛ばせる
{
  check(
    "header form parses",
    approx(compileField("f(x, y, t) = 1 + 2").sample(0, 0, 0), 3),
  );
  check(
    "bare expression still works",
    approx(compileField("1 + 2").sample(0, 0, 0), 3),
  );
}
// 5a4) seed が rnd/noise に効く
{
  const f = compileField("rnd(0.3, 0.7)");
  check("seed changes rnd", !approx(f.sample(0, 0, 0, 0), f.sample(0, 0, 0, 7)));
}
// 5a5) 取捨：削った関数は未知としてエラー
{
  for (const name of ["pow", "hypot", "tan", "exp", "log", "round", "wave"]) {
    let caught = null;
    try {
      compileField(`${name}(1)`).sample(0, 0, 0);
    } catch (e) {
      caught = e;
    }
    check(`trimmed '${name}' is gone`, caught instanceof LangError);
  }
}

// 5b) コメント（// 行 / /* */ ブロック）
{
  check("line comment", approx(compileField("1 + 2 // ignored").sample(0, 0, 0), 3));
  check(
    "block comment",
    approx(compileField("1 /* mid */ + 2").sample(0, 0, 0), 3),
  );
  check(
    "multiline expr with comments",
    approx(
      compileField("sin(0) // zero\n + 1 /* one */").sample(0, 0, 0),
      1,
    ),
  );
  let caught = null;
  try {
    compileField("1 + /* open");
  } catch (e) {
    caught = e;
  }
  check("unclosed block comment errors", caught instanceof LangError);
}

// 6) 場のレンダリング（ヘッドレス surface で ASCII プレビュー）
{
  const W = 48,
    H = 20;
  let bits = null;
  const surface = {
    width: () => W,
    height: () => H,
    blitField: (buf, w, h) => {
      bits = ditherField(buf, w, h);
    },
    present: () => {},
  };
  const f = compileField("sin(x*6 - t) * cos(y*6 + t) * 0.5 + 0.5");
  f.render(surface, 1.0, 0);
  check("render produced bits", bits && bits.length === W * H);
  // ASCII で目視
  let out = "\nfield: sin(x*6 - t) * cos(y*6 + t) * 0.5 + 0.5  (t=1)\n";
  for (let y = 0; y < H; y++) {
    let row = "";
    for (let x = 0; x < W; x++) row += bits[y * W + x] ? "#" : " ";
    out += row + "\n";
  }
  console.log(out);
}

// 7) 描画モード（Tier1）: draw / repeat / dot / clear / 自動判別
{
  const cmds = [];
  const surf = {
    width: () => 100,
    height: () => 100,
    clear: (l) => cmds.push(["clear", l]),
    stroke: (v) => cmds.push(["stroke", v]),
    point: (x, y) => cmds.push(["point", x, y]),
    line: (...a) => cmds.push(["line", ...a]),
    present: () => cmds.push(["present"]),
  };
  const prog = compile("draw {\n clear\n repeat 3 as i {\n point(i*0.1, 0.5)\n }\n}");
  check("compile detects draw shape", prog.kind === "draw");
  check("bare expression is field shape", compile("sin(x)").kind === "field");
  prog.render(surf, 0, 0);
  const pts = cmds.filter((c) => c[0] === "point");
  check("draw: clear issued first", cmds[0][0] === "clear");
  check("draw: repeat ran 3 points", pts.length === 3);
  check(
    "draw: point maps [0,1]→px",
    pts[0][1] === 0 && pts[0][2] === 50 && pts[1][1] === 10,
  );
  check("draw: present at end", cmds[cmds.length - 1][0] === "present");
}

// 8) Tier2: 状態を持つ場（field { init / step / show }）
{
  const makeSurf = (W, H) => {
    const s = { width: () => W, height: () => H, present: () => {}, field: null };
    s.blitField = (b) => { s.field = b; };
    return s;
  };

  check(
    "cells shape detected",
    compile("field {\n init: 0\n step: s\n show: s\n}").kind === "cells",
  );

  // 恒等 step は状態を保つ
  {
    const surf = makeSurf(4, 4);
    compile("field {\n init: 1\n step: s\n show: s\n}").render(surf, 0, 0);
    check("cells: identity keeps state", surf.field.every((v) => v === 1));
  }

  // 状態はフレーム間で保持され step が積み上がる
  {
    const surf = makeSurf(3, 3);
    const p = compile("field {\n init: 0\n step: s + 1\n show: s\n}");
    p.render(surf, 0, 0);
    check("cells: 1 step → 1", surf.field[0] === 1);
    p.render(surf, 0, 0);
    check("cells: state persists (2 steps → 2)", surf.field[0] === 2);
  }

  // sum8: 全 1 の 8 近傍和 = 8
  {
    const surf = makeSurf(4, 4);
    compile("field {\n init: 1\n step: sum8()\n show: s\n}").render(surf, 0, 0);
    check("cells: sum8 of all-ones = 8", surf.field.every((v) => v === 8));
  }

  // lap: 一様場のラプラシアン = 0
  {
    const surf = makeSurf(4, 4);
    compile("field {\n init: 1\n step: lap()\n show: s\n}").render(surf, 0, 0);
    check("cells: lap of uniform = 0", surf.field.every((v) => v === 0));
  }

  // nbr + wrap: 右隣を取り込む。端は wrap で反対側へ
  {
    const surf = makeSurf(4, 4);
    compile("field {\n init: x\n step: nbr(1, 0)\n show: s\n}").render(surf, 0, 0);
    check(
      "cells: nbr(1,0) shifts, wraps at edge",
      approx(surf.field[0], 1 / 3) && approx(surf.field[3], 0),
    );
  }

  // show 省略は s を既定にする
  {
    const surf = makeSurf(2, 2);
    compile("field {\n init: 0.5\n step: s\n}").render(surf, 0, 0);
    check("cells: show defaults to s", surf.field.every((v) => v === 0.5));
  }

  // パースエラー: init 欠落 / 未知セクション
  for (const [src, label] of [
    ["field {\n step: s\n show: s\n}", "missing init errors"],
    ["field {\n init: 0\n foo: 1\n}", "unknown section errors"],
  ]) {
    let caught = null;
    try {
      compile(src);
    } catch (e) {
      caught = e;
    }
    check(`cells: ${label}`, caught instanceof LangError);
  }

  // 発展の ASCII プレビュー（ノイズが拡散して滑らかな塊へ）
  {
    const W = 48,
      H = 20;
    const surf = makeSurf(W, H);
    const p = compile(
      "field {\n init: rnd(x*20, y*20)\n step: s + 0.2 * lap()\n show: s\n}",
    );
    for (let i = 0; i < 25; i++) p.render(surf, i * 0.05, 0);
    const bits = ditherField(surf.field, W, H);
    let out = "\nTier2 field: rnd を 0.2*lap() で 25 ステップ拡散\n";
    for (let y = 0; y < H; y++) {
      let row = "";
      for (let x = 0; x < W; x++) row += bits[y * W + x] ? "#" : " ";
      out += row + "\n";
    }
    console.log(out);
  }
}

// 8b) Tier2 v2: 多チャンネル + 定数（反応拡散）
{
  const makeSurf = (W, H) => {
    const s = { width: () => W, height: () => H, present: () => {}, field: null };
    s.blitField = (b) => { s.field = b; };
    return s;
  };

  check(
    "v2: multi-channel detected as cells",
    compile("field {\n u: { init: 0\n step: u }\n v: { init: 0\n step: v }\n show: u\n}").kind ===
      "cells",
  );

  // 同期更新: u/v が入れ替わる（旧 curr のみ参照している証拠）
  {
    const surf = makeSurf(3, 3);
    const p = compile("field {\n u: { init: 1\n step: v }\n v: { init: 2\n step: u }\n show: u\n}");
    p.render(surf, 0, 0);
    check("v2: synchronous swap → u=2", surf.field[0] === 2);
    p.render(surf, 0, 0);
    check("v2: synchronous swap → u=1", surf.field[0] === 1);
  }

  // 定数（フレーム単位）。step で蓄積
  {
    const surf = makeSurf(2, 2);
    const p = compile("field {\n k = 5\n init: 0\n step: s + k\n show: s\n}");
    p.render(surf, 0, 0);
    check("v2: const (=5)", surf.field[0] === 5);
    p.render(surf, 0, 0);
    check("v2: const accumulates (=10)", surf.field[0] === 10);
  }

  // クロスチャンネル: u の step が v の現在値を参照
  {
    const surf = makeSurf(2, 2);
    compile("field {\n u: { init: 1\n step: u + v }\n v: { init: 3\n step: v }\n show: u\n}").render(
      surf,
      0,
      0,
    );
    check("v2: cross-channel value coupling (u=4)", surf.field[0] === 4);
  }

  // lap() は「現チャンネル」に束縛（u は一様→lap=0。v は勾配だが u には効かない）
  {
    const surf = makeSurf(4, 4);
    compile("field {\n u: { init: 1\n step: lap() }\n v: { init: x\n step: v }\n show: u\n}").render(
      surf,
      0,
      0,
    );
    check("v2: lap() uses current channel (u-lap=0)", surf.field.every((z) => z === 0));
  }

  // パースエラー
  for (const [src, label] of [
    ["field {\n init: 0\n u: { init: 0\n step: u }\n show: s\n}", "mix single+channel"],
    ["field {\n u: { init: 0 }\n show: u\n}", "channel missing step"],
    ["field {\n u: { init: 0\n step: u }\n}", "multi-channel needs show"],
  ]) {
    let caught = null;
    try {
      compile(src);
    } catch (e) {
      caught = e;
    }
    check(`v2: ${label} errors`, caught instanceof LangError);
  }

  // Gray-Scott: 多チャンネル RD が NaN を出さず発展する
  {
    let raw = null;
    const surf = {
      width: () => 20,
      height: () => 20,
      blitField: (b) => { raw = Float32Array.from(b); },
      present: () => {},
    };
    const gs = `field {
  Du = 0.16
  Dv = 0.08
  f = 0.06
  k = 0.062
  u: { init: 1, step: u + Du*lap() - u*v*v + f*(1 - u) }
  v: { init: 1 - step(0.1, dist(x, y, 0.5, 0.5)), step: v + Dv*lap() + u*v*v - (f + k)*v }
  show: v
}`;
    const p = compile(gs);
    for (let i = 0; i < 40; i++) p.render(surf, i * 0.1, 0);
    let finite = true,
      mn = Infinity,
      mx = -Infinity;
    for (const z of raw) {
      if (!Number.isFinite(z)) finite = false;
      if (z < mn) mn = z;
      if (z > mx) mx = z;
    }
    check("v2: Gray-Scott stays finite", finite);
    check("v2: Gray-Scott develops variation", mx - mn > 0.05);
  }
}

// 8c) view: 表示ディレクティブ（コア不透明データ。ラスタライズはホスト）
{
  const isView = (v, mode, args) =>
    v != null &&
    v.mode === mode &&
    v.args.length === args.length &&
    v.args.every((a, i) => a === args[i]);

  const p1 = compile("view: dither(2)\nsin(x)");
  check("view: field 形に付く", p1.kind === "field" && isView(p1.view, "dither", [2]));
  check("view: 本体の式は通る", approx(p1.sample(0, 0, 0), 0)); // sin(0)=0

  const p2 = compile("view: contour(7)\nfield{init:0\nstep:s\nshow:s}");
  check("view: cells 形に付く", p2.kind === "cells" && isView(p2.view, "contour", [7]));

  const p3 = compile("view: dither(4)\ndraw{clear}");
  check("view: draw 形に付く", p3.kind === "draw" && isView(p3.view, "dither", [4]));

  check("view: 無いと null", compile("sin(x)").view === null);
  check("view: 本体の後ろでも可", isView(compile("sin(x)\nview: dither(3)").view, "dither", [3]));
  check("view: 複数引数", isView(compile("view: halftone(2, 8)\nsin(x)").view, "halftone", [2, 8]));

  for (const [src, label] of [
    ["view: dither\nsin(x)", "no parens"],
    ["view: dither(x)\nsin(x)", "non-number arg"],
  ]) {
    let caught = null;
    try {
      compile(src);
    } catch (e) {
      caught = e;
    }
    check(`view: ${label} errors`, caught instanceof LangError);
  }
}

// 8d) 設定ディレクティブ（size/pixel/pad/fps/seed）。コア不透明データ・適用はホスト。
{
  const cfg = (src) => compile(src).config;

  // size: WxH（NUM + "xNNN" ID に字句化される）／ W H（2 数値）
  const c1 = cfg("size: 1920x1080\nsin(x)");
  check("size: WxH 解釈", c1.size && c1.size.w === 1920 && c1.size.h === 1080);
  const c2 = cfg("size: 800 600\nsin(x)");
  check("size: W H 解釈", c2.size && c2.size.w === 800 && c2.size.h === 600);

  // スカラー: pixel / pad / fps / seed
  const c3 = cfg("pixel: 4\npad: 32\nfps: 25\nseed: 7\nsin(x)");
  check("pixel/pad/fps/seed 解釈", c3.pixel === 4 && c3.pad === 32 && c3.fps === 25 && c3.seed === 7);

  // 未指定は null
  const c4 = cfg("sin(x)");
  check("未指定は null", c4.size === null && c4.pixel === null && c4.seed === null);

  // view と併用・本体は通る／ディレクティブは本体から除去される
  const p5 = compile("size: 1024x1024\npixel: 8\nview: contour(6)\nworley(x*5, y*5)");
  check("size+pixel+view 併用", p5.config.size.w === 1024 && p5.config.pixel === 8 && p5.config.view.mode === "contour");
  check("ディレクティブ除去後も式は評価できる", Number.isFinite(p5.sample(0.3, 0.3, 0)));

  // field{} 内の channel 構文（u:）はディレクティブと衝突しない
  const p6 = compile("seed: 3\nfield {\n u: { init: 1\n step: u }\n v: { init: 2\n step: v }\n show: u\n}");
  check("field channel と非衝突", p6.kind === "cells" && p6.config.seed === 3);

  // 本体の後ろに置いてもよい
  const c7 = cfg("sin(x)\nseed: 99");
  check("ディレクティブは本体後でも可", c7.seed === 99);

  // エラー
  for (const [src, label] of [
    ["size: 1920\nsin(x)", "size 高さ欠落"],
    ["pixel: x\nsin(x)", "pixel 非数値"],
  ]) {
    let caught = null;
    try { compile(src); } catch (e) { caught = e; }
    check(`directive: ${label} errors`, caught instanceof LangError);
  }
}

// 8f) 改行を跨いだ式（括弧内は改行自由・演算子の前後で改行可）
{
  const ev = (src) => compile(src).sample(0.3, 0.3, 0.5, 1);
  check("nl: op at line start", Number.isFinite(ev("sin(x)\n+ 0.5")));
  check("nl: op at line end", Number.isFinite(ev("sin(x) +\n0.5")));
  check("nl: after comma", Number.isFinite(ev("dist(x, y,\n0.5, 0.5)")));
  check("nl: after open paren", Number.isFinite(ev("sin(\nx*8)")));
  check("nl: before close paren", Number.isFinite(ev("sin(x*8\n)")));
  check("nl: mult at line end (in parens)", Number.isFinite(ev("(sin(x) *\ncos(y))")));
  // ブロック構文の SEP（文区切り）は維持される
  check("nl: value block 維持", Number.isFinite(ev("s = 0\nrepeat 3 as k {\n s = s + k\n}\ns")));
  const surf = { width: () => 4, height: () => 4, blitField: () => {}, present: () => {} };
  let ok = true;
  try { compile("field {\n init: 1\n step: s + lap()\n show: s\n}").render(surf, 0, 0); } catch { ok = false; }
  check("nl: field block 維持", ok);
}

// 8e) 大小文字を区別しない（SYNESTA は大文字表示前提。PIXEL と pixel が同じ見た目）
{
  // 関数 / 定数 / 変数を大文字で書いても通る
  check("ci: SIN(X*TAU) == sin(x*tau)", approx(compile("SIN(X * TAU)").sample(0.25, 0, 0), 1, 1e-9));
  // ディレクティブ・方式名も大文字で通る（小文字へ畳まれる）
  const c = compile("PIXEL: 8\nVIEW: DITHER(2)\nSIN(X)").config;
  check("ci: PIXEL directive", c.pixel === 8);
  check("ci: VIEW DITHER mode folded", c.view && c.view.mode === "dither");
  // field{} のキーワード・チャンネルも大文字で通る
  const surf = { width: () => 4, height: () => 4, blitField: () => {}, present: () => {} };
  let ok = true;
  try { compile("FIELD {\n U: { INIT: 1\n STEP: U }\n SHOW: U\n}").render(surf, 0, 0); }
  catch { ok = false; }
  check("ci: uppercase field/channel keywords", ok);
}

// 9) makeBufferSurface: 全モードを 1-bit バッファで受ける（SYNESTA 統合の土台）
{
  // 場: level 1 → 全 on / level 0 → 全 off
  {
    const s = makeBufferSurface(8, 8);
    compile("1").render(s, 0, 0);
    check("bufsurf: field level 1 → all on", s.buf.every((v) => v === 1));
    compile("0").render(s, 0, 0);
    check("bufsurf: field level 0 → all off", s.buf.every((v) => v === 0));
  }
  // 描画: point が画素を立てる（[0,1]→px）
  {
    const s = makeBufferSurface(10, 10);
    compile("draw {\n clear\n point(0.0, 0.0)\n point(0.9, 0.9)\n}").render(s, 0, 0);
    check("bufsurf: point sets pixels", s.buf[0] === 1 && s.buf[9 * 10 + 9] === 1);
  }
  // 描画: 横線
  {
    const s = makeBufferSurface(10, 10);
    compile("draw {\n clear\n line(0, 0, 0.9, 0)\n}").render(s, 0, 0);
    let row0 = true;
    for (let x = 0; x < 10; x++) if (!s.buf[x]) row0 = false;
    check("bufsurf: horizontal line", row0);
  }
  // 状態場: バッファサーフェスでも step が進む（coarsen 風を数ステップ）
  {
    const s = makeBufferSurface(16, 16);
    const p = compile(
      "field {\n init: rnd(x*20, y*20)\n step: clamp(s + (sum8()/8 - 0.5)*0.5, 0, 1)\n show: step(0.5, s)\n}",
    );
    for (let i = 0; i < 5; i++) p.render(s, i * 0.05, 0);
    check("bufsurf: cells render into buffer (0|1)", s.buf.every((v) => v === 0 || v === 1));
  }
}

// 10) format: トークン再出力フォーマッタ（意味不変・コメント保持・折り返しなし）
{
  const f = format;
  check("fmt: spacing", f("1+2*3") === "1 + 2 * 3");
  check("fmt: call & comma", f("mix( a,b )") === "mix(a, b)");
  check("fmt: unary tight", f("sin(-1.4*y)") === "sin(-1.4 * y)");
  check("fmt: parens preserved", f("(a+b)*c") === "(a + b) * c");
  check("fmt: number字面 preserved", f("1.0 + .5") === "1.0 + .5");
  check(
    "fmt: draw block indents + 1文1行",
    f("draw{clear\nx=0;y=0}") === "draw {\n  clear\n  x = 0\n  y = 0\n}",
  );
  check(
    "fmt: field sections",
    f("field{init:0\nstep:s+lap()\nshow:s}") ===
      "field {\n  init: 0\n  step: s + lap()\n  show: s\n}",
  );
  check(
    "fmt: nested repeat indent",
    f("draw{repeat 2 as i{point(i,0)}}") ===
      "draw {\n  repeat 2 as i {\n    point(i, 0)\n  }\n}",
  );
  check(
    "fmt: channel block indents",
    f("field{u:{init:1\nstep:u+lap()}\nshow:u}") ===
      "field {\n  u: {\n    init: 1\n    step: u + lap()\n  }\n  show: u\n}",
  );
  check(
    "fmt: view directive",
    f("view:dither(2)\nsin(x*8)") === "view: dither(2)\nsin(x * 8)",
  );
  check("fmt: line comment kept", f("1 + 2 // hi") === "1 + 2 // hi");
  check("fmt: own-line comment kept", f("// head\n1") === "// head\n1");
  // 空行は消さない（連続は 1 行に畳む）。先頭/末尾の空行は除去。
  check("fmt: blank line kept (collapsed to 1)", f("1\n\n\n2") === "1\n\n2");
  check("fmt: single newline = no blank", f("1\n2") === "1\n2");
  check("fmt: leading/trailing blanks stripped", f("\n\n1\n\n") === "1");
  check("fmt: blank between sections kept", f("seed: 1\n\nsin(x)") === "seed: 1\n\nsin(x)");
  check("fmt: idempotent", f(f("(a+b)*c")) === f("(a+b)*c"));
  check("fmt: blank idempotent", f(f("1\n\n2")) === f("1\n\n2"));
  check("fmt: lex error → unchanged", f("1 + /* open") === "1 + /* open");
}

// 11) 言語拡張: worley（stdlib）+ Tier0 値ブロック（文＋最終式）
{
  // worley は [0,1] & seed で変わる
  {
    const f = compileField("worley(x*4, y*4)");
    let ok = true;
    for (let i = 0; i < 60; i++) {
      const v = f.sample(Math.random(), Math.random(), 0, 0);
      if (v < -0.01 || v > 1.01) ok = false;
    }
    check("worley in [0,1]", ok);
    check(
      "worley seed-varies",
      !approx(f.sample(0.3, 0.7, 0, 0), f.sample(0.3, 0.7, 0, 9)),
    );
  }
  // 値ブロック: 代入 → 最終式
  check("block: assign then value", approx(compileField("a = 5\na * 2").sample(0, 0, 0), 10));
  check("block: uses x", approx(compileField("a = 2\na * x").sample(0.5, 0, 0), 1));
  // 値ブロック: repeat 総和（0+1+2 = 3）
  check(
    "block: repeat sum",
    approx(compileField("s = 0\nrepeat 3 as k { s = s + k }\ns").sample(0, 0, 0), 3),
  );
  // 値ブロックは "field" 形
  check("block is field kind", compile("a=1\na").kind === "field");
  // 素の式（文なし）は従来どおり（改行をまたぐ単一式も）
  check("plain expr still works", approx(compileField("sin(0)\n + 1").sample(0, 0, 0), 1));
  // エラー: 最終の値式が無い / 値式が複数
  for (const [src, label] of [
    ["a = 5", "needs final value"],
    ["1\n2", "one value only"],
  ]) {
    let caught = null;
    try {
      compileField(src);
    } catch (e) {
      caught = e;
    }
    check(`block: ${label} errors`, caught instanceof LangError);
  }
  // julia 風: 反復（発散を避けるため毎ステップ z をクランプ＝簡易 bailout）。
  // NaN を出さず、位置で値が変わる。
  {
    const julia =
      "zr = x*3 - 1.5\nzi = y*3 - 1.5\nm = 0\nrepeat 24 {\n t = clamp(zr*zr - zi*zi - 0.8, -4, 4)\n zi = clamp(2*zr*zi + 0.156, -4, 4)\n zr = t\n m = m + (zr*zr + zi*zi)\n}\nclamp(1 - m/200, 0, 1)";
    const f = compileField(julia);
    let finite = true,
      varied = false,
      first = null;
    for (let i = 0; i < 50; i++) {
      const v = f.sample(Math.random(), Math.random(), 0, 0);
      if (!Number.isFinite(v)) finite = false;
      if (first === null) first = v;
      else if (!approx(v, first)) varied = true;
    }
    check("block: julia iteration finite", finite);
    check("block: julia iteration varies", varied);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
