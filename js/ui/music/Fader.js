/**
 * @module ui/music/Fader
 * Fader.js — 垂直フェーダー (音楽制作系ウィジェット)
 *
 * ハードウェア音楽機材のコンソール・フェーダーを 1-bit で再現した縦スライダー。
 * OS 標準の水平 Slider とは別カテゴリ (js/ui/music/) の音楽制作系ウィジェットで、
 * SYNTH / MIXER / SAMPLER / DAW など音を扱うアプリでのみ使う。
 *
 * 幅は固定 (FADER_W=23)、高さ h をアプリが指定する (= つまみの可動域)。
 * アプリは必要な本数を 1px 間隔で横に並べて 1 つのフェーダー・バンクを作る
 * (MIXER ならトラック数ぶん)。フォーカス時のカギ括弧は自前枠と二重になるため抑止する。
 *
 * ── 見た目 (ASCII 仕様の実測に一致) ──
 *   枠      : 四辺 1px の実線ボーダー
 *   地      : 枠の内側を市松テクスチャ ((lx+ly) が奇数のとき前景)
 *   グルーヴ : 中央の縦溝。幅 5px = 壁1 + 溝3 + 壁1、上下に 1px キャップ
 *   つまみ   : 全幅 × 高さ 11px の横長キャップ。中央グリップ線 (19px, 左右 2px 内側) が
 *             現在値を指す。max で上端・min で下端に密着する。
 *
 * 操作は水平 Slider と対称:
 *   上下ドラッグで値 (上端 = max)、Shift+ドラッグで微調整、ホイールで増減、
 *   ダブルクリックでデフォルト値、フォーカス中 ↑/↓ で最小ステップ増減。
 */

import { FocusableWidget } from "../FocusableWidget.js";
import {
  fillRect,
  drawRect,
  drawCheckerboard,
  hline,
} from "../ports.js";
import { tickRepeat } from "../ui_helpers.js";

/** フェーダーの固定幅 (px) — ASCII 仕様の 1 セル幅 */
export const FADER_W = 23;

/** 高さ (可動域) の推奨初期値 (px) */
export const FADER_DEFAULT_H = 44;

/** 隣接フェーダー間の間隔 (px) — バンク化するときのピッチは FADER_W + FADER_GAP */
export const FADER_GAP = 1;

/** つまみの高さ (px): 枠1 + 余白4 + グリップ線1 + 余白4 + 枠1 = 11 */
const THUMB_H = 11;
/** つまみ上端からグリップ線 (中央) までの距離 (px) */
const THUMB_GRIP_OFFSET = 5;
/** グリップ線の左右インセット (px): 枠1 + 余白1 */
const GRIP_INSET = 2;
/** グルーヴの溝 (背景でくり抜く) 幅 (px) */
const GROOVE_HOLLOW_W = 3;
/** グルーヴの左右壁の厚み (px) */
const GROOVE_WALL_W = 1;
/** グルーヴ全体の幅 (px) = 壁1 + 溝3 + 壁1 */
const GROOVE_W = GROOVE_HOLLOW_W + GROOVE_WALL_W * 2;
/** グルーヴ端キャップの厚み (px) */
const GROOVE_CAP_H = 1;
/** フェーダー端からグルーヴ端キャップまでの距離 (px)。max 時のグリップ線の 1px 手前 */
const GROOVE_END_MARGIN = THUMB_GRIP_OFFSET - 1;

export class Fader extends FocusableWidget {
  /**
   * @param {number} x  コンテンツ領域内の X
   * @param {number} y  コンテンツ領域内の Y
   * @param {number} h  高さ (px) — つまみの可動域。幅は FADER_W 固定
   * @param {number} min 最小値
   * @param {number} max 最大値
   * @param {number} value 初期値
   * @param {function} [onChange] 値変更コールバック (newValue) => void
   */
  constructor(x, y, h, min, max, value, onChange) {
    super(x, y, FADER_W, h);
    this.min = min;
    this.max = max;
    this.value = Math.max(min, Math.min(max, value));
    this.defaultValue = this.value;
    this.dragging = false;
    this.onChange = onChange || null;
    /** @type {number|null} ホイール操作のステップ量 (null=自動) */
    this.wheelStep = null;
    /** @private 整数モードか (min/max がともに整数) */
    this._isInt = Number.isInteger(min) && Number.isInteger(max);
    /** @private */
    this.dragShift = false;
    /** @private */
    this.dragStartY = 0;
    /** @private */
    this.dragStartVal = 0;
  }

  /** @override — 幅は固定 (FADER_W)、高さはアプリが指定するため不変 */
  remeasure() {
    this.w = FADER_W;
  }

  /**
   * 値をクランプ・丸め・比較し、変化があればセット＋コールバックを呼ぶ。
   * @param {number} raw 設定したい生の値
   * @returns {boolean} 値が変化したら true
   * @private
   */
  _setValue(raw) {
    const clamped = Math.max(this.min, Math.min(this.max, raw));
    const v = this._isInt ? Math.round(clamped) : clamped;
    if (v === this.value) return false;
    this.value = v;
    if (this.onChange) this.onChange(v);
    return true;
  }

