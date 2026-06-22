/**
 * smoke.mjs — node 動作確認（ブラウザ不要）。
 *   node lang/smoke.mjs
 * 式の評価・stdlib・エラー位置・場のレンダリング（ASCII プレビュー）を確認する。
 */
import { compileField } from "./runtime.js";
import { ditherField } from "./surface.js";
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

// 5a2) wave は [0,1]（オフセット不要）
{
  check("wave(0) = 0.5", approx(compileField("wave(0)").sample(0, 0, 0), 0.5));
  check(
    "wave(PI/2) = 1",
    approx(compileField("wave(PI/2)").sample(0, 0, 0), 1, 1e-9),
  );
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
  for (const name of ["pow", "hypot", "tan", "exp", "log", "round"]) {
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
