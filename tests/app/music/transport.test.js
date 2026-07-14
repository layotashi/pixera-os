/**
 * transport.test.js — 共有トランスポート (グローバル再生時計) の契約。
 *
 * 位置 / テンポ / ループ / 拍子 / メトロノーム / 録音の状態と、時刻ベースで冪等な
 * update() の振る舞いを固定する。全音楽アプリがこの 1 本の時計を読んで追従するため、
 * ここが崩れると ROLL の再生や TRANSPORT アプリの操作が壊れる。
 *
 * core/audio.js は fake AudioContext でモックし、currentTime を進めて位置を検証する。
 * トランスポートはモジュール・グローバルなので各テストの冒頭で既定へ戻す。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── core/audio.js をモック (fake AudioContext + master gain) ──
vi.mock("@/core/audio.js", () => {
  const ctx = {
    currentTime: 0,
    state: "running",
    oscCount: 0, // メトロノームのクリック生成回数 (createOscillator 呼び出し数)
    resume() {},
    createGain() {
      return {
        gain: {
          value: 0,
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
        disconnect() {},
      };
    },
    createOscillator() {
      ctx.oscCount++;
      return {
        type: "",
        frequency: { value: 0 },
        connect() {},
        start() {},
        stop() {},
        disconnect() {},
        onended: null,
      };
    },
  };
  return {
    __ctx: ctx,
    getAudioContext: () => ctx,
    getMasterGain: () => ({ connect() {} }),
    initAudio: () => {},
  };
});

import * as Audio from "@/core/audio.js";
import * as T from "@/app/music/transport.js";

/** fake ctx の時計を秒でセットする */
function setNow(sec) {
  Audio.__ctx.currentTime = sec;
}

beforeEach(() => {
  setNow(0);
  T.stop();
  T.setTempo(120);
  T.setBeatsPerBar(4);
  T.setLoop(0, 16, true);
  T.setMetronomeEnabled(false);
  T.setPosition(0);
  Audio.__ctx.oscCount = 0;
});

describe("transport defaults", () => {
  it("既定は 120BPM / 0..16beat ループ ON / 4/4 / 停止・非録音・メトロノーム OFF", () => {
    expect(T.getTempo()).toBe(120);
    expect(T.getLoop()).toEqual({ start: 0, end: 16, on: true });
    expect(T.getBeatsPerBar()).toBe(4);
    expect(T.getStepsPerBeat()).toBe(4);
    expect(T.isPlaying()).toBe(false);
    expect(T.isRecording()).toBe(false);
    expect(T.isMetronomeEnabled()).toBe(false);
  });
});

describe("position <-> bar.beat.sub", () => {
  it("beatToParts は 4/4 で bar.beat.sub (1 始まり) に分解する", () => {
    expect(T.beatToParts(0)).toEqual({ bar: 1, beat: 1, sub: 1 });
    expect(T.beatToParts(4)).toEqual({ bar: 2, beat: 1, sub: 1 });
    expect(T.beatToParts(5.5)).toEqual({ bar: 2, beat: 2, sub: 3 });
  });

  it("formatPosition は 'bar.beat.sub' 文字列を返す", () => {
    expect(T.formatPosition(0)).toBe("1.1.1");
    expect(T.formatPosition(6.25)).toBe("2.3.2");
  });

  it("barToBeat は小節頭の beat を返す", () => {
    expect(T.barToBeat(1)).toBe(0);
    expect(T.barToBeat(3)).toBe(8);
  });

  it("拍子を変えると bar 換算が追従する", () => {
    T.setBeatsPerBar(3);
    expect(T.beatToParts(3)).toEqual({ bar: 2, beat: 1, sub: 1 });
    expect(T.barToBeat(2)).toBe(3);
  });
});