  /**
   * グリップ線 (現在値) が動く範囲をローカル座標で返す。
   * travelTop = max 位置 (つまみ上端密着)、travelBottom = min 位置 (下端密着)。
   * @private
   */
  _travel() {
    const travelTop = this.y + THUMB_GRIP_OFFSET;
    const travelBottom = this.y + this.h - 1 - (THUMB_H - 1 - THUMB_GRIP_OFFSET);
    return { travelTop, travelBottom };
  }

  /** @override */
  get cursorName() {
    return "drag-v";
  }

  /** @override */
  get isActive() {
    return this.dragging;
  }

  /** @override — 自前で枠を描くのでフォーカスのカギ括弧は抑止 (二重枠回避) */
  get noFocusBracket() {
    return true;
  }

  /** @override */
  resetDragState() {
    this.dragging = false;
  }

  /** @override */
  draw(cr) {
    const ax = cr.x + this.x;
    const ay = cr.y + this.y;
    const w = FADER_W;
    const h = this.h;

    // 1) 四辺 1px の枠 + 内側の市松 (地)。位相 1 で内側原点を背景にし角を ASCII に合わせる
    drawRect(ax, ay, w, h, 1);
    drawCheckerboard(ax + 1, ay + 1, w - 2, h - 2, 1, 1);

    // 2) 縦グルーヴ (中央) — 実線スロットの内側を背景でくり抜き、上下 1px キャップを残す
    const gx = ax + ((w - GROOVE_W) >> 1);
    const gTop = ay + GROOVE_END_MARGIN;
    const gH = h - GROOVE_END_MARGIN * 2;
    if (gH > GROOVE_CAP_H * 2) {
      fillRect(gx, gTop, GROOVE_W, gH, 1);
      fillRect(
        gx + GROOVE_WALL_W,
        gTop + GROOVE_CAP_H,
        GROOVE_HOLLOW_W,
        gH - GROOVE_CAP_H * 2,
        0,
      );
    }

    // 3) つまみ — max で上端・min で下端に密着 (thumbTop ∈ [0, h-11])
    const range = this.max - this.min;
    const ratio = range > 0 ? (this.value - this.min) / range : 0;
    const thumbTop = ay + Math.round((1 - ratio) * (h - THUMB_H));
    fillRect(ax, thumbTop, w, THUMB_H, 0); // 下地 (枠・市松・溝) を消す
    drawRect(ax, thumbTop, w, THUMB_H, 1); // つまみ枠
    hline(ax + GRIP_INSET, ax + w - 1 - GRIP_INSET, thumbTop + THUMB_GRIP_OFFSET, 1); // 中央グリップ線
  }

  /** @override */
  update(ev) {
    const hit = this.hitTest(ev.localX, ev.localY);

    if (ev.type === "down" && hit) {
      this.dragging = true;
      this.dragShift = !!ev.shift;
      this.dragStartY = ev.localY;
      this.dragStartVal = this.value;
    }

    if (this.dragging && (ev.type === "down" || ev.type === "held")) {
      const { travelTop, travelBottom } = this._travel();
      const travelLen = travelBottom - travelTop;
      if (travelLen <= 0) return;
      if (this.dragShift || ev.shift) {
        // Shift+ドラッグ: 微調整 (上 = 増加)
        const dy = ev.localY - this.dragStartY;
        const pxPerStep = 4;
        const step = this._isInt
          ? 1 / pxPerStep
          : (this.max - this.min) / (travelLen * 10);
        this._setValue(this.dragStartVal - dy * step);
      } else {
        // 通常ドラッグ: グリップ線をカーソル位置に置く (上 = max)
        const ratio = Math.max(
          0,
          Math.min(1, (travelBottom - ev.localY) / travelLen),
        );
        this._setValue(this.min + ratio * (this.max - this.min));
      }
    }

    if (ev.type === "up") {
      this.dragging = false;
    }

    // ダブルクリック: デフォルト値にリセット
    if (ev.type === "dblclick" && hit) {
      this.dragging = false;
      if (this.defaultValue != null) {
        this._setValue(this.defaultValue);
      }
    }

    // ホイール: ホバー中のフェーダーの値を増減 (上 = 増加)
    if (ev.type === "wheel" && hit) {
      const range = this.max - this.min;
      const step =
        this.wheelStep != null
          ? this.wheelStep
          : this._isInt
            ? Math.max(1, (range * 0.05) | 0)
            : range * 0.05;
      const dir = ev.deltaY > 0 ? -1 : 1;
      this._setValue(this.value + dir * step);
      ev.consumed = true;
    }
  }

  /** @override — ↑/↓ で最小ステップ増減 (リピート+加速) */
  handleKey() {
    let dir = 0;
    if (tickRepeat("ArrowUp", true)) dir = +1;
    else if (tickRepeat("ArrowDown", true)) dir = -1;
    if (dir !== 0) {
      const step = this._isInt ? 1 : (this.max - this.min) / this.h;
      this._setValue(this.value + dir * step);
      return true;
    }
    return false;
  }
}
