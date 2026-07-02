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

// 8c) view: 表示ディレクティブ（コア不透明データ。ラスタライズはホスト）
{
  const isView = (v, mode, args) =>
    v != null &&
    v.mode === mode &&
    v.args.length === args.length &&
    v.args.every((a, i) => a === args[i]);

  const p1 = compile("view: dither(2)\nsin(x)");
  check("view: 場の式に付く", isView(p1.config.view, "dither", [2]));
  check("view: 本体の式は通る", approx(p1.sample(0, 0, 0), 0)); // sin(0)=0

  check("view: 無いと null", compile("sin(x)").config.view === null);
  check("view: 本体の後ろでも可", isView(compile("sin(x)\nview: dither(3)").config.view, "dither", [3]));
  check("view: 複数引数", isView(compile("view: halftone(2, 8)\nsin(x)").config.view, "halftone", [2, 8]));

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

// 8d) 設定ディレクティブ（canvas/pad/fps/seed/period）。コア不透明データ・適用はホスト。
{
  const cfg = (src) => compile(src).config;

  // canvas: WxH（NUM + "xNNN" ID に字句化される）／ W H（2 数値）
  const c1 = cfg("canvas: 1920x1080\nsin(x)");
  check("canvas: WxH 解釈", c1.canvas && c1.canvas.w === 1920 && c1.canvas.h === 1080);
  const c2 = cfg("canvas: 800 600\nsin(x)");
  check("canvas: W H 解釈", c2.canvas && c2.canvas.w === 800 && c2.canvas.h === 600);
  // W・H は定数式可（他のスカラー系と同様）
  const c2e = cfg("canvas: 480*2 360*2\nsin(x)");
  check("canvas: 式 W H 解釈", c2e.canvas && c2e.canvas.w === 960 && c2e.canvas.h === 720);
  const c2g = cfg("canvas: 480*2x720\nsin(x)");
  check("canvas: 式 + glued 高さ", c2g.canvas && c2g.canvas.w === 960 && c2g.canvas.h === 720);

  // スカラー: pad / fps / seed / period
  const c3 = cfg("pad: 32\nfps: 25\nseed: 7\nsin(x)");
  check("pad/fps/seed 解釈", c3.pad === 32 && c3.fps === 25 && c3.seed === 7);
  const cl = cfg("period: 5\nsin(x - t)");
  check("period: 秒 解釈", cl.period === 5);
  // 定数式（pi/tau・四則）も受ける
  check("period: tau 解釈", Math.abs(cfg("period: tau\nsin(x - t)").period - Math.PI * 2) < 1e-9);
  check("period: 2*pi 解釈", Math.abs(cfg("period: 2*pi\nsin(x - t)").period - Math.PI * 2) < 1e-9);
  check("period: pi/2 解釈", Math.abs(cfg("period: pi/2\nsin(x - t)").period - Math.PI / 2) < 1e-9);
  // 変数や関数は定数でないのでエラー
  {
    let caught = null;
    try { cfg("period: x\nsin(x)"); } catch (e) { caught = e; }
    check("period: 変数はエラー", caught instanceof LangError);
  }

  // 未指定は null
  const c4 = cfg("sin(x)");
  check("未指定は null", c4.canvas === null && c4.pad === null && c4.seed === null && c4.period === null);

  // view と併用・本体は通る／ディレクティブは本体から除去される
  const p5 = compile("canvas: 1024x1024\npad: 16\nview: contour(6)\nworley(x*5, y*5)");
  check("canvas+pad+view 併用", p5.config.canvas.w === 1024 && p5.config.pad === 16 && p5.config.view.mode === "contour");
  check("ディレクティブ除去後も式は評価できる", Number.isFinite(p5.sample(0.3, 0.3, 0)));

  // 本体の後ろに置いてもよい
  const c7 = cfg("sin(x)\nseed: 99");
  check("ディレクティブは本体後でも可", c7.seed === 99);

  // エラー
  for (const [src, label] of [
    ["canvas: 1920\nsin(x)", "canvas 高さ欠落"],
    ["fps: sin(0)\nsin(x)", "fps に関数は不可"],
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
}

// 8e) 大小文字を区別しない（SYNESTA は大文字表示前提。CANVAS と canvas が同じ見た目）
{
  // 関数 / 定数 / 変数を大文字で書いても通る
  check("ci: SIN(X*TAU) == sin(x*tau)", approx(compile("SIN(X * TAU)").sample(0.25, 0, 0), 1, 1e-9));
  // ディレクティブ・方式名も大文字で通る（小文字へ畳まれる）
  const c = compile("SEED: 8\nVIEW: DITHER(2)\nSIN(X)").config;
  check("ci: SEED directive", c.seed === 8);
  check("ci: VIEW DITHER mode folded", c.view && c.view.mode === "dither");
}

// 9) makeBufferSurface: 場を 1-bit バッファで受ける（SYNESTA 統合の土台）
{
  // 場: level 1 → 全 on / level 0 → 全 off
  {
    const s = makeBufferSurface(8, 8);
    compile("1").render(s, 0, 0);
    check("bufsurf: field level 1 → all on", s.buf.every((v) => v === 1));
    compile("0").render(s, 0, 0);
    check("bufsurf: field level 0 → all off", s.buf.every((v) => v === 0));
  }
  // 場（ディザ）: チェッカー状の中間値は 0|1 のみへ落ちる
  {
    const s = makeBufferSurface(16, 16);
    compile("sin(x*20)*cos(y*20)*0.5 + 0.5").render(s, 0, 0);
    check("bufsurf: field dithers to 0|1", s.buf.every((v) => v === 0 || v === 1));
  }
}

// 10) format: トークン再出力フォーマッタ（意味不変・コメント保持・折り返しなし）
{
  const f = format;
  // 優先順位ベース: `+ -` は空け、`* / % ^` は詰める。
  check("fmt: spacing (precedence)", f("1+2*3") === "1 + 2*3");
  check("fmt: tight ops", f("a/b%c^d") === "a/b%c^d");
  check("fmt: mixed precedence", f("a*b+c*d") === "a*b + c*d");
  check("fmt: call & comma", f("mix( a,b )") === "mix(a, b)");
  check("fmt: unary tight", f("sin(-1.4*y)") === "sin(-1.4*y)");
  check("fmt: parens & tight", f("(a+b)*c") === "(a + b)*c");
  // 数値正準化: 先頭/末尾ゼロを落とす（GLSL/tixy 慣習・39桁節約・意味不変）。
  check("fmt: number canon (.5 / 1.0->1)", f("0.5 + 1.0") === ".5 + 1");
  check("fmt: number canon (trailing zeros)", f("2.00 + 1.50 + .250") === "2 + 1.5 + .25");
  check("fmt: number canon (int kept)", f("30 + 0 + 8") === "30 + 0 + 8");
  check(
    "fmt: repeat block indents + 1文1行",
    f("repeat 2 as i{x=0;y=0}\ns") === "repeat 2 as i {\n  x = 0\n  y = 0\n}\ns",
  );
  check(
    "fmt: nested repeat indent",
    f("repeat 2 as i{repeat 2 as j{s=i}}\ns") ===
      "repeat 2 as i {\n  repeat 2 as j {\n    s = i\n  }\n}\ns",
  );
  check(
    "fmt: view directive",
    f("view:dither(2)\nsin(x*8)") === "view: dither(2)\nsin(x*8)",
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

  // ── TESS 専用: 39桁折り返し(A) / ディレクティブ整列(B) / 代入整列(C) / コメント(E) ──
  const allFit = (s) => f(s).split("\n").every((l) => l.length <= 40);
  const idem = (s) => f(f(s)) === f(s);

  // B: 順不同ディレクティブ → 正準順(canvas→pad→fps→period→seed→view) + コロン揃え
  check(
    "fmt(B): directive reorder + colon align",
    f("view: dither(2)\nseed: 0\ncanvas: 1080x1080\npad: 80") ===
      "canvas: 1080x1080\npad:    80\nseed:   0\nview:   dither(2)",
  );
  check("fmt(B): lone directive unchanged", f("seed:1\nx") === "seed: 1\nx");

  // C: 同深度で連続する代入の `=` を揃える（39桁内のみ）
  check("fmt(C): assignment = align", f("ax = 1\nbbb = 2\nc = 3") === "ax  = 1\nbbb = 2\nc   = 3");
  check(
    "fmt(C): align guard (would overflow → stay unaligned)",
    f("a = sin(x*8) + sin(y*8) + cos(x*8)\nlongername = 0").split("\n")[0] ===
      "a = sin(x*8) + sin(y*8) + cos(x*8)",
  );

  // A1: 括弧内の長い和を 39桁で折る（全行 ≤39・演算子先頭レール・冪等）
  const a1 = "(sin(x*9 - t) + sin(y*9 + t) + sin((x + y)*9 - t) + cos(x*9 - t))*0.5 + 0.5";
  check("fmt(A1): wraps inside parens, all lines <=39", allFit(a1));
  check("fmt(A1): operator-leading rail", /\n\+ /.test(f(a1)));
  check("fmt(A1): idempotent", idem(a1));

  // A2: 括弧の無い深度0の長い和 → グルーピング括弧を補って折る
  const a2 = "aaaa + bbbb + cccc + dddd + eeee + ffff + gggg + hhhh";
  check("fmt(A2): inserts grouping paren + wraps <=39", allFit(a2) && f(a2).startsWith("( "));
  check("fmt(A2): idempotent", idem(a2));

  // E: 単独行コメントも正規化（`//x` → `// x`）
  check("fmt(E): own-line comment normalized", f("//hi\n1") === "// hi\n1");
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
  // 値ブロックも 1 本の式としてコンパイル・評価できる
  check("block compiles & evaluates", approx(compile("a=1\na").sample(0, 0, 0), 1));
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
