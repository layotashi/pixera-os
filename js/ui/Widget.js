/**
 * @module ui/Widget
 * Widget.js — ウィジェット基底クラス
 *
 * すべてのウィジェットの共通インターフェースを定義する。
 * サブクラスは draw() / update() をオーバーライドして固有の描画・入力処理を実装する。
 *
 * ── プロパティ ──
 *   x, y       : コンテンツ領域内のローカル座標
 *   w, h       : サイズ (px)
 *   visible    : 描画・入力処理を行うか
 *   tooltip    : ホバー時のツールチップテキスト (null で非表示)
 *
 * ── サブクラスでオーバーライド可能なメソッド / アクセサ ──
 *   draw(contentRect)   : 描画
 *   update(ev)        : 入力処理
 *   clearSelection()  : フォーカス喪失時の選択クリア
 *   resetDragState()  : ドラッグ状態のリセット (mousedown 時)
 *   handleKey()       : フォーカス中のキーボード入力 (FocusableWidget)
 *   focusable         : フォーカス可能か (getter)
 *   cursorName        : ホバー/操作時のカーソル名 (getter)
 *   isTextInput       : テキスト入力系か (getter)
 *   isActive          : 操作中か — ドラッグ/プレス (getter)
 *   hasPopup          : ポップアップを持つか (getter)
 */

export class Widget {
  /**
   * @param {number} x コンテンツ領域内の X 座標
   * @param {number} y コンテンツ領域内の Y 座標
   * @param {number} w 幅 (px)
   * @param {number} h 高さ (px)
   */
  constructor(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;

    /** 表示・更新の有効/無効 */
    this.visible = true;

    /** ホバー時ツールチップ (null=非表示) */
    this.tooltip = null;
  }

  // ── ライフサイクルメソッド ──

  /**
   * フォント/アイコンサイズ変更後に w, h を再計算する。
   * サブクラスはコンストラクタと同じロジックで w/h をセットし直す。
   * 呼出時点で GLYPH_W/GLYPH_H/ICON_W/ICON_H および
   * _computeDerivedConstants() は更新済みであることが前提。
   * デフォルト実装は何もしない (BayerPicker, HSep, VSep 等)。
   */
  remeasure() {}

  /**
   * ウィジェットを描画する。
   * @param {{ x: number, y: number }} contentRect コンテンツ領域のオフセット
   */
  draw(contentRect) {}

  /**
   * 入力イベントを処理する。
   * @param {{ localX: number, localY: number, type: string }} ev
   */
  update(ev) {}

  // ── ヒットテスト ──

  /**
   * ローカル座標がウィジェット矩形内にあるか判定する。
   * @param {number} localX ローカル X
   * @param {number} localY ローカル Y
   * @returns {boolean}
   */
  hitTest(localX, localY) {
    return (
      localX >= this.x &&
      localX < this.x + this.w &&
      localY >= this.y &&
      localY < this.y + this.h
    );
  }

  // ── オーバーライド可能なフック ──

  /** フォーカス喪失時に選択状態をクリアする (テキスト入力でオーバーライド) */
  clearSelection() {}

  /** ドラッグ状態をリセットする (mousedown 時に全ウィジェットに対して呼ばれる) */
  resetDragState() {}

  // ── 機能フラグ (アクセサ) ──

  /** フォーカス可能か */
  get focusable() {
    return false;
  }

  /** ホバー/操作時のカーソル名 (null = デフォルトカーソル) */
  get cursorName() {
    return null;
  }

  /** テキスト入力系ウィジェットか */
  get isTextInput() {
    return false;
  }

  /** ドラッグ/プレス等で操作中か (カーソル維持判定用) */
  get isActive() {
    return false;
  }

  /** ポップアップ描画を持つか */
  get hasPopup() {
    return false;
  }

  /**
   * フォーカス時の四隅カギ括弧インジケータを抑止するか。
   * 自前で枠を描くウィジェット (例: 音楽系フェーダー) は true を返して二重枠を避ける。
   */
  get noFocusBracket() {
    return false;
  }
}

