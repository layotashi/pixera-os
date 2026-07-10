/**
 * @module app/synth/keyboard
 * keyboard.js — SYNTH のオンスクリーン鍵盤 (演奏用ウィジェット)
 *
 * 1-bit のピアノ鍵盤。全ての線を 1px 幅に統一する: 白鍵は外枠 + 内部の縦仕切りを
 * 隣接キーで共有し、二重線 (2px) にならないようにする。黒鍵は塗りで、押下中のノートは
 * 反転で強調する (白鍵→内側を塗り / 黒鍵→中抜き)。マウスでクリック・ドラッグ演奏でき、
 * 押下状態は PolySynth を単一の真実として `isHeld(midi)` から取得する
 * (PC 鍵盤の押下も点灯する)。
 *
 * 表示範囲は `startMidi`(基準 C) から白鍵 `numWhite` 個ぶん。アプリが毎フレーム startMidi
 * を更新する (オクターブ切替)。
 */

import { drawRect, fillRect, hline, vline } from "../../core/gpu.js";
import { Widget } from "../../ui/index.js";

/** オクターブ内の白鍵の半音オフセット (C D E F G A B) */
const WHITE_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
/** その白鍵の直後に黒鍵があるか (E=2 と B=6 の後には無い) */
const HAS_BLACK_AFTER = new Set([0, 1, 3, 4, 5]);

/**
 * 黒鍵の幅 (px)。**奇数**にすることで中心が 1px の仕切り線と正確に一致する
 * (偶数だと中心が画素間に落ちて半 px ずれる)。x = 仕切り − (BLACK_W>>1) で中央配置。
 */
const BLACK_W = 9;

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
  }

  get _blackH() {
    return (this.h * 0.6) | 0;
  }

  /** 白鍵インデックス k の MIDI */
  _whiteMidi(k) {
    const oct = (k / 7) | 0;
    return this.startMidi + oct * 12 + WHITE_SEMITONES[(k % 7)];
  }

  /** 黒鍵の { midi, x(相対) } を列挙する (白鍵の仕切りの中央に配置) */
  _blacks() {
    const out = [];
    for (let k = 0; k < this.numWhite - 1; k++) {
      const wi = k % 7;
      if (!HAS_BLACK_AFTER.has(wi)) continue;
      const oct = (k / 7) | 0;
      const divider = this.x + (k + 1) * this.whiteW;
      out.push({
        midi: this.startMidi + oct * 12 + WHITE_SEMITONES[wi] + 1,
        x: divider - (BLACK_W >> 1),
      });
    }
    return out;
  }

  /** @override */
  draw(contentRect) {
    const ox0 = contentRect.x + this.x;
    const oy = contentRect.y + this.y;
    const wp = this.whiteW;
    const n = this.numWhite;
    const h = this.h;
    const right = ox0 + n * wp; // 末尾の仕切り
    const held = this.isHeld;

    // ── 押下白鍵の内側塗り (仕切り・外枠より先に。後で線を上描きして 1px を保つ) ──
    for (let k = 0; k < n; k++) {
      if (held && held(this._whiteMidi(k))) {
        fillRect(ox0 + k * wp + 1, oy + 1, wp - 1, h - 2, 1);
      }
    }

    // ── 外枠 + 共有縦仕切り (全て 1px) ──
    hline(ox0, right, oy, 1);
    hline(ox0, right, oy + h - 1, 1);
    for (let i = 0; i <= n; i++) {
      vline(ox0 + i * wp, oy, oy + h - 1, 1);
    }

    // ── 黒鍵 (塗り。押下は中抜きに反転) ──
    const bh = this._blackH;
    for (const b of this._blacks()) {
      const ox = contentRect.x + b.x;
      if (held && held(b.midi)) {
        fillRect(ox, oy, BLACK_W, bh, 0); // 一旦消して
        drawRect(ox, oy, BLACK_W, bh, 1); // 中抜き枠
      } else {
        fillRect(ox, oy, BLACK_W, bh, 1);
      }
    }
  }

  /** ローカル座標のキー (黒鍵優先) の MIDI を返す。無ければ -1 */
  _hitKey(px, py) {
    const bh = this._blackH;
    for (const b of this._blacks()) {
      if (px >= b.x && px < b.x + BLACK_W && py >= this.y && py < this.y + bh) {
        return b.midi;
      }
    }
    if (py >= this.y && py < this.y + this.h) {
      const rel = px - this.x;
      const total = this.numWhite * this.whiteW;
      if (rel >= 0 && rel <= total) {
        let k = (rel / this.whiteW) | 0;
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
