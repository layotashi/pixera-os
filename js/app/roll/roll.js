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
 *   点線は各セル内寸の上端から 1px おきに点を打つ。行高 (cellH) は常に奇数なので内寸も
 *   奇数となり、点は内寸の上端と下端の両方に乗る。よって隙間が横罫線の行にちょうど重なり、
 *   横線を上下 1px の点で挟んだ左右対称な 3px の交点になる (縦ズームは 2px 刻みで奇数を保つ)。
 *   横 (音高) はオクターブ境界 (B/C)・上端/下端 = 2px、他は 1px 実線。
 *   ノートはセル内寸いっぱいに置き、最外周 1px を白枠・内側を黒に (罫線との視認性)。
 *   非選択 = 黒枠+黒塗り。選択/発音中 = 黒枠+白塗り。
 *
 * ── 主な操作 (ABOUT にも記載) ──
 *   配置/削除 = ダブルクリック。選択 = クリック、Shift+クリックで複数。
 *   移動 = ドラッグ、複製 = Ctrl+ドラッグ。音価 = ノート左右の辺をドラッグ。
 *   ズーム = Ctrl/Shift+Ctrl+ホイール (カーソル基準)。FOLD = F。再生 = Space。
 *   選択時はピッチ確認のため短く試聴する。重なりは配置側が勝ち (被りは削除/クリップ)。
 *   コピー/ペースト = Ctrl+C / Ctrl+V (ペーストは直近クリックのグリッド線が起点)。
 *   Undo/Redo = Ctrl+Z / Ctrl+Y。時間スケール = `*`/`/` に続けて数字 (例 `*`2=2倍, `/`2=1/2倍)。
 *
 * マルチトラック: 共有ソングモデル (app/music/song.js) の 4 トラックのうち「選択トラック」の
 * クリップを編集する。非選択 3 トラックのノートは背面に市松ゴーストで表示 (同時刻・同音高の
 * 重なりを把握するため)。発音は各トラックの音色 (SYNTH が編集) で、再生は 4 トラック同時。
 * 再生位置は共有 transport が持つ (再生「制御」は TRANSPORT アプリが操作する)。
 *
 * ── VFS 連携 (保存 / 読込) ──
 *   保存単位は 4 トラック丸ごとの楽曲プロジェクト = `.song` (core/song.js)。
 *   Ctrl+S = 上書き保存 (無題なら Save As)。Ctrl+Shift+S = 名前を付けて保存。Ctrl+O = 開く。
 *   これで「1 トラックしか保存されない / 別ファイルを開くと旧データと混在する」不具合を解消する
 *   (docs/SONG_FORMAT_SPEC.md)。ノート形状は MIDI 互換 (pitch/start/len/vel) を保つ。
 *   `.roll` (core/clip.js の単一フレーズ) は交換/再利用グレインとして残り、FILES から
 *   ダブルクリックすると現在のトラックへフレーズを取り込む (rollOpenFile)。`.song` は
 *   rollOpenSong で開く。
 */

import { fillRect, pset, drawDashedRect, drawCheckerboard, isCapturing } from "../../core/gpu.js";
import { drawText, textWidth } from "../../core/font.js";
import {
  getAudioContext,
  initAudio,
  keepAudioAwake,
  releaseAudioAwake,
} from "../../core/audio.js";
import {
  initChipEngine,
  isChipSupported,
  chipSetPattern,
  chipSetTransport,
  createInstrument,
} from "../../core/chip.js";
import * as song from "../music/song.js";
import * as transport from "../music/transport.js";
import * as VFS from "../../core/vfs.js";
import { openFileDialog, openConfirmDialog } from "../../ui/index.js";
import { parseClip } from "../../core/clip.js";
import { SONG_EXT, serializeSong, parseSong } from "../../core/song.js";
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
import { keyDown, keyHeld, ctrlDown, ctrlShiftDown, getCharQueue } from "../../core/input.js";

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

/** 桁幅 (DOT) の範囲。時間方向は横スクロール前提なので、編集しやすい幅を保つ。 */
const CELL_W_MIN = 5;
const CELL_W_MAX = 30;
const CELL_W_DEFAULT = 15;

/** 行高 (DOT) は縦点線 (ステップ) の位相を保つため常に奇数にする。内寸が奇数だと点線が
 *  内寸の上端と下端の両方に乗り、横罫線を上下 1px の点で挟んだ左右対称な 3px 交点になる
 *  (偶数だと片側が隙間になり位相が崩れる)。ゆえに範囲・既定をすべて奇数で定義し、縦ズームは
 *  2px 刻みにして奇数を保つ。既定はチップチューンの主要音域を一度に見せる (≈2 オクターブ)
 *  よう控えめにし、起動ごとのスクロール手間を減らす (狭すぎると編集しづらいので下限寄り)。 */
const CELL_H_MIN = 5;
const CELL_H_MAX = 29;
const CELL_H_DEFAULT = 9;

/** ホイール 1 ノッチのズーム量 (DOT)。縦は奇数を保つため 2px 刻み。 */
const ZOOM_STEP_W = 1;
const ZOOM_STEP_H = 2;

/** キーリピート: 押下後この待機 (ms) を経てからこの間隔 (ms) で連続処理 */
const REPEAT_DELAY = 300;
const REPEAT_RATE = 45;

/** ノート辺の掴み判定幅 (DOT)。真上 1px より広く取る */
const EDGE_GRAB = 5;

/** 履歴 (Undo/Redo) の保持数。1 操作 = ノート全体のスナップショット 1 枚。
 *  4 小節 × 数十ノート規模なので 100 段でも十分軽い。 */
const HISTORY_LIMIT = 100;

/** スケール入力 (`*`/`/` → 数字) の受付猶予 (ms)。演算子を押してからこの時間内に数字を
 *  入力すると倍率が確定する。過ぎたら演算子待ちを破棄する (押しっぱなしの取り違え防止)。 */
const SCALE_PENDING_MS = 1500;

/** 既定ベロシティ (0..127)。v1 は固定 */
const DEFAULT_VEL = 100;
/** 試聴の長さ (秒) */
const AUDITION_SEC = 0.25;
/** ステップ発火のループ長 (= 4 小節 = 全列)。テンポ/ループ範囲は共有 transport が持つ。 */
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
/** FOLD を ON にする直前 (通常表示) のスクロール位置。OFF 復帰時にここへ戻す (null = 未保存) */
let _scrollBeforeFold = null;

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

// ── 履歴 (Undo/Redo) ──
/** 過去状態のスタック (それぞれノート全体のスナップショット)。undo で pop する */
let undoStack = [];
/** undo で戻した状態のスタック。redo で pop する。新規編集が入ると破棄する */
let redoStack = [];

