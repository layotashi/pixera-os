/**
 * @module core/song
 * song.js — 楽曲プロジェクト (.song) の共有モデル + JSON コーデック
 *
 * ROLL のクリップ (.roll = core/clip.js) が「音符と時間だけ」の単一フレーズなのに対し、
 * .song は 4 トラック (各トラックの音符 + 音色) を 1 ファイルに束ねた「楽曲まるごと」の
 * プロジェクトコンテナ。今回のマルチトラック化で作った共有ソングモデル
 * (app/music/song.js) を永続化した姿にあたる (docs/SONG_FORMAT_SPEC.md)。
 *
 * ── なぜ core/clip.js と分けるか ──
 *   clip.js は「単一フレーズの交換グレイン」という役割を保つ (複数トラックを含めない、
 *   という clip.js ヘッダ / MIDI_EDITOR_SPEC §4 の非目標を尊重)。song.js はその上位の
 *   コンテナで、ノートスキーマ {pitch,start,len,vel} は clip.js の createClip を再利用して
 *   モデルを二重に作らない。
 *
 * ── song 構造 ──
 *   {
 *     stepsPerBeat, steps,               // 全トラック共通の時間解像度 / パターン長
 *     selected,                          // 編集中 (アクティブ) トラック index (0..3)
 *     transport: {                       // 共有トランスポート状態 (再生状態は保存しない)
 *       bpm, beatsPerBar, loopStart, loopEnd, loopOn, metronome, position },
 *     view: { fold },                    // ROLL などの表示状態
 *     tracks: [ {                        // 固定 4 トラック
 *       name,                            // 表示名 (省略可)
 *       patch: { waveform, a, d, s, r, volume, maxVoices },  // 音色 (トラック単位)
 *       notes: [ { pitch, start, len, vel } ],               // clip.js と同一のノート形状
 *       solo, mute,                      // 発音制御 (1 トラック内で排他)
 *     } ]
 *   }
 *
 * ── 永続形式 (.song) ──
 *   上記に自己記述用の { format, version } を足した JSON。VFS へテキスト保存する。
 *   parseSong は防御的: 壊れた JSON / format 不一致は null、各フィールドは clamp / 正規化、
 *   トラックが 4 未満なら空トラックで補い、超過分は捨てる (混在や欠落を起こさない)。
 *
 * ── 将来 (加算的に予約) ──
 *   bpm / beatsPerBar / loop (トランスポート) や arrangement (クリップ配置) は
 *   version を上げて加算する (docs/SONG_FORMAT_SPEC.md §6)。version は前方互換の足場。
 */

import { createClip, DEFAULT_STEPS, DEFAULT_STEPS_PER_BEAT } from "./clip.js";

// ── 形式メタ ──
export const SONG_FORMAT = "pixera-song";
/** v2: トランスポート (bpm/loop/metro/position/拍子)・view (fold)・トラックの solo/mute を追加。
 *  v1 (それらを持たない) も既定値で補って読める (前方・後方互換)。 */
export const SONG_VERSION = 2;
/** 楽曲プロジェクトの拡張子 */
export const SONG_EXT = ".song";
/** 固定トラック数 (app/music/song.js の TRACK_COUNT と一致。将来可変) */
export const SONG_TRACK_COUNT = 4;

// ── 音色 (patch) の既定値 / 範囲 ──
// 波形 ID (文字列) の妥当性は音源側 (core/chip.js) が持つため、ここでは列挙を検証せず
// 文字列であることだけを確かめる (未知の波形も素通しし、壊れた値だけ既定へ倒す)。
const DEFAULT_PATCH = {
  waveform: "sq50",
  a: 0,
  d: 0,
  s: 100,
  r: 0,
  volume: 50,
  maxVoices: 1, // 既定は Monophonic (チップチューン。live モデル DEFAULT_MAX_VOICES と一致)
};

/** 全トラック共通のトランスポート状態の既定 (transport.js の既定に一致)。 */
const DEFAULT_TRANSPORT = {
  bpm: 120,
  beatsPerBar: 4,
  loopStart: 0,
  loopEnd: 16,
  loopOn: true,
  metronome: false,
  position: 0,
};
/** ROLL などの表示状態の既定。 */
const DEFAULT_VIEW = { fold: false };

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function nonNeg(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** トランスポート状態を正規化する (欠け/不正は既定へ)。 */
function normalizeTransport(t) {
  t = t && typeof t === "object" ? t : {};
  return {
    bpm: clampInt(num(t.bpm, DEFAULT_TRANSPORT.bpm), 1, 1000),
    beatsPerBar: Math.max(1, Math.round(num(t.beatsPerBar, DEFAULT_TRANSPORT.beatsPerBar))),
    loopStart: nonNeg(t.loopStart, DEFAULT_TRANSPORT.loopStart),
    loopEnd: nonNeg(t.loopEnd, DEFAULT_TRANSPORT.loopEnd),
    loopOn: t.loopOn === undefined ? DEFAULT_TRANSPORT.loopOn : !!t.loopOn,
    metronome: !!t.metronome,
    position: nonNeg(t.position, DEFAULT_TRANSPORT.position),
  };
}

/** 表示状態を正規化する。 */
function normalizeView(v) {
  v = v && typeof v === "object" ? v : {};
  return { fold: !!v.fold };
}

function posInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : def;
}

