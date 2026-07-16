/**
 * song.test.js — .song 楽曲プロジェクト コーデック (core/song.js) の検証。
 *
 * .song は 4 トラック (音符 + 音色) を束ねる楽曲コンテナ。防御的パース (壊れた JSON → null、
 * format タグ検証、トラックは常に 4 本へ正規化) と、往復 (serialize→parse) の安定を確かめる。
 * ノート正規化は core/clip.js を再利用しているため、ここでは「トラックの過不足を埋める」
 * 「音色を clamp する」「.roll (pixera-clip) を弾く」といった song 固有の責務に集中する。
 */
import { describe, it, expect } from "vitest";
import {
  createSong,
  serializeSong,
  parseSong,
  SONG_FORMAT,
  SONG_VERSION,
  SONG_TRACK_COUNT,
} from "@/core/song.js";

const NOTE = (pitch, start, len, vel = 100) => ({ pitch, start, len, vel });

describe("createSong — トラックを常に 4 本へ正規化", () => {
  it("空入力: 4 本の空トラック + 既定 selected=0", () => {
    const s = createSong();
    expect(s.tracks).toHaveLength(SONG_TRACK_COUNT);
    expect(s.selected).toBe(0);
    for (const t of s.tracks) expect(t.notes).toEqual([]);
  });

  it("トラックが 4 未満なら空トラックで補う (欠落を作らない)", () => {
    const s = createSong({ tracks: [{ notes: [NOTE(60, 0, 4)] }] });
    expect(s.tracks).toHaveLength(4);
    expect(s.tracks[0].notes).toEqual([NOTE(60, 0, 4)]);
    expect(s.tracks[1].notes).toEqual([]);
    expect(s.tracks[2].notes).toEqual([]);
    expect(s.tracks[3].notes).toEqual([]);
  });

  it("トラックが 4 超過なら切り捨てる", () => {
    const t = () => ({ notes: [] });
    const s = createSong({ tracks: [t(), t(), t(), t(), t(), t()] });
    expect(s.tracks).toHaveLength(4);
  });

  it("selected は 0..3 にクランプする", () => {
    expect(createSong({ selected: 2 }).selected).toBe(2);
    expect(createSong({ selected: 99 }).selected).toBe(3);
    expect(createSong({ selected: -5 }).selected).toBe(0);
    expect(createSong({ selected: "x" }).selected).toBe(0);
  });

  it("ノートは clip.js の正規化で範囲クランプ・整列される", () => {
    const s = createSong({
      tracks: [{ notes: [NOTE(200, 8, 1), NOTE(60, 0, 0)] }],
    });
    // pitch は 127 にクランプ、len は 1 以上、start 昇順に整列
    expect(s.tracks[0].notes).toEqual([
      { pitch: 60, start: 0, len: 1, vel: 100 },
      { pitch: 127, start: 8, len: 1, vel: 100 },
    ]);
  });

  it("音色 (patch) は未指定を既定で補い範囲を clamp する", () => {
    const s = createSong({
      tracks: [{ patch: { waveform: "saw", volume: 999, s: -10, maxVoices: 0 } }],
    });
    expect(s.tracks[0].patch).toEqual({
      waveform: "saw",
      a: 0,
      d: 0,
      s: 0,
      r: 0,
      volume: 100,
      maxVoices: 1,
    });
  });

  it("波形が文字列でなければ既定へ倒す (未知の文字列はそのまま通す)", () => {
    expect(createSong({ tracks: [{ patch: { waveform: 123 } }] }).tracks[0].patch.waveform).toBe(
      "sq50",
    );
    expect(
      createSong({ tracks: [{ patch: { waveform: "customwave" } }] }).tracks[0].patch.waveform,
    ).toBe("customwave");
  });
});

