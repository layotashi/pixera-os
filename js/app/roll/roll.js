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
 *   縦 (時間) は 3 段階の階層で役割を判別しやすくする:
 *     小節線 (16 列ごと)   = 2px 実線
 *     拍線   (4 列ごと)     = 1px 実線
 *     ステップ (拍より細かい) = 1px 点線 (1px 描画 + 1px 間隔の交互)
 *   点線は各セル内寸の上端から 1px おきに点を打つため、隙間が必ず横罫線の行に重なる。
 *   これにより交点で横線が途切れず、ズーム (cellH 可変) でもこの位相関係は保たれる。
 *   横 (音高) はオクターブ境界 (B/C)・上端/下端 = 2px、他は 1px 実線。
 *   ノートはセル内寸いっぱいに置き、最外周 1px を白枠・内側を黒に (罫線との視認性)。
 *   非選択 = 黒枠+黒塗り。選択/発音中 = 黒枠+白塗り。
 *
 * ── 主な操作 (ABOUT にも記載) ──
 *   配置/削除 = ダブルクリック。選択 = クリック、Shift+クリックで複数。
 *   移動 = ドラッグ、複製 = Ctrl+ドラッグ。音価 = ノート左右の辺をドラッグ。
 *   ズーム = Ctrl/Shift+Ctrl+ホイール (カーソル基準)。FOLD = F。再生 = Space。
 *   選択時はピッチ確認のため短く試聴する。重なりは配置側が勝ち (被りは削除/クリップ)。
 *
 * 発音は tracks レジストリ経由: SYNTH が開いていればその音色 (現在のパラメータ) で鳴り、
 * 無ければ ROLL 内蔵のフォールバック音源で鳴る。再生位置は共有 transport が持つ
 * (再生「制御」は将来 Transport アプリへ分離できるよう責務を分けてある)。
 *
 * ── VFS 連携 (保存 / 読込) ──
 *   Ctrl+S = 上書き保存 (無題なら Save As)。Ctrl+Shift+S = 名前を付けて保存。
 *   Ctrl+O = 開く。いずれも共有クリップモデル (core/clip.js) の JSON = `.roll`。
 *   モデルは MIDI 互換の形状 (pitch/start/len/vel) で、将来の `.mid` コーデック追加時に
 *   作り直さずに済む。FILES から `.roll` をダブルクリックで開く (rollOpenFile)。
 */

import { fillRect, pset, drawDashedRect, isCapturing } from "../../core/gpu.js";
import { drawText, textWidth } from "../../core/font.js";
import {
  createPolySynth,
  getAudioContext,
  initAudio,
  keepAudioAwake,
  releaseAudioAwake,
} from "../../core/audio.js";
import * as tracks from "../music/tracks.js";
import * as transport from "../music/transport.js";
import * as VFS from "../../core/vfs.js";
import { openFileDialog, openConfirmDialog } from "../../ui/index.js";
import { CLIP_EXT, serializeClip, parseClip } from "../../core/clip.js";
import {
  wmOpen,
  wmRegister,
  wmIsFocused,
  wmGetScroll,
  wmSetScroll,
  wmSetTitle,
  wmOpenOrFocus,
  wmClose,
  wmDefaultContentSize,
  wmGetContentRect,
  wmRequestCursor,
} from "../../wm/index.js";
import { keyDown, keyHeld, ctrlDown, ctrlShiftDown } from "../../core/input.js";

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

/** 起動時に縦中央へ収める音域 (チップチューンで多用する C4..C5 のメロディ域)。
 *  128 音高のうち最高音域は実用上ほぼ使わないため、ここを軸に初期スクロールを合わせる。 */
const INITIAL_VIEW_LO_MIDI = 60; // C4
const INITIAL_VIEW_HI_MIDI = 72; // C5

/** 罫線の太さ (DOT) */
const THIN = 1;
const BOLD = 2;

/** セル内寸 (DOT) の範囲。桁幅・行高は独立にズームできる (以下は初期値)。 */
const CELL_MIN = 5;
const CELL_MAX = 30;
/** 初期の桁幅。時間方向は横スクロール前提なので、編集しやすい幅を保つ。 */
const CELL_W_DEFAULT = 15;
/** 初期の行高。チップチューンの主要音域を一度に見せる (≈2 オクターブ) よう控えめにし、
 *  起動ごとに使用音域までスクロールする手間を減らす。狭すぎると編集しづらいので下限寄り。 */
