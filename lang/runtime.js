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
import { setSeed, setAudioClock, FUNCS } from "./stdlib.js";

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
  const env = { vars: { x: 0, y: 0, t: 0, seed: 0, amp: 0 } };

  function sample(x, y, t = 0, seed = 0) {
    setSeed(seed); // rnd/noise/fbm が seed を取り込む
    env.vars.x = x;
    env.vars.y = y;
    env.vars.t = t;
    env.vars.seed = seed;
    return exprFn(env);
  }

  // opts で AV 同期の uniform を渡せる（ホストが毎フレーム設定・視覚の場から読める）:
  //   opts.period → 音クロックを共有し、視覚の場でも beat(n)/step(n)/decay が t に同期する
  //   opts.amp    → 音の振幅エンベロープ [0,1]（フレーム定数＝オーディオリアクティブ）
  function render(surface, t = 0, seed = 0, opts = {}) {
    env.vars.amp = opts.amp || 0;
    setAudioClock(t, opts.period || Math.PI * 2); // フレーム内で一定
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
 * 音の場 a(t) を AST からコンパイルする。音は「時間の場」＝視覚の場と同じ式言語で、
 * t（秒）と seed から振幅 [-1,1] を返す純関数。オシレータ/拍は setAudioClock で
 * 渡す音クロックを暗黙に読む（stdlib）。出力は [-1,1] にクランプ。
 * @returns {{ sampleAudio:(t,seed,period)=>number,
 *             renderAudio:(sampleRate,seconds,seed,period)=>Float32Array }}
 */
function compileAudioAst(ast, voices = []) {
  const env = { vars: { t: 0, seed: 0, period: Math.PI * 2, f: 0 } };

  // 関数表 = stdlib（prototype）＋ voice（名前付き音色）。voice は呼ばれると f（周波数）を
  // 束縛して評価する＝上で音色を宣言し、下で名前を呼んで使う（作曲と音作りを分離）。
  const F = Object.create(FUNCS);
  const voiceNames = new Set(voices.map((v) => v.name));
  for (const v of voices) {
    const vFn = compileExpr(v.ast); // voice は stdlib + f のみ（voice 同士の呼び出しは不可）
    F[v.name] = (freq) => {
      env.vars.f = freq === undefined ? 0 : freq;
      return vFn(env, F);
    };
  }
  const exprFn = compileExpr(ast, voiceNames); // 音の場は voice を呼べる

  function sampleAudio(t, seed = 0, period = Math.PI * 2) {
    setSeed(seed);
    setAudioClock(t, period); // オシレータ/拍が読む音クロック
    env.vars.t = t;
    env.vars.seed = seed;
    env.vars.period = period;
    const v = exprFn(env, F);
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }

  /** seconds 秒ぶんを sampleRate で決定論オフラインレンダ（ループ再生・WAV 書き出し共用）。 */
  function renderAudio(sampleRate, seconds, seed = 0, period = Math.PI * 2) {
    const n = Math.max(1, Math.round(sampleRate * seconds));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = sampleAudio(i / sampleRate, seed, period);
    return out;
  }

  return { sampleAudio, renderAudio };
}

/**
 * ソースをコンパイルし、場 runner を返す。render(surface, t, seed) を持つ
 * （playground はこれだけ呼ぶ）。全セルに式を評価して 1-bit へ（毎フレーム全面更新）。
 * 返り値には設定ディレクティブ `config`（{ view, canvas, pad, fps, seed, period }。未指定は null）と、
 * `sound:` があれば音の場 `audio`（{ sampleAudio, renderAudio }。無ければ null）が付く。
 * コアはラスタライズ・適用・発音せず、ホスト（surface / 出力 / AudioContext）が
 * 既定値・範囲とともに解釈する＝表示・出力・発音はホストの責務のまま。
 * @param {string} src
 * @returns {{ render:Function, sample:Function, config:object, audio:(object|null) }}
 */
export function compile(src) {
  const prog = parseProgram(src); // 構文エラーはここで投げる
  const audio = prog.audio ? compileAudioAst(prog.audio, prog.voices) : null;
  return { config: prog.config, audio, ...compileFieldAst(prog.expr) };
}
