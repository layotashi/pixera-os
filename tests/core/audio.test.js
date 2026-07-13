/**
 * core/audio.js — オーディオ基盤テスト
 *
 * 音楽ユーティリティ (MIDI→周波数, MIDI→音名) の精度テスト、
 * 波形生成関数 (sampleWaveformFn) の数値テスト、
 * SynthChannel のパラメータ操作・波形サンプル取得テスト。
 */
import { describe, it, expect } from "vitest";
import {
  NOTE_NAMES,
  midiToFreq,
  midiToNoteName,
  WAVEFORM_LIST,
  sampleWaveformFn,
  fourierCoeff,
  SynthChannel,
  PolySynth,
  createChannel,
  createPolySynth,
  getDefaultChannel,
  createSfxChannels,
  SamplePlayer,
  playSample,
  dcBlock,
  computeMidiAudioTime,
  currentMidiLookahead,
  MIDI_LOOKAHEAD,
  MIDI_LOOKAHEAD_RECORDING,
  getMasterMeter,
} from "@/core/audio.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("NOTE_NAMES", () => {
  it("12 音名を持つ", () => {
    expect(NOTE_NAMES).toHaveLength(12);
  });

  it("C から始まり B で終わる", () => {
    expect(NOTE_NAMES[0]).toBe("C");
    expect(NOTE_NAMES[11]).toBe("B");
  });

  it("シャープ音名を含む", () => {
    expect(NOTE_NAMES).toContain("C#");
    expect(NOTE_NAMES).toContain("F#");
    expect(NOTE_NAMES).toContain("G#");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  dcBlock（書き出しの DC 除去 = 再生との音一致）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("dcBlock", () => {
  const SR = 44100;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

  it("入力を破壊しない（新しい配列を返す）", () => {
    const src = new Float32Array([1, 1, 1, 1]);
    const out = dcBlock(src, SR);
    expect(out).not.toBe(src);
    expect([...src]).toEqual([1, 1, 1, 1]);
  });

  it("非対称パルス波（duty=.25, DC≈-0.5）の DC 成分をほぼ 0 にする", () => {
    // 200Hz・duty 0.25 のパルスを 0.5 秒。1周だけだと過渡が残るので後半で評価。
    const f = 200;
    const n = SR / 2;
    const pulse = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ph = (i * f) / SR;
      pulse[i] = ph - Math.floor(ph) < 0.25 ? 1 : -1;
    }
    expect(mean(pulse)).toBeLessThan(-0.4); // 元は強い DC オフセット
    const out = dcBlock(pulse, SR).subarray(n >> 1); // 暖機後（後半）
    expect(Math.abs(mean(out))).toBeLessThan(0.01); // DC がほぼ消える
  });

  it("可聴帯域（440Hz サイン）の振幅はほぼ保つ（DC だけ抜く）", () => {
    const f = 440;
    const n = SR;
    const sine = new Float32Array(n);
    for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * f * i) / SR);
    const out = dcBlock(sine, SR).subarray(SR >> 1); // 後半
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.98); // 440Hz は 20Hz HP をほぼ素通り
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  midiToFreq
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("midiToFreq", () => {
  it("A4 (MIDI 69) = 440 Hz", () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 5);
  });

  it("A3 (MIDI 57) = 220 Hz (1オクターブ下)", () => {
    expect(midiToFreq(57)).toBeCloseTo(220, 5);
  });

  it("A5 (MIDI 81) = 880 Hz (1オクターブ上)", () => {
    expect(midiToFreq(81)).toBeCloseTo(880, 5);
  });

  it("C4 (MIDI 60) ≈ 261.626 Hz", () => {
    expect(midiToFreq(60)).toBeCloseTo(261.626, 2);
  });

  it("E4 (MIDI 64) ≈ 329.628 Hz", () => {
    expect(midiToFreq(64)).toBeCloseTo(329.628, 2);
  });

  it("MIDI 0 (最低) でも正の周波数", () => {
    expect(midiToFreq(0)).toBeGreaterThan(0);
    // C-1 ≈ 8.176 Hz
    expect(midiToFreq(0)).toBeCloseTo(8.176, 2);
  });

  it("MIDI 127 (最高) ≈ 12543.854 Hz", () => {
    expect(midiToFreq(127)).toBeCloseTo(12543.854, 0);
  });

  it("1オクターブ上がると周波数が2倍", () => {
    for (let midi = 0; midi < 116; midi++) {
      const ratio = midiToFreq(midi + 12) / midiToFreq(midi);
      expect(ratio).toBeCloseTo(2, 10);
    }
  });

  it("半音上がると周波数が 2^(1/12) 倍", () => {
    const semitoneRatio = Math.pow(2, 1 / 12);
    for (let midi = 0; midi < 126; midi++) {
      const ratio = midiToFreq(midi + 1) / midiToFreq(midi);
      expect(ratio).toBeCloseTo(semitoneRatio, 10);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  midiToNoteName
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("midiToNoteName", () => {
  it("MIDI 60 → C4", () => {
    expect(midiToNoteName(60)).toBe("C4");
  });

  it("MIDI 69 → A4", () => {
    expect(midiToNoteName(69)).toBe("A4");
  });

  it("MIDI 0 → C-1", () => {
    expect(midiToNoteName(0)).toBe("C-1");
  });

  it("MIDI 127 → G9", () => {
    expect(midiToNoteName(127)).toBe("G9");
  });

  it("シャープ音名を正しく返す", () => {
    expect(midiToNoteName(61)).toBe("C#4");
    expect(midiToNoteName(66)).toBe("F#4");
    expect(midiToNoteName(70)).toBe("A#4");
  });

  it("オクターブの境界を正しく処理", () => {
    expect(midiToNoteName(71)).toBe("B4");
    expect(midiToNoteName(72)).toBe("C5");
  });

  it("連続した MIDI 値が正しくマッピングされる", () => {
    const expected = [
      "C4",
      "C#4",
      "D4",
      "D#4",
      "E4",
      "F4",
      "F#4",
      "G4",
      "G#4",
      "A4",
      "A#4",
      "B4",
    ];
    for (let i = 0; i < 12; i++) {
      expect(midiToNoteName(60 + i)).toBe(expected[i]);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WAVEFORM_LIST
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("WAVEFORM_LIST", () => {
  it("7 種類の波形を持つ", () => {
    expect(WAVEFORM_LIST).toHaveLength(7);
  });

  it("saw から始まる", () => {
    expect(WAVEFORM_LIST[0]).toBe("saw");
  });

  it("全ての期待される波形タイプを含む", () => {
    const expected = ["saw", "tri", "sq50", "sq25", "sq12", "sine", "noise"];
    expect(WAVEFORM_LIST).toEqual(expected);
  });

  it("重複が無い", () => {
    const unique = new Set(WAVEFORM_LIST);
    expect(unique.size).toBe(WAVEFORM_LIST.length);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  sampleWaveformFn
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("sampleWaveformFn", () => {
  // ── saw ──
  describe("saw", () => {
    it("t=0 → 1", () => {
      expect(sampleWaveformFn("saw", 0)).toBe(1);
    });

    it("t=0.5 → 0", () => {
      expect(sampleWaveformFn("saw", 0.5)).toBe(0);
    });

    it("t→1 に近づくと -1 に近づく", () => {
      expect(sampleWaveformFn("saw", 0.999)).toBeCloseTo(-1, 1);
    });

    it("線形に減少する", () => {
      const v1 = sampleWaveformFn("saw", 0.25);
      const v2 = sampleWaveformFn("saw", 0.75);
      expect(v1).toBeCloseTo(0.5, 5);
      expect(v2).toBeCloseTo(-0.5, 5);
    });
  });

  // ── tri ──
  describe("tri", () => {
    it("t=0 → 0", () => {
      expect(sampleWaveformFn("tri", 0)).toBe(0);
    });

    it("t=0.25 → 1 (ピーク)", () => {
      expect(sampleWaveformFn("tri", 0.25)).toBe(1);
    });

    it("t=0.5 → 0 (ゼロクロス)", () => {
      expect(sampleWaveformFn("tri", 0.5)).toBeCloseTo(0, 5);
    });

    it("t=0.75 → -1 (ボトム)", () => {
      expect(sampleWaveformFn("tri", 0.75)).toBe(-1);
    });

    it("前半と後半が対称", () => {
      const v1 = sampleWaveformFn("tri", 0.1);
      const v2 = sampleWaveformFn("tri", 0.9);
      expect(v1).toBeCloseTo(-v2, 5);
    });
  });

  // ── sq50 ──
  describe("sq50", () => {
    it("前半は +1", () => {
      expect(sampleWaveformFn("sq50", 0)).toBe(1);
      expect(sampleWaveformFn("sq50", 0.25)).toBe(1);
      expect(sampleWaveformFn("sq50", 0.49)).toBe(1);
    });

    it("後半は -1", () => {
      expect(sampleWaveformFn("sq50", 0.5)).toBe(-1);
      expect(sampleWaveformFn("sq50", 0.75)).toBe(-1);
      expect(sampleWaveformFn("sq50", 0.99)).toBe(-1);
    });
  });

  // ── sq25 ──
  describe("sq25", () => {
    it("0〜0.25 未満は +1", () => {
      expect(sampleWaveformFn("sq25", 0)).toBe(1);
      expect(sampleWaveformFn("sq25", 0.24)).toBe(1);
    });

    it("0.25 以降は -1", () => {
      expect(sampleWaveformFn("sq25", 0.25)).toBe(-1);
      expect(sampleWaveformFn("sq25", 0.5)).toBe(-1);
      expect(sampleWaveformFn("sq25", 0.99)).toBe(-1);
    });
  });

  // ── sq12 ──
  describe("sq12", () => {
    it("0〜0.125 未満は +1", () => {
      expect(sampleWaveformFn("sq12", 0)).toBe(1);
      expect(sampleWaveformFn("sq12", 0.12)).toBe(1);
    });

    it("0.125 以降は -1", () => {
      expect(sampleWaveformFn("sq12", 0.125)).toBe(-1);
      expect(sampleWaveformFn("sq12", 0.5)).toBe(-1);
    });
  });

  // ── sine ──
  describe("sine", () => {
    it("t=0 → 0", () => {
      expect(sampleWaveformFn("sine", 0)).toBeCloseTo(0, 10);
    });

    it("t=0.25 → 1 (ピーク)", () => {
      expect(sampleWaveformFn("sine", 0.25)).toBeCloseTo(1, 10);
    });

    it("t=0.5 → 0 (ゼロクロス)", () => {
      expect(sampleWaveformFn("sine", 0.5)).toBeCloseTo(0, 10);
    });

    it("t=0.75 → -1 (ボトム)", () => {
      expect(sampleWaveformFn("sine", 0.75)).toBeCloseTo(-1, 10);
    });
  });

  // ── noise ──
  describe("noise", () => {
    it("-1〜+1 の範囲に収まる (100 サンプル)", () => {
      for (let i = 0; i < 100; i++) {
        const v = sampleWaveformFn("noise", Math.random());
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });

  // ── unknown ──
  describe("未知の波形タイプ", () => {
    it("0 を返す", () => {
      expect(sampleWaveformFn("unknown", 0)).toBe(0);
      expect(sampleWaveformFn("unknown", 0.5)).toBe(0);
    });
  });

  // ── 全波形が -1〜+1 の範囲 ──
  it("全波形タイプが -1〜+1 の範囲に収まる", () => {
    for (const wf of WAVEFORM_LIST) {
      for (let i = 0; i <= 100; i++) {
        const t = i / 100;
        const v = sampleWaveformFn(wf, t);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  fourierCoeff (帯域制限合成用)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("fourierCoeff", () => {
  /**
   * 倍音 N まで足し込んで sampleWaveformFn と比較する。
   * 不連続を含む波形 (saw/sq*) は Gibbs 現象で完全一致しないが、
   * 連続点 (1/4 周期等) では十分一致する。
   */
  function partialSum(wf, t, N) {
    let s = 0;
    for (let n = 1; n <= N; n++) {
      const { a, b } = fourierCoeff(wf, n);
      const phi = 2 * Math.PI * n * t;
      if (a !== 0) s += a * Math.cos(phi);
      if (b !== 0) s += b * Math.sin(phi);
    }
    return s;
  }

  describe("saw", () => {
    it("十分倍音を足し込めば連続点で sampleWaveformFn に収束する", () => {
      // t=0.25 で saw(0.25) = 0.5
      const reconstructed = partialSum("saw", 0.25, 200);
      expect(reconstructed).toBeCloseTo(0.5, 1);
    });

    it("a_n (cosine) は常に 0", () => {
      for (let n = 1; n <= 10; n++) {
        expect(fourierCoeff("saw", n).a).toBe(0);
      }
    });

    it("b_n (sine) = 2/(πn)", () => {
      for (let n = 1; n <= 10; n++) {
        expect(fourierCoeff("saw", n).b).toBeCloseTo(2 / (Math.PI * n), 10);
      }
    });
  });

  describe("tri", () => {
    it("ピーク (t=0.25) で +1 に近づく", () => {
      // tri Fourier 級数は 1/n² 収束で peak での誤差は π²/8 系列の tail
      // N=200 倍音で約 0.005 まで縮まる
      const reconstructed = partialSum("tri", 0.25, 200);
      expect(reconstructed).toBeCloseTo(1, 2);
    });

    it("ゼロクロス (t=0, 0.5) で 0 に近づく", () => {
      expect(partialSum("tri", 0, 50)).toBeCloseTo(0, 5);
      expect(partialSum("tri", 0.5, 50)).toBeCloseTo(0, 2);
    });

    it("偶数倍音は 0", () => {
      for (let n = 2; n <= 10; n += 2) {
        expect(fourierCoeff("tri", n).a).toBe(0);
        expect(fourierCoeff("tri", n).b).toBe(0);
      }
    });
  });

  describe("sq50", () => {
    it("偶数倍音は 0", () => {
      for (let n = 2; n <= 10; n += 2) {
        expect(fourierCoeff("sq50", n).a).toBe(0);
        expect(fourierCoeff("sq50", n).b).toBe(0);
      }
    });

    it("奇数倍音 b_n = 4/(πn)", () => {
      for (let n = 1; n <= 9; n += 2) {
        expect(fourierCoeff("sq50", n).b).toBeCloseTo(4 / (Math.PI * n), 10);
      }
    });
  });

  describe("sq25 / sq12 (任意 duty)", () => {
    it("sq25 は DC を除けば 25% high / 75% low に収束する", () => {
      // 倍音を多く積めば、高領域 (t<0.25) は +1 近く、低領域は -1 近くになる
      // (DC を sampleWaveformFn から引いて比較)
      const N = 200;
      const high = partialSum("sq25", 0.1, N);
      const low = partialSum("sq25", 0.5, N);
      // sq25 の DC は -0.5。AC のみ復元するので high ≈ +1.5、low ≈ -0.5
      expect(high).toBeGreaterThan(1.0);
      expect(low).toBeLessThan(0.0);
    });

    it("sq12 も同様に AC 部分が復元される", () => {
      const N = 200;
      const high = partialSum("sq12", 0.05, N);
      const low = partialSum("sq12", 0.5, N);
      expect(high).toBeGreaterThan(low);
    });
  });

  describe("sine", () => {
    it("n=1 だけ b=1、それ以外は全て 0", () => {
      expect(fourierCoeff("sine", 1)).toEqual({ a: 0, b: 1 });
      for (let n = 2; n <= 10; n++) {
        expect(fourierCoeff("sine", n)).toEqual({ a: 0, b: 0 });
      }
    });

    it("n=1 のみで完全に sampleWaveformFn と一致する", () => {
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        expect(partialSum("sine", t, 1)).toBeCloseTo(
          sampleWaveformFn("sine", t),
          10,
        );
      }
    });
  });

  describe("unknown", () => {
    it("a=0, b=0 を返す", () => {
      expect(fourierCoeff("unknown", 1)).toEqual({ a: 0, b: 0 });
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SynthChannel (AudioContext 不要な操作)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("SynthChannel", () => {
  // ── 波形 ──
  describe("波形の設定と取得", () => {
    it("デフォルト波形は saw", () => {
      const ch = new SynthChannel();
      expect(ch.getWaveform()).toBe("saw");
    });

    it("setWaveform で波形を変更できる", () => {
      const ch = new SynthChannel();
      ch.setWaveform("tri");
      expect(ch.getWaveform()).toBe("tri");
    });

    it("cycleWaveform で順送りできる", () => {
      const ch = new SynthChannel();
      expect(ch.getWaveform()).toBe("saw");
      expect(ch.cycleWaveform()).toBe("tri");
      expect(ch.cycleWaveform()).toBe("sq50");
      expect(ch.cycleWaveform()).toBe("sq25");
      expect(ch.cycleWaveform()).toBe("sq12");
      expect(ch.cycleWaveform()).toBe("sine");
      expect(ch.cycleWaveform()).toBe("noise");
      // ラップアラウンド
      expect(ch.cycleWaveform()).toBe("saw");
    });
  });

  // ── 位相 ──
  describe("発音開始位相", () => {
    it("デフォルトは 0", () => {
      const ch = new SynthChannel();
      expect(ch.getStartPhase()).toBe(0);
    });

    it("setStartPhase で設定できる", () => {
      const ch = new SynthChannel();
      ch.setStartPhase(0.5);
      expect(ch.getStartPhase()).toBe(0.5);
    });

    it("0 未満はクランプされる", () => {
      const ch = new SynthChannel();
      ch.setStartPhase(-0.5);
      expect(ch.getStartPhase()).toBe(0);
    });

    it("1 を超えるとクランプされる", () => {
      const ch = new SynthChannel();
      ch.setStartPhase(1.5);
      expect(ch.getStartPhase()).toBe(1);
    });
  });

  // ── ADSR ──
  describe("ADSR パラメータ", () => {
    it("setADSR で設定した値が内部状態に反映される (ms→秒 / %→比率)", () => {
      const ch = new SynthChannel();
      ch.setADSR(10, 200, 80, 500);
      // 内部値はプライベートだが getWaveformSamples 等を介して間接確認
      // ミリ秒→秒: A=0.01, D=0.2, S=0.8, R=0.5
      expect(ch._adsrA).toBeCloseTo(0.01, 5);
      expect(ch._adsrD).toBeCloseTo(0.2, 5);
      expect(ch._adsrS).toBeCloseTo(0.8, 5);
      expect(ch._adsrR).toBeCloseTo(0.5, 5);
    });
  });

  // ── 音量 ──
  describe("音量設定", () => {
    it("setVolume で 0〜100 を 0.0〜1.0 に変換", () => {
      const ch = new SynthChannel();
      ch.setVolume(50);
      expect(ch._volume).toBeCloseTo(0.5, 5);
      ch.setVolume(0);
      expect(ch._volume).toBeCloseTo(0, 5);
      ch.setVolume(100);
      expect(ch._volume).toBeCloseTo(1, 5);
    });
  });

  // ── getWaveformSamples ──
  describe("getWaveformSamples", () => {
    it("指定サンプル数の Float32Array を返す", () => {
      const ch = new SynthChannel();
      const samples = ch.getWaveformSamples(64);
      expect(samples).toBeInstanceOf(Float32Array);
      expect(samples).toHaveLength(64);
    });

    it("saw 波形の最初のサンプルは 1 (位相 0)", () => {
      const ch = new SynthChannel();
      ch.setWaveform("saw");
      ch.setStartPhase(0);
      const samples = ch.getWaveformSamples(100);
      expect(samples[0]).toBe(1);
    });

    it("sine 波形の全サンプルが -1〜+1", () => {
      const ch = new SynthChannel();
      ch.setWaveform("sine");
      const samples = ch.getWaveformSamples(256);
      for (let i = 0; i < samples.length; i++) {
        expect(samples[i]).toBeGreaterThanOrEqual(-1);
        expect(samples[i]).toBeLessThanOrEqual(1);
      }
    });

    it("startPhase を変えるとサンプルがオフセットされる", () => {
      const ch = new SynthChannel();
      ch.setWaveform("saw");
      ch.setStartPhase(0);
      const a = ch.getWaveformSamples(100);

      ch.setStartPhase(0.5);
      const b = ch.getWaveformSamples(100);

      // 位相 0 の先頭(=1) と 位相 0.5 の先頭(=0) は異なるはず
      expect(a[0]).not.toBeCloseTo(b[0], 5);
    });

    it("sq50 波形は +1 と -1 のみ", () => {
      const ch = new SynthChannel();
      ch.setWaveform("sq50");
      ch.setStartPhase(0);
      const samples = ch.getWaveformSamples(100);
      for (let i = 0; i < samples.length; i++) {
        expect(Math.abs(samples[i])).toBe(1);
      }
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PolySynth (AudioContext 不要な操作 = 帳簿 + パラメータ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("PolySynth", () => {
  // ── パラメータ (SynthChannel と同一 API) ──
  describe("パラメータ", () => {
    it("デフォルト波形は saw", () => {
      expect(new PolySynth().getWaveform()).toBe("saw");
    });

    it("setWaveform / getWaveform", () => {
      const p = new PolySynth();
      p.setWaveform("sine");
      expect(p.getWaveform()).toBe("sine");
    });

    it("cycleWaveform で順送り + ラップアラウンド", () => {
      const p = new PolySynth();
      const seen = [p.getWaveform()];
      for (let i = 0; i < WAVEFORM_LIST.length; i++) seen.push(p.cycleWaveform());
      // 1 周して先頭に戻る
      expect(seen[0]).toBe("saw");
      expect(seen[WAVEFORM_LIST.length]).toBe("saw");
      expect(new Set(seen.slice(0, WAVEFORM_LIST.length))).toEqual(
        new Set(WAVEFORM_LIST),
      );
    });

    it("setStartPhase は 0〜1 にクランプ", () => {
      const p = new PolySynth();
      p.setStartPhase(0.5);
      expect(p.getStartPhase()).toBe(0.5);
      p.setStartPhase(-1);
      expect(p.getStartPhase()).toBe(0);
      p.setStartPhase(2);
      expect(p.getStartPhase()).toBe(1);
    });

    it("setADSR は ms→秒 / %→比率 に変換", () => {
      const p = new PolySynth();
      p.setADSR(10, 200, 80, 500);
      expect(p._adsrA).toBeCloseTo(0.01, 5);
      expect(p._adsrD).toBeCloseTo(0.2, 5);
      expect(p._adsrS).toBeCloseTo(0.8, 5);
      expect(p._adsrR).toBeCloseTo(0.5, 5);
      // getADSR は ms/% で往復一致
      expect(p.getADSR()).toEqual({ a: 10, d: 200, s: 80, r: 500 });
    });

    it("setVolume は 0〜100 を 0.0〜1.0 に変換", () => {
      const p = new PolySynth();
      p.setVolume(50);
      expect(p._volume).toBeCloseTo(0.5, 5);
      expect(p.getVolume()).toBeCloseTo(50, 5);
    });

    it("getWaveformSamples は指定長の Float32Array (saw 先頭=1)", () => {
      const p = new PolySynth();
      const s = p.getWaveformSamples(64);
      expect(s).toBeInstanceOf(Float32Array);
      expect(s).toHaveLength(64);
      expect(s[0]).toBe(1);
    });
  });

  // ── 発音数管理 (帳簿) ──
  describe("押鍵状態の管理", () => {
    it("初期状態は押鍵ゼロ", () => {
      const p = new PolySynth();
      expect(p.heldCount).toBe(0);
      expect(p.getHeldNotes()).toEqual([]);
    });

    it("noteOn で押鍵に追加、noteOff で除去", () => {
      const p = new PolySynth();
      p.noteOn(60, 1);
      expect(p.isNoteHeld(60)).toBe(true);
      expect(p.heldCount).toBe(1);
      p.noteOff(60);
      expect(p.isNoteHeld(60)).toBe(false);
      expect(p.heldCount).toBe(0);
    });

    it("和音: 複数ノートを同時に保持し、getHeldNotes は昇順", () => {
      const p = new PolySynth();
      p.noteOn(64);
      p.noteOn(60);
      p.noteOn(67);
      expect(p.heldCount).toBe(3);
      expect(p.getHeldNotes()).toEqual([60, 64, 67]);
    });

    it("同ノートの再 noteOn は retrigger (重複しない)", () => {
      const p = new PolySynth();
      p.noteOn(60);
      p.noteOn(60);
      expect(p.heldCount).toBe(1);
      expect(p.getHeldNotes()).toEqual([60]);
    });

    it("未押鍵ノートの noteOff は no-op", () => {
      const p = new PolySynth();
      expect(() => p.noteOff(99)).not.toThrow();
      expect(p.heldCount).toBe(0);
    });

    it("allNotesOff で全ノート解放", () => {
      const p = new PolySynth();
      p.noteOn(60);
      p.noteOn(64);
      p.allNotesOff();
      expect(p.heldCount).toBe(0);
      expect(p.getHeldNotes()).toEqual([]);
    });
  });

  // ── ボイススティール ──
  describe("ボイススティール", () => {
    it("setMaxVoices は 1 以上にクランプ + 小数切り捨て", () => {
      const p = new PolySynth();
      p.setMaxVoices(4);
      expect(p.getMaxVoices()).toBe(4);
      p.setMaxVoices(0);
      expect(p.getMaxVoices()).toBe(1);
      p.setMaxVoices(3.9);
      expect(p.getMaxVoices()).toBe(3);
    });

    it("上限を超えて押鍵すると最古がスティールされ heldCount は上限を保つ", () => {
      const p = new PolySynth();
      p.setMaxVoices(2);
      p.noteOn(60);
      p.noteOn(62);
      p.noteOn(64); // 60 がスティールされる
      expect(p.heldCount).toBe(2);
      expect(p.isNoteHeld(60)).toBe(false);
      expect(p.getHeldNotes()).toEqual([62, 64]);
    });
  });

  // ── AudioContext なしでの安全性 ──
  describe("AudioContext 未初期化での安全性", () => {
    it("noteOn / noteOff / allNotesOff は例外を投げない", () => {
      const p = new PolySynth();
      expect(() => {
        p.noteOn(60, 0.8);
        p.noteOff(60);
        p.allNotesOff();
      }).not.toThrow();
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ファクトリ関数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("ファクトリ関数", () => {
  it("createChannel は SynthChannel インスタンスを返す", () => {
    const ch = createChannel();
    expect(ch).toBeInstanceOf(SynthChannel);
  });

  it("createChannel は毎回新しいインスタンスを返す", () => {
    const a = createChannel();
    const b = createChannel();
    expect(a).not.toBe(b);
  });

  it("createPolySynth は新しい PolySynth インスタンスを返す", () => {
    const a = createPolySynth();
    const b = createPolySynth();
    expect(a).toBeInstanceOf(PolySynth);
    expect(a).not.toBe(b);
  });

  it("getDefaultChannel は SynthChannel を返す", () => {
    const ch = getDefaultChannel();
    expect(ch).toBeInstanceOf(SynthChannel);
  });

  it("getDefaultChannel は同じインスタンスを返す (シングルトン)", () => {
    const a = getDefaultChannel();
    const b = getDefaultChannel();
    expect(a).toBe(b);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  getMasterMeter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("getMasterMeter", () => {
  it("AudioContext 未初期化時 (テスト環境) は peak / reduction ともに 0", () => {
    // Node には AudioContext が無く initAudio が走らないため、常に安全な 0 を返す。
    expect(getMasterMeter()).toEqual({ peak: 0, reduction: 0 });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  createSfxChannels
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("createSfxChannels", () => {
  it("定義辞書からチャンネルマップを生成する", () => {
    const defs = {
      hit: { wave: "sq50", adsr: [1, 40, 0, 20], vol: 22 },
      die: { wave: "noise", adsr: [1, 200, 0, 150], vol: 25 },
    };
    const sfx = createSfxChannels(defs);
    expect(Object.keys(sfx)).toEqual(["hit", "die"]);
    expect(sfx.hit).toBeInstanceOf(SynthChannel);
    expect(sfx.die).toBeInstanceOf(SynthChannel);
  });

  it("各チャンネルに波形が正しく設定される", () => {
    const defs = {
      beep: { wave: "sine", adsr: [5, 50, 60, 100], vol: 80 },
    };
    const sfx = createSfxChannels(defs);
    expect(sfx.beep.getWaveform()).toBe("sine");
  });

  it("各チャンネルに ADSR と音量が設定される", () => {
    const defs = {
      fx: { wave: "tri", adsr: [10, 200, 80, 500], vol: 50 },
    };
    const sfx = createSfxChannels(defs);
    expect(sfx.fx._adsrA).toBeCloseTo(0.01, 5);
    expect(sfx.fx._adsrD).toBeCloseTo(0.2, 5);
    expect(sfx.fx._adsrS).toBeCloseTo(0.8, 5);
    expect(sfx.fx._adsrR).toBeCloseTo(0.5, 5);
    expect(sfx.fx._volume).toBeCloseTo(0.5, 5);
  });

  it("空の定義辞書では空のオブジェクトを返す", () => {
    const sfx = createSfxChannels({});
    expect(Object.keys(sfx)).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SamplePlayer
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("SamplePlayer", () => {
  // ── コンストラクタ ──
  describe("constructor", () => {
    it("デフォルトではバッファなし・音量 0.5", () => {
      const p = new SamplePlayer();
      expect(p.getBuffer()).toBeNull();
      expect(p.getVolume()).toBe(0.5);
      expect(p.hasBuffer()).toBe(false);
    });

    it("バッファと音量を指定して生成できる", () => {
      const mockBuf = { duration: 1.0 }; // AudioBuffer モック
      const p = new SamplePlayer(mockBuf, 0.8);
      expect(p.getBuffer()).toBe(mockBuf);
      expect(p.getVolume()).toBeCloseTo(0.8, 5);
      expect(p.hasBuffer()).toBe(true);
    });

    it("音量は 0.0〜1.0 にクランプされる", () => {
      const p1 = new SamplePlayer(null, -0.5);
      expect(p1.getVolume()).toBe(0);

      const p2 = new SamplePlayer(null, 2.0);
      expect(p2.getVolume()).toBe(1);
    });
  });

  // ── setBuffer / getBuffer / hasBuffer ──
  describe("setBuffer / getBuffer / hasBuffer", () => {
    it("バッファを差し替えられる", () => {
      const p = new SamplePlayer();
      expect(p.hasBuffer()).toBe(false);

      const mockBuf = { duration: 2.0 };
      p.setBuffer(mockBuf);
      expect(p.getBuffer()).toBe(mockBuf);
      expect(p.hasBuffer()).toBe(true);
    });

    it("null でバッファを解除できる", () => {
      const p = new SamplePlayer({ duration: 1.0 });
      expect(p.hasBuffer()).toBe(true);

      p.setBuffer(null);
      expect(p.hasBuffer()).toBe(false);
    });
  });

  // ── setVolume / getVolume ──
  describe("setVolume / getVolume", () => {
    it("音量を設定できる", () => {
      const p = new SamplePlayer();
      p.setVolume(0.75);
      expect(p.getVolume()).toBeCloseTo(0.75, 5);
    });

    it("0 未満は 0 にクランプ", () => {
      const p = new SamplePlayer();
      p.setVolume(-1);
      expect(p.getVolume()).toBe(0);
    });

    it("1 超は 1 にクランプ", () => {
      const p = new SamplePlayer();
      p.setVolume(5);
      expect(p.getVolume()).toBe(1);
    });
  });

  // ── setMaxVoices ──
  describe("setMaxVoices", () => {
    it("最大同時発音数を設定できる", () => {
      const p = new SamplePlayer();
      p.setMaxVoices(8);
      expect(p._maxVoices).toBe(8);
    });

    it("0 以下は 1 にクランプ", () => {
      const p = new SamplePlayer();
      p.setMaxVoices(0);
      expect(p._maxVoices).toBe(1);

      p.setMaxVoices(-5);
      expect(p._maxVoices).toBe(1);
    });

    it("小数は切り捨て", () => {
      const p = new SamplePlayer();
      p.setMaxVoices(3.9);
      expect(p._maxVoices).toBe(3);
    });
  });

  // ── play (AudioContext なし = no-op) ──
  describe("play (AudioContext 未初期化)", () => {
    it("バッファなしで play しても例外を投げない", () => {
      const p = new SamplePlayer();
      expect(() => p.play()).not.toThrow();
    });
  });

  // ── stop (AudioContext なし = no-op) ──
  describe("stop (AudioContext 未初期化)", () => {
    it("stop を呼んでも例外を投げない", () => {
      const p = new SamplePlayer();
      expect(() => p.stop()).not.toThrow();
    });
  });

  // ── activeVoiceCount ──
  describe("activeVoiceCount", () => {
    it("初期状態は 0", () => {
      const p = new SamplePlayer();
      expect(p.activeVoiceCount).toBe(0);
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  playSample
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("playSample", () => {
  it("null を渡しても例外を投げない", () => {
    expect(() => playSample(null)).not.toThrow();
  });

  it("undefined を渡しても例外を投げない", () => {
    expect(() => playSample(undefined)).not.toThrow();
  });

  it("バッファなしの SamplePlayer を渡しても例外を投げない", () => {
    const p = new SamplePlayer();
    expect(() => playSample(p)).not.toThrow();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MIDI 発音スケジューリング (ジッタ吸収)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("computeMidiAudioTime", () => {
  it("timeStamp が無ければ now + lookahead (即時 + 一定遅延)", () => {
    expect(computeMidiAudioTime(10, 0, 12345, 0.008)).toBeCloseTo(10.008, 6);
    expect(computeMidiAudioTime(10, undefined, 12345, 0.008)).toBeCloseTo(
      10.008,
      6,
    );
  });

  it("perfNow が無ければ (null) now + lookahead", () => {
    expect(computeMidiAudioTime(10, 1000, null, 0.02)).toBeCloseTo(10.02, 6);
  });

  it("ハンドラ遅延が lookahead 未満なら、その遅延ぶん前倒しして発音時刻をイベント時刻に固定", () => {
    // イベント 1000ms、ハンドラ実行 1005ms → 遅延 5ms、lookahead 20ms
    // → now + 0.020 - 0.005 = now + 0.015 (イベント時刻 + lookahead に一致)
    expect(computeMidiAudioTime(2, 1000, 1005, 0.02)).toBeCloseTo(2.015, 6);
  });

  it("ハンドラ遅延が lookahead を超えると now にクランプ (過去にはしない)", () => {
    // 遅延 40ms > lookahead 20ms → now + 0.02 - 0.04 = now - 0.02 → now に丸め
    expect(computeMidiAudioTime(2, 1000, 1040, 0.02)).toBe(2);
  });

  it("遅延がちょうど lookahead なら now", () => {
    expect(computeMidiAudioTime(2, 1000, 1020, 0.02)).toBeCloseTo(2, 6);
  });

  it("負の遅延 (時刻巻き戻り) は 0 に丸め now + lookahead", () => {
    expect(computeMidiAudioTime(2, 1000, 990, 0.02)).toBeCloseTo(2.02, 6);
  });

  // 録画中の広いルックアヘッドの効果: 同じ滞留 (フレーム負荷) でも、通常 8ms だと
  // 過去にスケジュールできず now に丸められ発音が遅れる (ジッタ源) が、20ms なら
  // まだ未来に置けるので発音を「イベント時刻 + lookahead」に固定できジッタが出ない。
  it("録画中の広い lookahead は同じ滞留でも発音を未来に保ち、ジッタを吸収する", () => {
    const now = 5;
    const ev = 1000;
    const perf = 1015; // 滞留 15ms
    const tight = computeMidiAudioTime(now, ev, perf, MIDI_LOOKAHEAD); // 8ms < 15ms → now
    const wide = computeMidiAudioTime(now, ev, perf, MIDI_LOOKAHEAD_RECORDING); // 20ms > 15ms
    expect(tight).toBe(now); // 過去に置けず now に丸め = 遅延
    expect(wide).toBeCloseTo(now + 0.005, 6); // イベント時刻 + 20ms に固定
    expect(wide).toBeGreaterThan(tight);
  });
});

describe("currentMidiLookahead", () => {
  it("非録画時 (Node = PCM 収録なし) は通常ルックアヘッド 8ms", () => {
    expect(currentMidiLookahead()).toBe(MIDI_LOOKAHEAD);
    expect(MIDI_LOOKAHEAD).toBe(0.008);
  });

  it("録画中ルックアヘッドは通常より広い (ジッタ吸収のため)", () => {
    expect(MIDI_LOOKAHEAD_RECORDING).toBeGreaterThan(MIDI_LOOKAHEAD);
  });
});