// ── コピー / ペースト ──
/** コピーしたノート群。位置は先頭 (srcCol) からの相対 dCol で保持し、ペースト時に再配置する。
 *  null = クリップボード空。 @type {{srcCol:number,notes:{dCol:number,row:number,len:number,vel:number}[]}|null} */
let clipboard = null;
/** ペースト基準列 (グリッド線番号)。直近クリックのセル中央しきい値で決まる。null = 未クリック */
let _pasteRefCol = null;

// ── スケール入力の状態機械 (`*`/`/` を押した後に数字で倍率確定) ──
/** 押された演算子 ('*' | '/' | null)。null = 演算子待ち無し */
let _scaleOp = null;
/** 演算子を押した時刻 (ms)。SCALE_PENDING_MS を過ぎたら _scaleOp を破棄する */
let _scaleOpAt = 0;

/** ダブルクリック誤検出よけ: 直近 2 クリックのセルキー */
let lastDownKey = null;
let prevDownKey = null;

// ── 再生 (クロックは共有 transport、発音先は song モデルの 4 トラック) ──
//
// マルチトラック: 4 トラックを同時再生する。発音方式は 2 系統:
//   [seq]    ワークレット内シーケンサ (対応環境)。各トラックのパターンを自チャンネルへ、
//            共有トランスポート時計を 1 本送ると、オーディオスレッドが 4 チャンネルを
//            サンプル精度で同時発火する。メインスレッドの描画ジャンクに影響されない本命経路。
//   [legacy] 非対応環境。従来どおり毎フレームで発火するが、選択トラックのみ (安全網)。
let lastFiredStep = -1;
let _wasPlaying = false; // transport 再生状態の前フレーム値 (開始/停止の遷移検出)
let _activeInst = null; // [legacy] 再生セッション中の発音先 (選択トラック)
const sounding = new Map(); // note -> 残りステップ ([legacy] の発音管理用)

// ── [seq] ワークレットシーケンサの同期状態 ──
let _seqMode = false; // このセッションがワークレットシーケンサ経路か
let _lastSigs = []; // 直近に送った各トラックのパターン署名 (編集検知して再送)
let _lastClockKey = ""; // 直近に送ったトランスポート時計のキー (変化検知して再送)

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  音源 / 試聴
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 試聴の発音先 = 選択トラックの音源 (SYNTH と同じ音色で鳴らす)。 */
function targetInstrument() {
  return song.getInstrument(song.getSelectedIndex());
}
/** AudioContext を確実に用意 (ユーザー操作起点で resume) */
function ensureCtx() {
  if (!getAudioContext()) initAudio();
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") ctx.resume();
  return ctx;
}

// ── 試聴 / プレビュー (モノ単発 + ポリ和音) ──
//
// プレビューは選択トラックの「音色」で鳴らすが、トラックの発音チャンネルとは別の専用ポリ音源で
// 鳴らす。こうすることで (a) 和音ラバー選択で全音を同時に鳴らして響きを確認でき (トラックが
// Monophonic でもプレビューは和音になる) (b) SYNTH のライブ演奏や ROLL の再生と発音が干渉しない。
// 発音は「今すぐ」(ctx.currentTime) にスケジュールしてクリック→発音の遅延を最小化する。
//
//   audition(midi)       … モノ単発。直前の音を止めてから 1 音 (ノート移動・単体選択の確認)。
//                          半音移動での濁りを避けるためモノ制約を保ち AUDITION_SEC 後に自動消音。
//   previewChord(midis)  … ポリ持続。ラバー選択中の集合を鳴らし続け、外れた音は止め入った音を足す。
//                          離す (endDrag) と AUDITION_SEC の自動消音へ移行する。

/** 現在鳴っているプレビュー音の MIDI 集合 (空 = 無音)。 */
let _previewNotes = new Set();
/** その音を鳴らした発音先 (停止に使う)。 */
let _previewInst = null;
/** 自動消音の期限 (ms, performance.now 基準)。Infinity = 持続 (自動消音しない)。 */
let _previewOffAt = 0;
/** プレビュー専用のポリ音源 (トラックの maxVoices に縛られない。遅延生成)。 */
let _previewSynth = null;

/** プレビュー音源を確保し、選択トラックの音色をミラーして返す (和音でも鳴るよう maxVoices は多め)。 */
function previewSynth() {
  if (!_previewSynth) {
    song.getInstrument(song.getSelectedIndex()); // 先に 4 トラック音源を確保 (channel 0..3)
    _previewSynth = createInstrument(); // 専用プレビュー音源 (別チャンネル)
  }
  const t = song.getSelectedTrack();
  if (t && _previewSynth.setWaveform) {
    const p = t.patch;
    _previewSynth.setWaveform(p.waveform);
    _previewSynth.setADSR(p.a, p.d, p.s, p.r);
    _previewSynth.setVolume(p.volume);
    _previewSynth.setMaxVoices(16); // 試聴は常にポリ (和音確認のため)
  }
  return _previewSynth;
}

/** 現在のプレビュー音を全て止める。 */
function previewStop() {
  if (_previewNotes.size && _previewInst && getAudioContext()) {
    for (const m of _previewNotes) _previewInst.noteOff(m);
  }
  _previewNotes.clear();
  _previewInst = null;
  _previewOffAt = 0;
}

/**
 * モノ単発試聴 (ピッチ確認)。直前の音を必ず止めてから 1 音鳴らす。AUDITION_SEC 後に
 * updatePreview が自動消音する。同じ 1 音への連続呼び出しは鳴らし直さず消音期限だけ延長する。
 * @param {number} midi
 */
function audition(midi) {
  const ctx = ensureCtx();
  if (!ctx) return;
  const off = performance.now() + AUDITION_SEC * 1000;
  if (_previewNotes.size === 1 && _previewNotes.has(midi)) {
    _previewOffAt = off; // 同じ単音は鳴らし直さず、消音期限だけ延長
    return;
  }
  previewStop();
  const inst = previewSynth();
  inst.noteOn(midi, DEFAULT_VEL / 127, ctx.currentTime);
  _previewNotes.add(midi);
  _previewInst = inst;
  _previewOffAt = off;
}

/**
 * ポリ和音試聴 (ラバー選択の響き確認)。現在鳴っている集合を midis へ差分更新し持続させる
 * (外れた音は noteOff、入った音は noteOn)。自動消音はしない (endDrag で期限へ移行する)。
 * @param {number[]} midis
 */
function previewChord(midis) {
  const ctx = ensureCtx();
  if (!ctx) return;
  const inst = previewSynth();
  if (_previewInst && _previewInst !== inst) previewStop(); // 音源が変わったら作り直す
  const want = new Set(midis);
  for (const m of [..._previewNotes]) {
    if (!want.has(m)) {
      inst.noteOff(m);
      _previewNotes.delete(m);
    }
  }
  for (const m of want) {
    if (!_previewNotes.has(m)) {
      inst.noteOn(m, DEFAULT_VEL / 127, ctx.currentTime);
      _previewNotes.add(m);
    }
  }
  _previewInst = inst;
  _previewOffAt = _previewNotes.size ? Infinity : 0; // 持続 (自動消音しない)
}

