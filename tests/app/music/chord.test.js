/**
 * chord.test.js — 簡易コード推定 (app/music/chord.js) の契約テスト。
 *
 * 発音中の MIDI ノート群 → 和音名。転回無視 (各ピッチクラスをルート候補に照合)、
 * 相対度数/分数コード非対応の MVP を固定する。MIDI: C4=60。
 */
import { describe, it, expect } from "vitest";
import { estimateChord } from "@/app/music/chord.js";

// 音名 → MIDI (4 オクターブ)。
const C = 60, Cs = 61, D = 62, Ds = 63, E = 64, F = 65, Fs = 66, G = 67, Gs = 68, A = 69, As = 70, B = 71;

describe("estimateChord — 基本", () => {
  it("空は空文字", () => {
    expect(estimateChord([])).toBe("");
    expect(estimateChord(null)).toBe("");
  });

  it("単音は音名 (オクターブ違いの重ねも同じ)", () => {
    expect(estimateChord([C])).toBe("C");
    expect(estimateChord([Fs])).toBe("F#");
    expect(estimateChord([C, C + 12])).toBe("C"); // 同ピッチクラスの重ね
  });
});

describe("estimateChord — トライアド (転回無視)", () => {
  it("メジャーは接尾辞なし", () => {
    expect(estimateChord([C, E, G])).toBe("C");
    expect(estimateChord([G, B, D + 12])).toBe("G");
  });

  it("転回しても根音が採れる (E-G-C は C)", () => {
    expect(estimateChord([E, G, C + 12])).toBe("C");
    expect(estimateChord([G, C + 12, E + 12])).toBe("C");
  });

  it("マイナー / ディミニッシュ / オーギュメント", () => {
    expect(estimateChord([C, Ds, G])).toBe("Cm"); // C Eb G
    expect(estimateChord([C, Ds, Fs])).toBe("Cdim"); // C Eb Gb
    expect(estimateChord([C, E, Gs])).toBe("Caug"); // C E G#
  });

  it("sus2 / sus4 / パワーコード", () => {
    expect(estimateChord([C, D, G])).toBe("Csus2");
    expect(estimateChord([C, F, G])).toBe("Csus4");
    expect(estimateChord([C, G])).toBe("C5");
  });
});

describe("estimateChord — 7th / 6th", () => {
  it("ドミナント7 / メジャー7 / マイナー7", () => {
    expect(estimateChord([C, E, G, As])).toBe("C7"); // C E G Bb
    expect(estimateChord([C, E, G, B])).toBe("Cmaj7");
    expect(estimateChord([C, Ds, G, As])).toBe("Cm7"); // C Eb G Bb
  });

  it("ハーフディミニッシュ / ディミニッシュ7", () => {
    expect(estimateChord([C, Ds, Fs, As])).toBe("Cm7-5"); // C Eb Gb Bb
    expect(estimateChord([C, Ds, Fs, A])).toBe("Cdim7"); // C Eb Gb A(=Bbb)
  });

  it("6th / マイナー6th は 7th と区別される", () => {
    expect(estimateChord([C, E, G, A])).toBe("C6");
    expect(estimateChord([C, Ds, G, A])).toBe("Cm6");
  });
});

describe("estimateChord — 未知の和音", () => {
  it("テンプレートに無い集合は最低音を当て推量で出す", () => {
    // C と E の 2 音 (長 3 度) はテンプレートに無い → 最低音 C
    expect(estimateChord([C, E])).toBe("C");
    // クラスター (C D E) は該当なし → 最低音 C
    expect(estimateChord([C, D, E])).toBe("C");
  });
});
