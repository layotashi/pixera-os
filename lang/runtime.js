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

import { parse } from "./core/parser.js";
import { evalNode } from "./core/interp.js";
import { setSeed } from "./stdlib.js";

/**
 * @param {string} src
 * @returns {{ sample:(x:number,y:number,t:number,seed?:number)=>number,
 *             render:(surface:object, t?:number, seed?:number)=>void }}
 * @throws {LangError} 構文/評価エラー（message, pos を持つ）
 */
export function compileField(src) {
  const ast = parse(src); // 構文エラーはここで投げる
  const env = { vars: { x: 0, y: 0, t: 0, seed: 0 } };

  function sample(x, y, t = 0, seed = 0) {
    setSeed(seed); // rnd/noise/fbm が seed を取り込む
    env.vars.x = x;
    env.vars.y = y;
    env.vars.t = t;
    env.vars.seed = seed;
    return evalNode(ast, env);
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
