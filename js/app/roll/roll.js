/**
 * @module app/roll/roll
 * roll.js — ROLL ウィンドウ (ステップグリッド MIDI エディタ)
 *
 * ボディには表を 1 枚だけ描く:
 *   横 = 4 小節 × 16 分音符 = 64 列。
 *   縦 = MIDI で入力可能な全音高 = 128 行。row 0 = MIDI 127 (最高音・上端)。
 *   ノートは開始セル (col,row) と長さ len (セル数) を持つ。
 *
 * ── 罫線 ──
 *   小節の境界線 (16 列ごと) と、オクターブ境界 (B と C の間) は 2px 実線。上端も 2px。
 *   それ以外の内側の罫線は 1px 実線。罫線の太さはセル内寸に含めない。
 *
 * ── ノート ──
 *   セル内寸 (span) いっぱいに置き、最外周 1px を白枠、その内側を黒ノートにする
 *   (罫線との視認性確保。ノート + 白枠 = セル内寸)。
 *   非選択 = 黒枠 + 黒塗り。選択 = 黒枠 + 白塗り。
 *   ドラッグ/複製中は移動先へゴースト (非選択と同外観) を表示する。
 *
 * ── 操作 (ABOUT パネルにも記載。実装済みのもののみ) ──
 *   ダブルクリック(空/ノート) … 配置 / 削除。クリック … 単一選択 (空は解除)。
 *   Ctrl+クリック … 選択トグル。ドラッグ … 選択を移動。Ctrl+ドラッグ … 選択を複製
 *     (ドラッグ中の Ctrl 押下/解放で複製/移動をリアルタイム切替)。
 *   Ctrl+ホイール / Shift+Ctrl+ホイール … セル高さ / 幅のズーム (カーソル基準)。
 *   Ctrl+A / Esc … 全選択 / 全解除。Ctrl+D … 各ノートの直後に複製。
 *   矢印 … 選択を 1 セル移動 (長押しでリピート)。Shift+↑↓ … 1 オクターブ移動。
 *   Shift+←→ … 1 セル短縮 / 伸長 (最小 1 セル・上限なし)。
 *
 * 音名・小節番号・鍵盤・再生は、この段階では未実装。
 * ノートモデルや再生ロジックは grid.js に温存 (このウィンドウからは未接続) してある。
 */

import { fillRect, isCapturing } from "../../core/gpu.js";
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
const COLS = BARS * STEPS_PER_BAR;

/** 音高方向: MIDI 0..127 の 128 行。row 0 = MIDI 127 (最高音・上端) */
const OCTAVE = 12;
const ROWS = 128;

/** 罫線の太さ (DOT)。境界線 = 太線、それ以外 = 細線 */
const THIN = 1;
const BOLD = 2;

/** セル内寸 (DOT) の範囲と初期値。罫線の太さは内寸に含めない */
const CELL_MIN = 5;
const CELL_MAX = 30;
const CELL_DEFAULT = 15;

/** ホイール 1 ノッチあたりのズーム量 (DOT) */
const ZOOM_STEP = 1;

/** キーリピート: 押下後この待機 (ms) を経てから、この間隔 (ms) で連続処理 */
const REPEAT_DELAY = 300;
const REPEAT_RATE = 45;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let winId = -1;

/** セル内寸 (Ctrl / Shift+Ctrl ホイールで可変) */
let cellW = CELL_DEFAULT; // 横 (列) 方向の内寸
let cellH = CELL_DEFAULT; // 縦 (行) 方向の内寸

/** ノート一覧。@type {{col:number,row:number,len:number,selected:boolean}[]} */
let notes = [];

/**
 * ドラッグ状態。sel = 対象ノート (down 時の選択スナップショット)、dCol/dRow = 現在のデルタ、
 * pending = クリック確定時 (未移動) の選択変更。移動/複製は Ctrl の実時間状態で切替える。
 * @type {{grabCol:number,grabRow:number,dCol:number,dRow:number,moved:boolean,sel:object[],pending:(()=>void)|null}|null}
 */
let drag = null;

/** キーリピート: 対象コードと次回発火時刻 (ms) */
let repeatCode = null;
let repeatNext = 0;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  寸法 / 座標 (コンテンツ空間。原点 = 表の左上)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ctrlHeld = () => keyHeld("ControlLeft") || keyHeld("ControlRight");

/** 列境界 (縦罫線) の太さ。小節境界 (16 列ごと・両端含む) = 太線 */
const vThick = (c) => (c % STEPS_PER_BAR === 0 ? BOLD : THIN);
/** 行境界 (横罫線) の太さ。オクターブ境界 (B/C) と上端 = 太線 */
const hThick = (r) => (r === 0 || (ROWS - r) % OCTAVE === 0 ? BOLD : THIN);

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

