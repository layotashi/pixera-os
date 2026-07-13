/**
 * @module app/oscillo
 * oscillo.js — OSCILLO (1-bit オシロスコープ)
 *
 * Web Audio の AnalyserNode で master gain から時間ドメイン波形を取得し、ウィンドウ
 * ボディ全域に 1-bit のトレースとして描く。SYNESTA/SYNTH/ROLL 等の再生と同期して
 * 「画が音に踊る」体験を提供する。
 *
 * 仕様:
 *   - master gain に AnalyserNode を接続 (信号経路は非侵襲: 受動的な分岐)
 *   - 表示は単純な波形トレースのみ (表示モードの概念は持たない)
 *   - 配色はオシロスコープに倣い「地 = 前景 (黒)・波形 = 背景 (白)」。SYNTH の反転配色
 *     (白鍵=背景/黒鍵=前景、フェーダーの溝=前景) と同じ規則で、地を前景色で塗り波形を
 *     背景色で描く。OS 全体の invert 切替が入っても SYNTH と一緒に反転して整合する。
 *   - ボディ全域を使う (NOTEPAD/ROLL と同じく Content Pad を効かせない padding:"none")
 *
 * 未実装 (本格化時の検討事項):
 *   - BPM 検出 → 拍に合わせた演出
 *   - CAPTURE との統合 (録画専用モード)
 */

import { fillRect, vline } from "../core/gpu.js";
import { getAudioContext, getMasterGain, initAudio } from "../core/audio.js";
import { wmOpen, wmRegister } from "../wm/index.js";

const APP_NAME = "OSCILLO";

const WIN_W = 240;
const WIN_H = 160;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  オーディオ解析セットアップ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {AnalyserNode|null} */
let analyser = null;
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
  master.connect(analyser); // 受動的な分岐 (destination には繋がないので音は変えない)
  timeData = new Uint8Array(analyser.fftSize);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  波形トレース
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 時間ドメイン波形をボディ全域に描く。
 *
 * 全ての列を同じ規則で扱う: 列 i の描画位置は「その列に写像したサンプルの振幅 A」だけで
 * 決まり、左右端も内部の列と完全に等価。i=0 は基準点を打つだけ、以降は直前の列の振幅と
 * 現在の列の振幅を縦線で結んで連続したトレースにする (隣接列なので縦補間で足りる)。
 * 旧実装は基準点を中央 (振幅 0) に固定していたため、左端だけが「中央→先頭サンプル」の
 * 縦線になって非対称に見えていた。基準点を先頭サンプル自身にすることでこれを解消する。
 *
 * @param {{x:number,y:number,w:number,h:number}} cr  コンテンツ矩形 (= ボディ全域)
 */
function drawWave(cr) {
  const cy = cr.y + cr.h / 2;
  const amp = cr.h / 2 - 1; // 上下 1px を余白として残す
  const n = timeData.length;
  let prevY = 0;
  for (let i = 0; i < cr.w; i++) {
    const sampleIdx = Math.min(n - 1, Math.floor((i / cr.w) * n));
    const v = (timeData[sampleIdx] - 128) / 128; // -1.0 〜 +1.0
    const x = cr.x + i;
    const y = (cy - v * amp) | 0;
    const from = i === 0 ? y : prevY; // 先頭列は自分自身を基準に (= 点を打つ)
    vline(x, from, y, 0); // 波形は背景色 (白) で描く
    prevY = y;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDraw(cr) {
  _ensureAnalyser();
  // 地をボディ全域に前景色 (黒) で塗る。オーディオ未初期化 (無音・ユーザー未操作) でも
  // オシロスコープらしい黒画面になる。
  fillRect(cr.x, cr.y, cr.w, cr.h, 1);
  if (!analyser) return;
  analyser.getByteTimeDomainData(timeData);
  drawWave(cr);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    return wmOpen(-1, -1, WIN_W, WIN_H, APP_NAME, onDraw, null, null, {
      about:
        "Visualizes audio from SYNTH / ROLL playback as a 1-bit oscilloscope " +
        "trace across the whole window.",
      // ボディ全域を波形に使う (NOTEPAD/ROLL 同様)。Content Pad を効かせると波形が
      // 中途半端な位置で途切れて見えるため、アプリ側で内側余白を無効化する。
      padding: "none",
      noResize: true,
      noMaximize: true,
    });
  },
  { category: "EXPERIMENT" },
);
