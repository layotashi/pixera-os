/**
 * @module ui/music/Fader
 * Fader.js — 垂直フェーダー (音楽制作系ウィジェット)
 *
 * ハードウェア音楽機材のコンソール・フェーダーを 1-bit で再現した縦スライダー。
 * OS 標準の水平 Slider とは別カテゴリ (js/ui/music/) の音楽制作系ウィジェットで、
 * SYNTH / MIXER / SAMPLER / DAW など音を扱うアプリでのみ使う。
 *
 * 幅は固定 (FADER_W=25)、高さ h をアプリが指定する (= つまみの可動域)。
 * アプリは必要な本数を外枠 1px を共有させて横に並べ 1 つのフェーダー・バンクを作る
 * (バンクのピッチ = FADER_W-1。MIXER ならトラック数ぶん)。
 * フォーカス時のカギ括弧は自前枠と二重になるため抑止する。
 *
 * ── 見た目 (前景/背景を反転した配色。1px 単位の ASCII 仕様に一致) ──
 * 白鍵=背景・黒鍵=前景で描く鍵盤と並べたとき、溝とつまみは前景 (黒) の方が馴染む。
 * そこで枠は外形の境界として前景のまま据え置き、枠の内側に 1px の背景マージン環を取って
 * 地・溝・つまみが枠に接して角や辺が汚れないようにし、溝の内側とつまみを前景で塗る。
 * (市松は対称なので前景/背景を反転しても地の見えは変わらない)。
 *   枠        : 四辺 1px の実線ボーダー (隣接フェーダーと共有)
 *   マージン  : 枠の内側 1px の背景環。地・溝・つまみはこの内側にだけ描き枠に触れない
 *   地        : マージンの内側を市松テクスチャ ((lx+ly) が偶数のとき前景)
 *   グルーヴ  : 中央の縦溝。幅 5px = 壁1 + 溝3 + 壁1、上下に 1px キャップ。壁=背景・内側=前景
 *   つまみ    : 幅 21px (枠から左右 2px 内側) × 高さ 11px の横長キャップ。前景ベタ塗りで、
 *               上下端 1px と中央グリップ線 (19px) を背景で抜く。max で上端・min で下端側の
 *               マージンに密着し、現在値をグリップ線が指す。
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

/** フェーダーの固定幅 (px) — 枠1 + マージン1 + 内容21 + マージン1 + 枠1 */
export const FADER_W = 25;

/** 高さ (可動域) の推奨初期値 (px) — 四隅の市松位相を揃えるための奇数 */
export const FADER_DEFAULT_H = 71;

/** 隣接フェーダーの重なり (px)。外枠 1px を共有するのでピッチは FADER_W + FADER_GAP = 24。
 *  負値 = 重なり (共有)。単体フェーダーには影響しない。 */
export const FADER_GAP = -1;