const CELL_H_DEFAULT = 8;

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
/** 再生テンポ (v1 固定) と拍/ループ長 (= 4 小節) */
const BPM = 120;
const BEATS_PER_BAR = STEPS_PER_BAR / STEPS_PER_BEAT; // 4/4 → 4
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
let cellW = CELL_W_DEFAULT;
let cellH = CELL_H_DEFAULT;
let fold = false; // FOLD: ノートのある行だけ表示

/** @type {{col:number,row:number,len:number,vel:number,selected:boolean}[]} */
let notes = [];

// ── ファイル状態 (VFS 保存/読込) ──
/** 現在開いているクリップの VFS パス (null = 無題) */
let currentFilePath = null;
/** 最後に保存/読込した時点から編集があるか */
let isDirty = false;

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

// ── 再生 (クロックは共有 transport、発音先は tracks レジストリ) ──
let lastFiredStep = -1;
let _wasPlaying = false; // transport 再生状態の前フレーム値 (開始/停止の遷移検出)
let _activeInst = null; // 再生セッション中の発音先 (開始時に確定し、途中で切替えない)
const sounding = new Map(); // note -> 残りステップ (発音中)

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  音源 / 試聴
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ROLL 内蔵のフォールバック音源 (SYNTH トラックが無いとき用)。PolySynth は instrument 互換 */
let _fallback = null;
function fallbackInstrument() {
  if (!_fallback) _fallback = createPolySynth();
  return _fallback;
}
/** 発音先: SYNTH が登録したトラックがあればその音色、無ければフォールバック */
function targetInstrument() {
  const t = tracks.getDefaultTrack();
  return t ? t.instrument : fallbackInstrument();
}
/** AudioContext を確実に用意 (ユーザー操作起点で resume) */
function ensureCtx() {
  if (!getAudioContext()) initAudio();
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") ctx.resume();
  return ctx;
}

// ── モノフォニック試聴 / プレビュー ──
//
// 一度に鳴るプレビュー音は常に 1 つだけ。次の音を鳴らす前に必ず直前の音を止めるので
// 多重発音しない。プレビューはすべて単発 (audition) で AUDITION_SEC 後に自動消音する。
// ドラッグやキーでピッチが変わるたびに鳴らし直すため、移動中も短い発音が連なる (持続はしない)。
// 発音は「今すぐ」(ctx.currentTime) にスケジュールしてクリック→発音の遅延を最小化する。

/** 現在鳴っているプレビュー音の MIDI (null = 無音) */
let _previewMidi = null;
/** その音を鳴らした発音先 (停止に使う。途中でターゲットが変わっても正しく止める) */
let _previewInst = null;
/** 自動消音の期限 (ms, performance.now 基準) */
let _previewOffAt = 0;

/** 現在のプレビュー音を止める (直前の音を停止 = 多重発音の防止) */
function previewStop() {
  if (_previewMidi == null) return;
  if (_previewInst && getAudioContext()) _previewInst.noteOff(_previewMidi);
  _previewMidi = null;
  _previewInst = null;
  _previewOffAt = 0;
}

/**
 * 単発試聴 (ピッチ確認)。直前の音を必ず止めてから鳴らす (モノフォニック)。AUDITION_SEC 後に
 * updatePreview が自動消音する。同じ音高への連続呼び出しは鳴らし直さず消音期限だけ延長する。
 * @param {number} midi
 */
function audition(midi) {
  const ctx = ensureCtx();
  if (!ctx) return;
  const off = performance.now() + AUDITION_SEC * 1000;
  if (_previewMidi === midi) {
    _previewOffAt = off; // 同じ音は鳴らし直さず、消音期限だけ延長
    return;
  }
  previewStop();
  const inst = targetInstrument();
  inst.noteOn(midi, DEFAULT_VEL / 127, ctx.currentTime);
  _previewMidi = midi;
  _previewInst = inst;
  _previewOffAt = off;
}

