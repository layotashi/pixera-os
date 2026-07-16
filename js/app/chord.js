/**
 * @module app/chord
 * chord.js — CHORD (発音中の和音名表示)
 *
 * OSCILLO の兄弟アプリ。発音中のノート群 (再生中の各可聴トラック + ライブ押鍵) から和音を推定し、
 * 黒背景の中央に白の大きな文字で和音名を出す。作曲支援 (今どの和音が鳴っているか) 兼、SNS 映えを
 * 狙った演出。推定は簡易 (app/music/chord.js の estimateChord)。SYNESTA メンバー。
 *
 * 配色は OSCILLO と同じ規則 (地 = 前景色で塗り、文字 = 背景色)。OS の invert 切替に一緒に追従する。
 * 文字は 5x5 システムフォントのグリフを x4 に拡大して描く (20x20px)。和音名は大文字小文字を
 * 区別したい (m = マイナー) ので OS の uppercase 変換は通さず、グリフを直接拡大描画する。
 */

import { fillRect } from "../core/gpu.js";
import { getGlyph, GLYPH_W, GLYPH_H } from "../core/font.js";
import { wmOpen, wmRegister } from "../wm/index.js";
import * as song from "./music/song.js";
import * as transport from "./music/transport.js";
import { estimateChord } from "./music/chord.js";

const APP_NAME = "CHORD";
const WIN_W = 240;
const WIN_H = 100;
/** 文字の拡大率 (5x5 → 20x20px)。 */
const SCALE = 4;

/**
 * 発音中の MIDI ピッチ群を集める: 再生中は各可聴トラックのクリップで再生ヘッド上のノート、
 * さらに全トラックのライブ押鍵 (鍵盤 / MIDI)。SOLO/MUTE で鳴らないトラックは除く。
 * @returns {number[]}
 */
function soundingPitches() {
  const set = new Set();
  if (transport.isPlaying()) {
    const step = Math.floor(transport.getPosition() * transport.getStepsPerBeat());
    for (let i = 0; i < song.getTrackCount(); i++) {
      if (!song.isAudible(i)) continue;
      const clip = song.getClip(i);
      if (!clip) continue;
      for (const n of clip.notes) {
        if (step >= n.start && step < n.start + n.len) set.add(n.pitch);
      }
    }
  }
  for (let i = 0; i < song.getTrackCount(); i++) {
    if (!song.isAudible(i)) continue;
    const inst = song.peekInstrument(i);
    if (inst && inst.getHeldNotes) for (const m of inst.getHeldNotes()) set.add(m);
  }
  return [...set];
}

/** 文字列を x4 拡大し、(cx,cy) を中心に背景色 (白) で描く。1 文字送り = (GLYPH_W+1)×SCALE。 */
function drawBigCentered(cx, cy, str) {
  const cw = (GLYPH_W + 1) * SCALE; // 1 文字の送り幅 (字間 1px 込み)
  const totalW = str.length * cw - SCALE; // 末尾の字間は含めない
  const totalH = GLYPH_H * SCALE;
  let x = cx - (totalW >> 1);
  const y = cy - (totalH >> 1);
  for (const ch of str) {
    const g = getGlyph(ch);
    if (g) {
      for (let gy = 0; gy < GLYPH_H; gy++) {
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (g[gy * GLYPH_W + gx]) fillRect(x + gx * SCALE, y + gy * SCALE, SCALE, SCALE, 0);
        }
      }
    }
    x += cw;
  }
}

function onDraw(cr) {
  fillRect(cr.x, cr.y, cr.w, cr.h, 1); // 地を前景色 (黒) で塗る
  const name = estimateChord(soundingPitches());
  if (name) drawBigCentered(cr.x + (cr.w >> 1), cr.y + (cr.h >> 1), name);
}

wmRegister(
  APP_NAME,
  () => {
    return wmOpen(-1, -1, WIN_W, WIN_H, APP_NAME, onDraw, null, null, {
      about:
        "Shows the name of the chord currently sounding across the music tracks " +
        "(playback + live keys). A simple estimator (major / minor / 7th / sus / etc.), " +
        "meant as a composing aid and a bit of flair. Big white text on black.",
      // ボディ全域を使う (OSCILLO 同様)。Content Pad を効かせると文字が中途半端に寄るため無効化。
      padding: "none",
    });
  },
  // SYNESTA メンバー: アイコン / ランチャーには出さず、SYNESTA からまとめて起動する。
  { category: "CREATIVE", hidden: true, noIcon: true },
);
