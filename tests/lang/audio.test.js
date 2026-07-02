/**
 * tests/lang/audio.test.js — Tessera の音（時間の場 a(t)）の単体テスト。
 * 文法分割（sound:）・チップチューン語彙の決定論と値域・オフラインレンダを検証する。
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../lang/runtime.js";
import { FUNCS, setAudioClock, setSeed } from "../../lang/stdlib.js";

describe("parseProgram / compile: sound: の分割", () => {
  it("sound: が無ければ audio は null（従来どおり）", () => {
    const p = compile("x");
    expect(p.audio).toBe(null);
    expect(typeof p.sample).toBe("function"); // 視覚の場は不変
    expect(p.sample(0.5, 0, 0)).toBeCloseTo(0.5, 6);
  });

  it("sound: があれば audio が付く（視覚の場は前段のまま）", () => {
    const p = compile("x*y\nsound: pulse(hz(69))");
    expect(p.audio).not.toBe(null);
    expect(typeof p.audio.sampleAudio).toBe("function");
    expect(typeof p.audio.renderAudio).toBe("function");
    expect(p.sample(1, 1, 0)).toBeCloseTo(1, 6); // 視覚 = x*y
  });
});

describe("チップチューン語彙（決定論・値域）", () => {
  it("hz: 半音番号 → 周波数（A4=69=440Hz）", () => {
    expect(FUNCS.hz(69)).toBeCloseTo(440, 6);
    expect(FUNCS.hz(57)).toBeCloseTo(220, 6); // 1 オクターブ下
  });

  it("pulse/saw/tri: 位相から決まる矩形/鋸/三角（出力 [-1,1]）", () => {
    setAudioClock(0, 1);
    expect(FUNCS.pulse(440)).toBe(1); // 位相 0 < duty .5 → +1
    setAudioClock(0.25, 1);
    expect(FUNCS.saw(1)).toBeCloseTo(-0.5, 6); // 2*.25 - 1
    expect(FUNCS.tri(1)).toBeCloseTo(0, 6); // 4*|.25-.5| - 1
  });

  it("beat/step/seq/decay: サイクル位相と並び・包絡", () => {
    setAudioClock(0.25, 1); // サイクル位相 0.25
    expect(FUNCS.step(4)).toBe(1); // floor(.25*4)
    expect(FUNCS.seq(FUNCS.step(4), 0, 10, 20, 30)).toBe(10);
    setAudioClock(0.1, 1);
    expect(FUNCS.beat(1)).toBeCloseTo(0.1, 6);
    expect(FUNCS.decay(FUNCS.beat(1))).toBeCloseTo(0.9, 6); // 1 - 位相
  });

  it("nz: seed 連動で再現可能・値域 [-1,1]", () => {
    setSeed(7);
    setAudioClock(0.5, 1);
    const a = FUNCS.nz(1000);
    setSeed(7);
    setAudioClock(0.5, 1);
    const b = FUNCS.nz(1000);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(-1);
    expect(a).toBeLessThanOrEqual(1);
  });
});

describe("renderAudio: オフラインレンダ", () => {
  it("長さ = round(sampleRate*seconds)、全サンプル [-1,1]", () => {
    const p = compile("0\nsound: pulse(hz(69)) * decay(beat(4))");
    const buf = p.audio.renderAudio(100, 1, 0, 1);
    expect(buf).toBeInstanceOf(Float32Array);
    expect(buf.length).toBe(100);
    for (const v of buf) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("決定論: 同じ seed/period なら同じ波形", () => {
    const p = compile("0\nsound: pulse(hz(45 + seq(step(8), 0, 3, 7, 12)))");
    const a = p.audio.renderAudio(200, 1, 3, 1);
    const b = p.audio.renderAudio(200, 1, 3, 1);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