/** 毎フレーム: 単発プレビューが期限に達していたら消音する */
function updatePreview() {
  if (_previewMidi != null && performance.now() >= _previewOffAt) previewStop();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  縦レイアウト (FOLD 対応。表示行の並びを 1 度計算してキャッシュ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ctrlHeld = () => keyHeld("ControlLeft") || keyHeld("ControlRight");
const shiftHeld = () => keyHeld("ShiftLeft") || keyHeld("ShiftRight");

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
 * ラバー矩形 (コンテンツ空間の 2 点) に触れているノートを選択する。ノート全体が矩形内に
 * 収まっている必要はなく、矩形とノート描画箱が少しでも重なれば選択する。additive (Shift)
 * のときは base (開始時の選択) にマージする。毎フレーム全ノートを再判定して反映する。
 * 矩形へ新たに入ったノート (前フレーム未ヒットで既存選択でもない) はピッチ確認のため試聴する。
 * @param {{x0:number,y0:number,x1:number,y1:number,base:Set|null,rubberHit:Set}} d
 */
function applyRubberSelection(d) {
  const vl = vLayout();
  const rx0 = Math.min(d.x0, d.x1);
  const rx1 = Math.max(d.x0, d.x1);
  const ry0 = Math.min(d.y0, d.y1);
  const ry1 = Math.max(d.y0, d.y1);
  const prevHit = d.rubberHit;
  const hitNow = new Set();
  let addedTopRow = Infinity; // 新たに矩形へ入ったノートの最高音 (= 最小 row)
  for (const n of notes) {
    const di = vl.rowToDi.get(n.row);
    if (di === undefined) {
      n.selected = d.base ? d.base.has(n) : false; // FOLD で非表示の行は base のみ
      continue;
    }
    const nx0 = colInnerX(n.col);
    const nx1 = colInnerX(n.col + n.len - 1) + cellW; // drawNoteAt と同じ描画範囲
    const ny0 = vl.interiorY[di];
    const ny1 = ny0 + cellH;
    const hit = nx0 < rx1 && nx1 > rx0 && ny0 < ry1 && ny1 > ry0;
    n.selected = hit || (d.base ? d.base.has(n) : false);
    if (hit) {
      hitNow.add(n);
      // 選択状態が false→true に変わった (前は未ヒット & base にも無い) ノートだけ試聴候補
      if (!prevHit.has(n) && !(d.base && d.base.has(n))) addedTopRow = Math.min(addedTopRow, n.row);
    }
  }
  d.rubberHit = hitNow;
  if (addedTopRow !== Infinity) audition(rowToMidi(addedTopRow));
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
  markDirty();
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
  // ピッチ方向 (上下キー) の移動だけ、移動後の代表音 (最高音) を試聴する。
  // 時間方向 (左右キー = dRow 0) では鳴らさない。
  if (dRow !== 0) audition(rowToMidi(Math.min(...sel.map((n) => n.row))));
  markDirty();
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
  markDirty();
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
  if (!notes.some((n) => n.selected)) return;
  notes = notes.filter((n) => !n.selected);
  drag = null;
  markDirty();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ファイル (VFS 保存 / 読込)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 保存形式は共有クリップモデル (core/clip.js) の JSON = .roll。ROLL 内部の
// ノート表現 {col,row,len,vel} と、MIDI 互換のクリップ表現 {pitch,start,len,vel}
// を相互変換する (pitch = rowToMidi(row)、start = col)。

/** タイトルバーをファイル名 + dirty マークで更新する */
function refreshTitle() {
  if (winId < 0) return;
  const name = currentFilePath ? VFS.basename(currentFilePath) : "UNTITLED";
  wmSetTitle(winId, `${isDirty ? "* " : ""}${name} - ${APP_NAME}`);
}

/** 編集が起きたら dirty にしてタイトルを更新する (未 dirty からの遷移時のみ) */
function markDirty() {
  if (isDirty) return;
  isDirty = true;
  refreshTitle();
}

/** 現在のノート群を保存用クリップ (MIDI 互換形状) にする */
function currentClip() {
  return {
    stepsPerBeat: STEPS_PER_BEAT,
    steps: COLS,
    notes: notes.map((n) => ({
      pitch: rowToMidi(n.row),
      start: n.col,
      len: n.len,
      vel: n.vel,
    })),
  };
}

/** 読み込んだクリップをノート群へ反映し、再生/編集の一時状態を初期化する */
function loadClip(clip) {
  notes = clip.notes.map((n) => ({
    col: n.start,
    row: ROWS - 1 - n.pitch, // rowToMidi の逆
    len: n.len,
    vel: n.vel,
    selected: false,
  }));
  drag = null;
  sounding.clear();
}

/** dirty なら破棄確認、無ければ即実行 */
function confirmDiscard(onOk) {
  if (!isDirty) {
    onOk();
    return;
  }
  openConfirmDialog("DISCARD UNSAVED CHANGES?", { variant: "danger", onOk });
}

/** 名前を付けて保存 (FileDialog) */
function saveClipAs() {
  const dir = currentFilePath ? VFS.parentPath(currentFilePath) : "/Music";
  const name = currentFilePath ? VFS.basename(currentFilePath) : "untitled" + CLIP_EXT;
  openFileDialog("save", {
    title: "SAVE AS",
    defaultPath: dir,
    defaultName: name,
    filter: [CLIP_EXT],
    onResult: (path) => {
      if (!path) return;
      currentFilePath = path;
      VFS.writeFile(path, serializeClip(currentClip()));
      isDirty = false;
      refreshTitle();
    },
  });
}

/** 上書き保存 (パス未定なら Save As へフォールバック) */
function saveClip() {
  if (!currentFilePath) {
    saveClipAs();
    return;
  }
  VFS.writeFile(currentFilePath, serializeClip(currentClip()));
  isDirty = false;
  refreshTitle();
}

/** ファイルを開く (未保存確認 → FileDialog → 読込) */
function openClip() {
  confirmDiscard(() => {
    openFileDialog("open", {
      title: "OPEN",
      filter: [CLIP_EXT],
      onResult: (path) => {
        if (!path) return;
        const text = VFS.readFile(path);
        if (text === null) return;
        const clip = parseClip(text);
        if (!clip) return;
        loadClip(clip);
        currentFilePath = path;
        isDirty = false;
        refreshTitle();
      },
    });
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  再生
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Space: transport を開始/停止する。fromStop=true で停止位置から (Shift+Space) */
function togglePlay(fromStop) {
  if (transport.isPlaying()) {
    transport.stop();
  } else {
    transport.setTempo(BPM);
    transport.setLoop(0, BARS * BEATS_PER_BAR, true); // 4 小節ループ
    transport.play(fromStop ? null : 0); // null=停止位置から / 0=1.1.1 から
  }
}
/** ステップ境界: 発音中を減衰・消音し、そのステップで始まるノートを発音 */
function onStepEnter(step) {
  const inst = _activeInst;
  if (!inst) return;
  for (const [note, rem] of sounding) {
    const r = rem - 1;
    if (r <= 0) {
      inst.noteOff(rowToMidi(note.row));
      sounding.delete(note);
    } else {
      sounding.set(note, r);
    }
  }
  for (const n of notes) {
    if (n.col === step) {
      const midi = rowToMidi(n.row);
      inst.noteOff(midi);
      inst.noteOn(midi, n.vel / 127);
      sounding.set(n, n.len);
    }
  }
}
/**
 * 毎フレーム: transport を進め、開始/停止の遷移を処理し、跨いだステップを発火する。
 * transport を誰が操作しても (将来の Transport アプリ含む) ここで追従する。
 */
function updatePlayback() {
  transport.update();
  const p = transport.isPlaying();
  if (p && !_wasPlaying) {
    // 再生開始: このセッションの発音先を確定し、開始ステップ直前へ合わせる
    _activeInst = targetInstrument();
    const startStep = transport.getPosition() * STEPS_PER_BEAT;
    lastFiredStep = (Math.floor(startStep) - 1 + LOOP_STEPS) % LOOP_STEPS;
    sounding.clear();
  } else if (!p && _wasPlaying) {
    // 停止: 発音を止める
    if (_activeInst) _activeInst.allNotesOff();
    _activeInst = null;
    sounding.clear();
  }
  _wasPlaying = p;
  if (!p) return;
  const target = Math.floor(transport.getPosition() * STEPS_PER_BEAT) % LOOP_STEPS;
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

// ── 操作カーソル (assets/cursors/manifest.json のキー) ──
// カーソル名は「操作の役割」を表す。ホバー中は「今押したら何が起きるか」、ドラッグ中は
// 「実行中の操作」に合わせて毎フレーム要求する (WM の contentCursorOverride は毎フレーム
// リセットされるため、hover/held のたびに要求し直す必要がある)。
const CURSOR_SELECT = "pointer"; // 選択 (空セルのラバー選択 / Shift 選択トグル)
const CURSOR_MOVE = "move"; // ノート移動
const CURSOR_RESIZE = "resize-ew"; // 音価変更 (ノート左右の辺)
const CURSOR_DUPLICATE = "move-copy"; // 複製移動 (Ctrl+ドラッグ)

/** ノート n の辺掴み判定。'l'/'r'/null。端ゾーンは幅の 1/3 (最大 EDGE_GRAB) */
function edgeSide(lx, n) {
  const le = colInnerX(n.col);
  const re = colInnerX(n.col + n.len - 1) + cellW;
  const g = Math.min(EDGE_GRAB, Math.max(1, Math.floor((re - le) / 3)));
  if (lx < le + g) return "l";
  if (lx >= re - g) return "r";
  return null;
}

/**
 * ホバー/ドラッグ状態に応じて操作カーソルを WM へ要求する。判定順は down ハンドラと
 * 揃える (辺 > Shift 選択 > Ctrl 複製 > 移動)。hover イベントは ctrl/shift を運ばないため、
 * endDrag と同じくキーボードの押下状態 (ctrlHeld/shiftHeld) で複製・選択を見分ける。
 * @param {number} lx コンテンツ空間 X
 * @param {number} ly コンテンツ空間 Y
 */
function updateCursor(lx, ly) {
  if (drag) {
    // ドラッグ中は実行中の操作がそのままカーソル
    if (drag.mode === "resize") wmRequestCursor(CURSOR_RESIZE);
    else if (drag.mode === "move") wmRequestCursor(ctrlHeld() ? CURSOR_DUPLICATE : CURSOR_MOVE);
    else wmRequestCursor(CURSOR_SELECT); // rubber
    return;
  }
  // ホバー: 押したら何が起きるかでカーソルを決める
  const cell = cellAt(lx, ly);
  const n = cell ? noteAt(cell.col, cell.row) : null;
  if (!n) wmRequestCursor(CURSOR_SELECT); // 空セル → ラバー選択
  else if (shiftHeld()) wmRequestCursor(CURSOR_SELECT); // Shift → 選択トグル (辺掴み無効)
  else if (edgeSide(lx, n)) wmRequestCursor(CURSOR_RESIZE); // ノートの辺 → 音価変更
  else wmRequestCursor(ctrlHeld() ? CURSOR_DUPLICATE : CURSOR_MOVE); // 本体 → 移動 / Ctrl=複製
}

/** ドラッグ確定 */
function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;

  if (d.mode === "rubber") {
    // 動かして離した場合は held で選択反映済み。動かさず離した (単なる空クリック) は
    // 非 Shift なら全解除、Shift なら選択維持。
    if (!d.moved && !d.additive) deselectAll();
    return;
  }
  if (d.mode === "resize") {
    resolveOverlaps([d.note]); // 端ドラッグはノートを実時間で伸縮済み。確定時に重なり解決
    if (d.resized) markDirty();
    return;
  }
  if (!d.moved) {
    if (d.pending) d.pending();
    return;
  }
  if (ctrlHeld()) {
    duplicateAt(d.sel, d.dCol, d.dRow); // Ctrl 押下中 = 複製 (markDirty は duplicateAt 内)
  } else {
    for (const n of d.sel) {
      n.col += d.dCol;
      n.row += d.dRow;
    }
    resolveOverlaps(d.sel);
    markDirty();
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
    markDirty();
    return;
  }

  if (ev.type === "down") {
    const cell = cellAt(ev.localX, ev.localY);
    prevDownKey = lastDownKey;
    lastDownKey = cell ? `${cell.col},${cell.row}` : null;

    const n = cell ? noteAt(cell.col, cell.row) : null;
    if (!n) {
      // 空セル: ラバー選択を開始。ドラッグすれば矩形に触れたノートを一括選択し、
      // 動かさず離せば単なる空クリック (plain=全解除 / Shift=維持) になる。選択の
      // 変更は確定 (endDrag) まで遅延する。base = Shift 時の合成元 (既存選択)。
      drag = {
        mode: "rubber",
        x0: ev.localX,
        y0: ev.localY,
        x1: ev.localX,
        y1: ev.localY,
        additive: !!ev.shift,
        base: ev.shift ? new Set(selected()) : null,
        rubberHit: new Set(), // 前フレームまでに矩形へ入ったノート (新規ヒットの試聴判定用)
        moved: false,
      };
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
        resized: false,
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
      previewRow: 0, // 最後に試聴した dRow (ピッチが変わったフレームだけ鳴らすため)
      sel: selected(),
      pending,
    };
    return;
  }

  if (ev.type === "held") {
    if (!drag) return;
    updateCursor(ev.localX, ev.localY);
    if (drag.mode === "rubber") {
      // ラバー矩形を更新し、触れているノートをリアルタイム選択する。cellAt に依らず
      // localX/localY をそのまま使う (表の外まで広げても矩形を追従させるため)。
      drag.x1 = ev.localX;
      drag.y1 = ev.localY;
      if (Math.abs(drag.x1 - drag.x0) > 2 || Math.abs(drag.y1 - drag.y0) > 2) drag.moved = true;
      applyRubberSelection(drag);
      return;
    }
    const cell = cellAt(ev.localX, ev.localY);
    if (!cell) return;
    if (drag.mode === "resize") {
      const pc = drag.note.col;
      const pl = drag.note.len;
      if (drag.side === "r") {
        drag.note.len = Math.max(1, cell.col - drag.fixedCol + 1);
      } else {
        const s = clampInt(cell.col, 0, drag.fixedCol);
        drag.note.col = s;
        drag.note.len = drag.fixedCol - s + 1;
      }
      if (drag.note.col !== pc || drag.note.len !== pl) drag.resized = true;
      return;
    }
    const [dCol, dRow] = clampDelta(drag.sel, cell.col - drag.grabCol, cell.row - drag.grabRow);
    drag.dCol = dCol;
    drag.dRow = dRow;
    drag.moved = dCol !== 0 || dRow !== 0;
    // ピッチ (行) が変わったフレームだけ、移動先の音高を短く試聴する。時間 (列) 方向だけの
    // 移動では鳴らさない。掴んだセルの新しい行を鳴らす (通常/Shift/Ctrl ドラッグ共通)。
    if (dRow !== drag.previewRow) {
      audition(rowToMidi(drag.grabRow + dRow));
      drag.previewRow = dRow;
    }
    return;
  }

  if (ev.type === "up") {
    endDrag();
  } else if (ev.type === "hover") {
    if (drag) endDrag(); // 領域外リリースの保険 (枠外で離すと up が来ないため)
    updateCursor(ev.localX, ev.localY); // ホバー位置に応じてカーソル形状を更新
  }
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
  // フォーカス判定は winId で行う (title はファイル名で変わるため APP_NAME 比較は不可)
  if (!wmIsFocused(winId)) {
    repeatCode = null;
    return;
  }
  const shift = shiftHeld();
  // ファイル (VFS): Ctrl+Shift+S を Ctrl+S より先に判定する
  if (ctrlShiftDown("KeyS")) saveClipAs();
  else if (ctrlDown("KeyS")) saveClip();
  if (ctrlDown("KeyO")) openClip();
  if (ctrlDown("KeyA")) selectAll();
  if (ctrlDown("KeyD")) duplicateAfter();
  if (keyDown("Escape")) deselectAll();
  if (keyDown("Delete")) deleteSelected();
  if (keyDown("KeyF")) fold = !fold;
  if (keyDown("Space")) togglePlay(shift); // Shift = 停止位置から / 素 = 1.1.1 から
  handleArrows(performance.now(), shift);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ステップ (拍より細かい) の縦点線を 1 本描く。各セル内寸の上端 (interiorY) から 1px おきに
 * 点を打つ。横罫線は内寸の「外」にあるため点が乗らず、点線の隙間が必ず横線の行に重なる
 * (ASCII 仕様の位相)。内寸基準なので cellH や罫線厚がズームで変わっても位相は保たれる。
 * @param {number} x   線の X (画面座標)
 * @param {number} oy  表上端の Y (画面座標。interiorY はこの原点からのオフセット)
 * @param {number[]} interiorY  各表示行の内寸上端 Y (コンテンツ空間)
 * @param {number} rows 表示行数 (interiorY の有効長)
 * @param {number} ch  セル行高
 */
export function drawStepDots(x, oy, interiorY, rows, ch) {
  for (let di = 0; di < rows; di++) {
    const y0 = oy + interiorY[di];
    for (let k = 0; k < ch; k += 2) pset(x, y0 + k, 1);
  }
}

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
  updatePreview(); // 単発プレビューの自動消音
  const vl = vLayout();
  const tw = tableW();
  const th = vl.totalH;

  // 縦罫線 (列境界) — 時間方向の階層: 小節線=2px 実線 / 拍線=1px 実線 / ステップ=1px 点線。
  // 拍境界 (小節を含む) は実線、それ以外の細かいステップは点線。点線は横罫線の行を避けて
  // 内寸だけに点を打つので、横線と交差しても線が潰れず隙間が横線に重なる (ASCII 位相)。
  for (let c = 0, x = cr.x; c <= COLS; c++) {
    const t = vThick(c);
    if (c % STEPS_PER_BEAT === 0) fillRect(x, cr.y, t, th, 1); // 小節線(2px)/拍線(1px)=実線
    else drawStepDots(x, cr.y, vl.interiorY, vl.R, cellH); // ステップ=1px 点線
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

  // ラバー選択の矩形 (破線マーキー。コンテンツ空間 → 画面座標へ cr で変換)
  if (drag && drag.mode === "rubber" && drag.moved) {
    drawDashedRect(cr.x + drag.x0, cr.y + drag.y0, cr.x + drag.x1, cr.y + drag.y1);
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
  // 移動ドラッグ中は確定前でも移動先を即時反映する (PITCH/TIME をライブ更新)。
  // 選択集合は一括して同じ量だけ動くので、scope 全体に dCol/dRow を足せばよい。
  // 音価変更 (resize) はノートを実時間で書き換えるため LEN/TIME はそのまま反映される。
  const moving = drag && drag.mode === "move" && drag.moved;
  const dC = moving ? drag.dCol : 0;
  const dR = moving ? drag.dRow : 0;
  let loM = Infinity;
  let hiM = -Infinity;
  let loL = Infinity;
  let hiL = -Infinity;
  let loV = Infinity;
  let hiV = -Infinity;
  let loC = Infinity;
  let hiE = -Infinity;
  for (const n of scope) {
    const col = n.col + dC;
    const m = rowToMidi(n.row + dR);
    loM = Math.min(loM, m);
    hiM = Math.max(hiM, m);
    loL = Math.min(loL, n.len);
    hiL = Math.max(hiL, n.len);
    loV = Math.min(loV, n.vel);
    hiV = Math.max(hiV, n.vel);
    loC = Math.min(loC, col);
    hiE = Math.max(hiE, col + n.len);
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
  "ROLL is a step-grid MIDI editor. Four bars of 16 steps across, all 128 MIDI pitches down. Notes play through SYNTH's voice when it is open, else a built-in fallback.",
  "",
  "MOUSE",
  "- Double-click empty: place note",
  "- Double-click a note: delete",
  "- Click a note: select it",
  "- Shift+click a note: toggle",
  "- Click empty: clear selection",
  "- Drag empty: rubber-band select",
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
  "",
  "FILE",
  "- Ctrl+S: save (.roll clip)",
  "- Ctrl+Shift+S: save as",
  "- Ctrl+O: open",
].join("\n");

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 閉じる際の後始末: 再生を止め発音を消す (updatePlayback は閉じると呼ばれないため明示) */
function cleanupOnClose() {
  if (transport.isPlaying()) transport.stop();
  if (_activeInst) _activeInst.allNotesOff();
  _activeInst = null;
  _wasPlaying = false;
  sounding.clear();
  previewStop(); // プレビュー音を止める
  releaseAudioAwake(); // キープアライブ解放 (開いた時の keepAudioAwake と対)
  winId = -1;
}

/** 閉じる前: 未保存なら破棄確認して閉じをキャンセル、確認後に直接クローズ */
function onBeforeClose() {
  if (isDirty) {
    const id = winId;
    openConfirmDialog("DISCARD UNSAVED CHANGES?", {
      variant: "danger",
      onOk: () => {
        isDirty = false;
        cleanupOnClose();
        wmClose(id);
      },
    });
    return false;
  }
  cleanupOnClose();
  return true;
}

/** 起動/再オープン時、チップチューンの主要音域 (C4..C5 のメロディ域) が縦中央に来るよう
 *  縦スクロールを合わせる。窓は標準サイズで小さいため、そのままだと最上段 (最高音・通常は
 *  空) が見えてしまう。行高を控えめにしてあるので、この帯を中心に約 2 オクターブが収まる。 */
function scrollToDefaultRegister() {
  if (winId < 0) return;
  const vl = vLayout();
  const centerMidi = Math.round((INITIAL_VIEW_LO_MIDI + INITIAL_VIEW_HI_MIDI) / 2);
  const di = vl.rowToDi.get(ROWS - 1 - centerMidi); // C4..C5 の中央 (=B4/C5 境) の表示行
  if (di === undefined) return;
  const cr = wmGetContentRect(winId);
  const viewH = cr ? cr.h : 0;
  // wmSetScroll がコンテンツ範囲でクランプするので端でも安全
  wmSetScroll(winId, 0, vl.interiorY[di] + cellH / 2 - viewH / 2);
}

wmRegister(
  APP_NAME,
  () => {
    winId = wmOpen(-1, -1, 0, 0, APP_NAME, onDraw, onInput, onMeasure, {
      footer: true,
      onDrawFooter,
      onBeforeClose,
      about: ABOUT_TEXT,
      // ボディ全域をピアノロールに使う (NOTEPAD 同様)。Content Pad を効かせると作業領域が
      // 中途半端な位置で途切れて見えるため、アプリ側で内側余白を無効化する。
      padding: "none",
      // 起動サイズは標準サイズ (解像度に依存しない小さめの窓)。128 音高の全グリッドは
      // onMeasure がスクロール範囲として返し、はみ出す分は窓側スクロールで巡る。
      initialSize: wmDefaultContentSize(true),
    });
    refreshTitle(); // 再オープン時もファイル名 / dirty をタイトルに反映
    scrollToDefaultRegister();
    // 起動 (ユーザー操作) の時点でオーディオを用意/起こしておく。1 音目や放置後の
    // 復帰時に出る余分な発音遅延を防ぐ (クローズ時に releaseAudioAwake で解放)。
    keepAudioAwake();
    return winId;
  },
  { category: "CREATIVE", dev: true },
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  公開 API: FILES 等から .roll を開く
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 指定パスの .roll クリップを ROLL で開く。
 * ウィンドウが閉じていれば開き、最前面へ。未保存の編集があれば破棄確認する。
 * @param {string} path  VFS 上のファイルパス (.roll)
 * @returns {boolean} 読み込み成功なら true
 */
export function rollOpenFile(path) {
  const text = VFS.readFile(path);
  if (text === null) return false;
  const clip = parseClip(text);
  if (!clip) return false;

  const load = () => {
    wmOpenOrFocus(APP_NAME); // 未オープンなら登録 cb が winId を確定
    loadClip(clip);
    currentFilePath = path;
    isDirty = false;
    refreshTitle();
  };
  // 開いていて未保存編集があるときだけ確認する (閉じていれば破棄するものは無い)
  if (winId >= 0 && isDirty) confirmDiscard(load);
  else load();
  return true;
}
