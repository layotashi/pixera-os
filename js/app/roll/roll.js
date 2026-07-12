/**
 * @module app/roll/roll
 * roll.js — ROLL ウィンドウ (ステップグリッド MIDI エディタ)
 *
 * ボディには表を 1 枚だけ描く:
 *   横 = 4 小節 × 16 分音符 = 64 列。
 *   縦 = MIDI で入力可能な全音高 = 128 行。row 0 = MIDI 127 (最高音・上端)。
 *   ノートは開始セル (col,row)・長さ len (セル数)・ベロシティ vel を持つ。
 *
 * ── 罫線 / ノート ──
 *   小節境界 (16 列ごと) とオクターブ境界 (B/C)・上端 = 2px、他は 1px。
 *   ノートはセル内寸いっぱいに置き、最外周 1px を白枠・内側を黒に (罫線との視認性)。
 *   非選択 = 黒枠+黒塗り。選択/発音中 = 黒枠+白塗り。
 *
 * ── 主な操作 (ABOUT にも記載) ──
 *   配置/削除 = ダブルクリック。選択 = クリック、Shift+クリックで複数。
 *   移動 = ドラッグ、複製 = Ctrl+ドラッグ。音価 = ノート左右の辺をドラッグ。
 *   ズーム = Ctrl/Shift+Ctrl+ホイール (カーソル基準)。FOLD = F。再生 = Space。
 *   選択時はピッチ確認のため短く試聴する。重なりは配置側が勝ち (被りは削除/クリップ)。
 *
 * 音源は内蔵 PolySynth。再生はフレーム駆動 (AudioContext 時計基準)。
 */

import { fillRect, isCapturing } from "../../core/gpu.js";
import { drawText, textWidth } from "../../core/font.js";
import { createPolySynth, getAudioContext, initAudio } from "../../core/audio.js";
import {
  wmOpen,
  wmRegister,
  wmIsFocused,
  wmGetScroll,
  wmSetScroll,
} from "../../wm/index.js";
import { keyDown, keyHeld, ctrlDown } from "../../core/input.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const APP_NAME = "ROLL";

/** 時間方向: 4 小節 × 16 分音符 = 64 列 */
const BARS = 4;
const STEPS_PER_BAR = 16;
const STEPS_PER_BEAT = 4;
const COLS = BARS * STEPS_PER_BAR;

/** 音高方向: MIDI 0..127 の 128 行。row 0 = MIDI 127 (最高音・上端) */
const OCTAVE = 12;
const ROWS = 128;

/** 罫線の太さ (DOT) */
const THIN = 1;
const BOLD = 2;

/** セル内寸 (DOT) の範囲と初期値 */
const CELL_MIN = 5;
const CELL_MAX = 30;
const CELL_DEFAULT = 15;

/** ホイール 1 ノッチのズーム量 (DOT) */
const ZOOM_STEP = 1;

/** キーリピート: 押下後この待機 (ms) を経てからこの間隔 (ms) で連続処理 */
const REPEAT_DELAY = 300;
const REPEAT_RATE = 45;

/** ノート辺の掴み判定幅 (DOT)。真上 1px より広く取る */
const EDGE_GRAB = 5;

