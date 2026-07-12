/**
 * @module app/roll/roll
 * roll.js — ROLL ウィンドウ (ステップグリッド MIDI エディタ)
 *
 * 最小構成からの再出発。ボディには表を 1 枚だけ描く:
 *   横 16 列 = 1 小節を 16 分音符で分割したステップ。
 *   縦 12 行 = 1 オクターブを構成する 12 音。
 *   計 192 セル。ノートは開始セル (col,row) と長さ len (セル数) を持つ。
 *
 * ── 罫線 ──
 *   小節の境界線 (左右端) と、オクターブ境界 (B と C の間 = 上下端) は 2px 実線。
 *   それ以外の内側の罫線は 1px 実線。罫線の太さはセル内寸に含めない。
 *
 * ── ノート ──
 *   寸法 = セル内寸 (span) から上下左右 1px ずつ内側。
 *   非選択 = 1px 黒枠 + 黒塗り (実質べた塗り)。選択 = 1px 黒枠 + 白塗り。
 *   移動中はゴースト (非選択と同じ外観) を移動先に表示する。
 *
 * ── 操作 (ABOUT パネルにも記載。実装済みのもののみ) ──
 *   ダブルクリック(空)  … ノート配置 (配置直後は選択状態・排他)。
 *   ダブルクリック(ノート)… 削除。
 *   クリック            … 単一選択 (空セルは選択解除)。
 *   Ctrl+クリック       … 選択トグル (複数選択)。
 *   ドラッグ            … ノートを別セルへ移動。
 *   Ctrl+ホイール       … セル高さのズーム。Shift+Ctrl+ホイール … セル幅のズーム。
 *   Ctrl+A / Esc        … 全選択 / 全解除。
 *   Shift+← / Shift+→   … 選択ノートを 1 セル短縮 / 伸長 (最小 1 セル・上限なし)。
 *
 * 音名・小節番号・鍵盤・再生は、この段階では未実装。
 * ノートモデルや再生ロジックは grid.js に温存 (このウィンドウからは未接続) してある。
 */

import { fillRect } from "../../core/gpu.js";
import { wmOpen, wmRegister, wmIsFocused } from "../../wm/index.js";
import { keyDown, keyHeld, ctrlDown } from "../../core/input.js";

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

/** ノート一覧。@type {{col:number,row:number,len:number,selected:boolean}[]} */
let notes = [];

/** ドラッグ移動の状態。@type {{note:object,startCol:number,startRow:number,targetCol:number,targetRow:number}|null} */
let drag = null;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  寸法 / 座標 (コンテンツ空間。原点 = 表の左上)
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

/** 列 c のセル内寸・左端 X (コンテンツ空間)。c > COLS-1 は同じ規則で外挿する */
function colInnerX(c) {
  let x = 0;
  for (let i = 0; i < c; i++) x += vThick(i) + cellW;
  return x + vThick(c);
}
/** 行 r のセル内寸・上端 Y (コンテンツ空間) */
function rowInnerY(r) {
  let y = 0;
  for (let i = 0; i < r; i++) y += hThick(i) + cellH;
  return y + hThick(r);
}

/**
 * コンテンツ空間の点 → セル (col,row)。境界線 + その手前のセル内寸を 1 つのスロット
 * とみなし、当たり判定に隙間を作らない。末尾の閉じ罫線より外は null。
 */
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
  let row = -1;
  for (let r = 0, y = 0; r < ROWS; r++) {
    y += hThick(r) + cellH;
    if (ly < y) {
      row = r;
      break;
    }
  }
  if (row < 0) return null;
  return { col, row };
}

