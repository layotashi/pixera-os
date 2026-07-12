/**
 * @module app/roll/roll
 * roll.js — ROLL ウィンドウ (ステップグリッド MIDI エディタ)
 *
 * 最小構成からの再出発。ボディには表を 1 枚だけ描く:
 *   横 16 列 = 1 小節を 16 分音符で分割したステップ。
 *   縦 12 行 = 1 オクターブを構成する 12 音。
 *   計 192 セル。
 *
 * ── 罫線 ──
 *   小節の境界線 (左右端) と、オクターブ境界 (B と C の間 = 上下端) は 2px 実線。
 *   それ以外の内側の罫線は 1px 実線。罫線の太さはセル内寸に含めない。
 *
 * ── ズーム ──
 *   Ctrl+ホイール        … セルを垂直方向 (高さ) に拡大 / 縮小。
 *   Shift+Ctrl+ホイール  … セルを水平方向 (幅) に拡大 / 縮小。
 *   セル内寸は 0..30px。表が窓を超えると WM 標準スクロールバーで巡る。
 *
 * 鍵盤・音名・小節番号・ノート・再生・編集・選択・拍の強調は、この段階では未実装。
 * ノートモデルや再生ロジックは grid.js に温存 (このウィンドウからは未接続) してある。
 */

import { fillRect } from "../../core/gpu.js";
import { wmOpen, wmRegister } from "../../wm/index.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const APP_NAME = "ROLL";

/** 表の格子数: 横 16 列 (1 小節 / 16 分音符) × 縦 12 行 (1 オクターブ 12 音) */
const COLS = 16;
const ROWS = 12;

/** 罫線の太さ (DOT)。境界線 = 太線、それ以外 = 細線 */
const THIN = 1;
const BOLD = 2;

/** セル内寸 (DOT) の範囲と初期値。罫線の太さは内寸に含めない */
const CELL_MIN = 0;
const CELL_MAX = 30;
const CELL_DEFAULT = 15;

/** ホイール 1 ノッチあたりのズーム量 (DOT) */
const ZOOM_STEP = 1;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let winId = -1;

/** セル内寸 (Ctrl / Shift+Ctrl ホイールで可変) */
let cellW = CELL_DEFAULT; // 横 (列) 方向の内寸
let cellH = CELL_DEFAULT; // 縦 (行) 方向の内寸

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  寸法
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 列境界 (縦罫線) の太さ。両端 = 小節境界 = 太線 */
const vThick = (c) => (c === 0 || c === COLS ? BOLD : THIN);
/** 行境界 (横罫線) の太さ。両端 = オクターブ境界 (B/C) = 太線 */
const hThick = (r) => (r === 0 || r === ROWS ? BOLD : THIN);

/** 表の総幅 (DOT) = 全セル内寸 + 全縦罫線の太さ */
function tableW() {
  let w = COLS * cellW;
  for (let c = 0; c <= COLS; c++) w += vThick(c);
  return w;
}
/** 表の総高 (DOT) = 全セル内寸 + 全横罫線の太さ */
function tableH() {
  let h = ROWS * cellH;
  for (let r = 0; r <= ROWS; r++) h += hThick(r);
  return h;
}

/** WM 管理スクロールの仮想コンテンツ寸法 = 表の外寸 */
function onMeasure() {
  return { w: tableW(), h: tableH() };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDraw(cr) {
  // 背景 (ペーパー) は WM がボディを毎フレーム塗るのでここでは不要。
  // cr はスクロール量ぶん原点がずれた自然座標系 (WM が平行移動 + クリップする)。
  const tw = tableW();
  const th = tableH();

  // 縦罫線 (列境界。左端〜右端)。太さ分を進めながら描く
  let x = cr.x;
  for (let c = 0; c <= COLS; c++) {
    const t = vThick(c);
    fillRect(x, cr.y, t, th, 1);
    x += t + (c < COLS ? cellW : 0);
  }
  // 横罫線 (行境界。上端〜下端)
  let y = cr.y;
  for (let r = 0; r <= ROWS; r++) {
    const t = hThick(r);
    fillRect(cr.x, y, tw, t, 1);
    y += t + (r < ROWS ? cellH : 0);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力 (ズーム)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const clampCell = (v) => Math.max(CELL_MIN, Math.min(CELL_MAX, v));

function onInput(ev) {
  if (ev.type !== "wheel" || !ev.ctrl) return; // 通常/Shift ホイールは WM のスクロールへ委ねる
  // WheelUp (deltaY<0) = 拡大 / WheelDown (deltaY>0) = 縮小
  const dir = -Math.sign(ev.deltaY || 0);
  if (dir === 0) return;
  if (ev.shift) {
    cellW = clampCell(cellW + dir * ZOOM_STEP); // Shift+Ctrl = 水平方向 (幅)
  } else {
    cellH = clampCell(cellH + dir * ZOOM_STEP); // Ctrl = 垂直方向 (高さ)
  }
  ev.consumed = true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    // w=0/h=0: onMeasure から初期外寸を自動算出 (表 + chrome にちょうど合う)
    winId = wmOpen(-1, -1, 0, 0, APP_NAME, onDraw, onInput, onMeasure, {
      onBeforeClose: () => {
        winId = -1;
        return true;
      },
      about:
        "A step-grid MIDI editor, rebuilt from a minimal core. The body shows a single " +
        "16-column x 12-row table: 16 sixteenth-note steps of one bar across, the 12 " +
        "semitones of an octave down. Bar and octave (B/C) boundaries are drawn bold. " +
        "Ctrl+wheel resizes cells vertically, Shift+Ctrl+wheel horizontally. Keys, notes, " +
        "and playback come next.",
    });
    return winId;
  },
  { category: "CREATIVE", dev: true },
);