/** 既定ベロシティ (0..127)。v1 は固定 */
const DEFAULT_VEL = 100;
/** 試聴の長さ (秒) */
const AUDITION_SEC = 0.25;
/** 再生テンポ (v1 固定) と 1 ループ長 (= 4 小節) */
const BPM = 120;
const LOOP_STEPS = COLS;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** row → MIDI ノート番号 (上端 row 0 = 127) */
const rowToMidi = (row) => ROWS - 1 - row;
/** MIDI → 音名 + オクターブ (MIDI 60 = C4) */
const midiName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
/** 列 → 小節.拍.ステップ (1 始まり) */
function timePos(col) {
  const inBar = ((col % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
  return `${Math.floor(col / STEPS_PER_BAR) + 1}.${Math.floor(inBar / 4) + 1}.${(inBar % 4) + 1}`;
}

/** 全行 (normal モードの表示行。定数として 1 度だけ生成) */
const ALL_ROWS = Array.from({ length: ROWS }, (_, i) => i);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let winId = -1;
let cellW = CELL_DEFAULT;
let cellH = CELL_DEFAULT;
let fold = false; // FOLD: ノートのある行だけ表示

/** @type {{col:number,row:number,len:number,vel:number,selected:boolean}[]} */
let notes = [];

/**
 * ドラッグ状態。mode="move": 選択のグループ移動/複製 (dCol/dRow, sel, pending)。
 * mode="resize": 単一ノートの音価変更 (note, side 'l'|'r', fixedCol)。
 * @type {object|null}
 */
let drag = null;

/** キーリピート */
let repeatCode = null;
let repeatNext = 0;

/** ダブルクリック誤検出よけ: 直近 2 クリックのセルキー */
let lastDownKey = null;
let prevDownKey = null;

// ── 再生 ──
let playing = false;
let playPos = 0; // 現在位置 (ステップ)。停止後は停止位置を保持
let playStartTime = 0;
let playStartPos = 0;
let lastFiredStep = -1;
const sounding = new Map(); // note -> 残りステップ (発音中)

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  音源 / 試聴
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _synth = null;
function synth() {
  if (!_synth) _synth = createPolySynth();
  return _synth;
}
/** AudioContext を確実に用意 (ユーザー操作起点で resume) */
function ensureCtx() {
  if (!getAudioContext()) initAudio();
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") ctx.resume();
  return ctx;
}
/** ピッチ確認の短い試聴 */
function audition(midi) {
  const ctx = ensureCtx();
  if (!ctx) return;
  synth().noteOn(midi, DEFAULT_VEL / 127, ctx.currentTime);
  synth().noteOff(midi, ctx.currentTime + AUDITION_SEC);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  縦レイアウト (FOLD 対応。表示行の並びを 1 度計算してキャッシュ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ctrlHeld = () => keyHeld("ControlLeft") || keyHeld("ControlRight");

/** 表示する実 row の配列。normal = 全行、fold = ノートのある行のみ昇順 */
function visibleRows() {
  if (!fold) return ALL_ROWS;
  const s = new Set();
  for (const n of notes) s.add(n.row);
  return [...s].sort((a, b) => a - b);
}

/** 列境界 (縦罫線) の太さ。小節境界 (16 列ごと・両端) = 太線 */
const vThick = (c) => (c % STEPS_PER_BAR === 0 ? BOLD : THIN);
/** 実 row r の上の横罫線の太さ。オクターブ境界 (B/C) と上端 = 太線 */
const hThick = (r) => (r === 0 || (ROWS - r) % OCTAVE === 0 ? BOLD : THIN);

let _vlKey = "";
let _vlCache = null;
/**
 * 縦レイアウト: { rows, R, lineThick[R+1], interiorY[R], rowToDi(Map), totalH }。
 * rows[di] = 表示 di 番目の実 row。interiorY[di] = セル内寸上端の Y (コンテンツ空間)。
 */
function vLayout() {
  const rows = visibleRows();
  const key = (fold ? "F" : "N") + cellH + ":" + (fold ? rows.join(",") : "");
  if (_vlKey === key && _vlCache) return _vlCache;
  const R = rows.length;
  const lineThick = new Array(R + 1);
  const interiorY = new Array(R);
  const rowToDi = new Map();
  let y = 0;
  for (let di = 0; di < R; di++) {
    const t = di === 0 ? BOLD : hThick(rows[di]);
    lineThick[di] = t;
    y += t;
    interiorY[di] = y;
    rowToDi.set(rows[di], di);
    y += cellH;
  }
  lineThick[R] = BOLD; // 下端フレーム
  _vlKey = key;
  _vlCache = { rows, R, lineThick, interiorY, rowToDi, totalH: y + BOLD };
  return _vlCache;
}

/** 表の総幅 (DOT) */
function tableW() {
  let w = COLS * cellW;
  for (let c = 0; c <= COLS; c++) w += vThick(c);
  return w;
}

/** 列 c のセル内寸・左端 X (コンテンツ空間)。c > COLS-1 も同規則で外挿 */
function colInnerX(c) {
  let x = 0;
  for (let i = 0; i < c; i++) x += vThick(i) + cellW;
  return x + vThick(c);
}

/** コンテンツ空間 X → 連続列座標 (ズームのカーソル基準用) */
function anchorCol(lx) {
  if (lx <= 0) return 0;
  let x = 0;
  for (let c = 0; c < COLS; c++) {
    const ix = x + vThick(c);
    const end = ix + cellW;
    if (lx < end) return c + Math.max(0, Math.min(1, (lx - ix) / cellW));
    x = end;
  }
  return COLS;
}
/** コンテンツ空間 Y → 連続表示行座標 (FOLD 対応) */
function anchorRow(ly) {
  if (ly <= 0) return 0;
  const vl = vLayout();
  let y = 0;
  for (let di = 0; di < vl.R; di++) {
    const iy = y + vl.lineThick[di];
    const end = iy + cellH;
    if (ly < end) return di + Math.max(0, Math.min(1, (ly - iy) / cellH));
    y = end;
  }
  return vl.R;
}

/** コンテンツ空間の点 → セル (col, 実 row)。境界線+手前セルを 1 スロットに */
function cellAt(lx, ly) {
  if (lx < 0 || ly < 0) return null;
  let col = -1;
  for (let c = 0, x = 0; c < COLS; c++) {
    x += vThick(c) + cellW;
    if (lx < x) {
      col = c;
      break;
    }
  }
  if (col < 0) return null;
  const vl = vLayout();
  let di = -1;
  for (let i = 0, y = 0; i < vl.R; i++) {
    y += vl.lineThick[i] + cellH;
    if (ly < y) {
      di = i;
      break;
    }
  }
  if (di < 0) return null;
  return { col, row: vl.rows[di] };
}

/** WM 管理スクロールの仮想コンテンツ寸法 */
function onMeasure() {
  return { w: tableW(), h: vLayout().totalH };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ノートモデル / 選択 / 重なり解決
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** セル (col,row) を覆うノート (len スパン内)。後勝ち (最前面) */
function noteAt(col, row) {
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    if (n.row === row && col >= n.col && col < n.col + n.len) return n;
  }
  return null;
}
function removeNote(n) {
  const i = notes.indexOf(n);
  if (i >= 0) notes.splice(i, 1);
}
function deselectAll() {
  for (const n of notes) n.selected = false;
}
function selectAll() {
  for (const n of notes) n.selected = true;
}
function selectOnly(note) {
  for (const n of notes) n.selected = n === note;
}
function selected() {
  return notes.filter((n) => n.selected);
}

/**
 * active ノートを優先し、同じ行で重なる非 active ノートを削除/クリップする。
 * 完全に隠れる → 削除。一部が隠れる → 残る区間へ分割 (中央被りは 2 分割)。
 * active はそのまま残す (同一オブジェクト = 選択/参照を保持)。
 */
function resolveOverlaps(active) {
  if (!active.length) return;
  const activeSet = new Set(active);
  const out = [];
  for (const n of notes) {
    if (activeSet.has(n)) {
      out.push(n);
      continue;
    }
    let segs = [[n.col, n.col + n.len]];
    for (const a of active) {
      if (a.row !== n.row) continue;
      const aS = a.col;
      const aE = a.col + a.len;
      const next = [];
      for (const [s, e] of segs) {
        if (aE <= s || aS >= e) {
          next.push([s, e]);
          continue;
        }
        if (s < aS) next.push([s, aS]); // 左の残り
        if (e > aE) next.push([aE, e]); // 右の残り
      }
      segs = next;
    }
    for (const [s, e] of segs) {
      if (e > s) out.push({ col: s, row: n.row, len: e - s, vel: n.vel, selected: n.selected });
    }
  }
  notes = out;
}

/** 選択長を d 変える (最小 1・上限なし)。変更後に重なりを解決 */
function changeLen(d) {
  const sel = selected();
  if (!sel.length) return;
  for (const n of sel) n.len = Math.max(1, n.len + d);
  resolveOverlaps(sel);
}
/** (dCol,dRow) を選択集合が枠内に収まる範囲へクランプ */
function clampDelta(sel, dCol, dRow) {
  let minC = Infinity;
  let maxC = -Infinity;
  let minR = Infinity;
  let maxR = -Infinity;
  for (const n of sel) {
    minC = Math.min(minC, n.col);
    maxC = Math.max(maxC, n.col);
    minR = Math.min(minR, n.row);
    maxR = Math.max(maxR, n.row);
  }
  return [clampInt(dCol, -minC, COLS - 1 - maxC), clampInt(dRow, -minR, ROWS - 1 - maxR)];
}
/** 選択を (dCol,dRow) 移動 (相対位置を保つ all-or-nothing)。移動後に重なり解決 */
function moveSelected(dCol, dRow) {
  const sel = selected();
  if (!sel.length) return;
  const [cc, rr] = clampDelta(sel, dCol, dRow);
  if (cc !== dCol || rr !== dRow) return;
  for (const n of sel) {
    n.col += dCol;
    n.row += dRow;
  }
  resolveOverlaps(sel);
}
/** sel を (dCol,dRow) へ複製し選択をコピーへ移す。コピーが既存に勝つ */
function duplicateAt(sel, dCol, dRow) {
  if (!sel.length) return;
  const copies = sel.map((n) => ({
    col: n.col + dCol,
    row: n.row + dRow,
    len: n.len,
    vel: n.vel,
    selected: true,
  }));
  for (const n of sel) n.selected = false;
  notes.push(...copies);
  resolveOverlaps(copies);
}
/** Ctrl+D: 「ノート群の末尾の次のセル」から複製 (音高そのまま。相対位置を保つ) */
function duplicateAfter() {
  const sel = selected();
  if (!sel.length) return;
  let minCol = Infinity;
  let maxEnd = -Infinity;
  for (const n of sel) {
    minCol = Math.min(minCol, n.col);
    maxEnd = Math.max(maxEnd, n.col + n.len);
  }
  duplicateAt(sel, maxEnd - minCol, 0);
}
function deleteSelected() {
  notes = notes.filter((n) => !n.selected);
  drag = null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  再生
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const stepDur = () => 60 / BPM / STEPS_PER_BEAT;

function startPlay(fromPos) {
  const ctx = ensureCtx();
  if (!ctx) return;
  playing = true;
  playStartPos = ((fromPos % LOOP_STEPS) + LOOP_STEPS) % LOOP_STEPS;
  playPos = playStartPos;
  playStartTime = ctx.currentTime;
  lastFiredStep = (Math.floor(playStartPos) - 1 + LOOP_STEPS) % LOOP_STEPS;
  sounding.clear();
}
function stopPlay() {
  playing = false;
  if (_synth) _synth.allNotesOff();
  sounding.clear();
}
/** ステップ境界: 発音中を減衰・消音し、そのステップで始まるノートを発音 */
function onStepEnter(step) {
  for (const [note, rem] of sounding) {
    const r = rem - 1;
    if (r <= 0) {
      synth().noteOff(rowToMidi(note.row));
      sounding.delete(note);
    } else {
      sounding.set(note, r);
    }
  }
  for (const n of notes) {
    if (n.col === step) {
      const midi = rowToMidi(n.row);
      synth().noteOff(midi);
      synth().noteOn(midi, n.vel / 127);
      sounding.set(n, n.len);
    }
  }
}
/** 毎フレーム: AudioContext 時計で位置を進め、跨いだステップを 1 つずつ発火 */
function updatePlayback() {
  if (!playing) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  playPos = (playStartPos + (ctx.currentTime - playStartTime) / stepDur()) % LOOP_STEPS;
  const target = Math.floor(playPos);
  let guard = 0;
  while (lastFiredStep !== target && guard++ <= LOOP_STEPS) {
    lastFiredStep = (lastFiredStep + 1) % LOOP_STEPS;
    onStepEnter(lastFiredStep);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力 — ホイール (カーソル基準ズーム)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const clampCell = (v) => Math.max(CELL_MIN, Math.min(CELL_MAX, v));

function zoomWheel(ev) {
  const dir = -Math.sign(ev.deltaY || 0); // WheelUp = 拡大 / Down = 縮小
  if (dir === 0) return;
  const s0 = wmGetScroll(winId);
  // 補正は整数へ丸めグリッドをピクセル境界へ (滲み防止・カーソル下のセルを厳密に保持)
  if (ev.shift) {
    const f = anchorCol(ev.localX);
    const old = cellW;
    cellW = clampCell(cellW + dir * ZOOM_STEP); // Shift+Ctrl = 水平 (幅)
    wmSetScroll(winId, Math.round(s0.x + f * (cellW - old)), null);
  } else {
    const f = anchorRow(ev.localY);
    const old = cellH;
    cellH = clampCell(cellH + dir * ZOOM_STEP); // Ctrl = 垂直 (高さ)
    wmSetScroll(winId, null, Math.round(s0.y + f * (cellH - old)));
  }
  ev.consumed = true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力 — マウス
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ノート n の辺掴み判定。'l'/'r'/null。端ゾーンは幅の 1/3 (最大 EDGE_GRAB) */
function edgeSide(lx, n) {
  const le = colInnerX(n.col);
  const re = colInnerX(n.col + n.len - 1) + cellW;
  const g = Math.min(EDGE_GRAB, Math.max(1, Math.floor((re - le) / 3)));
  if (lx < le + g) return "l";
  if (lx >= re - g) return "r";
  return null;
}

/** ドラッグ確定 */
function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.mode === "resize") {
    resolveOverlaps([d.note]); // 端ドラッグはノートを実時間で伸縮済み。確定時に重なり解決
    return;
  }
  if (!d.moved) {
    if (d.pending) d.pending();
    return;
  }
  if (ctrlHeld()) {
    duplicateAt(d.sel, d.dCol, d.dRow); // Ctrl 押下中 = 複製
  } else {
    for (const n of d.sel) {
      n.col += d.dCol;
      n.row += d.dRow;
    }
    resolveOverlaps(d.sel);
  }
}

function onInput(ev) {
  if (ev.type === "wheel") {
    if (ev.ctrl) zoomWheel(ev); // 通常/Shift ホイールは WM のスクロールへ
    return;
  }

  if (ev.type === "dblclick") {
    drag = null;
    const cell = cellAt(ev.localX, ev.localY);
    if (!cell) return;
    // 別セルへの連続シングルクリックが時間だけで dblclick 誤検出されるのを弾く
    if (`${cell.col},${cell.row}` !== prevDownKey) return;
    const n = noteAt(cell.col, cell.row);
    if (n) {
      removeNote(n); // 既存 → 削除
    } else {
      const nn = { col: cell.col, row: cell.row, len: 1, vel: DEFAULT_VEL, selected: false };
      notes.push(nn);
      selectOnly(nn); // 配置直後は選択
      audition(rowToMidi(nn.row));
      resolveOverlaps([nn]);
    }
    return;
  }

  if (ev.type === "down") {
    const cell = cellAt(ev.localX, ev.localY);
    prevDownKey = lastDownKey;
    lastDownKey = cell ? `${cell.col},${cell.row}` : null;

    const n = cell ? noteAt(cell.col, cell.row) : null;
    if (!n) {
      if (!ev.shift) deselectAll(); // 空クリック: plain=全解除、Shift=維持
      drag = null;
      return;
    }

    // 音価変更 (辺ドラッグ)。Shift 中は複数選択トグルを優先
    const side = ev.shift ? null : edgeSide(ev.localX, n);
    if (side) {
      if (!n.selected) audition(rowToMidi(n.row));
      selectOnly(n); // 音価変更は単一対象
      drag = {
        mode: "resize",
        note: n,
        side,
        fixedCol: side === "r" ? n.col : n.col + n.len - 1,
      };
      return;
    }

    // 選択 (Shift = 複数トグル)。ドラッグで意味が変わる操作は pending に遅延
    let pending = null;
    const midi = rowToMidi(n.row);
    if (ev.shift) {
      if (n.selected) pending = () => (n.selected = false); // Shift+クリック(選択中)=解除
      else {
        n.selected = true; // Shift+down(非選択)=追加
        audition(midi);
      }
    } else if (n.selected) {
      pending = () => {
        selectOnly(n); // クリック=単一化
        audition(midi);
      };
    } else {
      selectOnly(n); // plain down(非選択)=単一選択
      audition(midi);
    }
    drag = {
      mode: "move",
      grabCol: cell.col,
      grabRow: cell.row,
      dCol: 0,
      dRow: 0,
      moved: false,
      sel: selected(),
      pending,
    };
    return;
  }

  if (ev.type === "held") {
    if (!drag) return;
    const cell = cellAt(ev.localX, ev.localY);
    if (!cell) return;
    if (drag.mode === "resize") {
      if (drag.side === "r") {
        drag.note.len = Math.max(1, cell.col - drag.fixedCol + 1);
      } else {
        const s = clampInt(cell.col, 0, drag.fixedCol);
        drag.note.col = s;
        drag.note.len = drag.fixedCol - s + 1;
      }
      return;
    }
    const [dCol, dRow] = clampDelta(drag.sel, cell.col - drag.grabCol, cell.row - drag.grabRow);
    drag.dCol = dCol;
    drag.dRow = dRow;
    drag.moved = dCol !== 0 || dRow !== 0;
    return;
  }

  if (ev.type === "up") endDrag();
  else if (ev.type === "hover" && drag) endDrag(); // 領域外リリースの保険
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力 — キーボード (最前面時のみ。長押しリピート対応)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

function arrowAction(code, shift) {
  switch (code) {
    case "ArrowLeft":
      return shift ? () => changeLen(-1) : () => moveSelected(-1, 0);
    case "ArrowRight":
      return shift ? () => changeLen(+1) : () => moveSelected(+1, 0);
    case "ArrowUp":
      return shift ? () => moveSelected(0, -OCTAVE) : () => moveSelected(0, -1);
    case "ArrowDown":
      return shift ? () => moveSelected(0, +OCTAVE) : () => moveSelected(0, +1);
    default:
      return null;
  }
}
function handleArrows(now, shift) {
  for (const code of ARROWS) {
    if (keyDown(code)) {
      arrowAction(code, shift)?.();
      repeatCode = code;
      repeatNext = now + REPEAT_DELAY;
      return;
    }
  }
  if (repeatCode && keyHeld(repeatCode)) {
    if (now >= repeatNext) {
      arrowAction(repeatCode, shift)?.();
      repeatNext = now + REPEAT_RATE;
    }
  } else {
    repeatCode = null;
  }
}
function handleKeys() {
  if (!wmIsFocused(APP_NAME)) {
    repeatCode = null;
    return;
  }
  const shift = keyHeld("ShiftLeft") || keyHeld("ShiftRight");
  if (ctrlDown("KeyA")) selectAll();
  if (ctrlDown("KeyD")) duplicateAfter();
  if (keyDown("Escape")) deselectAll();
  if (keyDown("Delete")) deleteSelected();
  if (keyDown("KeyF")) fold = !fold;
  if (keyDown("Space")) {
    if (playing) stopPlay();
    else startPlay(shift ? playPos : 0); // Shift = 停止位置から / 素 = 1.1.1 から
  }
  handleArrows(performance.now(), shift);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 1 ノートを描く。hollow=true で内部を白抜き (選択/発音中) */
function drawNoteAt(cr, col, row, len, hollow, vl) {
  const di = vl.rowToDi.get(row);
  if (di === undefined) return; // FOLD で非表示の行
  const x0 = colInnerX(col);
  const x1 = colInnerX(col + len - 1) + cellW;
  const ox = cr.x + x0;
  const oy = cr.y + vl.interiorY[di];
  const ow = x1 - x0;
  const oh = cellH;
  if (ow <= 0 || oh <= 0) return;
  fillRect(ox, oy, ow, oh, 0); // 白枠 (最外周 1px を含む白地)
  if (ow > 2 && oh > 2) {
    fillRect(ox + 1, oy + 1, ow - 2, oh - 2, 1); // 黒ノート本体
    if (hollow && ow > 4 && oh > 4) fillRect(ox + 2, oy + 2, ow - 4, oh - 4, 0);
  }
}

function onDraw(cr) {
  if (!isCapturing()) handleKeys(); // CAPTURE の二度描きでキー二重発火を抑止
  updatePlayback(); // 発音・位置更新はフォーカスに依らず継続
  const vl = vLayout();
  const tw = tableW();
  const th = vl.totalH;

  // 縦罫線 (列境界)
  for (let c = 0, x = cr.x; c <= COLS; c++) {
    const t = vThick(c);
    fillRect(x, cr.y, t, th, 1);
    x += t + (c < COLS ? cellW : 0);
  }
  // 横罫線 (表示行の境界)
  for (let di = 0, y = cr.y; di <= vl.R; di++) {
    const t = vl.lineThick[di];
    fillRect(cr.x, y, tw, t, 1);
    y += t + (di < vl.R ? cellH : 0);
  }

  // ノート + 移動プレビュー (発音中/選択は白抜き)
  const moving = !!(drag && drag.mode === "move" && drag.moved);
  const dup = moving && ctrlHeld();
  for (const n of notes) {
    if (moving && !dup && drag.sel.includes(n)) continue; // 移動: 掴んだ実体は隠す
    drawNoteAt(cr, n.col, n.row, n.len, n.selected || sounding.has(n), vl);
  }
  if (moving) {
    for (const n of drag.sel) drawNoteAt(cr, n.col + drag.dCol, n.row + drag.dRow, n.len, false, vl);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  フッタ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 右にノート件数、左に統計 (選択があれば選択、なければ全体)。
 * PITCH/VEL/LEN は範囲 (単一値は畳む)、TIME は開始〜終了の時間位置。
 */
function onDrawFooter(fr) {
  const total = notes.length;
  const sel = selected();
  const right = sel.length
    ? `SEL ${sel.length}/${total}`
    : total + (total === 1 ? " NOTE" : " NOTES");
  drawText(fr.x + fr.w - textWidth(right), fr.y, right, 1);

  const scope = sel.length ? sel : notes;
  if (!scope.length) {
    drawText(fr.x, fr.y, "EMPTY", 1);
    return;
  }
  let loM = Infinity;
  let hiM = -Infinity;
  let loL = Infinity;
  let hiL = -Infinity;
  let loV = Infinity;
  let hiV = -Infinity;
  let loC = Infinity;
  let hiE = -Infinity;
  for (const n of scope) {
    const m = rowToMidi(n.row);
    loM = Math.min(loM, m);
    hiM = Math.max(hiM, m);
    loL = Math.min(loL, n.len);
    hiL = Math.max(hiL, n.len);
    loV = Math.min(loV, n.vel);
    hiV = Math.max(hiV, n.vel);
    loC = Math.min(loC, n.col);
    hiE = Math.max(hiE, n.col + n.len);
  }
  const rng = (a, b, f) => (a === b ? f(a) : `${f(a)}-${f(b)}`);
  const str = (x) => `${x}`;
  const left =
    `PITCH ${rng(loM, hiM, midiName)}  ` +
    `VEL ${rng(loV, hiV, str)}  ` +
    `LEN ${rng(loL, hiL, str)}  ` +
    `TIME ${timePos(loC)}-${timePos(hiE)}`;
  drawText(fr.x, fr.y, left, 1);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ABOUT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ABOUT_TEXT = [
  "ROLL is a step-grid MIDI editor. Four bars of 16 steps across, all 128 MIDI pitches down. Selecting a note plays its pitch.",
  "",
  "MOUSE",
  "- Double-click empty: place note",
  "- Double-click a note: delete",
  "- Click a note: select it",
  "- Shift+click a note: toggle",
  "- Click empty: clear selection",
  "- Drag a note: move selection",
  "- Drag a note edge: change length",
  "- Ctrl+drag: duplicate selection",
  "- Ctrl+wheel: zoom height (at cursor)",
  "- Shift+Ctrl+wheel: zoom width",
  "- Wheel / Shift+wheel: scroll",
  "",
  "KEYS",
  "- Ctrl+A / Esc: select all / none",
  "- Delete: delete selection",
  "- Ctrl+D: duplicate after group",
  "- Arrows: move 1 cell (held repeats)",
  "- Shift+Up/Down: move 1 octave",
  "- Shift+Left/Right: shorten/lengthen",
  "- F: fold (show only used rows)",
  "- Space: play / stop",
  "- Shift+Space: play from stop point",
].join("\n");

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    winId = wmOpen(-1, -1, 0, 0, APP_NAME, onDraw, onInput, onMeasure, {
      footer: true,
      onDrawFooter,
      onBeforeClose: () => {
        stopPlay();
        winId = -1;
        return true;
      },
      about: ABOUT_TEXT,
    });
    return winId;
  },
  { category: "CREATIVE", dev: true },
);