/** WM 管理スクロールの仮想コンテンツ寸法 = 表の外寸 */
function onMeasure() {
  return { w: tableW(), h: tableH() };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ノートモデル / 選択
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** セル (col,row) を覆うノート (len スパン内に col を含む)。後勝ち (最前面) */
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
/** note だけを選択状態にする (他は解除) */
function selectOnly(note) {
  for (const n of notes) n.selected = n === note;
}
/** 選択中の全ノートの長さを d セル変える (最小 1・上限なし) */
function changeLen(d) {
  for (const n of notes) if (n.selected) n.len = Math.max(1, n.len + d);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const clampCell = (v) => Math.max(CELL_MIN, Math.min(CELL_MAX, v));

/** ドラッグが実際に別セルへ動いているか (= ゴースト表示中か) */
function dragMoved() {
  return (
    drag && (drag.targetCol !== drag.startCol || drag.targetRow !== drag.startRow)
  );
}

/** ドラッグ確定: ノートが残っていればゴースト位置へ移動する */
function endDrag() {
  if (!drag) return;
  if (notes.includes(drag.note)) {
    drag.note.col = drag.targetCol;
    drag.note.row = drag.targetRow;
  }
  drag = null;
}

function onInput(ev) {
  if (ev.type === "wheel") {
    if (!ev.ctrl) return; // 通常/Shift ホイールは WM のスクロールへ委ねる
    // WheelUp (deltaY<0) = 拡大 / WheelDown (deltaY>0) = 縮小
    const dir = -Math.sign(ev.deltaY || 0);
    if (dir === 0) return;
    if (ev.shift) cellW = clampCell(cellW + dir * ZOOM_STEP); // Shift+Ctrl = 水平 (幅)
    else cellH = clampCell(cellH + dir * ZOOM_STEP); //           Ctrl = 垂直 (高さ)
    ev.consumed = true;
    return;
  }

  if (ev.type === "dblclick") {
    drag = null; // ダブルクリックは移動操作ではない
    const cell = cellAt(ev.localX, ev.localY);
    if (!cell) return;
    const n = noteAt(cell.col, cell.row);
    if (n) {
      removeNote(n); // 既存ノート → 削除
    } else {
      const nn = { col: cell.col, row: cell.row, len: 1, selected: false };
      notes.push(nn);
      selectOnly(nn); // 配置直後は選択状態 (排他)
    }
    return;
  }

  if (ev.type === "down") {
    const cell = cellAt(ev.localX, ev.localY);
    const n = cell ? noteAt(cell.col, cell.row) : null;
    // 選択
    if (ev.ctrl) {
      if (n) n.selected = !n.selected; // Ctrl+クリック = トグル。空セルは維持
    } else if (n) {
      selectOnly(n); // クリック = 単一選択
    } else {
      deselectAll(); // 空セルのクリック = 全解除
    }
    // ノート上ならドラッグ開始 (実際の移動は held/up で確定)
    drag = n
      ? { note: n, startCol: n.col, startRow: n.row, targetCol: n.col, targetRow: n.row }
      : null;
    return;
  }

  if (ev.type === "held") {
    if (!drag) return;
    const cell = cellAt(ev.localX, ev.localY);
    if (!cell) return; // グリッド外は移動先を据え置き
    drag.targetCol = cell.col;
    drag.targetRow = cell.row;
    return;
  }

  // ボディ上でのリリース。hover はボタンを離すと (領域外リリースでも) 届くので保険。
  if (ev.type === "up") endDrag();
  else if (ev.type === "hover" && drag) endDrag();
}

/** キーボード (毎フレーム onDraw から。最前面のときだけ拾う) */
function handleKeys() {
  if (!wmIsFocused(APP_NAME)) return;
  if (ctrlDown("KeyA")) selectAll();
  if (keyDown("Escape")) deselectAll();
  const shift = keyHeld("ShiftLeft") || keyHeld("ShiftRight");
  if (shift && keyDown("ArrowRight")) changeLen(+1); // 伸長
  if (shift && keyDown("ArrowLeft")) changeLen(-1); //  短縮
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ノート (col,row から len セル) を描く。cr はコンテンツ矩形。
 * selected=true で 1px 黒枠 + 白塗り、false で黒枠 + 黒塗り (べた)。
 */
function drawNoteAt(cr, col, row, len, selected) {
  const x0 = colInnerX(col);
  const x1 = colInnerX(col + len - 1) + cellW; // 最終セルの内寸・右端
  const nx = cr.x + x0 + 1;
  const ny = cr.y + rowInnerY(row) + 1;
  const nw = x1 - x0 - 2; // span から左右 1px ずつ内側
  const nh = cellH - 2;
  if (nw <= 0 || nh <= 0) return; // 縮小しすぎでノートが消える範囲
  fillRect(nx, ny, nw, nh, 1); // 1px 黒枠 + 黒塗り
  if (selected && nw > 2 && nh > 2) {
    fillRect(nx + 1, ny + 1, nw - 2, nh - 2, 0); // 内部を白へ → 黒枠 + 白塗り
  }
}

function onDraw(cr) {
  handleKeys();
  // 背景 (ペーパー) は WM がボディを毎フレーム塗るのでここでは不要。
  // cr はスクロール量ぶん原点がずれた自然座標系 (WM が平行移動 + クリップする)。
  const tw = tableW();
  const th = tableH();

  // 縦罫線 (列境界。左端〜右端)。太さ分を進めながら描く
  for (let c = 0, x = cr.x; c <= COLS; c++) {
    const t = vThick(c);
    fillRect(x, cr.y, t, th, 1);
    x += t + (c < COLS ? cellW : 0);
  }
  // 横罫線 (行境界。上端〜下端)
  for (let r = 0, y = cr.y; r <= ROWS; r++) {
    const t = hThick(r);
    fillRect(cr.x, y, tw, t, 1);
    y += t + (r < ROWS ? cellH : 0);
  }

  // ノート (罫線の上に重ねる。内寸から 1px 内側なので線には触れない)
  const moving = dragMoved();
  for (const n of notes) {
    if (moving && n === drag.note) continue; // 移動中の実体は隠しゴーストだけ描く
    drawNoteAt(cr, n.col, n.row, n.len, n.selected);
  }
  // ゴースト (移動先。非選択と同じ外観)
  if (moving) drawNoteAt(cr, drag.targetCol, drag.targetRow, drag.note.len, false);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ABOUT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// パネル側が「ABOUT」見出しと「CLICK TO RETURN」を描くのでここでは含めない。
// 段落は空行区切り。字下げは描画側で空白が畳まれるため "-" 箇条書きで構造化する。
// 実装済みの操作のみを記載し、機能追加ごとにこの一覧を更新する。
const ABOUT_TEXT = [
  "ROLL is a step-grid MIDI editor. One bar of 16 steps across, one octave down.",
  "",
  "MOUSE",
  "- Double-click empty: place note",
  "- Double-click a note: delete",
  "- Click a note: select it",
  "- Ctrl+click a note: toggle",
  "- Click empty: clear selection",
  "- Drag a note: move it",
  "- Ctrl+wheel: resize height",
  "- Shift+Ctrl+wheel: resize width",
  "- Wheel / Shift+wheel: scroll",
  "",
  "KEYS",
  "- Ctrl+A: select all",
  "- Esc: clear selection",
  "- Shift+Left: shorten note",
  "- Shift+Right: lengthen note",
].join("\n");

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
      about: ABOUT_TEXT,
    });
    return winId;
  },
  { category: "CREATIVE", dev: true },
);
