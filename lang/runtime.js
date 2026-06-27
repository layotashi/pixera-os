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
import { compileExpr } from "./core/interp.js";
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

/** 既に解析済みの式 AST から場 runner を作る（compile が directive 抽出後に使う）。 */
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
 * ソースをコンパイルし、場 runner を返す。render(surface, t, seed) を持つ
 * （playground はこれだけ呼ぶ）。全セルに式を評価して 1-bit へ（毎フレーム全面更新）。
 * 返り値には設定ディレクティブ `config`（{ view, canvas, pad, fps, seed, period }。未指定は null）が
 * 付く。コアはラスタライズ・適用せず、ホスト（surface / 出力）が既定値・範囲とともに
 * 解釈する＝表示・出力はホストの責務のまま。
 * @param {string} src
 * @returns {{ render:Function, sample:Function, config:object }}
 */
export function compile(src) {
  const prog = parseProgram(src); // 構文エラーはここで投げる
  return { config: prog.config, ...compileFieldAst(prog.expr) };
}
