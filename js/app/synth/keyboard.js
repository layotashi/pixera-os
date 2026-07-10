/**
 * @module app/synth/keyboard
 * keyboard.js — SYNTH のオンスクリーン鍵盤 (演奏用ウィジェット)
 *
 * 1-bit のピアノ鍵盤。全ての線を 1px に統一し、各鍵は「枠 → 背景余白 1px → 塗り領域」で
 * 構成する。この 1px の背景余白が、押下した白鍵の塗りが隣の黒鍵と融合して見えるのを防ぐ。
 *
 * ── 塗り領域 (押下で見た目が変わる部分) ──
 *   鍵の形状を 1px 収縮 (erosion) した領域。白鍵は黒鍵の切り欠きを持つ L 字型で、
 *   内側コーナーも含め枠から 1px 内側に収まる。押下表示は市松模様:
 *     白鍵: 背景 → 市松    黒鍵: 前景(塗り) → 市松
 *   マウスのクリック・ドラッグで演奏でき、押下状態は PolySynth を単一の真実として
 *   `isHeld(midi)` から取得する (PC 鍵盤・MIDI 由来の押下も点灯する)。
 *
 * 幾何 (枠/余白/塗り) は寸法から一度だけ算出してグリッドにキャッシュし、毎フレームは
 * 押下状態だけで描き分ける。表示範囲は `startMidi`(基準 C) から白鍵 `numWhite` 個ぶん。
 */

import { fillRect, pset } from "../../core/gpu.js";
import { Widget } from "../../ui/index.js";

/** オクターブ内の白鍵の半音オフセット (C D E F G A B) */
const WHITE_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
/** その白鍵の直後 (右) に黒鍵があるか (E=2 と B=6 の後には無い) */
const HAS_BLACK_AFTER = new Set([0, 1, 3, 4, 5]);

/** 黒鍵の幅 (px)。**奇数**にすることで中心が 1px の仕切り線と正確に一致する */
const BLACK_W = 9;
/** 黒鍵の高さ (鍵盤高さに対する比) */
const BLACK_H_RATIO = 0.6;

/** ピクセル分類 */
const CLS_BG = 0; // 背景 / 余白
const CLS_BORDER = 1; // 枠線 (前景)
const CLS_WHITE_FILL = 2; // 白鍵の塗り領域
const CLS_BLACK_FILL = 3; // 黒鍵の塗り領域

export class Keyboard extends Widget {
  /**
   * @param {number} whiteW  白鍵のピッチ (px。隣接する仕切り線の間隔)
   * @param {number} keyH     鍵盤の高さ (px)
   * @param {number} numWhite 表示する白鍵の数
   * @param {{ onNoteOn:(m:number)=>void, onNoteOff:(m:number)=>void, isHeld:(m:number)=>boolean }} cbs
   */
  constructor(whiteW, keyH, numWhite, cbs) {
    // 仕切りを共有するので幅は numWhite*whiteW + 1 (末尾の仕切り 1px 分)
    super(0, 0, whiteW * numWhite + 1, keyH);
    this.whiteW = whiteW;
    this.numWhite = numWhite;
    /** 表示範囲の基準 MIDI (白鍵 0 = この C)。アプリが更新する */
    this.startMidi = 60;
    this.onNoteOn = cbs.onNoteOn;
    this.onNoteOff = cbs.onNoteOff;
    this.isHeld = cbs.isHeld;
    /** マウスで発音中のノート (-1 = なし) */
    this._mouseNote = -1;
    /** @private 幾何グリッドのキャッシュキー */
    this._gridKey = "";
  }

  /** 白鍵インデックス k の MIDI */
  _whiteMidi(k) {
    return this.startMidi + ((k / 7) | 0) * 12 + WHITE_SEMITONES[k % 7];
  }
  /** 黒鍵 (白鍵 k の右) の MIDI */
  _blackMidi(k) {
    return this.startMidi + ((k / 7) | 0) * 12 + WHITE_SEMITONES[k % 7] + 1;
  }