describe("playback clock", () => {
  it("play 後は経過時刻 × テンポで位置が進む", () => {
    T.play(0);
    setNow(1); // 1 秒 = 120BPM で 2 beat
    T.update();
    expect(T.getPosition()).toBeCloseTo(2, 5);
    expect(T.isPlaying()).toBe(true);
  });

  it("update は冪等 (同フレーム複数回でも位置は一致)", () => {
    T.play(0);
    setNow(0.5);
    T.update();
    const a = T.getPosition();
    T.update();
    expect(T.getPosition()).toBeCloseTo(a, 10);
  });

  it("ループ有効なら範囲内へ折り返す", () => {
    T.setLoop(0, 4, true);
    T.play(0);
    setNow(3); // raw = 6 beat → 0..4 に折り返して 2
    T.update();
    expect(T.getPosition()).toBeCloseTo(2, 5);
  });

  it("停止は位置を保持し、rewind はループ先頭へ戻す", () => {
    T.setLoop(4, 12, true);
    T.play(4);
    setNow(1);
    T.update(); // pos ~ 6
    T.stop();
    expect(T.isPlaying()).toBe(false);
    expect(T.getPosition()).toBeCloseTo(6, 5); // 停止は位置保持

    T.rewind();
    expect(T.isPlaying()).toBe(false);
    expect(T.getPosition()).toBe(4); // ループ ON → 開始小節 (beat 4)
  });

  it("rewind はループ OFF のとき 0 へ戻す", () => {
    T.setLoop(4, 12, false);
    T.setPosition(8);
    T.rewind();
    expect(T.getPosition()).toBe(0);
  });
});

describe("clock (getClock) — ワークレットシーケンサへ渡すアンカー", () => {
  it("play 後は開始位置/時刻・テンポ・ループを返す", () => {
    setNow(2);
    T.play(4);
    const c = T.getClock();
    expect(c.playing).toBe(true);
    expect(c.bpm).toBe(120);
    expect(c.startBeat).toBe(4);
    expect(c.startTime).toBe(2);
    expect(c.loopStart).toBe(0);
    expect(c.loopEnd).toBe(16);
    expect(c.loopOn).toBe(true);
  });

  it("stop すると playing:false になる (位置アンカーは保持)", () => {
    T.play(0);
    setNow(1);
    T.update();
    T.stop();
    const c = T.getClock();
    expect(c.playing).toBe(false);
    expect(c.startBeat).toBe(0);
  });

  it("テンポ/ループ変更が反映される", () => {
    T.setTempo(140);
    T.setLoop(4, 12, false);
    const c = T.getClock();
    expect(c.bpm).toBe(140);
    expect(c.loopStart).toBe(4);
    expect(c.loopEnd).toBe(12);
    expect(c.loopOn).toBe(false);
  });
});

describe("recording", () => {
  it("startRecording は停止中なら再生も始め、状態を立てる", () => {
    T.startRecording();
    expect(T.isRecording()).toBe(true);
    expect(T.isPlaying()).toBe(true);
  });

  it("stopRecording はパンチアウト (再生は継続)", () => {
    T.startRecording();
    T.stopRecording();
    expect(T.isRecording()).toBe(false);
    expect(T.isPlaying()).toBe(true);
  });

  it("stop は録音も止める", () => {
    T.startRecording();
    T.stop();
    expect(T.isRecording()).toBe(false);
    expect(T.isPlaying()).toBe(false);
  });
});

describe("metronome", () => {
  it("OFF の間は update してもクリックを鳴らさない", () => {
    T.play(0);
    setNow(1);
    T.update();
    expect(Audio.__ctx.oscCount).toBe(0);
  });

  it("ON なら拍を跨ぐたびに 1 回だけクリックする (冪等)", () => {
    T.setMetronomeEnabled(true);
    T.play(0); // 拍頭で開始 → 最初の update で拍 0 を鳴らす
    setNow(0.01);
    T.update();
    expect(Audio.__ctx.oscCount).toBe(1);
    // 同じ拍のまま複数フレーム: 追加のクリックは無い
    setNow(0.02);
    T.update();
    expect(Audio.__ctx.oscCount).toBe(1);
    // 次の拍へ (0.5 秒 = 120BPM で 1 beat) → もう 1 回
    setNow(0.5);
    T.update();
    expect(Audio.__ctx.oscCount).toBe(2);
  });
});