/** 枠の内側に取る背景マージン環の厚み (px)。地・溝・つまみを枠から離し角/辺を綺麗に保つ */
const MARGIN = 1;
/** つまみの高さ (px): 背景端1 + 前景4 + グリップ線1 + 前景4 + 背景端1 = 11 */
const THUMB_H = 11;
/** つまみ上端 (背景端) からグリップ線 (中央) までの距離 (px) */
const THUMB_GRIP_OFFSET = 5;
/** グリップ線の左右インセット (px): 枠1 + マージン1 + つまみ内側1 */
const GRIP_INSET = 2 + MARGIN;
/** グルーヴの溝 (前景でくり抜く) 幅 (px) */
const GROOVE_HOLLOW_W = 3;
/** グルーヴの左右壁の厚み (px) */
const GROOVE_WALL_W = 1;
/** グルーヴ全体の幅 (px) = 壁1 + 溝3 + 壁1 */
const GROOVE_W = GROOVE_HOLLOW_W + GROOVE_WALL_W * 2;
/** グルーヴ端キャップの厚み (px) */
const GROOVE_CAP_H = 1;
/** フェーダー端からグルーヴ端キャップまでの距離 (px)。max 時のグリップ線の 1px 手前 */
const GROOVE_END_MARGIN = THUMB_GRIP_OFFSET - 1 + MARGIN;

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
   * 描画・可動域に使う実効高さ (奇数)。四隅の市松位相を揃えるため、偶数高は 1px 縮める。
   * 奇数高なら上端基準の連続した市松で四隅の位相が必ず揃い、継ぎ目もできない。
   * @private
   */
  _effH() {
    return this.h & 1 ? this.h : this.h - 1;
  }

  /**
   * グリップ線 (現在値) が動く範囲をローカル座標で返す。
   * travelTop = max 位置 (つまみが上端マージンに密着)、travelBottom = min 位置 (下端マージン)。
   * つまみは枠の内側マージンぶん (MARGIN) 内に収まるので上下端とも 1px 内側で止まる。
   * @private
   */
  _travel() {
    const h = this._effH();
    const travelTop = this.y + MARGIN + THUMB_GRIP_OFFSET;
    const travelBottom = this.y + h - MARGIN - THUMB_H + THUMB_GRIP_OFFSET;
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
    const h = this._effH(); // 奇数化 (四隅の市松位相を揃えるため。偶数は 1px 縮む)

    // 1) 四辺 1px の枠 + 内側の市松 (地)。枠と地の間に MARGIN の背景環を取り、市松を枠から
    //    離して角/辺が汚れないようにする。phase=0 で内側原点 (四隅) = 前景に揃い、奇数高なら
    //    四隅の位相が必ず一致し継ぎ目もできない。地の背景はウィンドウ地 (描かず素通し)。
    drawRect(ax, ay, w, h, 1);
    drawCheckerboard(
      ax + 1 + MARGIN,
      ay + 1 + MARGIN,
      w - 2 - 2 * MARGIN,
      h - 2 - 2 * MARGIN,
      1,
      0,
    );

    // 2) 縦グルーヴ (中央) — 反転配色: 背景の壁で縁取り、内側を前景でくり抜いて溝を暗く沈める。
    //    上下 1px キャップを残す。黒く沈んだ溝が白鍵/黒鍵の並びと調和する。
    const gx = ax + ((w - GROOVE_W) >> 1);
    const gTop = ay + GROOVE_END_MARGIN;
    const gH = h - GROOVE_END_MARGIN * 2;
    if (gH > GROOVE_CAP_H * 2) {
      fillRect(gx, gTop, GROOVE_W, gH, 0);
      fillRect(
        gx + GROOVE_WALL_W,
        gTop + GROOVE_CAP_H,
        GROOVE_HOLLOW_W,
        gH - GROOVE_CAP_H * 2,
        1,
      );
    }

    // 3) つまみ — 反転配色: 幅 21px (枠から左右 MARGIN 内側) の前景ベタ塗りキャップ。上下端 1px と
    //    中央グリップ線を背景で抜いて溝から浮かせる。max で上端マージン・min で下端マージンに密着。
    const range = this.max - this.min;
    const ratio = range > 0 ? (this.value - this.min) / range : 0;
    const travel = h - 2 * MARGIN - THUMB_H;
    const thumbTop = ay + MARGIN + Math.round((1 - ratio) * travel);
    const tx = ax + 1 + MARGIN; // 枠から MARGIN 内側
    const tw = w - 2 - 2 * MARGIN; // 21
    fillRect(tx, thumbTop, tw, THUMB_H, 0); // 下地を背景で消す (上下端の 1px も背景に)
    fillRect(tx, thumbTop + 1, tw, THUMB_H - 2, 1); // 前景ベタのキャップ本体 (上下 1px 内側)
    hline(ax + GRIP_INSET, ax + w - 1 - GRIP_INSET, thumbTop + THUMB_GRIP_OFFSET, 0); // 中央グリップ線
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
