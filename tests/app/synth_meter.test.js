/**
 * synth_meter.test.js — SYNTH フッタのレベル / リミッタ・メーターの純粋ロジック。
 *
 * 計測値 (瞬時ピーク・リミッタのゲインリダクション) から表示状態への変換を検証する。
 * 描画 (synth.js) には触れず、meter.js の純関数のみを対象にする。
 */
import { describe, it, expect } from "vitest";

import {
  PEAK_DECAY_PER_SEC,
  LIMITER_ON_DB,
  LIMITER_HOLD_SEC,
  initialMeterState,
  nextMeterState,
  isLimiterLit,
  meterBarFill,
} from "@/app/synth/meter.js";

describe("initialMeterState", () => {
  it("ピーク・点灯ともにゼロから始まる", () => {
    expect(initialMeterState()).toEqual({ peak: 0, lim: 0 });
  });
});

describe("nextMeterState — ピーク", () => {
  it("新しい瞬時ピークへ即座に立ち上がる", () => {
    const s = nextMeterState(initialMeterState(), 0.8, 0, 0.016);
    expect(s.peak).toBeCloseTo(0.8, 5);
  });

  it("入力が下がっても dt に比例して緩やかに減衰する (即落ちしない)", () => {
    // peak=1.0 から 0.1 秒後: 1.0 - 3.0*0.1 = 0.7
    const s = nextMeterState({ peak: 1.0, lim: 0 }, 0, 0, 0.1);
    expect(s.peak).toBeCloseTo(1.0 - PEAK_DECAY_PER_SEC * 0.1, 5);
  });

  it("減衰中でも今回の瞬時ピークが大きければそちらを採る", () => {
    const s = nextMeterState({ peak: 0.5, lim: 0 }, 0.9, 0, 0.1);
    expect(s.peak).toBeCloseTo(0.9, 5);
  });

  it("減衰は 0 未満にならない", () => {
    const s = nextMeterState({ peak: 0.1, lim: 0 }, 0, 0, 1.0);
    expect(s.peak).toBe(0);
  });

  it("1.0 を超える瞬時ピーク (過大入力) はそのまま保持する", () => {
    const s = nextMeterState(initialMeterState(), 1.5, 0, 0.016);
    expect(s.peak).toBeCloseTo(1.5, 5);
  });

  it("負の dt は 0 扱いで減衰しない", () => {
    const s = nextMeterState({ peak: 0.6, lim: 0 }, 0, 0, -1);
    expect(s.peak).toBeCloseTo(0.6, 5);
  });
});

describe("nextMeterState — リミッタ点灯", () => {
  it("リダクションが閾値以下ならホールド時間へ点灯", () => {
    const s = nextMeterState(initialMeterState(), 0.5, -3, 0.016);
    expect(s.lim).toBe(LIMITER_HOLD_SEC);
    expect(isLimiterLit(s)).toBe(true);
  });

  it("閾値ちょうど (-0.5dB) でも点灯する", () => {
    const s = nextMeterState(initialMeterState(), 0.5, LIMITER_ON_DB, 0.016);
    expect(isLimiterLit(s)).toBe(true);
  });

  it("閾値より浅い (-0.4dB) リダクションでは点灯しない", () => {
    const s = nextMeterState(initialMeterState(), 0.5, -0.4, 0.016);
    expect(s.lim).toBe(0);
    expect(isLimiterLit(s)).toBe(false);
  });

  it("作動が止むとホールドが dt ずつ減り、やがて消灯する", () => {
    let s = { peak: 0, lim: LIMITER_HOLD_SEC };
    s = nextMeterState(s, 0, 0, 0.1); // 0.25 → 0.15
    expect(s.lim).toBeCloseTo(LIMITER_HOLD_SEC - 0.1, 5);
    expect(isLimiterLit(s)).toBe(true);
    s = nextMeterState(s, 0, 0, 1.0); // 0 でクランプ
    expect(s.lim).toBe(0);
    expect(isLimiterLit(s)).toBe(false);
  });

  it("点灯ホールド中に再作動するとホールドが満タンに戻る", () => {
    const s = nextMeterState({ peak: 0, lim: 0.05 }, 0, -6, 0.016);
    expect(s.lim).toBe(LIMITER_HOLD_SEC);
  });
});

describe("meterBarFill", () => {
  it("0 は塗り幅 0", () => {
    expect(meterBarFill(0, 38)).toBe(0);
  });

  it("1.0 は満杯 (内側幅ちょうど)", () => {
    expect(meterBarFill(1, 38)).toBe(38);
  });

  it("1.0 超過はクランプして満杯", () => {
    expect(meterBarFill(1.7, 38)).toBe(38);
  });

  it("中間値は比例して四捨五入", () => {
    expect(meterBarFill(0.5, 38)).toBe(19);
  });

  it("負値は 0", () => {
    expect(meterBarFill(-0.2, 38)).toBe(0);
  });
});
