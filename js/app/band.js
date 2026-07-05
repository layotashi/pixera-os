/**
 * @module app/band
 * band.js — BAND (1-bit 音声反応ビジュアル) のプロトタイプ
 *
 * Web Audio の AnalyserNode で master gain から FFT / 波形を取得し、
 * 1-bit でリアルタイム可視化する。SYNESTA の再生と同期して
 * 「画が音に踊る」体験を提供する。
 *
 * プロトタイプ仕様:
 *   - master gain に AnalyserNode を接続 (信号経路は非侵襲)
 *   - 3 つのビジュアライザを切替可能 (BARS / WAVE / RIPPLE)
 *     - BARS: FFT スペクトラムの 1-bit 棒グラフ
 *     - WAVE: 時間ドメイン波形のラインプロット
 *     - RIPPLE: 音量に応じて中心から広がる同心円
 *   - 上部に簡素なボタン行で切替
 *
 * 未実装 (本格化時の検討事項):
 *   - BPM 検出 → 拍に合わせた演出
 *   - エフェクトプリセットの増加 (core/field_render.js の場レンダラを流用可能)
 *   - CAPTURE との統合 (録画専用モード)
 *   - VRAM dither グラデーション活用
 */

import { pset, fillRect, hline, vline, drawRect } from "../core/gpu.js";
import { drawText, GLYPH_W, GLYPH_H } from "../core/font.js";
import { getAudioContext, getMasterGain, initAudio } from "../core/audio.js";
import { wmOpen, wmRegister } from "../wm/index.js";

const APP_NAME = "BAND";

const WIN_W = 240;
const WIN_H = 160;
const HEADER_H = 14;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  オーディオ解析セットアップ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {AnalyserNode|null} */
let analyser = null;
/** @type {Uint8Array|null} */
let freqData = null;
/** @type {Uint8Array|null} */
let timeData = null;

