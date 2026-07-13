/**
 * @module app/synth/meter
 * meter.js — SYNTH フッタのレベル / リミッタ・メーターの純粋ロジック。
 *
 * 計測値 (core/audio.js の getMasterMeter が返す瞬時ピークとリミッタのゲイン
 * リダクション) から、フッタ表示用の状態 (ホールド付きピーク・リミッタ点灯の
 * 残り時間) を更新する。描画 (synth.js) と計測 (audio.js) から切り離した純関数
 * なので単体テストできる (ROLL の grid.js と同じ「描画に依存しない編集/表示モデル」)。
 *
 * ねらい: 波形音量とリミッタ作動を目視で確認しながら VOL を追い込めるようにする。
 * ピークは一瞬で立ち上がり、その後ゆっくり落ちる (VU 的な視認性)。リミッタ点灯は
 * 瞬間的な作動も見逃さないよう一定時間ホールドする。
 */

/** ピーク表示の減衰速度 (フルスケール / 秒)。1.0 から約 0.33 秒でゼロへ落ちる VU 感 */
export const PEAK_DECAY_PER_SEC = 3.0;

/** リミッタ作動とみなすゲインリダクション閾値 (dB)。これ以下 (より負) で点灯する。
 *  微小なノイズ的リダクションで点滅しないよう 0 から少しマージンを取る。 */
export const LIMITER_ON_DB = -0.5;

/** リミッタ点灯のホールド時間 (秒)。瞬間的な作動も視認できるよう保持する */
export const LIMITER_HOLD_SEC = 0.25;

/**
 * メーター表示状態の初期値。
 * @returns {{ peak:number, lim:number }} peak: 表示ピーク(0..∞) / lim: 点灯の残り秒
 */
export function initialMeterState() {
  return { peak: 0, lim: 0 };
}

/**
 * メーター表示状態を 1 フレーム進める純関数 (フレームレート非依存)。
 * ピークは新しい瞬時ピークへ即座に立ち上がり、そこから dt に比例して減衰する。
 * リミッタ点灯は reduction が閾値以下の間ホールド時間へリセットし、離れると dt で減る。
 *
 * @param {{peak:number, lim:number}} state  直前状態
 * @param {number} rawPeak    今回の瞬時ピーク (0..∞。負は 0 扱い)
 * @param {number} reduction  リミッタのゲインリダクション (dB, ≤0)
 * @param {number} dt         前フレームからの経過秒 (負は 0 扱い)
 * @returns {{peak:number, lim:number}} 新しい状態
 */
export function nextMeterState(state, rawPeak, reduction, dt) {
  const step = Math.max(0, dt);
  const decayed = state.peak - PEAK_DECAY_PER_SEC * step;
  const peak = Math.max(0, Math.max(rawPeak, decayed));
  const lim =
    reduction <= LIMITER_ON_DB
      ? LIMITER_HOLD_SEC
      : Math.max(0, state.lim - step);
  return { peak, lim };
}

/**
 * リミッタ点灯中か (ホールド残あり)。フッタの LIM バッジの反転判定に使う。
 * @param {{lim:number}} state
 * @returns {boolean}
 */
export function isLimiterLit(state) {
  return state.lim > 0;
}

/**
 * ピーク値 (0..1+) をレベルバーの塗り幅 (px) に変換する。1.0 で満杯、超過はクランプ。
 * @param {number} peak   ピーク (0..∞)
 * @param {number} innerW バー内側の最大幅 (px)
 * @returns {number} 塗り幅 (0..innerW の整数)
 */
export function meterBarFill(peak, innerW) {
  const f = Math.max(0, Math.min(1, peak));
  return Math.round(innerW * f);
}
