/**
 * @module core/anim
 * anim.js — イージング関数群・アニメーションユーティリティ
 *
 * UI アニメーション全般で使えるイージング関数と補助ユーティリティを提供する。
 * Robert Penner のイージング方程式をベースに、正規化シグネチャ (t → t') で統一。
 *
 * すべてのイージング関数は以下の契約に従う:
 *   - 入力  t : 0.0 〜 1.0 (進行度)
 *   - 出力 t' : 0.0 〜 1.0 (イージング適用後の値)
 *   - t=0 → 0, t=1 → 1 が保証される (Back/Elastic は中間でオーバーシュートあり)
 *
 * 外部依存: なし (純粋数学モジュール)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ユーティリティ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 値を 0–1 の範囲にクランプする。
 * @param {number} t
 * @returns {number}
 */
export function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * 線形補間 (Linear Interpolation)。
 * @param {number} a 開始値
 * @param {number} b 終了値
 * @param {number} t 進行度 (0–1)
 * @returns {number} a と b の間の補間値
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 経過時間を 0–1 の進行度に変換する。
 * @param {number} elapsed  経過ミリ秒
 * @param {number} duration 全体のミリ秒
 * @returns {number} 0.0 〜 1.0 にクランプされた進行度
 */
export function normalizeTime(elapsed, duration) {
  if (duration <= 0) return 1;
  return clamp01(elapsed / duration);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  イージング関数 — Linear
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @param {number} t @returns {number} */
export function linear(t) {
  return t;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  イージング関数 — Quadratic (t²)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @param {number} t @returns {number} */
export function easeInQuad(t) {
  return t * t;
}

/** @param {number} t @returns {number} */
export function easeOutQuad(t) {
  return t * (2 - t);
}

/** @param {number} t @returns {number} */
export function easeInOutQuad(t) {
  return t < 0.5
    ? 2 * t * t
    : -1 + (4 - 2 * t) * t;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  イージング関数 — Cubic (t³)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @param {number} t @returns {number} */
export function easeInCubic(t) {
  return t * t * t;
}

/** @param {number} t @returns {number} */
export function easeOutCubic(t) {
  const u = t - 1;
  return u * u * u + 1;
}

/** @param {number} t @returns {number} */
export function easeInOutCubic(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 + (t - 1) * (2 * t - 2) * (2 * t - 2);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  イージング関数 — Quartic (t⁴)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @param {number} t @returns {number} */
export function easeInQuart(t) {
  return t * t * t * t;
}

/** @param {number} t @returns {number} */
export function easeOutQuart(t) {
  const u = t - 1;
  return 1 - u * u * u * u;
}

/** @param {number} t @returns {number} */
export function easeInOutQuart(t) {
  const u = t - 1;
  return t < 0.5
    ? 8 * t * t * t * t
    : 1 - 8 * u * u * u * u;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  イージング関数 — Sine
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @param {number} t @returns {number} */
export function easeInSine(t) {
  return 1 - Math.cos((t * Math.PI) / 2);
}

/** @param {number} t @returns {number} */
export function easeOutSine(t) {
  return Math.sin((t * Math.PI) / 2);
}

/** @param {number} t @returns {number} */
export function easeInOutSine(t) {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  イージング関数 — Exponential
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @param {number} t @returns {number} */
export function easeInExpo(t) {
  return t === 0 ? 0 : Math.pow(2, 10 * (t - 1));
}

/** @param {number} t @returns {number} */
export function easeOutExpo(t) {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/** @param {number} t @returns {number} */
export function easeInOutExpo(t) {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return t < 0.5
    ? Math.pow(2, 20 * t - 10) / 2
    : (2 - Math.pow(2, -20 * t + 10)) / 2;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  イージング関数 — Back (オーバーシュート)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const BACK_OVERSHOOT = 1.70158;
const BACK_OVERSHOOT_IO = BACK_OVERSHOOT * 1.525;

/** @param {number} t @returns {number} */
export function easeInBack(t) {
  return t * t * ((BACK_OVERSHOOT + 1) * t - BACK_OVERSHOOT);
}

/** @param {number} t @returns {number} */
export function easeOutBack(t) {
  const u = t - 1;
  return u * u * ((BACK_OVERSHOOT + 1) * u + BACK_OVERSHOOT) + 1;
}

/** @param {number} t @returns {number} */
export function easeInOutBack(t) {
  if (t < 0.5) {
    const u = 2 * t;
    return (u * u * ((BACK_OVERSHOOT_IO + 1) * u - BACK_OVERSHOOT_IO)) / 2;
  }
  const u = 2 * t - 2;
  return (u * u * ((BACK_OVERSHOOT_IO + 1) * u + BACK_OVERSHOOT_IO) + 2) / 2;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  イージング関数 — Elastic (弾性振動)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ELASTIC_PERIOD = 0.3;
const ELASTIC_SHIFT = ELASTIC_PERIOD / 4;

/** @param {number} t @returns {number} */
export function easeInElastic(t) {
  if (t === 0 || t === 1) return t;
  return -Math.pow(2, 10 * (t - 1)) *
    Math.sin(((t - 1 - ELASTIC_SHIFT) * (2 * Math.PI)) / ELASTIC_PERIOD);
}

/** @param {number} t @returns {number} */
export function easeOutElastic(t) {
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) *
    Math.sin(((t - ELASTIC_SHIFT) * (2 * Math.PI)) / ELASTIC_PERIOD) + 1;
}

/** @param {number} t @returns {number} */
export function easeInOutElastic(t) {
  if (t === 0 || t === 1) return t;
  const p = ELASTIC_PERIOD * 1.5;
  const s = p / 4;
  if (t < 0.5) {
    return -0.5 * Math.pow(2, 20 * t - 10) *
      Math.sin(((20 * t - 11.125) * (2 * Math.PI)) / (p * 2));
  }
  return 0.5 * Math.pow(2, -20 * t + 10) *
    Math.sin(((20 * t - 11.125) * (2 * Math.PI)) / (p * 2)) + 1;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  イージング関数 — Bounce
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @param {number} t @returns {number} */
export function easeOutBounce(t) {
  if (t < 1 / 2.75) {
    return 7.5625 * t * t;
  } else if (t < 2 / 2.75) {
    const u = t - 1.5 / 2.75;
    return 7.5625 * u * u + 0.75;
  } else if (t < 2.5 / 2.75) {
    const u = t - 2.25 / 2.75;
    return 7.5625 * u * u + 0.9375;
  } else {
    const u = t - 2.625 / 2.75;
    return 7.5625 * u * u + 0.984375;
  }
}

/** @param {number} t @returns {number} */
export function easeInBounce(t) {
  return 1 - easeOutBounce(1 - t);
}

/** @param {number} t @returns {number} */
export function easeInOutBounce(t) {
  return t < 0.5
    ? (1 - easeOutBounce(1 - 2 * t)) / 2
    : (1 + easeOutBounce(2 * t - 1)) / 2;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ステップ化ラッパー (PIXERA OS 固有)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 任意のイージング関数を N 段階に離散化するラッパー。
 * 1-bit・ピクセル単位の環境で意図的にカクカクさせるレトロ演出に有用。
 *
 * @param {(t:number)=>number} easeFn  元のイージング関数
 * @param {number}             steps   ステップ数 (2 以上推奨)
 * @returns {(t:number)=>number}       ステップ化されたイージング関数
 *
 * @example
 * const steppedBounce = stepped(easeOutBounce, 8);
 * steppedBounce(0.5); // → 8段階に離散化された値
 */
export function stepped(easeFn, steps) {
  return (t) => {
    if (t >= 1) return 1;
    const s = easeFn(t);
    return Math.floor(s * steps) / steps;
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  辞書 (名前引き用)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 全イージング関数を名前で引ける辞書オブジェクト。
 * DropDown 等の UI で関数名を選択→適用する用途を想定。
 * @type {Record<string, (t:number)=>number>}
 */
export const easings = {
  linear,
  easeInQuad,
  easeOutQuad,
  easeInOutQuad,
  easeInCubic,
  easeOutCubic,
  easeInOutCubic,
  easeInQuart,
  easeOutQuart,
  easeInOutQuart,
  easeInSine,
  easeOutSine,
  easeInOutSine,
  easeInExpo,
  easeOutExpo,
  easeInOutExpo,
  easeInBack,
  easeOutBack,
  easeInOutBack,
  easeInElastic,
  easeOutElastic,
  easeInOutElastic,
  easeInBounce,
  easeOutBounce,
  easeInOutBounce,
};

/**
 * イージング関数名の一覧 (辞書のキー配列)。
 * @type {string[]}
 */
export const easingNames = Object.keys(easings);