/** 毎フレーム: プレビューが期限に達していたら消音する (Infinity = 持続中は消さない)。 */
function updatePreview() {
  if (_previewNotes.size && performance.now() >= _previewOffAt) previewStop();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  縦レイアウト (FOLD 対応。表示行の並びを 1 度計算してキャッシュ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ctrlHeld = () => keyHeld("ControlLeft") || keyHeld("ControlRight");
const shiftHeld = () => keyHeld("ShiftLeft") || keyHeld("ShiftRight");

/**
 * FOLD の表示行 (ノートのある行のみ昇順) を求める純関数。選択トラックのノート行と、非選択
 * トラックのノート行の和集合を返す ── FOLD でも 4 トラック全てのノートがゴースト表示される
 * ように (選択トラックの行だけに畳むと他トラックのノートが隠れてしまう)。選択トラックは表示行を
 * 直接持つ selNotes を、他トラックは MIDI 形状 (pitch) の clip を渡す (row = ROWS-1-pitch)。
 * @param {{row:number}[]} selNotes 選択トラックのノート (row = 表示行)
 * @param {{notes:{pitch:number}[]}[]} otherClips 非選択トラックの clip 群
 * @returns {number[]} 昇順の表示行
 */
export function foldedRows(selNotes, otherClips) {
  const s = new Set();
  for (const n of selNotes) s.add(n.row);
  for (const c of otherClips) {
    for (const gn of c.notes) s.add(ROWS - 1 - gn.pitch);
  }
  return [...s].sort((a, b) => a - b);
}

/** 表示する実 row の配列。normal = 全行、fold = ノートのある行のみ昇順 (4 トラック分)。 */
function visibleRows() {
  if (!fold) return ALL_ROWS;
  const selIdx = song.getSelectedIndex();
  const others = [];
  for (let ti = 0; ti < song.getTrackCount(); ti++) {
    if (ti !== selIdx) others.push(song.getClip(ti));
  }
  return foldedRows(notes, others);
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

/**
 * コンテンツ空間 X → 最寄りのグリッド線番号 (0..COLS)。判定はセル中央がしきい値:
 * クリックがセル中央より左なら左側の線 (= その列番号)、中央以上なら右側の線 (= 列番号+1)。
 * anchorCol はセル中央でちょうど整数+0.5 になるので、Math.round が中央しきい値そのものになる
 * (中央上は右側へ丸める)。ペーストの基準列決定に使う。
 */
export function gridLineAtX(lx) {
  return clampInt(Math.round(anchorCol(lx)), 0, COLS);
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

/**
 * セル (col,row) を覆う「非アクティブトラック」の index を求める純関数 (無ければ -1)。
 * 重なりは描画順 (index 昇順で後描き = 前面) に合わせ、最前面 = 最大 index を優先する。
 * clips[i] は MIDI 形状 (pitch/start/len) のノートを持つトラック clip (row = ROWS-1-pitch)。
 * @param {number} col
 * @param {number} row 表示行 (0 = 最高音)
 * @param {number} selIdx アクティブトラック index (これは除外する)
 * @param {{notes:{pitch:number,start:number,len:number}[]}[]} clips 全トラックの clip
 * @returns {number} トラック index、無ければ -1
 */
export function ghostTrackAtCell(col, row, selIdx, clips) {
  const pitch = ROWS - 1 - row;
  for (let ti = clips.length - 1; ti >= 0; ti--) {
    if (ti === selIdx) continue;
    const c = clips[ti];
    if (!c) continue;
    for (const gn of c.notes) {
      if (gn.pitch === pitch && col >= gn.start && col < gn.start + gn.len) return ti;
    }
  }
  return -1;
}

/** セル (col,row) を覆う非アクティブトラックがあれば index を返す (無ければ -1)。
 *  ROLL から直接そのトラックへ切り替える (ゴーストノードのクリック) 判定に使う。 */
function ghostTrackAt(col, row) {
  const clips = [];
  for (let ti = 0; ti < song.getTrackCount(); ti++) clips.push(song.getClip(ti));
  return ghostTrackAtCell(col, row, song.getSelectedIndex(), clips);
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
  const hitNow = new Set();
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
    if (hit) hitNow.add(n);
  }
  // 矩形に触れているノート群を「和音」としてポリで持続試聴し、響きを確認できるようにする
  // (移動プレビューのモノ制約とは別扱い)。矩形から外れた音は止め、入った音を足す。重複ピッチは 1 度。
  previewChord([...hitNow].map((n) => rowToMidi(n.row)));
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
//  履歴 (Undo / Redo)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// スナップショット方式: 1 操作の直前状態 (ノート全体の複製) を undo スタックへ積む。
// 自然な操作単位で 1 件になるよう、記録は「操作の確定点」で行う ── ドラッグは離した
// とき、矢印キーは押下 1 回 (長押しリピートは 1 件に集約)、配置/削除/複製/削除/
// スケール/ペーストはそれぞれ完了時。選択だけの変化は履歴に残さない (編集ではないため)。
// commitHistory は直前スナップショットと現在を比較し、変化が無ければ積まない (空エントリ防止)。

/** ノート全体を値だけ複製する (選択状態も含めて復元できるよう selected も持つ) */
function snapshotNotes() {
  return notes.map((n) => ({ col: n.col, row: n.row, len: n.len, vel: n.vel, selected: n.selected }));
}
/** スナップショットからノート配列を復元する (新しいオブジェクトに作り直す) */
function restoreNotes(snap) {
  notes = snap.map((n) => ({ ...n }));
}
/** 2 つのスナップショット (or 現在の notes) が値として等しいか (順序も含めて比較) */
function historyEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.col !== y.col || x.row !== y.row || x.len !== y.len || x.vel !== y.vel || x.selected !== y.selected)
      return false;
  }
  return true;
}
/** before (操作前スナップショット) を undo スタックへ積む。変化が無ければ何もしない。
 *  新規編集なので redo スタックは破棄する。上限を超えた分は古い方から捨てる。 */
function commitHistory(before) {
  if (historyEqual(before, notes)) return;
  undoStack.push(before);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
}
/** fn を実行し、ノートが変化していれば 1 件の履歴として記録する (配置/削除/スケール等の共通枠) */
function withHistory(fn) {
  const before = snapshotNotes();
  fn();
  commitHistory(before);
}
/** undo/redo でノートを差し替えた後の後始末 (ドラッグ/発音/dirty を整える) */
function afterHistoryChange() {
  drag = null;
  if (_activeInst) _activeInst.allNotesOff(); // 発音中があれば消す (残った参照は無効になるため)
  sounding.clear();
  markDirty();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshotNotes());
  restoreNotes(undoStack.pop());
  afterHistoryChange();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshotNotes());
  restoreNotes(redoStack.pop());
  afterHistoryChange();
}
/** 履歴をまっさらにする (ファイル読込など、別ドキュメントへ切り替えたとき) */
function resetHistory() {
  undoStack = [];
  redoStack = [];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  選択編集 — 時間スケール / コピー&ペースト
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 選択ノート群を時間方向へ factor 倍したノートを返す (純関数)。起点は選択先頭ノート
 * (最小 col) の開始列。各ノートの開始・長さを起点基準で factor 倍する。
 *
 * factor は整数 d (= d 倍) か、整数の逆数 1/d (= 1/d 倍) を渡す約束。倍・除算は整数演算で
 * 正確に行う (浮動小数の丸め誤差で成立判定がブレないように 1/d は割り切れるかを整数で見る)。
 *
 * ステップグリッド上で「丸めずに」正確に表せない場合は null を返す (呼び出し側は操作を
 * 実行しない): 割り切れず開始列/長さが非整数になる・長さが最小グリッド (1 ステップ) 未満に
 * なる・グリッド枠 (0..maxCols) をはみ出す、のいずれか。2 倍は常に整数だが、1/2 倍は各ノートの
 * 長さと起点からの距離がともに偶数のときだけ成立する。
 *
 * @param {{col:number,row:number,len:number,vel:number}[]} sel  選択ノート
 * @param {number} factor  倍率 (2 = 2 倍 / 0.5 = 1/2 倍)。整数 d か 1/d
 * @param {number} maxCols グリッド総列数 (枠外判定用)
 * @returns {{col:number,row:number,len:number,vel:number}[]|null} sel と同順の変換結果、不可なら null
 */
export function scaleNotesInTime(sel, factor, maxCols) {
  if (!sel || !sel.length || !(factor > 0)) return null;
  const mul = factor >= 1; // >=1 は d 倍、<1 は 1/d 倍として整数 d を復元する
  const d = mul ? Math.round(factor) : Math.round(1 / factor);
  let origin = Infinity;
  for (const n of sel) origin = Math.min(origin, n.col);
  const out = [];
  for (const n of sel) {
    const off = n.col - origin;
    let col, len;
    if (mul) {
      col = origin + off * d;
      len = n.len * d;
    } else {
      if (off % d !== 0 || n.len % d !== 0) return null; // 割り切れない → 丸めず実行しない
      col = origin + off / d;
      len = n.len / d;
    }
    if (len < 1) return null; // 最小グリッド (1 ステップ) 未満
    if (col < 0 || col + len > maxCols) return null; // 枠外
    out.push({ col, row: n.row, len, vel: n.vel });
  }
  return out;
}

/** 選択ノート群を factor 倍する。成立しなければ何もしない (1 件の履歴として記録) */
function applyScale(factor) {
  withHistory(() => {
    const sel = selected();
    const scaled = scaleNotesInTime(sel, factor, COLS);
    if (!scaled) return; // 実行不可 (丸めず操作自体を行わない)
    for (let i = 0; i < sel.length; i++) {
      sel[i].col = scaled[i].col;
      sel[i].len = scaled[i].len;
    }
    resolveOverlaps(sel); // 拡大で他ノートに被った分は選択側を勝たせて解決
    markDirty();
  });
}

/** 現在の選択をクリップボードへコピーする (先頭 col からの相対位置で保持) */
function copySelection() {
  const sel = selected();
  if (!sel.length) return;
  let srcCol = Infinity;
  for (const n of sel) srcCol = Math.min(srcCol, n.col);
  clipboard = {
    srcCol,
    notes: sel.map((n) => ({ dCol: n.col - srcCol, row: n.row, len: n.len, vel: n.vel })),
  };
}

/** 選択をクリップボードへ退避してから削除する (Ctrl+X)。コピー & ペーストと対になる操作で、
 *  クリップボードの中身は copySelection と同一形式。削除は 1 件の履歴として記録し Undo で戻せる。 */
function cutSelection() {
  if (!selected().length) return;
  copySelection();
  withHistory(deleteSelected);
}

/**
 * クリップボードのノート群を基準列 refCol に配置したノートを返す (純関数)。
 * 各ノートの col = refCol + dCol。右端をはみ出す分は長さを詰め、枠外に出るものは捨てる。
 * @param {{dCol:number,row:number,len:number,vel:number}[]} clipNotes
 * @param {number} refCol  ノート群の開始列 (グリッド線番号)
 * @param {number} maxCols グリッド総列数
 * @returns {{col:number,row:number,len:number,vel:number}[]}
 */
export function pasteNotesAt(clipNotes, refCol, maxCols) {
  const out = [];
  for (const c of clipNotes) {
    const col = refCol + c.dCol;
    if (col < 0 || col >= maxCols) continue; // 枠外は捨てる
    const len = Math.min(c.len, maxCols - col); // 右端はみ出しは詰める
    if (len < 1) continue;
    out.push({ col, row: c.row, len, vel: c.vel });
  }
  return out;
}

/** クリップボードを基準グリッド線へペーストする (1 件の履歴として記録) */
function pasteClipboard() {
  if (!clipboard || !clipboard.notes.length) return;
  withHistory(() => {
    // 基準列は直近クリックのグリッド線。未クリックならコピー元の位置に戻す。
    const refCol = _pasteRefCol != null ? _pasteRefCol : clipboard.srcCol;
    const placed = pasteNotesAt(clipboard.notes, refCol, COLS);
    if (!placed.length) return;
    deselectAll();
    const copies = placed.map((p) => ({ ...p, selected: true }));
    notes.push(...copies);
    resolveOverlaps(copies); // ペースト側が既存に勝つ
    markDirty();
  });
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
  resetHistory(); // 別ドキュメントなので Undo/Redo をまっさらに
}

// ── マルチトラック: 選択トラックとの同期 ──
//
// ROLL は「選択トラックの clip」を編集する。編集中のノートは毎フレーム song へ書き戻し
// (commitSelectedClip)、他アプリ (再生・ゴースト・将来の保存) がプル参照できるようにする。
// トラックを切り替えたら旧トラックへ確定保存し、新トラックのノートを読み込む。

/** ROLL の現在ノートを選択トラックのクリップとして song へ書き戻す (毎フレーム。鮮度維持)。 */
function commitSelectedClip() {
  song.setClipNotes(song.getSelectedIndex(), currentClip().notes);
}

/** .song 読み込み中フラグ。全トラックを一括差し替えする間は onTrackSwitch の「旧トラックへ
 *  現在ノートを書き戻す」処理を止める。さもないと applySong が発火する選択変更で、まだ差し替え
 *  前の ROLL バッファ (古いノート) が読み込んだトラックへ上書きされてしまう。 */
let _loadingSong = false;

/** トラック切替: 旧トラックへ現在ノートを保存し、新トラックのクリップを読み込む
 *  (Undo 履歴・選択・ドラッグ・発音中は loadClip 内で初期化される)。
 *  .song 読み込み中は loadSong が全トラックと ROLL バッファを自前で管理するため何もしない。 */
function onTrackSwitch(next, prev) {
  if (_loadingSong) return;
  song.setClipNotes(prev, currentClip().notes);
  loadClip(song.getClip(next));
}
song.onSelectionChange(onTrackSwitch);

/** .song (4 トラック) を丸ごと読み込む。全トラックのノート・音色・選択を差し替え、
 *  選択トラックを ROLL の編集バッファへ読み込む。旧データは残らない (混在しない)。 */
function loadSong(data) {
  _loadingSong = true;
  song.applySong(data); // 全トラックを一括差し替え + 選択設定 (ROLL の onTrackSwitch は抑止)
  _loadingSong = false;
  loadClip(song.getClip(song.getSelectedIndex())); // 選択トラックを編集バッファへ
}

/** dirty なら破棄確認、無ければ即実行 */
function confirmDiscard(onOk) {
  if (!isDirty) {
    onOk();
    return;
  }
  openConfirmDialog("DISCARD UNSAVED CHANGES?", { variant: "danger", onOk });
}

/** 保存前に選択トラックの編集を song へ確定する (毎フレームの commit と冪等だが、次フレームを
 *  待たずスナップショットへ確実に載せるため保存時に明示する)。 */
function flushForSave() {
  commitSelectedClip();
}

/** 名前を付けて保存 (FileDialog)。4 トラック丸ごとを .song として保存する。 */
function saveSongAs() {
  const dir = currentFilePath ? VFS.parentPath(currentFilePath) : "/Music";
  const name = currentFilePath ? VFS.basename(currentFilePath) : "untitled" + SONG_EXT;
  openFileDialog("save", {
    title: "SAVE AS",
    defaultPath: dir,
    defaultName: name,
    filter: [SONG_EXT],
    onResult: (path) => {
      if (!path) return;
      currentFilePath = path;
      flushForSave();
      VFS.writeFile(path, serializeSong(song.snapshotSong()));
      isDirty = false;
      refreshTitle();
    },
  });
}

/** 上書き保存 (パス未定なら Save As へフォールバック) */
function saveSong() {
  if (!currentFilePath) {
    saveSongAs();
    return;
  }
  flushForSave();
  VFS.writeFile(currentFilePath, serializeSong(song.snapshotSong()));
  isDirty = false;
  refreshTitle();
}

/** ファイルを開く (未保存確認 → FileDialog → 読込)。4 トラックを丸ごと差し替える。 */
function openSong() {
  confirmDiscard(() => {
    openFileDialog("open", {
      title: "OPEN",
      filter: [SONG_EXT],
      onResult: (path) => {
        if (!path) return;
        const text = VFS.readFile(path);
        if (text === null) return;
        const data = parseSong(text);
        if (!data) return;
        loadSong(data);
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

/** Space: transport を開始/停止する。fromStop=true で停止位置から (Shift+Space)
 *
 *  テンポ・ループは共有 transport が持つ単一の出所 (TRANSPORT アプリが操作する)。
 *  ROLL はそれを上書きせず読むだけにする ── こうしないと ROLL で Space を押すたびに
 *  TRANSPORT で設定したテンポ/ループが 120・4 小節へ戻ってしまう。共有 transport の
 *  既定 (120BPM / 0..16beat ループ ON) は元々ここで固定していた値と同じなので、
 *  ROLL 単体での挙動は変わらない。 */
function togglePlay(fromStop) {
  transport.toggleFromSpace(fromStop); // 共有仕様: 素=1.1.1 から / Shift=停止位置から
}
// ── [seq] ワークレットシーケンサへ渡す変換 / 同期 (トラック別) ──

/** トラック i のクリップ {pitch,start,len,vel} → ワークレットのパターン形 {midi,startStep,lenSteps,vel(0..1)}。 */
function trackWorkletNotes(i) {
  return song.getClip(i).notes.map((n) => ({
    midi: n.pitch,
    startStep: n.start,
    lenSteps: n.len,
    vel: n.vel / 127,
  }));
}

/** トラック i のパターン署名 (編集検知用)。値が変われば再送する。 */
function trackSig(i) {
  const ns = song.getClip(i).notes;
  let s = ns.length | 0;
  for (const n of ns) {
    s = (Math.imul(s, 31) + n.start * 131071 + n.pitch * 8191 + n.len * 127 + n.vel) | 0;
  }
  return s;
}

/** トラック i の発音チャンネル (ChipSynth のみ。不可なら null)。 */
function trackChannel(i) {
  if (!isChipSupported()) return null;
  const inst = song.getInstrument(i);
  return inst && inst.channel != null ? inst.channel : null;
}

/** トラック i のパターン + チャンネルをワークレットへ送る (チャンネル未確定なら何もしない)。 */
function sendTrackPattern(i) {
  const ch = trackChannel(i);
  if (ch == null) return;
  chipSetPattern(trackWorkletNotes(i), STEPS_PER_BEAT, ch);
}

/** トランスポート時計のキー (変化検知用)。アンカー/テンポ/ループが変われば再送する。 */
function clockKey(c) {
  return `${c.playing}|${c.bpm}|${c.startBeat}|${c.startTime}|${c.loopStart}|${c.loopEnd}|${c.loopOn}`;
}

/** [legacy] ステップ境界: 発音中を減衰・消音し、そのステップで始まるノートを発音 */
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
 * 毎フレーム: transport を進め、開始/停止の遷移を処理する。
 * [seq] 経路ではパターン + トランスポート時計をワークレットへ同期するだけで、発火はオーディオ
 * スレッドが担う (発音タイミングはメインの描画負荷から独立)。[legacy] 経路のみ従来の per-frame
 * 発火を行う。transport を誰が操作しても (将来の TRANSPORT アプリ含む) ここで追従する。
 */
function updatePlayback() {
  transport.update();
  // 選択トラックの編集を song へ反映してから各トラックのパターンを読む (鮮度の保証)。
  commitSelectedClip();
  const p = transport.isPlaying();
  const clock = transport.getClock();
  const chip = isChipSupported();
  const N = song.getTrackCount();

  if (p && !_wasPlaying) {
    // ── 再生開始: 経路を選ぶ ──
    if (chip) {
      song.getInstrument(0); // 全チャンネル (0..N-1) を確保
      _seqMode = true;
      _lastSigs = [];
      // 全トラックのパターンを各チャンネルへ、共有時計を 1 本送る (以降オーディオスレッドが自走)
      for (let i = 0; i < N; i++) {
        sendTrackPattern(i);
        _lastSigs[i] = trackSig(i);
      }
      chipSetTransport(clock);
      _lastClockKey = clockKey(clock);
    } else {
      // フォールバック: 選択トラックのみ per-frame 発火。開始ステップ直前へ合わせる
      _seqMode = false;
      _activeInst = targetInstrument();
      const startStep = transport.getPosition() * STEPS_PER_BEAT;
      lastFiredStep = (Math.floor(startStep) - 1 + LOOP_STEPS) % LOOP_STEPS;
      sounding.clear();
    }
  } else if (!p && _wasPlaying) {
    // ── 停止 ──
    if (_seqMode) {
      chipSetTransport(clock); // playing:false ＝ 全チャンネルのシーケンス音を止める
    } else if (_activeInst) {
      _activeInst.allNotesOff();
    }
    _activeInst = null;
    _seqMode = false;
    sounding.clear();
  } else if (p && _seqMode) {
    // ── 継続 [seq]: 各トラックの編集 / トランスポート変更をワークレットへ同期 ──
    for (let i = 0; i < N; i++) {
      const sig = trackSig(i);
      if (sig !== _lastSigs[i]) {
        sendTrackPattern(i); // 打ち込み編集を即反映 (WYSIWYG)
        _lastSigs[i] = sig;
      }
    }
    const ck = clockKey(clock);
    if (ck !== _lastClockKey) {
      chipSetTransport(clock); // テンポ/ループ/シーク変更を反映
      _lastClockKey = ck;
    }
  }

  _wasPlaying = p;
  if (!p || _seqMode) return;

  // ── [legacy] per-frame 発火 (非対応環境のみ。選択トラック) ──
  const target = Math.floor(transport.getPosition() * STEPS_PER_BEAT) % LOOP_STEPS;
  let guard = 0;
  while (lastFiredStep !== target && guard++ <= LOOP_STEPS) {
    lastFiredStep = (lastFiredStep + 1) % LOOP_STEPS;
    onStepEnter(lastFiredStep);
  }
}

/** 発音中ノートの視覚ハイライト用の現在ステップ (再生ヘッド)。停止中は -1。
 *  [seq]/[legacy] 共通で共有時計 (transport) から導出する ＝ 盤面と発音が一致する (WYSIWYG)。
 *  LOOP_STEPS での剰余は取らない: ループ ON なら transport 側が位置を範囲内へ折り返し済みで
 *  剰余は無用、ループ OFF では位置がパターン長 (64 step) を超えて進むため剰余を取ると 1.1.1
 *  付近のノートが誤って発音中表示になる (5.1.1 以降で step%64 が 0 付近へ巻き戻るバグ)。
 *  パターン長を超えた step は isNoteSounding にどのノートもヒットせず、正しく無ハイライトになる。 */
function currentPlayStep() {
  if (!transport.isPlaying()) return -1;
  return Math.floor(transport.getPosition() * STEPS_PER_BEAT);
}
/** ノート n が再生ヘッド playStep 上で発音中か (視覚ハイライト用)。 */
function isNoteSounding(n, playStep) {
  return playStep >= n.col && playStep < n.col + n.len;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力 — ホイール (カーソル基準ズーム)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const clampW = (v) => Math.max(CELL_W_MIN, Math.min(CELL_W_MAX, v));
const clampH = (v) => Math.max(CELL_H_MIN, Math.min(CELL_H_MAX, v));

function zoomWheel(ev) {
  const dir = -Math.sign(ev.deltaY || 0); // WheelUp = 拡大 / Down = 縮小
  if (dir === 0) return;
  const s0 = wmGetScroll(winId);
  // 補正は整数へ丸めグリッドをピクセル境界へ (滲み防止・カーソル下のセルを厳密に保持)
  if (ev.shift) {
    const f = anchorCol(ev.localX);
    const old = cellW;
    cellW = clampW(cellW + dir * ZOOM_STEP_W); // Shift+Ctrl = 水平 (幅)
    wmSetScroll(winId, Math.round(s0.x + f * (cellW - old)), null);
  } else {
    const f = anchorRow(ev.localY);
    const old = cellH;
    // 縦は 2px 刻み。奇数の既定値から偶数を足し引きするので cellH は常に奇数のまま
    // (= 点線の隙間が横罫線に重なり、上下対称な交点になる位相を維持する)。
    cellH = clampH(cellH + dir * ZOOM_STEP_H); // Ctrl = 垂直 (高さ)
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
    // 和音プレビューを鳴らし切ってから消す (キーを離した時のリリース感)。持続 → 自動消音へ移行。
    if (_previewNotes.size) _previewOffAt = performance.now() + AUDITION_SEC * 1000;
    return;
  }
  if (d.mode === "resize") {
    resolveOverlaps([d.note]); // 端ドラッグはノートを実時間で伸縮済み。確定時に重なり解決
    if (d.resized) {
      markDirty();
      commitHistory(d.before); // 音価変更を 1 件の履歴に
    }
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
  commitHistory(d.before); // 移動 / 複製を 1 件の履歴に
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
    const before = snapshotNotes();
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
    commitHistory(before); // 配置 / 削除を 1 件の履歴に
    return;
  }

  if (ev.type === "down") {
    const cell = cellAt(ev.localX, ev.localY);
    _pasteRefCol = gridLineAtX(ev.localX); // ペースト基準グリッド線 (セル中央しきい値)
    let before = snapshotNotes(); // ドラッグ確定時に使う履歴起点 (move/resize)
    prevDownKey = lastDownKey;
    lastDownKey = cell ? `${cell.col},${cell.row}` : null;

    let n = cell ? noteAt(cell.col, cell.row) : null;

    // アクティブトラックにノートが無く、非アクティブトラックのゴーストノードを掴んだ (plain
    // クリック) 場合は、そのトラックへ切り替える。TRACK アプリを経由せず ROLL 上で素早く
    // トラックを移れる。切替後はそのノートを掴み直し、アクティブノートをクリックしたのと同じ
    // 挙動 (選択 + ドラッグ) へ流す。before は旧トラックのスナップなので取り直す。
    if (!n && cell && !ev.shift) {
      const ti = ghostTrackAt(cell.col, cell.row);
      if (ti >= 0) {
        song.setSelectedIndex(ti); // onTrackSwitch が旧トラック保存 + 新トラック読込を行う
        before = snapshotNotes();
        n = noteAt(cell.col, cell.row);
      }
    }

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
        before,
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
      before,
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
      // 押下 1 回を 1 件の履歴に。以降の長押しリピートはこの起点へ集約する
      // (リピート中は commit しないので、その連続移動を 1 回の Undo で戻せる)。
      const before = snapshotNotes();
      arrowAction(code, shift)?.();
      commitHistory(before);
      repeatCode = code;
      repeatNext = now + REPEAT_DELAY;
      return;
    }
  }
  if (repeatCode && keyHeld(repeatCode)) {
    if (now >= repeatNext) {
      arrowAction(repeatCode, shift)?.(); // リピートは履歴を追加しない (押下単位で 1 件)
      repeatNext = now + REPEAT_RATE;
    }
  } else {
    repeatCode = null;
  }
}
/**
 * FOLD を切り替える。ON にする直前の (通常表示の) スクロール位置を覚えておき、OFF に戻した
 * ときにそこへ復帰する。こうしないと、FOLD 中はコンテンツが短くスクロールが 0 付近へ寄るため、
 * OFF に戻した瞬間に全 128 音高グリッドの最上部 (最高音域・通常は空) へ飛んでしまう。
 * FOLD 表示中のスクロールは破棄する (打ち込んでいた音域へ戻すのが目的なので通常位置だけ保つ)。
 */
function toggleFold() {
  if (!fold) {
    _scrollBeforeFold = wmGetScroll(winId); // ON へ: 通常表示のスクロールを退避
    fold = true;
  } else {
    fold = false; // OFF へ: レイアウトを通常表示へ戻してから退避位置を復元
    if (_scrollBeforeFold) {
      // wmSetScroll は onMeasure で新レイアウト (縦=128 行) の寸法に同期してからクランプするので
      // 退避した通常表示の位置が正しく収まる。
      wmSetScroll(winId, _scrollBeforeFold.x, _scrollBeforeFold.y);
      _scrollBeforeFold = null;
    }
  }
}

/**
 * スケール入力 (`*`/`/` → 数字) を文字キューから解釈する。演算子を押すと待ち状態になり、
 * 続けて数字 d を押すと `*` は d 倍・`/` は 1/d 倍で確定する (例: `*` `2` = 2 倍、`/` `2` =
 * 1/2 倍)。修飾なしの印字文字だけを見るので Ctrl 系のショートカットとは干渉しない。
 * SCALE_PENDING_MS を過ぎた演算子待ちは破棄する。
 */
function handleScaleInput(now) {
  if (_scaleOp && now - _scaleOpAt > SCALE_PENDING_MS) _scaleOp = null; // 期限切れ
  const chars = getCharQueue();
  for (const ch of chars) {
    if (ch === "*" || ch === "/") {
      _scaleOp = ch;
      _scaleOpAt = now;
    } else if (_scaleOp && ch >= "1" && ch <= "9") {
      const d = ch.charCodeAt(0) - 48;
      applyScale(_scaleOp === "*" ? d : 1 / d);
      _scaleOp = null;
    } else {
      _scaleOp = null; // 無関係な文字入力で演算子待ちを中断
    }
  }
}

function handleKeys() {
  // フォーカス判定は winId で行う (title はファイル名で変わるため APP_NAME 比較は不可)
  if (!wmIsFocused(winId)) {
    repeatCode = null;
    _scaleOp = null; // フォーカスを失ったら演算子待ちも捨てる
    return;
  }
  const shift = shiftHeld();
  // ファイル (VFS): Ctrl+Shift+S を Ctrl+S より先に判定する。保存単位は 4 トラック丸ごと (.song)
  if (ctrlShiftDown("KeyS")) saveSongAs();
  else if (ctrlDown("KeyS")) saveSong();
  if (ctrlDown("KeyO")) openSong();
  // 履歴: Ctrl+Z = Undo / Ctrl+Y = Redo
  if (ctrlDown("KeyZ")) undo();
  if (ctrlDown("KeyY")) redo();
  // 切り取り / コピー / ペースト
  if (ctrlDown("KeyX")) cutSelection();
  if (ctrlDown("KeyC")) copySelection();
  if (ctrlDown("KeyV")) pasteClipboard();
  if (ctrlDown("KeyA")) selectAll();
  if (ctrlDown("KeyD")) withHistory(duplicateAfter);
  if (keyDown("Escape")) deselectAll();
  if (keyDown("Delete")) withHistory(deleteSelected);
  if (keyDown("KeyF")) toggleFold();
  if (keyDown("Space")) togglePlay(shift); // Shift = 停止位置から / 素 = 1.1.1 から
  handleScaleInput(performance.now());
  handleArrows(performance.now(), shift);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ステップ (拍より細かい) の縦点線を 1 本描く。各セル内寸の上端 (interiorY) から 1px おきに
 * 点を打つ。横罫線は内寸の「外」にあるため点が乗らず、点線の隙間が必ず横線の行に重なる
 * (ASCII 仕様の位相)。呼び出し側は行高 ch を常に奇数に保つので、内寸の上端と下端の両方が
 * 点になり、横罫線を上下 1px の点で対称に挟む 3px の交点になる。内寸基準なので cellH や
 * 罫線厚がズームで変わってもこの位相は保たれる。
 * @param {number} x   線の X (画面座標)
 * @param {number} oy  表上端の Y (画面座標。interiorY はこの原点からのオフセット)
 * @param {number[]} interiorY  各表示行の内寸上端 Y (コンテンツ空間)
 * @param {number} rows 表示行数 (interiorY の有効長)
 * @param {number} ch  セル行高 (奇数。0,2,…,ch-1 に点 = 内寸の上端と下端の両方に乗る)
 */
export function drawStepDots(x, oy, interiorY, rows, ch) {
  for (let di = 0; di < rows; di++) {
    const y0 = oy + interiorY[di];
    for (let k = 0; k < ch; k += 2) pset(x, y0 + k, 1);
  }
}

/** 1 ノートを描く。hollow=true で内部を白抜き (選択/発音中) */
/**
 * ノートグリフを絶対矩形へ描く (レイアウト非依存の純関数)。全スタイル共通で
 * 白の外枠 (最外周 1px) + 黒枠を描き、内部を style で埋める:
 *   solid  … 黒のまま (通常の非選択ノート)
 *   hollow … 白抜き (選択中 / 再生中)
 *   ghost  … 市松 (非アクティブトラック)。drawCheckerboard は内側原点 (ox+2,oy+2) 基準の
 *            phase=0 で一致位相に白 (=0) を置くので、各ノートの左上角が常に白始まりになり、
 *            位置/サイズに依らず角の位相が揃う (ユーザー ASCII 仕様どおり)。
 * @param {"solid"|"hollow"|"ghost"} style
 */
export function drawNoteGlyph(ox, oy, ow, oh, style) {
  if (ow <= 0 || oh <= 0) return;
  fillRect(ox, oy, ow, oh, 0); // 白枠 (最外周 1px を含む白地)
  if (ow > 2 && oh > 2) {
    fillRect(ox + 1, oy + 1, ow - 2, oh - 2, 1); // 黒枠本体
    if (ow > 4 && oh > 4) {
      if (style === "hollow") fillRect(ox + 2, oy + 2, ow - 4, oh - 4, 0);
      else if (style === "ghost") drawCheckerboard(ox + 2, oy + 2, ow - 4, oh - 4, 0, 0);
    }
  }
}

/** レイアウトからノートの描画矩形 (絶対座標) を求める。FOLD で非表示の行は null。 */
function noteRect(cr, col, row, len, vl) {
  const di = vl.rowToDi.get(row);
  if (di === undefined) return null; // FOLD で非表示の行
  const x0 = colInnerX(col);
  const x1 = colInnerX(col + len - 1) + cellW;
  return { ox: cr.x + x0, oy: cr.y + vl.interiorY[di], ow: x1 - x0, oh: cellH };
}

/** 1 ノートを描く。hollow=true で内部を白抜き (選択/発音中)。 */
function drawNoteAt(cr, col, row, len, hollow, vl) {
  const r = noteRect(cr, col, row, len, vl);
  if (r) drawNoteGlyph(r.ox, r.oy, r.ow, r.oh, hollow ? "hollow" : "solid");
}

/** 非アクティブトラックのノートを描く (背面表示用)。発音中はトラックのアクティブ状態に
 *  依らず「再生中」スタイル (hollow) で目立たせ、それ以外は市松ゴーストで描く。 */
function drawGhostNoteAt(cr, col, row, len, sounding, vl) {
  const r = noteRect(cr, col, row, len, vl);
  if (r) drawNoteGlyph(r.ox, r.oy, r.ow, r.oh, sounding ? "hollow" : "ghost");
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

  // 発音中判定は再生ヘッドから導出するので [seq]/[legacy] どちらの発音経路でも盤面と一致する。
  const playStep = currentPlayStep();

  // 非選択トラックのノートを背面に市松ゴースト表示する (同時刻・同音高の重なりを把握するため)。
  // 選択トラックのノートは後段で通常描画され前面に来る。発音中のゴーストノートはトラックの
  // アクティブ状態に依らず「再生中」スタイルで描く (再生を全トラック横断で可視化する)。
  const selIdx = song.getSelectedIndex();
  for (let ti = 0; ti < song.getTrackCount(); ti++) {
    if (ti === selIdx) continue;
    for (const gn of song.getClip(ti).notes) {
      const sounding = playStep >= gn.start && playStep < gn.start + gn.len;
      drawGhostNoteAt(cr, gn.start, ROWS - 1 - gn.pitch, gn.len, sounding, vl);
    }
  }

  // ノート + 移動プレビュー (発音中/選択は白抜き)。
  const moving = !!(drag && drag.mode === "move" && drag.moved);
  const dup = moving && ctrlHeld();
  for (const n of notes) {
    if (moving && !dup && drag.sel.includes(n)) continue; // 移動: 掴んだ実体は隠す
    drawNoteAt(cr, n.col, n.row, n.len, n.selected || isNoteSounding(n, playStep), vl);
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
  "- Ctrl+X / Ctrl+C / Ctrl+V: cut / copy / paste",
  "- Ctrl+Z / Ctrl+Y: undo / redo",
  "- * then N: scale length x N",
  "- / then N: scale length / N",
  "- Arrows: move 1 cell (held repeats)",
  "- Shift+Up/Down: move 1 octave",
  "- Shift+Left/Right: shorten/lengthen",
  "- F: fold (show only used rows)",
  "- Space: play / stop",
  "- Shift+Space: play from stop point",
  "",
  "PASTE lands the group's start on the grid line nearest your last click (the cell center decides left or right).",
  "",
  "SCALE grows or shrinks length from the first selected note. It is skipped whole, never rounded, if a result would fall below one step.",
  "",
  "FILE",
  "- Ctrl+S: save song (all 4 tracks, .song)",
  "- Ctrl+Shift+S: save as",
  "- Ctrl+O: open a .song project",
  "- A .roll file imports one phrase into the current track.",
].join("\n");

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 閉じる際の後始末: 再生を止め発音を消す (updatePlayback は閉じると呼ばれないため明示) */
function cleanupOnClose() {
  if (transport.isPlaying()) transport.stop();
  // [seq] ワークレットシーケンサは自走するので、停止後の時計 (playing:false) を明示的に送って止める。
  if (_seqMode) chipSetTransport(transport.getClock());
  song.allNotesOff(); // 全トラックのライブ/シーケンス発音を止める
  if (_activeInst) _activeInst.allNotesOff();
  _activeInst = null;
  _seqMode = false;
  _wasPlaying = false;
  sounding.clear();
  previewStop(); // プレビュー音を止める
  if (_previewSynth) _previewSynth.allNotesOff(); // 専用プレビュー音源のリリース残りも消す
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
    initChipEngine(); // チップ音源エンジンも用意 (発音先がフォールバック音源のとき用)
    return winId;
  },
  // SYNESTA メンバー: アイコン / ランチャーには出さず、SYNESTA からまとめて起動する。
  { category: "CREATIVE", dev: true, hidden: true, noIcon: true },
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  公開 API: FILES 等から .song / .roll を開く
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 指定パスの .song プロジェクト (4 トラック) を ROLL で開く。
 * ウィンドウが閉じていれば開き、最前面へ。未保存の編集があれば破棄確認する。
 * @param {string} path  VFS 上のファイルパス (.song)
 * @returns {boolean} 読み込み成功なら true
 */
export function rollOpenSong(path) {
  const text = VFS.readFile(path);
  if (text === null) return false;
  const data = parseSong(text);
  if (!data) return false;

  const load = () => {
    wmOpenOrFocus(APP_NAME); // 未オープンなら登録 cb が winId を確定
    loadSong(data);
    currentFilePath = path;
    isDirty = false;
    refreshTitle();
  };
  // 開いていて未保存編集があるときだけ確認する (閉じていれば破棄するものは無い)
  if (winId >= 0 && isDirty) confirmDiscard(load);
  else load();
  return true;
}

/**
 * 指定パスの .roll クリップ (単一フレーズ) を ROLL の「選択トラック」へ取り込む。
 * .roll は交換/再利用グレインなので、これは楽曲を開くのではなく現在のトラックへフレーズを
 * インポートする操作。他トラックには触れないため、選択トラックのノートだけが差し替わる。
 * プロジェクトの保存先 (.song パス) は変えず、未保存編集として dirty にする。
 * @param {string} path  VFS 上のファイルパス (.roll)
 * @returns {boolean} 読み込み成功なら true
 */
export function rollOpenFile(path) {
  const text = VFS.readFile(path);
  if (text === null) return false;
  const clip = parseClip(text);
  if (!clip) return false;

  const doImport = () => {
    wmOpenOrFocus(APP_NAME); // 未オープンなら登録 cb が winId を確定
    loadClip(clip); // フレーズを編集バッファ (= 選択トラック) へ。他トラックは不変
    markDirty(); // プロジェクトの未保存編集にする (.song パスは変えない)
    refreshTitle();
  };
  // 開いていて未保存編集があるときだけ確認する (閉じていれば破棄するものは無い)
  if (winId >= 0 && isDirty) confirmDiscard(doImport);
  else doImport();
  return true;
}