describe("createSong — トランスポート / view / solo-mute (v2)", () => {
  it("未指定なら既定のトランスポート / view / solo-mute を補う", () => {
    const s = createSong();
    expect(s.transport).toEqual({
      bpm: 120,
      beatsPerBar: 4,
      loopStart: 0,
      loopEnd: 16,
      loopOn: true,
      metronome: false,
      position: 0,
    });
    expect(s.view).toEqual({ fold: false });
    for (const t of s.tracks) {
      expect(t.solo).toBe(false);
      expect(t.mute).toBe(false);
    }
  });

  it("指定したトランスポート / view / solo-mute を保持・正規化する", () => {
    const s = createSong({
      transport: { bpm: 140, loopStart: 4, loopEnd: 12, loopOn: false, metronome: true, position: 6 },
      view: { fold: true },
      tracks: [{ solo: true }, { mute: true }],
    });
    expect(s.transport.bpm).toBe(140);
    expect(s.transport).toMatchObject({ loopStart: 4, loopEnd: 12, loopOn: false, metronome: true, position: 6 });
    expect(s.view.fold).toBe(true);
    expect(s.tracks[0].solo).toBe(true);
    expect(s.tracks[1].mute).toBe(true);
  });

  it("SOLO と MUTE が両方 true なら SOLO 優先 (MUTE を落とす)", () => {
    const s = createSong({ tracks: [{ solo: true, mute: true }] });
    expect(s.tracks[0].solo).toBe(true);
    expect(s.tracks[0].mute).toBe(false);
  });

  it("往復 (serialize→parse) でトランスポート / view / solo-mute が保たれる", () => {
    const src = {
      transport: { bpm: 90, beatsPerBar: 3, loopStart: 8, loopEnd: 24, loopOn: false, metronome: true, position: 10 },
      view: { fold: true },
      tracks: [{ solo: true }, {}, { mute: true }, {}],
    };
    const round = parseSong(serializeSong(src));
    expect(round.transport).toEqual(createSong(src).transport);
    expect(round.view.fold).toBe(true);
    expect(round.tracks[0].solo).toBe(true);
    expect(round.tracks[2].mute).toBe(true);
  });

  it("v1 形式 (transport/view/solo-mute 無し) も既定で補って読める (後方互換)", () => {
    const v1 = JSON.stringify({
      format: SONG_FORMAT,
      version: 1,
      stepsPerBeat: 4,
      steps: 64,
      selected: 1,
      tracks: [{ name: "LEAD", patch: { waveform: "sq25" }, notes: [] }],
    });
    const s = parseSong(v1);
    expect(s).not.toBeNull();
    expect(s.selected).toBe(1);
    expect(s.transport.bpm).toBe(120); // 既定
    expect(s.view.fold).toBe(false);
    expect(s.tracks[0].solo).toBe(false);
    expect(s.tracks[0].mute).toBe(false);
  });
});

describe("serializeSong / parseSong — 往復と防御的パース", () => {
  const src = {
    stepsPerBeat: 4,
    steps: 64,
    selected: 2,
    tracks: [
      { name: "LEAD", patch: { waveform: "sq25", volume: 60 }, notes: [NOTE(72, 0, 2)] },
      { name: "CHORD", patch: { waveform: "sq12", volume: 40 }, notes: [NOTE(48, 4, 8)] },
      { name: "BASS", patch: { waveform: "tri", volume: 70 }, notes: [] },
      { name: "DRUM", patch: { waveform: "noise", volume: 50 }, notes: [NOTE(38, 0, 1)] },
    ],
  };

  it("往復で同じソングに戻る (4 トラック分すべて保持される)", () => {
    const round = parseSong(serializeSong(src));
    expect(round).toEqual(createSong(src));
    // 4 トラックのノートが失われない (Task 5 の中心的な回帰防止)
    expect(round.tracks[0].notes).toEqual([NOTE(72, 0, 2)]);
    expect(round.tracks[1].notes).toEqual([NOTE(48, 4, 8)]);
    expect(round.tracks[3].notes).toEqual([NOTE(38, 0, 1)]);
    expect(round.selected).toBe(2);
  });

  it("直列化 JSON は format / version を含む", () => {
    const obj = JSON.parse(serializeSong({ tracks: [] }));
    expect(obj.format).toBe(SONG_FORMAT);
    expect(obj.version).toBe(SONG_VERSION);
    expect(obj.tracks).toHaveLength(4);
  });

  it("壊れた JSON は null", () => {
    expect(parseSong("{ not json")).toBeNull();
    expect(parseSong("")).toBeNull();
  });

  it("format タグが違う JSON は null (.roll = pixera-clip をここで弾く)", () => {
    const roll = JSON.stringify({ format: "pixera-clip", notes: [] });
    expect(parseSong(roll)).toBeNull();
  });

  it("format タグの無い最小 JSON も緩く受理し 4 トラックへ整える", () => {
    const s = parseSong(JSON.stringify({ tracks: [{ notes: [NOTE(60, 0, 1)] }] }));
    expect(s).not.toBeNull();
    expect(s.tracks).toHaveLength(4);
    expect(s.tracks[0].notes).toHaveLength(1);
  });
});
