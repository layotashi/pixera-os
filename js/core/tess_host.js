/**
 * @module core/tess_host
 * tess_host.js — Tessera ディレクティブ解決 & 場サーフェス生成 (ホスト共通)
 *
 * lang/ の Tessera コアは「config は不透明データ、実効設定への解決はホストの
 * 責務」という方針。その解決 (既定値・クランプ・fps スナップ・view→パラメータ)
 * と、場 (0..1) を 1-bit へ描くサーフェス生成を、TESSERA アプリ (プレビュー /
 * 書き出し) と壁紙 (live-render) で共有し、二重定義による乖離を防ぐ。
 *
 * tessera は size/pad/pixel/fps/seed/period を、壁紙は seed/period/fps/aspect/
 * view を同じ resolveTessConfig() の結果から取り出す。
 */

import { renderField } from "./field_render.js";
import { makeBufferSurface } from "../../lang/surface.js";

/** period 既定 (t を sin/cos に通す作例の 1 周期)。 */
export const TAU = Math.PI * 2;

/** 動画 1 本の上限秒 (period をこの長さでクランプ)。 */
export const PERIOD_CAP_S = 30;

/**
 * 1 アートドット = 8 出力px (チャンキーさ = Tessera の identity)。pixel は 8 固定。
 * base = canvas / PIXEL の解像度で描き、整数 ×PIXEL で書き出す。
 */
export const PIXEL = 8;

/**
 * fps 候補。全て 100 の約数 (GIF の遅延はセンチ秒(1/100s)整数なので、約数で
 * ないと round(100/fps) の丸めで速度・ループ長がズレる。MP4 は μ秒で不問だが統一)。
 */
export const FPS_OPTIONS = [5, 10, 20, 25, 50, 100];

/** 場方式の既定パラメータ (view: で個別指定が無いとき)。 */
export const MODE_PARAMS = { ditherSize: 2, hatchPitch: 4, halftoneCell: 6 };

/** view: 引数 (数値) を field_render パラメータへ写す。各モードは args[0] を使う。 */
export const VIEW_PARAM = {
  dither: "ditherSize",
  braille: "ditherSize",
  hatch: "hatchPitch",
  halftone: "halftoneCell",
};

const DEFAULTS = { sizeW: 1080, sizeH: 1080, pad: 80, fps: 20, seed: 0, period: TAU };

const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const clampF = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const nearest = (v, arr) =>
  arr.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

/**
 * view ディレクティブ (不透明データ) を field_render の { mode, params } へ解決する。
 * dither/braille/hatch/halftone のみ引数を写す。ascii など field_render 外の mode は
 * ここでは dither へフォールバックする (ascii を描き分けるホストは別途 mode を扱う)。
 * @returns {{ mode: string, params: object }}
 */
export function resolveView(view) {
  const params = { ...MODE_PARAMS };
  if (view && VIEW_PARAM[view.mode]) {
    if (view.args && view.args.length) {
      params[VIEW_PARAM[view.mode]] = view.args[0];
    }
    return { mode: view.mode, params };
  }
  return { mode: "dither", params };
}

/**
 * compile 済み config (不透明データ) を実効設定へ解決する。
 * canvas 16..4096 / pad の各辺クランプ / fps スナップ / period 上限を一元化。
 * @param {object} config  program.config (無ければ既定)
 * @returns {{ sizeW:number, sizeH:number, pixel:number, pad:number, fps:number,
 *             seed:number, period:number, aspect:number,
 *             viewMode:string, viewParams:object }}
 */
export function resolveTessConfig(config) {
  const c = config || {};
  const canvas = c.canvas || {};
  const sizeW = clampI(canvas.w ?? DEFAULTS.sizeW, 16, 4096);
  const sizeH = clampI(canvas.h ?? DEFAULTS.sizeH, 16, 4096);
  const pixel = PIXEL;
  const fps = nearest(c.fps ?? DEFAULTS.fps, FPS_OPTIONS);
  const seed = clampI(c.seed ?? DEFAULTS.seed, 0, 999999);
  // pad (出力px) は base 上で各辺がアート(≥4px)を潰さない範囲にクランプ。
  const padMax = Math.max(
    0,
    Math.floor((Math.min(sizeW, sizeH) / pixel - 4) / 2) * pixel,
  );
  const pad = clampI(c.pad ?? DEFAULTS.pad, 0, padMax);
  // period (秒) = プレビュー周期かつ動画長。既定 tau、上限 PERIOD_CAP_S。
  const period = clampF(c.period ?? DEFAULTS.period, 0.1, PERIOD_CAP_S);
  const aspect = sizeH ? sizeW / sizeH : 1;
  const view = resolveView(c.view);
  return {
    sizeW,
    sizeH,
    pixel,
    pad,
    fps,
    seed,
    period,
    aspect,
    viewMode: view.mode,
    viewParams: view.params,
  };
}

/**
 * 場 (0..1) を 1-bit へ描く field_render 方式のオフスクリーンサーフェスを作る。
 * ホストは surf を program.render() へ渡し、描画後に surf.buf (Uint8Array 0|1) を読む。
 * ascii など field_render 外の方式は呼び出し側で別途 surface を組む。
 * @returns {object} makeBufferSurface の契約 + `.buf`
 */
export function makeFieldSurface(w, h, viewMode, viewParams) {
  const surf = makeBufferSurface(w, h);
  surf.blitField = (field, fw, fh) =>
    renderField(field, fw, fh, surf.buf, viewMode, viewParams);
  return surf;
}
