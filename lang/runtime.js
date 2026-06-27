/**
 * @module lang/runtime
 * runtime.js — ソース文字列 → 場（field）へコンパイルし、サーフェスへ描く。
 *
 * Tier0: ソースは「x, y, t（と seed）から場の値を返す式」。
 *   座標は x,y ∈ [0,1]（アスペクトは将来対応）。t は時間（秒相当）。
 *   返り値はインク level として扱う（ディザが [0,1] にクランプ）。
 *
 * 設計: 言語本体は surface 契約だけに依存。SYNESTA でも playground でも同一。
 */

import { parse, parseProgram } from "./core/parser.js";
import { compileExpr, compileDraw } from "./core/interp.js";
import { setSeed } from "./stdlib.js";

/**
 * @param {string} src
 * @returns {{ sample:(x:number,y:number,t:number,seed?:number)=>number,
 *             render:(surface:object, t?:number, seed?:number)=>void }}
 * @throws {LangError} 構文/評価エラー（message, pos を持つ）
 */
export function compileField(src) {
  return compileFieldAst(parse(src)); // 構文エラーは parse で投げる
}

/** 既に解析済みの式 AST から場 runner を作る（compile が view 抽出後に使う）。 */
function compileFieldAst(ast) {
  const exprFn = compileExpr(ast); // AST を 1 度だけクロージャ化（per-pixel を高速に）
  const env = { vars: { x: 0, y: 0, t: 0, seed: 0 } };

  function sample(x, y, t = 0, seed = 0) {
    setSeed(seed); // rnd/noise/fbm が seed を取り込む
    env.vars.x = x;
    env.vars.y = y;
    env.vars.t = t;
    env.vars.seed = seed;
    return exprFn(env);
  }

  function render(surface, t = 0, seed = 0) {
    const w = surface.width();
    const h = surface.height();
    const buf = new Float32Array(w * h);
    for (let yy = 0; yy < h; yy++) {
      const ny = h > 1 ? yy / (h - 1) : 0;
      for (let xx = 0; xx < w; xx++) {
        const nx = w > 1 ? xx / (w - 1) : 0;
        buf[yy * w + xx] = sample(nx, ny, t, seed);
      }
    }
    surface.blitField(buf, w, h);
    surface.present();
  }

  return { sample, render };
}

/**
 * Tier2: 状態を持つ場 `field { … }` を runner にする（単一/多チャンネル）。
 *
 * 各セルがチャンネルごとにスカラー状態を持ち、毎フレーム step で更新する
 * （ping-pong バッファ・同期更新：全チャンネルの next を旧 curr から計算→一括 swap）。
 *   - 定数 (consts): フレーム単位で 1 回評価（env は {t, seed}。x,y 不可＝パラメータ）。
 *   - init: (定数, x, y, seed) → 各チャンネルの初期状態。
 *   - step: (定数, 全チャンネルの現在値, x, y, t) ＋近傍 lap()/nbr()/sum8()。
 *           近傍は「いま評価中のチャンネル」の旧バッファを wrap（トーラス）参照する。
 *   - show: (定数, 全チャンネルの現在値, x, y, t) → 表示 level。
 * 単一チャンネル(v1)は channels=[{name:"s",…}] として同じ経路で動く。
 * @param {{consts:Array, channels:Array, show:object}} prog
 * @returns {{ render:(surface:object, t?:number, seed?:number)=>void, kind:string }}
 */
