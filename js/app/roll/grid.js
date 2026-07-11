/**
 * @module app/roll/grid
 * grid.js — ROLL のステップグリッド・ピアノロール (ビュー + 編集 + スクロール)
 *
 * 音楽アプリ再設計の第 2 弾 ROLL のコア画面。旧 SYNESTA の piano_roll.js は
 * 参照も流用もせずゼロベース設計 (docs/MIDI_EDITOR_SPEC.md)。
 *
 * ── 設計 (v1 プロトタイプ) ──
 *   ステップ量子化グリッド。ノートは常にステップ (16 分) にスナップする。
 *   自由ドラッグ (端掴みリサイズ・自由移動・ラバーバンド) は採らない
 *   ── 低解像度・1-bit で当たり判定が破綻し、旧実装の品質課題源だったため。
 *
 *   操作:
 *     空セルをクリック   … 1 ステップのノートを配置 (即オーディション)
 *     ノート上をクリック … 削除 (トグル)
 *     ノートを横ドラッグ … 長さをセル単位で伸縮 (端掴みの精密操作は無し)
 *     鍵盤列をクリック   … その音高をオーディション
 *     ホイール           … 縦/横スクロール (Shift で横。Ctrl は将来のズーム用に透過)
 *
 * ── 座標系 ──
 *   縦 = ピッチ。rowIndex 0 = MIDI 127 (最高音・上端)、rowIndex 127 = MIDI 0。
 *   横 = 時間。col = ステップ番号 (0..TOTAL_STEPS-1)。
 *   スクロールは行/桁単位の ScrollState (offset が可視左上のセル)。WM 標準バーへは
 *   roll.js が wmAttachScroll で接続する。
 *
 * ── 1-bit 表現 ──
 *   ノート = 塗り矩形。シャープ行 = 淡いディザ帯 (ピアノ配列の視覚的手がかり)。
 *   小節線 = 実線、拍線 = 点線、オクターブ境界 = 実線。プレイヘッド = 縦の反転バー。
 *   発音中のノートは反転で「光る」(映える画面)。
 */

import {
  fillRect,
  hline,
  vline,
  pset,
  invertRect,
  drawCheckerboard,
  pushClip,
  popClip,
} from "../../core/gpu.js";
import { drawText, GLYPH_H } from "../../core/font.js";
import {
  createScrollState,
  scrollBy,
  scrollSetViewport,
} from "../../ui/index.js";
import {
  PIANO_ROLL_TOTAL_COLUMNS,
  PIANO_ROLL_STEPS_PER_BEAT,
  PIANO_ROLL_STEPS_PER_BAR,
} from "../../config.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** グリッド寸法 (DOT)。fixed-size + scroll。ズームは将来 Ctrl+ホイールで可変化 */
export const CELL_W = 12; // 1 ステップの桁幅
export const ROW_H = 9; // 1 ピッチの行高 (>= GLYPH_H で C ラベルが収まる)
export const KEY_COL_W = 20; // 左端ピアノ鍵盤列の幅
export const RULER_H = 8; // 上端ルーラー (小節/拍) の高さ

/** ピッチ総数 (MIDI 0..127) と総ステップ数 */
const TOTAL_ROWS = 128;
const TOTAL_STEPS = PIANO_ROLL_TOTAL_COLUMNS;

/** ホイール 1 ノッチのスクロール量 (行/桁) */
const SCROLL_STEP = 3;

/** シャープ (黒鍵) のピッチクラス */
const SHARP_PC = new Set([1, 3, 6, 8, 10]);
const isSharp = (midi) => SHARP_PC.has(((midi % 12) + 12) % 12);