  /**
   * 寸法から幾何 (各ピクセルの分類 + 所属鍵) を一度だけ算出してキャッシュする。
   * startMidi (オクターブ) には依存しない (発音判定は描画時に別途行う)。
   */
  _ensureGrid() {
    const w = this.w;
    const h = this.h;
    const wp = this.whiteW;
    const n = this.numWhite;
    const key = `${w}x${h}x${wp}x${n}`;
    if (this._gridKey === key) return;
    this._gridKey = key;

    const blackH = Math.round(h * BLACK_H_RATIO);
    const bh = BLACK_W >> 1;
    this._blackH = blackH;
    this._bh = bh;

    // 黒鍵リスト { kWhite: 左の白鍵, dx: 仕切り X }
    const blacks = [];
    for (let k = 0; k < n - 1; k++) {
      if (HAS_BLACK_AFTER.has(k % 7)) blacks.push({ kWhite: k, dx: (k + 1) * wp });
    }
    this._blackList = blacks;

    // ── 枠線判定 ──
    const isBorder = (rx, ry) => {
      if (rx === 0 || rx === w - 1 || ry === 0 || ry === h - 1) return true; // 外枠
      for (let j = 0; j < blacks.length; j++) {
        const d = blacks[j].dx;
        if (ry <= blackH - 1 && (rx === d - bh || rx === d + bh)) return true; // 黒鍵の左右
        if (ry === blackH - 1 && rx >= d - bh && rx <= d + bh) return true; // 黒鍵の下辺
      }
      if (rx % wp === 0) {
        const i = rx / wp;
        if (i >= 1 && i <= n - 1) {
          // 黒鍵のある仕切りは下部のみ。無い仕切り (E-F, B-C) は全高。
          if (HAS_BLACK_AFTER.has((i - 1) % 7)) {
            if (ry >= blackH - 1) return true;
          } else {
            return true;
          }
        }
      }
      return false;
    };

    // ── 黒鍵の所属 (ある座標が黒鍵本体か。ならその黒鍵リスト添字) ──
    const blackAt = (rx, ry) => {
      if (ry > blackH - 1) return -1;
      for (let j = 0; j < blacks.length; j++) {
        const d = blacks[j].dx;
        if (rx >= d - bh && rx <= d + bh) return j;
      }
      return -1;
    };

    // ── 枠グリッド → 塗りグリッド (枠でなく 8 近傍が全て枠でない = 1px 収縮) ──
    const border = new Uint8Array(w * h);
    for (let ry = 0; ry < h; ry++) {
      for (let rx = 0; rx < w; rx++) border[ry * w + rx] = isBorder(rx, ry) ? 1 : 0;
    }
    const cls = new Uint8Array(w * h);
    const keyof = new Int16Array(w * h);
    for (let ry = 0; ry < h; ry++) {
      for (let rx = 0; rx < w; rx++) {
        const idx = ry * w + rx;
        if (border[idx]) {
          cls[idx] = CLS_BORDER;
          continue;
        }
        let fill = true;
        for (let dy = -1; dy <= 1 && fill; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = rx + dx;
            const ny = ry + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h || border[ny * w + nx]) {
              fill = false;
              break;
            }
          }
        }
        if (!fill) continue; // 余白 (CLS_BG)
        const bj = blackAt(rx, ry);
        if (bj >= 0) {
          cls[idx] = CLS_BLACK_FILL;
          keyof[idx] = bj;
        } else {
          let wk = (rx / wp) | 0;
          if (wk >= n) wk = n - 1;
          cls[idx] = CLS_WHITE_FILL;
          keyof[idx] = wk;
        }
      }
    }
    this._cls = cls;
    this._keyof = keyof;
  }

  /** @override */
  draw(contentRect) {
    this._ensureGrid();
    const w = this.w;
    const h = this.h;
    const ox = contentRect.x + this.x;
    const oy = contentRect.y + this.y;
    const cls = this._cls;
    const keyof = this._keyof;
    const held = this.isHeld;

    // 各鍵の押下状態を先に確定 (ピクセルごとの再計算を避ける)
    const wPressed = new Uint8Array(this.numWhite);
    if (held) {
      for (let k = 0; k < this.numWhite; k++) wPressed[k] = held(this._whiteMidi(k)) ? 1 : 0;
    }
    const bList = this._blackList;
    const bPressed = new Uint8Array(bList.length);
    if (held) {
      for (let j = 0; j < bList.length; j++) bPressed[j] = held(this._blackMidi(bList[j].kWhite)) ? 1 : 0;
    }

    fillRect(ox, oy, w, h, 0); // 背景で初期化

    // 市松模様は鍵盤ローカル座標 (rx, ry) の偶奇で決める。絶対座標だとウィンドウ位置で
    // 位相がずれて角の見え方が変わるため。偶数パリティを前景色にすると、塗り領域の角
    // (rx/ry とも偶数から始まる) が前景色に落ち、余白の角が綺麗に見える。
    for (let ry = 0; ry < h; ry++) {
      const ay = oy + ry;
      const base = ry * w;
      for (let rx = 0; rx < w; rx++) {
        const c = cls[base + rx];
        if (c === CLS_BG) continue;
        const ax = ox + rx;
        const checkerOn = ((rx + ry) & 1) === 0;
        if (c === CLS_BORDER) {
          pset(ax, ay, 1);
        } else if (c === CLS_WHITE_FILL) {
          // 未押下: 背景 (何もしない) / 押下: 市松
          if (wPressed[keyof[base + rx]] && checkerOn) pset(ax, ay, 1);
        } else {
          // 黒鍵 — 未押下: 塗り / 押下: 市松
          if (bPressed[keyof[base + rx]]) {
            if (checkerOn) pset(ax, ay, 1);
          } else {
            pset(ax, ay, 1);
          }
        }
      }
    }
  }

  /** ローカル座標のキー (黒鍵優先) の MIDI を返す。無ければ -1 */
  _hitKey(px, py) {
    this._ensureGrid();
    const rx = px - this.x;
    const ry = py - this.y;
    const bh = this._bh;
    const blackH = this._blackH;
    for (const b of this._blackList) {
      if (rx >= b.dx - bh && rx <= b.dx + bh && ry >= 0 && ry < blackH) {
        return this._blackMidi(b.kWhite);
      }
    }
    if (ry >= 0 && ry < this.h) {
      const total = this.numWhite * this.whiteW;
      if (rx >= 0 && rx <= total) {
        let k = (rx / this.whiteW) | 0;
        if (k >= this.numWhite) k = this.numWhite - 1;
        return this._whiteMidi(k);
      }
    }
    return -1;
  }

  /** @override */
  update(ev) {
    if (ev.type === "down") {
      const m = this._hitKey(ev.localX, ev.localY);
      if (m >= 0) {
        this._mouseNote = m;
        if (this.onNoteOn) this.onNoteOn(m);
      }
    } else if (ev.type === "held" && this._mouseNote >= 0) {
      // ドラッグでキー間を移動 → グリッサンド
      const m = this._hitKey(ev.localX, ev.localY);
      if (m >= 0 && m !== this._mouseNote) {
        if (this.onNoteOff) this.onNoteOff(this._mouseNote);
        if (this.onNoteOn) this.onNoteOn(m);
        this._mouseNote = m;
      }
    } else if (ev.type === "up" && this._mouseNote >= 0) {
      if (this.onNoteOff) this.onNoteOff(this._mouseNote);
      this._mouseNote = -1;
    }
  }

  /** @override */
  get cursorName() {
    return "pointer";
  }

  /** マウス発音状態をリセットする (ウィンドウを閉じるとき) */
  reset() {
    this._mouseNote = -1;
  }
}