function compileCells(prog) {
  const chans = prog.channels; // [{ name, init, step }]
  const consts = prog.consts || [];
  const N = chans.length;
  // AST を 1 度だけクロージャ化（per-cell × チャンネルの評価を高速に）。
  const constFns = consts.map((c) => ({ name: c.name, fn: compileExpr(c.expr) }));
  const chanNames = chans.map((c) => c.name);
  const initFns = chans.map((c) => compileExpr(c.init));
  const stepFns = chans.map((c) => compileExpr(c.step));
  const showFn = compileExpr(prog.show);

  let W = 0,
    H = 0,
    curr = null, // Float32Array[N]
    next = null, // Float32Array[N]
    inited = false,
    lastSeed = null;

  function alloc(w, h) {
    W = w;
    H = h;
    curr = chans.map(() => new Float32Array(w * h));
    next = chans.map(() => new Float32Array(w * h));
  }

  /** 定数をフレーム単位で評価（後の定数は前の定数を参照可）→ env.vars へマージ用 */
  function evalConsts(vars) {
    const env = { vars };
    for (const c of constFns) vars[c.name] = c.fn(env);
    return vars;
  }

  function initState(seed) {
    setSeed(seed);
    const env = { vars: evalConsts({ t: 0, seed }) };
    for (let yy = 0; yy < H; yy++) {
      const ny = H > 1 ? yy / (H - 1) : 0;
      for (let xx = 0; xx < W; xx++) {
        const idx = yy * W + xx;
        env.vars.x = W > 1 ? xx / (W - 1) : 0;
        env.vars.y = ny;
        for (let ci = 0; ci < N; ci++) curr[ci][idx] = initFns[ci](env);
      }
    }
    inited = true;
    lastSeed = seed;
  }

  function step(t, seed) {
    setSeed(seed);
    let xx = 0,
      yy = 0,
      curBuf = null, // いま評価中チャンネルの旧バッファ
      curS = 0; // いま評価中チャンネルの現在セル値
    const at = (gx, gy) => {
      gx = ((gx % W) + W) % W;
      gy = ((gy % H) + H) % H;
      return curBuf[gy * W + gx];
    };
    // funcs は 1 度だけ作り、curBuf/curS/xx/yy の現在値をクロージャで参照（割当ゼロ）。
    // 近傍は「いま評価中のチャンネル」の旧バッファを wrap（トーラス）参照する。
    const funcs = {
      nbr: (dx, dy) => at(xx + Math.round(dx), yy + Math.round(dy)),
      lap: () =>
        at(xx - 1, yy) + at(xx + 1, yy) + at(xx, yy - 1) + at(xx, yy + 1) -
        4 * curS,
      sum8: () =>
        at(xx - 1, yy - 1) +
        at(xx, yy - 1) +
        at(xx + 1, yy - 1) +
        at(xx - 1, yy) +
        at(xx + 1, yy) +
        at(xx - 1, yy + 1) +
        at(xx, yy + 1) +
        at(xx + 1, yy + 1),
    };
    const env = { vars: evalConsts({ t, seed }), funcs };
    for (yy = 0; yy < H; yy++) {
      const ny = H > 1 ? yy / (H - 1) : 0;
      for (xx = 0; xx < W; xx++) {
        const idx = yy * W + xx;
        env.vars.x = W > 1 ? xx / (W - 1) : 0;
        env.vars.y = ny;
        // 全チャンネルの現在値を env へ（同期更新：step は旧 curr のみ参照）
        for (let ci = 0; ci < N; ci++) env.vars[chanNames[ci]] = curr[ci][idx];
        for (let ci = 0; ci < N; ci++) {
          curBuf = curr[ci];
          curS = curBuf[idx];
          next[ci][idx] = stepFns[ci](env);
        }
      }
    }
    for (let ci = 0; ci < N; ci++) {
      const tmp = curr[ci];
      curr[ci] = next[ci];
      next[ci] = tmp;
    }
  }

  function render(surface, t = 0, seed = 0) {
    const w = surface.width();
    const h = surface.height();
    if (!inited || w !== W || h !== H || seed !== lastSeed) {
      alloc(w, h);
      initState(seed);
    }
    step(t, seed);
    // show: 現在状態 → 表示 level
    setSeed(seed);
    const out = new Float32Array(W * H);
    const env = { vars: evalConsts({ t, seed }) };
    for (let yy = 0; yy < H; yy++) {
      const ny = H > 1 ? yy / (H - 1) : 0;
      for (let xx = 0; xx < W; xx++) {
        const idx = yy * W + xx;
        env.vars.x = W > 1 ? xx / (W - 1) : 0;
        env.vars.y = ny;
        for (let ci = 0; ci < N; ci++) env.vars[chanNames[ci]] = curr[ci][idx];
        out[idx] = showFn(env);
      }
    }
    surface.blitField(out, W, H);
    surface.present();
  }

  return { kind: "cells", render };
}

/**
 * プログラムをコンパイルし、形（場/描画/状態場）を自動判別した runner を返す。
 * 全モードとも render(surface, t, seed) を持つ（playground はこれだけ呼ぶ）。
 *  - 場(field): 全セルに式を評価して 1-bit へ（毎フレーム全面更新）。
 *  - 描画(draw): draw ブロックを実行し命令を発行（自動クリアなし＝蓄積可）。
 *  - 状態場(cells): field{init/step/show}。状態を保持し毎フレーム step（反応拡散/CA/成長）。
 * 返り値には設定ディレクティブ `config`（{ view, canvas, pad, fps, seed, period }。未指定は null）が
 * 付く。`view` も別途公開（= config.view）。いずれもコアはラスタライズ・適用せず、
 * ホスト（surface / 出力）が既定値・範囲とともに解釈する＝表示・出力はホストの責務のまま。
 * @param {string} src
 * @returns {{ render:Function, kind:string, view:object|null, config:object }}
 */
export function compile(src) {
  const prog = parseProgram(src); // 構文エラーはここで投げる
  const view = prog.view || null;
  const config = prog.config;
  if (prog.kind === "draw") {
    const run = compileDraw(prog.body); // AST を 1 度だけクロージャ化
    return {
      kind: "draw",
      view,
      config,
      render(surface, t = 0, seed = 0) {
        setSeed(seed);
        run(surface, t, seed);
        surface.present();
      },
    };
  }
  if (prog.kind === "cells") return { ...compileCells(prog), view, config };
  return { kind: "field", view, config, ...compileFieldAst(prog.expr) };
}