/** コンテンツ空間 X → 連続列座標 (col + セル内フラクション)。ズームのカーソル基準に使う */
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
/** コンテンツ空間 Y → 連続行座標 */
function anchorRow(ly) {
  if (ly <= 0) return 0;
  let y = 0;
  for (let r = 0; r < ROWS; r++) {
    const iy = y + hThick(r);
    const end = iy + cellH;
    if (ly < end) return r + Math.max(0, Math.min(1, (ly - iy) / cellH));
    y = end;
  }
  return ROWS;
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
function selected() {
  return notes.filter((n) => n.selected);
}
/** 選択中の全ノートの長さを d セル変える (最小 1・上限なし) */
function changeLen(d) {
  for (const n of notes) if (n.selected) n.len = Math.max(1, n.len + d);
}
/**
 * (dCol,dRow) を、選択集合が全てグリッド枠内に収まる範囲へクランプして返す。
 * 先頭セルを [0,COLS-1]×[0,ROWS-1] に保つ (末尾は len で枠外可)。
 */
function clampDelta(sel, dCol, dRow) {
  if (!sel.length) return [0, 0];
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
  return [
    clampInt(dCol, -minC, COLS - 1 - maxC),
    clampInt(dRow, -minR, ROWS - 1 - maxR),
  ];
}
/** 選択を (dCol,dRow) 動かす。全体が枠内のときだけ (相対位置を保つ all-or-nothing) */
function moveSelected(dCol, dRow) {
  const sel = selected();
  if (!sel.length) return;
  const [cc, rr] = clampDelta(sel, dCol, dRow);
  if (cc !== dCol || rr !== dRow) return; // 1 つでも枠外 → 動かさない
  for (const n of sel) {
    n.col += dCol;
    n.row += dRow;
  }
}
/** sel を各ノートの (dCol,dRow) 平行移動位置へ複製し、選択をコピーへ移す (元は残す) */
function duplicateAt(sel, dCol, dRow) {
  if (!sel.length) return;
  const copies = sel.map((n) => ({
    col: n.col + dCol,
    row: n.row + dRow,
    len: n.len,
    selected: true,
  }));
  for (const n of sel) n.selected = false;
  notes.push(...copies);
}
/** Ctrl+D: 選択を各ノートの直後 (col+len・音高そのまま) へ複製する */
function duplicateAfter() {
  const sel = selected();
  if (!sel.length) return;
  const copies = sel.map((n) => ({
    col: n.col + n.len,
    row: n.row,
    len: n.len,
    selected: true,
  }));
  for (const n of sel) n.selected = false;
  notes.push(...copies);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力 — ホイール (カーソル基準ズーム)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const clampCell = (v) => Math.max(CELL_MIN, Math.min(CELL_MAX, v));

/**
 * ズームでセル内寸が old→new に変わったとき、カーソル下 (連続座標 f) の点が画面上で
 * 動かないよう、スクロール量の補正 = f * (new - old) を返す (境界線は不変なので相殺)。
 */
function zoomWheel(ev) {
  const dir = -Math.sign(ev.deltaY || 0); // WheelUp = 拡大 / Down = 縮小
  if (dir === 0) return;
  const s0 = wmGetScroll(winId);
  if (ev.shift) {
    const f = anchorCol(ev.localX);
    const old = cellW;
    cellW = clampCell(cellW + dir * ZOOM_STEP); // Shift+Ctrl = 水平 (幅)
    wmSetScroll(winId, s0.x + f * (cellW - old), null);
  } else {
    const f = anchorRow(ev.localY);
    const old = cellH;
    cellH = clampCell(cellH + dir * ZOOM_STEP); // Ctrl = 垂直 (高さ)
    wmSetScroll(winId, null, s0.y + f * (cellH - old));
  }
  ev.consumed = true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力 — マウス (配置 / 選択 / ドラッグ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ドラッグ確定: 未移動ならクリック扱い、移動なら Ctrl の状態で複製 / 移動 */
function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.moved) {
    if (d.pending) d.pending();
    return;
  }
  if (ctrlHeld()) {
    duplicateAt(d.sel, d.dCol, d.dRow); // Ctrl 押下中 = 複製 (元を残す)
  } else {
    for (const n of d.sel) {
      n.col += d.dCol;
      n.row += d.dRow;
    }
  }
}

function onInput(ev) {
  if (ev.type === "wheel") {
    if (ev.ctrl) zoomWheel(ev); // 通常/Shift ホイールは WM のスクロールへ委ねる
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
    if (!n) {
      if (!ev.ctrl) deselectAll(); // plain 空クリック = 全解除、Ctrl 空クリック = 維持
      drag = null;
      return;
    }
    // 選択変更。ドラッグで意味が変わる操作 (選択中ノートの掴み) は pending に遅延する
    let pending = null;
    if (ev.ctrl) {
      if (n.selected) pending = () => (n.selected = false); // Ctrl+クリック=トグルOff / ドラッグ=複製
      else n.selected = true; //                              Ctrl+down(非選択)=選択に追加
    } else if (n.selected) {
      pending = () => selectOnly(n); // クリック=単一化 / ドラッグ=グループ移動
    } else {
      selectOnly(n); //               plain down(非選択)=単一選択
    }
    drag = {
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
    if (!cell) return; // グリッド外は据え置き
    const [dCol, dRow] = clampDelta(
      drag.sel,
      cell.col - drag.grabCol,
      cell.row - drag.grabRow,
    );
    drag.dCol = dCol;
    drag.dRow = dRow;
    drag.moved = dCol !== 0 || dRow !== 0;
    return;
  }

  // ボディ上でのリリース。hover はボタンを離すと (領域外リリースでも) 届くので保険。
  if (ev.type === "up") endDrag();
  else if (ev.type === "hover" && drag) endDrag();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力 — キーボード (最前面時のみ。長押しリピート対応)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/** 矢印コード + Shift 状態 → 適用する操作 */
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

/** 矢印: 押下直後に 1 段階、その後 REPEAT_DELAY を経て REPEAT_RATE ごとに連続処理 */
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
  if (ctrlDown("KeyA")) selectAll();
  if (ctrlDown("KeyD")) duplicateAfter();
  if (keyDown("Escape")) deselectAll();
  handleArrows(performance.now(), keyHeld("ShiftLeft") || keyHeld("ShiftRight"));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ノート (col,row から len セル) を描く。セル内寸いっぱいを白枠 (最外周 1px) にし、
 * その内側を黒ノートに。selected=true で内部をさらに白へ (黒枠 + 白塗り)。
 */
function drawNoteAt(cr, col, row, len, selected) {
  const x0 = colInnerX(col);
  const x1 = colInnerX(col + len - 1) + cellW; // 最終セル内寸の右端
  const ox = cr.x + x0;
  const oy = cr.y + rowInnerY(row);
  const ow = x1 - x0; // セル内寸の span 幅 (白枠込みのノート全体)
  const oh = cellH;
  if (ow <= 0 || oh <= 0) return;
  fillRect(ox, oy, ow, oh, 0); // 白枠 (最外周 1px を含む白地)
  if (ow > 2 && oh > 2) {
    fillRect(ox + 1, oy + 1, ow - 2, oh - 2, 1); // 黒ノート本体 (白枠の内側)
    if (selected && ow > 4 && oh > 4) {
      fillRect(ox + 2, oy + 2, ow - 4, oh - 4, 0); // 選択: 内部を白へ (黒枠 + 白塗り)
    }
  }
}

function onDraw(cr) {
  if (!isCapturing()) handleKeys(); // CAPTURE の二度描きでキーが二重発火しないよう抑止
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

  // ノート + ドラッグ/複製プレビュー (Ctrl の実時間状態で切替)
  const moving = !!(drag && drag.moved);
  const dup = moving && ctrlHeld();
  for (const n of notes) {
    if (moving && !dup && drag.sel.includes(n)) continue; // 移動: 掴んだ実体は隠す
    drawNoteAt(cr, n.col, n.row, n.len, n.selected);
  }
  if (moving) {
    // ゴースト (移動先。非選択と同じ外観)。複製時は元も残るので二重に見える
    for (const n of drag.sel) {
      drawNoteAt(cr, n.col + drag.dCol, n.row + drag.dRow, n.len, false);
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ABOUT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// パネル側が「ABOUT」見出しと「CLICK TO RETURN」を描くのでここでは含めない。
// 段落は空行区切り。字下げは描画側で空白が畳まれるため "-" 箇条書きで構造化する。
// 実装済みの操作のみを記載し、機能追加ごとにこの一覧を更新する。
const ABOUT_TEXT = [
  "ROLL is a step-grid MIDI editor. Four bars of 16 steps across, all 128 MIDI pitches down.",
  "",
  "MOUSE",
  "- Double-click empty: place note",
  "- Double-click a note: delete",
  "- Click a note: select it",
  "- Ctrl+click a note: toggle",
  "- Click empty: clear selection",
  "- Drag: move selection",
  "- Ctrl+drag: duplicate selection",
  "- Ctrl+wheel: zoom height (at cursor)",
  "- Shift+Ctrl+wheel: zoom width",
  "- Wheel / Shift+wheel: scroll",
  "",
  "KEYS",
  "- Ctrl+A: select all",
  "- Esc: clear selection",
  "- Ctrl+D: duplicate after",
  "- Arrows: move 1 cell (held repeats)",
  "- Shift+Up/Down: move 1 octave",
  "- Shift+Left: shorten note",
  "- Shift+Right: lengthen note",
].join("\n");

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    // w=0/h=0: onMeasure から初期外寸を自動算出 (表が work area より大きければ
    // クランプされ、スクロールで巡る = fixed-size + scroll)
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