/**
 * 1 トラックの音色を正規化する。未指定・不正なフィールドは既定値で補い、範囲外は clamp する。
 * @param {object} p
 * @returns {{waveform:string,a:number,d:number,s:number,r:number,volume:number,maxVoices:number}}
 */
function normalizePatch(p) {
  p = p && typeof p === "object" ? p : {};
  return {
    waveform: typeof p.waveform === "string" ? p.waveform : DEFAULT_PATCH.waveform,
    a: Math.max(0, num(p.a, DEFAULT_PATCH.a)),
    d: Math.max(0, num(p.d, DEFAULT_PATCH.d)),
    s: clampInt(num(p.s, DEFAULT_PATCH.s), 0, 100),
    r: Math.max(0, num(p.r, DEFAULT_PATCH.r)),
    volume: clampInt(num(p.volume, DEFAULT_PATCH.volume), 0, 100),
    maxVoices: Math.max(1, Math.round(num(p.maxVoices, DEFAULT_PATCH.maxVoices))),
  };
}

/**
 * 素材から正規化済みソングを組み立てる。
 * トラックは常にちょうど SONG_TRACK_COUNT 本にする (不足は空トラックで補い、超過は捨てる)
 * ため、読み込み後に「トラックが混在・欠落する」ことがない。ノートは clip.js の createClip で
 * 検証・整列し、音色は normalizePatch で clamp する。
 * @param {object} [src]
 * @returns {{stepsPerBeat:number, steps:number, selected:number, tracks:Array}}
 */
export function createSong(src = {}) {
  src = src && typeof src === "object" ? src : {};
  const stepsPerBeat = posInt(src.stepsPerBeat, DEFAULT_STEPS_PER_BEAT);
  const steps = posInt(src.steps, DEFAULT_STEPS);
  const rawTracks = Array.isArray(src.tracks) ? src.tracks : [];

  const tracks = [];
  for (let i = 0; i < SONG_TRACK_COUNT; i++) {
    const t = rawTracks[i] && typeof rawTracks[i] === "object" ? rawTracks[i] : {};
    // ノートは clip.js のスキーマ検証・整列を再利用する (モデルを二重に作らない)。
    const clip = createClip({ stepsPerBeat, steps, notes: t.notes });
    const solo = !!t.solo;
    tracks.push({
      name: typeof t.name === "string" ? t.name : "",
      patch: normalizePatch(t.patch),
      notes: clip.notes,
      solo, // SOLO / MUTE は 1 トラック内で排他 (SOLO 優先で正規化)
      mute: !!t.mute && !solo,
    });
  }

  const selected = clampInt(num(src.selected, 0), 0, SONG_TRACK_COUNT - 1);
  return {
    stepsPerBeat,
    steps,
    selected,
    transport: normalizeTransport(src.transport),
    view: normalizeView(src.view),
    tracks,
  };
}

/**
 * ソングを .song の JSON テキストへ直列化する。
 * 各トラックは検証・整列され、自己記述用の format/version を付す。
 * @param {object} song
 * @returns {string}
 */
export function serializeSong(song) {
  const s = createSong(song);
  return JSON.stringify(
    {
      format: SONG_FORMAT,
      version: SONG_VERSION,
      stepsPerBeat: s.stepsPerBeat,
      steps: s.steps,
      selected: s.selected,
      transport: s.transport,
      view: s.view,
      tracks: s.tracks.map((t) => ({
        name: t.name,
        patch: t.patch,
        notes: t.notes,
        solo: t.solo,
        mute: t.mute,
      })),
    },
    null,
    2,
  );
}

/**
 * .song の JSON テキストを解析してソングへ復元する。
 * JSON が壊れている・format タグが違う場合は null (.roll = "pixera-clip" もここで弾かれる)。
 * トラックは常に 4 本へ正規化される (不足は空、超過は切り捨て)。
 * @param {string} text
 * @returns {{stepsPerBeat:number, steps:number, selected:number, tracks:Array}|null}
 */
export function parseSong(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  // format タグが有れば検証する (無い最小 JSON も緩く受理する)。
  if (data.format !== undefined && data.format !== SONG_FORMAT) return null;
  return createSong(data);
}