function _ensureAnalyser() {
  if (analyser) return;
  initAudio();
  const ctx = getAudioContext();
  const master = getMasterGain();
  if (!ctx || !master) return;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  master.connect(analyser);
  freqData = new Uint8Array(analyser.frequencyBinCount);
  timeData = new Uint8Array(analyser.fftSize);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const MODES = ["BARS", "WAVE", "RIPPLE"];
let modeIdx = 0;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ビジュアライザ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function drawBars(cr) {
  if (!analyser) return;
  analyser.getByteFrequencyData(freqData);
  const drawY = cr.y + HEADER_H;
  const drawH = cr.h - HEADER_H - 2;
  const drawW = cr.w - 4;
  const numBars = 48;
  const barW = Math.max(1, ((drawW - numBars) / numBars) | 0);
  const step = Math.floor(freqData.length / numBars);
  for (let i = 0; i < numBars; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += freqData[i * step + j];
    const avg = sum / step / 255;
    const h = Math.floor(avg * drawH);
    const x = cr.x + 2 + i * (barW + 1);
    if (h > 0) {
      fillRect(x, drawY + drawH - h, barW, h, 1);
    }
  }
}

function drawWave(cr) {
  if (!analyser) return;
  analyser.getByteTimeDomainData(timeData);
  const drawY = cr.y + HEADER_H;
  const drawH = cr.h - HEADER_H - 2;
  const cy = drawY + drawH / 2;
  const drawW = cr.w - 4;
  let prevX = cr.x + 2;
  let prevY = cy;
  for (let i = 0; i < drawW; i++) {
    const sampleIdx = Math.floor((i / drawW) * timeData.length);
    const v = (timeData[sampleIdx] - 128) / 128; // -1 ~ +1
    const x = cr.x + 2 + i;
    const y = cy - v * (drawH / 2 - 2);
    // 単純 line: prev と curr 間を線で結ぶ
    const x0 = prevX, y0 = prevY | 0, x1 = x, y1 = y | 0;
    // bresenham 簡略 (横ラインなので適当でも見える)
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1;
    for (let s = 0; s <= steps; s++) {
      const px = x0 + ((x1 - x0) * s) / steps;
      const py = y0 + ((y1 - y0) * s) / steps;
      pset(px | 0, py | 0, 1);
    }
    prevX = x;
    prevY = y;
  }
}

let ripples = []; // { r, age }

function drawRipple(cr) {
  if (!analyser) return;
  analyser.getByteFrequencyData(freqData);
  // 低音域の平均パワーを取得
  let bass = 0;
  for (let i = 0; i < 16; i++) bass += freqData[i];
  bass /= 16 * 255;

  // 一定閾値を超えたら新しい波紋
  if (bass > 0.4 && (ripples.length === 0 || ripples[ripples.length - 1].r > 8)) {
    ripples.push({ r: 1, age: 0 });
  }

  const cx = cr.x + cr.w / 2;
  const cy = cr.y + HEADER_H + (cr.h - HEADER_H) / 2;
  const maxR = Math.min(cr.w, cr.h - HEADER_H) / 2 - 2;

  for (const ring of ripples) {
    ring.r += 0.7 + bass * 1.5;
    ring.age++;
    // 1-bit 円 (mid-point algorithm 簡略)
    const r = ring.r | 0;
    if (r > maxR) continue;
    let x = r, y = 0, err = 0;
    while (x >= y) {
      pset(cx + x, cy + y, 1);
      pset(cx + y, cy + x, 1);
      pset(cx - y, cy + x, 1);
      pset(cx - x, cy + y, 1);
      pset(cx - x, cy - y, 1);
      pset(cx - y, cy - x, 1);
      pset(cx + y, cy - x, 1);
      pset(cx + x, cy - y, 1);
      y++;
      err += 1 + 2 * y;
      if (2 * (err - x) + 1 > 0) {
        x--;
        err += 1 - 2 * x;
      }
    }
  }
  ripples = ripples.filter((r) => r.r <= maxR);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ヘッダー (モード切替ボタン)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 最新の contentRect 幅を onInput hit-test と共有する
let _crW = 0;

// ボタンのジオメトリ。
// グリフを 1px 単位で対称に配置するため、サイズと padding は明示計算する。
// (BTN_W - GLYPH_W) / 2 が整数になる組み合わせを選ぶ:
//   GLYPH_W = 5 → BTN_W = 11 で padX = 3
//   GLYPH_H = 5 → BTN_H = 11 で padY = 3
const BTN_W = 11;
const BTN_H = 11;

function drawHeader(cr) {
  _crW = cr.w;
  // モード名表示
  const label = `MODE: ${MODES[modeIdx]}`;
  drawText(cr.x + 4, cr.y + 4, label, 1);
  // 「>」ボタン (右側、左右上下とも完全対称な padding)
  const btnX = cr.x + cr.w - BTN_W - 2;
  // ヘッダー領域内で button を上下中央に配置 (HEADER_H = 14)
  const btnY = cr.y + Math.floor((HEADER_H - BTN_H) / 2);
  drawRect(btnX, btnY, BTN_W, BTN_H, 1);
  // グリフを button 内で 1px 単位で対称配置
  const padX = Math.floor((BTN_W - GLYPH_W) / 2);
  const padY = Math.floor((BTN_H - GLYPH_H) / 2);
  drawText(btnX + padX, btnY + padY, ">", 1);
  // セパレータ
  hline(cr.x, cr.x + cr.w - 1, cr.y + HEADER_H - 1, 1);
}

function isHeaderClick(ev) {
  return ev.localY < HEADER_H;
}

function isModeButtonClick(ev) {
  return (
    ev.localX >= _crW - BTN_W - 2 &&
    ev.localX < _crW - 2 &&
    ev.localY >= 0 &&
    ev.localY < HEADER_H
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画 / 入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDraw(cr) {
  _ensureAnalyser();
  drawHeader(cr);
  if (modeIdx === 0) drawBars(cr);
  else if (modeIdx === 1) drawWave(cr);
  else drawRipple(cr);
}

function onInput(ev) {
  if (ev.type === "down" && isHeaderClick(ev) && isModeButtonClick(ev)) {
    modeIdx = (modeIdx + 1) % MODES.length;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    return wmOpen(-1, -1, WIN_W, WIN_H, APP_NAME, onDraw, onInput, null, {
      about:
        "Visualizes audio from SYNESTA playback in 1-bit. Press the > " +
        "button in the header to cycle through visualizer modes.",
      noResize: true,
      noMaximize: true,
    });
  },
  { category: "EXPERIMENT" },
);