/** MIDI → 行インデックス (上が高音) */
const midiToRow = (midi) => TOTAL_ROWS - 1 - midi;
/** 行インデックス → MIDI */
const rowToMidi = (row) => TOTAL_ROWS - 1 - row;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RollGrid
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class RollGrid {
  /**
   * @param {object} [o]
   * @param {(midi:number)=>void} [o.audition]  ノート配置・鍵盤クリック時の試聴コールバック
   */
  constructor({ audition } = {}) {
    /** @type {{pitch:number,start:number,len:number}[]} */
    this.notes = [];
    this._audition = audition || (() => {});

    // 行/桁単位のスクロール状態。viewport は draw で毎フレーム更新する。
    this.vScroll = createScrollState(1, TOTAL_ROWS);
    this.hScroll = createScrollState(1, TOTAL_STEPS);
    // 初期表示: 中音域 (C4=MIDI60 付近) を見えるように
    this.vScroll.offset = midiToRow(72); // C5 を上端付近に

    // 編集ドラッグ状態
    this._active = null; // 伸縮中 / 判定中のノート
    this._activeIsNew = false; // このドラッグで新規作成したか
    this._dragged = false; // ドラッグで桁が動いたか (クリック削除の判定用)
    this._downCol = -1;
  }

  get scrollRow() {
    return this.vScroll.offset;
  }
  get scrollCol() {
    return this.hScroll.offset;
  }

  // ── モデル操作 ──

  _noteAt(col, midi) {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      if (n.pitch === midi && col >= n.start && col < n.start + n.len) return n;
    }
    return null;
  }

  _remove(n) {
    const i = this.notes.indexOf(n);
    if (i >= 0) this.notes.splice(i, 1);
  }

  /** ローカル座標 (コンテンツ原点。RULER_H/KEY_COL_W はグリッド内オフセット) → セル */
  _cellAt(lx, ly) {
    const gx = lx - KEY_COL_W;
    const gy = ly - RULER_H;
    if (gx < 0 || gy < 0) return null;
    const col = this.hScroll.offset + Math.floor(gx / CELL_W);
    const row = this.vScroll.offset + Math.floor(gy / ROW_H);
    if (col < 0 || col >= TOTAL_STEPS || row < 0 || row >= TOTAL_ROWS) return null;
    return { col, midi: rowToMidi(row) };
  }

  // ── 入力 ──

  /** @param {{type:string,localX:number,localY:number,deltaX?:number,deltaY?:number,ctrl?:boolean,shift?:boolean}} ev */
  handleInput(ev) {
    if (ev.type === "wheel") {
      if (ev.ctrl) return; // ズームは将来。Ctrl+ホイールはアプリへ透過される
      const dy = Math.sign(ev.deltaY || 0);
      const dx = Math.sign(ev.deltaX || 0);
      if (ev.shift) {
        if (dy) scrollBy(this.hScroll, dy * SCROLL_STEP);
      } else {
        if (dy) scrollBy(this.vScroll, dy * SCROLL_STEP);
        if (dx) scrollBy(this.hScroll, dx * SCROLL_STEP);
      }
      return;
    }

    if (ev.type === "down") {
      const cell = this._cellAt(ev.localX, ev.localY);
      if (!cell) {
        // 鍵盤列クリック → 試聴
        if (ev.localX < KEY_COL_W && ev.localY >= RULER_H) {
          const row = this.vScroll.offset + Math.floor((ev.localY - RULER_H) / ROW_H);
          if (row >= 0 && row < TOTAL_ROWS) this._audition(rowToMidi(row));
        }
        return;
      }
      const hit = this._noteAt(cell.col, cell.midi);
      if (hit) {
        this._active = hit;
        this._activeIsNew = false;
      } else {
        const n = { pitch: cell.midi, start: cell.col, len: 1 };
        this.notes.push(n);
        this._active = n;
        this._activeIsNew = true;
        this._audition(cell.midi);
      }
      this._dragged = false;
      this._downCol = cell.col;
      return;
    }

    if (ev.type === "held") {
      if (!this._active) return;
      const cell = this._cellAt(ev.localX, ev.localY);
      if (!cell) return;
      if (cell.col !== this._downCol) this._dragged = true;
      // 開始桁から現在桁までを長さに (端掴みではなく「どこまで伸ばすか」)
      this._active.len = Math.max(1, cell.col - this._active.start + 1);
      return;
    }

    if (ev.type === "up") {
      // 既存ノートを動かさずクリック = 削除 (トグル)
      if (this._active && !this._activeIsNew && !this._dragged) {
        this._remove(this._active);
      }
      this._active = null;
      this._activeIsNew = false;
      this._dragged = false;
      this._downCol = -1;
      return;
    }
  }

  // ── 描画 ──

  /**
   * @param {{x:number,y:number,w:number,h:number}} cr  グリッド用コンテンツ矩形 (絶対 VRAM 座標)
   * @param {object} [o]
   * @param {number} [o.playheadStep]  連続プレイヘッド位置 (ステップ)。-1 で非表示
   * @param {Set<number>} [o.playing]  現在発音中のピッチ集合 (反転で光らせる)
   */
  draw(cr, { playheadStep = -1, playing = null } = {}) {
    const gx0 = cr.x + KEY_COL_W;
    const gy0 = cr.y + RULER_H;
    const gw = cr.w - KEY_COL_W;
    const gh = cr.h - RULER_H;
    const cols = Math.max(0, Math.floor(gw / CELL_W));
    const rows = Math.max(0, Math.floor(gh / ROW_H));

    // スクロールバー用に viewport (行/桁数) を毎フレーム同期
    scrollSetViewport(this.vScroll, rows);
    scrollSetViewport(this.hScroll, cols);
    const sRow = this.vScroll.offset;
    const sCol = this.hScroll.offset;

    // 背景をペーパーで一旦クリア
    fillRect(cr.x, cr.y, cr.w, cr.h, 0);

    // ── グリッド本体 ──
    pushClip(gx0, gy0, gw, gh);
    // シャープ行のディザ帯 + オクターブ境界線
    for (let r = 0; r <= rows; r++) {
      const midi = rowToMidi(sRow + r);
      if (midi < 0 || midi > 127) continue;
      const y = gy0 + r * ROW_H;
      if (isSharp(midi)) drawCheckerboard(gx0, y, gw, ROW_H, 1);
      if (midi % 12 === 0) hline(gx0, gx0 + gw - 1, y, 1); // C 行上端 = オクターブ境界
    }
    // 縦線: 小節=実線 / 拍=点線
    for (let c = 0; c <= cols; c++) {
      const absCol = sCol + c;
      const x = gx0 + c * CELL_W;
      if (absCol % PIANO_ROLL_STEPS_PER_BAR === 0) {
        vline(x, gy0, gy0 + gh - 1, 1);
      } else if (absCol % PIANO_ROLL_STEPS_PER_BEAT === 0) {
        for (let y = gy0; y < gy0 + gh; y += 2) pset(x, y, 1); // 点線
      }
    }
    // ノート
    for (const n of this.notes) {
      const row = midiToRow(n.pitch);
      if (row < sRow - 1 || row > sRow + rows) continue;
      if (n.start + n.len <= sCol || n.start >= sCol + cols + 1) continue;
      const x = gx0 + (n.start - sCol) * CELL_W;
      const y = gy0 + (row - sRow) * ROW_H;
      const w = n.len * CELL_W;
      fillRect(x, y, w - 1, ROW_H - 1, 1);
      // 発音中なら反転で光らせる
      if (
        playing &&
        playing.has(n.pitch) &&
        playheadStep >= n.start &&
        playheadStep < n.start + n.len
      ) {
        invertRect(x, y, w - 1, ROW_H - 1);
      }
    }
    // プレイヘッド
    if (playheadStep >= 0) {
      const px = gx0 + Math.round((playheadStep - sCol) * CELL_W);
      if (px >= gx0 && px < gx0 + gw) invertRect(px, gy0, 1, gh);
    }
    popClip();

    // ── 左端ピアノ鍵盤列 ──
    pushClip(cr.x, gy0, KEY_COL_W, gh);
    fillRect(cr.x, gy0, KEY_COL_W, gh, 0);
    for (let r = 0; r <= rows; r++) {
      const midi = rowToMidi(sRow + r);
      if (midi < 0 || midi > 127) continue;
      const y = gy0 + r * ROW_H;
      if (isSharp(midi)) {
        fillRect(cr.x, y, KEY_COL_W - 1, ROW_H, 1); // 黒鍵 = 塗り帯
      } else if (midi % 12 === 0) {
        // C 行: オクターブ境界線 + "C{oct}" ラベル
        hline(cr.x, cr.x + KEY_COL_W - 1, y, 1);
        const oct = Math.floor(midi / 12) - 1;
        drawText(cr.x + 1, y + ((ROW_H - GLYPH_H) >> 1), "C" + oct, 1);
      }
    }
    vline(cr.x + KEY_COL_W - 1, gy0, gy0 + gh - 1, 1); // 列の右境界
    popClip();

    // ── 上端ルーラー (小節/拍) ──
    pushClip(cr.x, cr.y, cr.w, RULER_H);
    fillRect(cr.x, cr.y, cr.w, RULER_H, 0);
    for (let c = 0; c <= cols; c++) {
      const absCol = sCol + c;
      const x = gx0 + c * CELL_W;
      if (absCol % PIANO_ROLL_STEPS_PER_BAR === 0) {
        vline(x, cr.y + RULER_H - 3, cr.y + RULER_H - 1, 1);
        const bar = Math.floor(absCol / PIANO_ROLL_STEPS_PER_BAR) + 1;
        drawText(x + 1, cr.y + 1, String(bar), 1);
      } else if (absCol % PIANO_ROLL_STEPS_PER_BEAT === 0) {
        vline(x, cr.y + RULER_H - 2, cr.y + RULER_H - 1, 1);
      }
    }
    if (playheadStep >= 0) {
      const px = gx0 + Math.round((playheadStep - sCol) * CELL_W);
      if (px >= gx0 && px < cr.x + cr.w) invertRect(px, cr.y, 1, RULER_H);
    }
    hline(cr.x, cr.x + cr.w - 1, cr.y + RULER_H - 1, 1); // ルーラー下境界
    popClip();
  }
}
