/**
 * song.test.js — 共有 4 トラック・ソングモデル (app/music/song.js) の検証。
 *
 * 音源 (ChipSynth/PolySynth) の生成は AudioContext を要するため触れず、
 * データモデル (トラック既定 / 選択の排他 / patch 更新 / clip 保持 / 通知) を検証する。
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as song from "@/app/music/song.js";

describe("song モデル (4 トラック固定)", () => {
  beforeEach(() => song._resetSong());

  it("トラック数は 4、既定の選択は 0", () => {
    expect(song.getTrackCount()).toBe(4);
    expect(song.getSelectedIndex()).toBe(0);
  });

  it("トラック既定 (名前 / 波形): LEAD=sq25 / CHORD=sq12 / BASS=tri / DRUM=noise", () => {
    expect(song.getTrack(0).name).toBe("LEAD");
    expect(song.getTrack(1).name).toBe("CHORD");
    expect(song.getTrack(2).name).toBe("BASS");
    expect(song.getTrack(3).name).toBe("DRUM");
    expect(song.getPatch(0).waveform).toBe("sq25");
    expect(song.getPatch(1).waveform).toBe("sq12");
    expect(song.getPatch(2).waveform).toBe("tri");
    expect(song.getPatch(3).waveform).toBe("noise");
  });

  it("全トラックの ADSR = MIN/MIN/MAX/MIN、VOL=50、VOICES=1 (MONO 既定)", () => {
    for (let i = 0; i < 4; i++) {
      expect(song.getPatch(i)).toMatchObject({
        a: 0,
        d: 0,
        s: 100,
        r: 0,
        volume: 50,
        maxVoices: 1,
      });
    }
  });

  it("setSelectedIndex: 範囲外・同一は無視する", () => {
    song.setSelectedIndex(2);
    expect(song.getSelectedIndex()).toBe(2);
    song.setSelectedIndex(99);
    expect(song.getSelectedIndex()).toBe(2);
    song.setSelectedIndex(-1);
    expect(song.getSelectedIndex()).toBe(2);
    song.setSelectedIndex(2); // 同一
    expect(song.getSelectedIndex()).toBe(2);
  });

  it("onSelectionChange: (next, prev) を通知し、同一選択では発火しない", () => {
    const calls = [];
    song.onSelectionChange((n, p) => calls.push([n, p]));
    song.setSelectedIndex(1);
    song.setSelectedIndex(1); // 無視
    song.setSelectedIndex(3);
    expect(calls).toEqual([
      [1, 0],
      [3, 1],
    ]);
  });

  it("updatePatch: 指定キーだけ更新し他は保持する (音源未生成でも patch に残る)", () => {
    song.updatePatch(0, { waveform: "saw", volume: 80 });
    expect(song.getPatch(0)).toMatchObject({ waveform: "saw", volume: 80, a: 0 });
    song.updatePatch(0, { a: 500 });
    expect(song.getPatch(0)).toMatchObject({ waveform: "saw", volume: 80, a: 500 });
  });

  it("getPatch はコピーを返す (外部変更がモデルに漏れない)", () => {
    const p = song.getPatch(0);
    p.volume = 999;
    expect(song.getPatch(0).volume).toBe(50);
  });

  it("clip はトラックごとに独立して保持される", () => {
    const n0 = [{ pitch: 60, start: 0, len: 4, vel: 100 }];
    const n1 = [{ pitch: 48, start: 8, len: 2, vel: 90 }];
    song.setClipNotes(0, n0);
    song.setClipNotes(1, n1);
    expect(song.getClip(0).notes).toEqual(n0);
    expect(song.getClip(1).notes).toEqual(n1);
    expect(song.getClip(2).notes).toEqual([]);
    // steps / stepsPerBeat は保持される
    expect(song.getClip(0).steps).toBeGreaterThan(0);
    expect(song.getClip(0).stepsPerBeat).toBeGreaterThan(0);
  });

  it("peekInstrument は音源生成前は null を返す (強制生成しない)", () => {
    expect(song.peekInstrument(0)).toBe(null);
    expect(song.peekInstrument(3)).toBe(null);
  });
});

describe("song モデル — .song 永続化ブリッジ (snapshotSong / applySong)", () => {
  beforeEach(() => song._resetSong());

  it("snapshotSong: 全 4 トラックの notes / patch / selected をコピーで返す", () => {
    song.setClipNotes(0, [{ pitch: 60, start: 0, len: 4, vel: 100 }]);
    song.setClipNotes(2, [{ pitch: 48, start: 8, len: 2, vel: 90 }]);
    song.setSelectedIndex(2);
    const snap = song.snapshotSong();
    expect(snap.selected).toBe(2);
    expect(snap.tracks).toHaveLength(4);
    expect(snap.tracks[0].notes).toEqual([{ pitch: 60, start: 0, len: 4, vel: 100 }]);
    expect(snap.tracks[2].notes).toEqual([{ pitch: 48, start: 8, len: 2, vel: 90 }]);
    expect(snap.tracks[0].patch.waveform).toBe("sq25");
    // コピーなので書き換えてもモデルに漏れない
    snap.tracks[0].notes.push({ pitch: 1, start: 1, len: 1, vel: 1 });
    snap.tracks[0].patch.volume = 999;
    expect(song.getClip(0).notes).toHaveLength(1);
    expect(song.getPatch(0).volume).toBe(50);
  });

  it("applySong: 全トラックを丸ごと差し替え、旧トラックのデータを残さない (混在防止)", () => {
    // 事前に 4 トラックすべてへ何か打ち込んでおく
    for (let i = 0; i < 4; i++) song.setClipNotes(i, [{ pitch: 60 + i, start: 0, len: 1, vel: 100 }]);
    // 2 トラック分だけ持つデータを適用 (残り 2 トラックは空になるべき)
    song.applySong({
      selected: 1,
      tracks: [
        { notes: [{ pitch: 72, start: 0, len: 2, vel: 100 }], patch: { waveform: "saw", volume: 80 } },
        { notes: [{ pitch: 50, start: 4, len: 1, vel: 90 }] },
      ],
    });
    expect(song.getSelectedIndex()).toBe(1);
    expect(song.getClip(0).notes).toEqual([{ pitch: 72, start: 0, len: 2, vel: 100 }]);
    expect(song.getClip(1).notes).toEqual([{ pitch: 50, start: 4, len: 1, vel: 90 }]);
    // 差し替え前のトラック 2・3 のノートは消える (旧データが残らない)
    expect(song.getClip(2).notes).toEqual([]);
    expect(song.getClip(3).notes).toEqual([]);
    // 音色も適用される
    expect(song.getPatch(0)).toMatchObject({ waveform: "saw", volume: 80 });
  });

  it("applySong: selected が現状と同じでも選択リスナへ通知する (view を強制再同期)", () => {
    const calls = [];
    song.onSelectionChange((n, p) => calls.push([n, p]));
    // 選択は 0 のまま。それでも読み込み後の状態へ view を揃えるため通知される。
    song.applySong({ selected: 0, tracks: [{ notes: [] }] });
    expect(calls).toEqual([[0, 0]]);
  });

  it("snapshotSong → applySong の往復でノートが保たれる", () => {
    song.setClipNotes(3, [{ pitch: 38, start: 0, len: 1, vel: 100 }]);
    song.setSelectedIndex(3);
    const snap = song.snapshotSong();
    song._resetSong();
    song.applySong(snap);
    expect(song.getClip(3).notes).toEqual([{ pitch: 38, start: 0, len: 1, vel: 100 }]);
    expect(song.getSelectedIndex()).toBe(3);
  });
});
