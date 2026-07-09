/**
 * wm/desktop.js — デスクトップアイコン管理のテスト
 *
 * gpu / app_icon / font / input をモックして、
 * グリッド配置・選択・ドラッグ・ラッソ選択のロジックをテスト。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── モック: config ──
vi.mock("@/config.js", () => ({
  VRAM_WIDTH: 640,
  VRAM_HEIGHT: 360,
  onFontChange: vi.fn(),
}));

// ── モック: GPU (描画は no-op) ──
vi.mock("@/core/gpu.js", () => ({
  fillRect: vi.fn(),
  fillRoundRect: vi.fn(),
  drawRect: vi.fn(),
  drawRoundRect: vi.fn(),
  drawCheckerboard: vi.fn(),
  invertRect: vi.fn(),
  invertRoundRect: vi.fn(),
  pset: vi.fn(),
  pget: vi.fn(() => 0),
}));

// ── モック: app_icon ──
vi.mock("@/core/app_icon.js", () => ({
  drawAppIcon: vi.fn(),
  APP_ICON_W: 18,
  APP_ICON_H: 18,
}));

// ── モック: font ──
vi.mock("@/core/font.js", () => ({
  drawText: vi.fn(),
  GLYPH_W: 5,
  GLYPH_H: 7,
}));

// ── モック: input (テスト毎に挙動を差し替え可能) ──
const _inputState = {
  mx: 0,
  my: 0,
  btnDown: false,
  btnHeld: false,
  btnUp: false,
  ctrl: false,
  dragging: false,
  ctrlA: false,
  dblclick: false,
  keys: new Set(),
  chars: [],
};

vi.mock("@/core/input.js", () => ({
  mouseX: () => _inputState.mx,
  mouseY: () => _inputState.my,
  mouseButtonDown: (btn) => (btn === 0 ? _inputState.btnDown : false),
  mouseButtonHeld: (btn) => (btn === 0 ? _inputState.btnHeld : false),
  mouseButtonUp: (btn) => (btn === 0 ? _inputState.btnUp : false),
  mouseHasCtrl: () => _inputState.ctrl,
  hasInputEvent: (type, btn) =>
    type === "dblclick" && btn === 0 ? _inputState.dblclick : false,
  isDragging: (btn) => (btn === 0 ? _inputState.dragging : false),
  ctrlDown: (key) => (key === "KeyA" ? _inputState.ctrlA : false),
  keyDown: (code) => _inputState.keys.has(code),
  getCharQueue: () => _inputState.chars,
}));

import {
  desktopSetIcons,
  desktopSetWorkAreaTop,
  desktopHandleInput,
  desktopUpdate,
  desktopIsDragging,
  desktopBlur,
  desktopDraw,
  _testing,
} from "@/wm/desktop.js";
import * as GPUMock from "@/core/gpu.js";

// ── ヘルパー ──

/** テスト用のアイコンエントリを生成する */
function makeEntries(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `app${i}`,
    label: `App${i}`,
    icon: `app${i}`,
  }));
}

/** input モックをリセットする */
function resetInput() {
  _inputState.mx = 0;
  _inputState.my = 0;
  _inputState.btnDown = false;
  _inputState.btnHeld = false;
  _inputState.btnUp = false;
  _inputState.ctrl = false;
  _inputState.dragging = false;
  _inputState.ctrlA = false;
  _inputState.dblclick = false;
  _inputState.keys.clear();
  _inputState.chars = [];
}

/** セルの中心ピクセル座標を返す */
function cellCenter(col, row) {
  const { CELL_W, CELL_H, GRID_MARGIN_X, GRID_MARGIN_Y } = _testing;
  const wat = 12; // workAreaTop
  return {
    x: GRID_MARGIN_X + col * CELL_W + (CELL_W >> 1),
    y: wat + GRID_MARGIN_Y + row * CELL_H + (CELL_H >> 1),
  };
}

/**
 * アイコンをクリックして選択し、デスクトップにフォーカスを与える。
 * (キーボード操作は _desktopFocused が true のときのみ動くため、
 *  クリックで確実にフォーカス状態を作ってからキー入力を検証する)
 */
function focusIconViaClick(idx) {
  const e = _testing.iconEntries[idx];
  const c = cellCenter(e.gridCol, e.gridRow);
  _inputState.btnDown = true;
  _inputState.btnHeld = true;
  desktopHandleInput(c.x, c.y, vi.fn());
  _inputState.btnDown = false;
  _inputState.btnHeld = false;
  _inputState.btnUp = true;
  desktopUpdate(c.x, c.y, vi.fn());
  resetInput();
}

// ── セットアップ ──

const WORK_AREA_TOP = 12;

beforeEach(() => {
  resetInput();
  desktopSetWorkAreaTop(WORK_AREA_TOP);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  desktopSetIcons — グリッド座標の自動割り当て
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("desktopSetIcons", () => {
  it("アイコンに列優先でグリッド座標を割り当てる", () => {
    desktopSetIcons(makeEntries(5));
    const entries = _testing.iconEntries;
    expect(entries).toHaveLength(5);
    // 最初のアイコンは (0,0)
    expect(entries[0].gridCol).toBe(0);
    expect(entries[0].gridRow).toBe(0);
  });

  it("列優先で上→下、左→右に配置される", () => {
    // maxRows 以内なら全て col=0 の連続行
    desktopSetIcons(makeEntries(3));
    const entries = _testing.iconEntries;
    expect(entries[0]).toMatchObject({ gridCol: 0, gridRow: 0 });
    expect(entries[1]).toMatchObject({ gridCol: 0, gridRow: 1 });
    expect(entries[2]).toMatchObject({ gridCol: 0, gridRow: 2 });
  });

  it("行数を超えると次の列に配置される", () => {
    // 最終行の次のアイコンは次列の先頭 (col=1, row=0) へ回り込む
    const rows = _testing.maxRows;
    desktopSetIcons(makeEntries(rows + 1));
    const entries = _testing.iconEntries;
    expect(entries[rows - 1]).toMatchObject({ gridCol: 0, gridRow: rows - 1 });
    expect(entries[rows].gridCol).toBe(1);
    expect(entries[rows].gridRow).toBe(0);
  });

  it("選択状態をクリアする", () => {
    desktopSetIcons(makeEntries(3));
    // 先にアイコンを選択してから再設定
    _testing.selectedSet.add(0);
    desktopSetIcons(makeEntries(2));
    expect(_testing.selectedSet.size).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  desktopHandleInput — クリック選択
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("desktopHandleInput — 選択", () => {
  beforeEach(() => {
    desktopSetIcons(makeEntries(4));
  });

  it("アイコンクリックで選択される", () => {
    const c = cellCenter(0, 0);
    _inputState.btnDown = true;
    _inputState.mx = c.x;
    _inputState.my = c.y;
    const hit = desktopHandleInput(c.x, c.y, vi.fn());
    expect(hit).toBe(true);
    expect(_testing.selectedSet.has(0)).toBe(true);
    expect(_testing.selectedSet.size).toBe(1);
  });

  it("別アイコンクリックで選択が切り替わる", () => {
    // アイコン 0 を選択
    const c0 = cellCenter(0, 0);
    _inputState.btnDown = true;
    desktopHandleInput(c0.x, c0.y, vi.fn());

    // アイコン 1 を選択
    const c1 = cellCenter(0, 1);
    desktopHandleInput(c1.x, c1.y, vi.fn());
    expect(_testing.selectedSet.has(0)).toBe(false);
    expect(_testing.selectedSet.has(1)).toBe(true);
    expect(_testing.selectedSet.size).toBe(1);
  });

  it("Ctrl+Click でトグル追加選択できる", () => {
    const c0 = cellCenter(0, 0);
    const c1 = cellCenter(0, 1);
    _inputState.btnDown = true;

    // アイコン 0 を通常選択
    desktopHandleInput(c0.x, c0.y, vi.fn());
    expect(_testing.selectedSet.size).toBe(1);

    // Ctrl+Click でアイコン 1 を追加
    _inputState.ctrl = true;
    desktopHandleInput(c1.x, c1.y, vi.fn());
    expect(_testing.selectedSet.has(0)).toBe(true);
    expect(_testing.selectedSet.has(1)).toBe(true);
    expect(_testing.selectedSet.size).toBe(2);
  });

  it("Ctrl+Click で選択済みアイコンをトグル解除できる", () => {
    const c0 = cellCenter(0, 0);
    _inputState.btnDown = true;
    desktopHandleInput(c0.x, c0.y, vi.fn());

    _inputState.ctrl = true;
    desktopHandleInput(c0.x, c0.y, vi.fn());
    expect(_testing.selectedSet.has(0)).toBe(false);
    expect(_testing.selectedSet.size).toBe(0);
  });

  it("空白クリックで選択が解除される", () => {
    const c0 = cellCenter(0, 0);
    _inputState.btnDown = true;
    desktopHandleInput(c0.x, c0.y, vi.fn());

    // 空白 (右端) クリック
    _inputState.ctrl = false;
    desktopHandleInput(600, 200, vi.fn());
    expect(_testing.selectedSet.size).toBe(0);
  });

  it("workAreaTop より上のクリックは無視される", () => {
    _inputState.btnDown = true;
    const hit = desktopHandleInput(10, WORK_AREA_TOP - 1, vi.fn());
    expect(hit).toBe(false);
  });

  it("ダブルクリックで openByName が呼ばれる", () => {
    const c0 = cellCenter(0, 0);
    _inputState.btnDown = true;
    _inputState.dblclick = false;

    // まず選択
    desktopHandleInput(c0.x, c0.y, vi.fn());
    expect(_testing.selectedSet.has(0)).toBe(true);

    // ダブルクリック
    _inputState.dblclick = true;
    const openByName = vi.fn();
    desktopHandleInput(c0.x, c0.y, openByName);
    expect(openByName).toHaveBeenCalledWith("app0");
    expect(_testing.selectedSet.size).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  desktopUpdate — Ctrl+A
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("desktopUpdate — Ctrl+A", () => {
  it("デスクトップフォーカス時に Ctrl+A で全選択される", () => {
    desktopSetIcons(makeEntries(5));
    _inputState.ctrlA = true;
    desktopUpdate(0, 0);
    expect(_testing.selectedSet.size).toBe(5);
  });

  it("desktopBlur 後は Ctrl+A が効かない", () => {
    desktopSetIcons(makeEntries(3));
    desktopBlur();
    _inputState.ctrlA = true;
    desktopUpdate(0, 0);
    expect(_testing.selectedSet.size).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  desktopUpdate — ラッソ選択
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("desktopUpdate — ラッソ選択", () => {
  beforeEach(() => {
    desktopSetIcons(makeEntries(4));
  });

  it("空白クリック→ドラッグで lassoMode が selecting に遷移する", () => {
    // 空白で mouseDown → pending
    _inputState.btnDown = true;
    _inputState.btnHeld = true;
    desktopHandleInput(600, 200, vi.fn());
    expect(_testing.lassoMode).toBe("pending");
    _inputState.btnDown = false;

    // ドラッグ開始
    _inputState.dragging = true;
    desktopUpdate(610, 210);
    expect(_testing.lassoMode).toBe("selecting");
  });

  it("ラッソ矩形内のアイコンが選択される", () => {
    // セル (0,0) と (0,1) のアイコンを囲むラッソ
    const topLeft = cellCenter(0, 0);
    // 空白で開始 (アイコン外)
    const startX = _testing.GRID_MARGIN_X - 2;
    const startY = WORK_AREA_TOP + _testing.GRID_MARGIN_Y - 2;

    _inputState.btnDown = true;
    _inputState.btnHeld = true;
    desktopHandleInput(startX, startY, vi.fn());
    _inputState.btnDown = false;

    // ドラッグ開始
    _inputState.dragging = true;
    // (0,0) と (0,1) を含む範囲までドラッグ
    const endX = topLeft.x + 10;
    const endY = cellCenter(0, 1).y + 10;
    desktopUpdate(endX, endY);

    expect(_testing.selectedSet.has(0)).toBe(true);
    expect(_testing.selectedSet.has(1)).toBe(true);
    // (0,2), (0,3) は範囲外
    expect(_testing.selectedSet.has(2)).toBe(false);
    expect(_testing.selectedSet.has(3)).toBe(false);
  });

  it("Ctrl+ラッソで既存選択に追加選択できる", () => {
    // まずアイコン 2 を通常選択
    const c2 = cellCenter(0, 2);
    _inputState.btnDown = true;
    desktopHandleInput(c2.x, c2.y, vi.fn());
    expect(_testing.selectedSet.has(2)).toBe(true);
    _inputState.btnDown = false;
    _inputState.btnUp = true;
    desktopUpdate(c2.x, c2.y);
    _inputState.btnUp = false;

    // Ctrl+空白クリックでラッソ開始
    const startX = _testing.GRID_MARGIN_X - 2;
    const startY = WORK_AREA_TOP + _testing.GRID_MARGIN_Y - 2;
    _inputState.ctrl = true;
    _inputState.btnDown = true;
    _inputState.btnHeld = true;
    desktopHandleInput(startX, startY, vi.fn());
    _inputState.btnDown = false;

    // ドラッグで (0,0) を含む範囲
    _inputState.dragging = true;
    const endX = cellCenter(0, 0).x + 10;
    const endY = cellCenter(0, 0).y + 10;
    desktopUpdate(endX, endY);

    // アイコン 0 がラッソ選択、アイコン 2 は既存選択を保持
    expect(_testing.selectedSet.has(0)).toBe(true);
    expect(_testing.selectedSet.has(2)).toBe(true);
  });

  it("マウスリリースでラッソが終了する", () => {
    _inputState.btnDown = true;
    _inputState.btnHeld = true;
    desktopHandleInput(600, 200, vi.fn());
    _inputState.btnDown = false;

    _inputState.dragging = true;
    desktopUpdate(610, 210);
    expect(_testing.lassoMode).toBe("selecting");

    // リリース
    _inputState.btnUp = true;
    _inputState.btnHeld = false;
    _inputState.dragging = false;
    desktopUpdate(610, 210);
    expect(_testing.lassoMode).toBe("none");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  desktopIsDragging
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("desktopIsDragging", () => {
  it("初期状態では false", () => {
    desktopSetIcons(makeEntries(1));
    expect(desktopIsDragging()).toBe(false);
  });

  it("アイコンクリック (ドラッグ pending) で true", () => {
    desktopSetIcons(makeEntries(1));
    const c = cellCenter(0, 0);
    _inputState.btnDown = true;
    _inputState.btnHeld = true;
    desktopHandleInput(c.x, c.y, vi.fn());
    expect(desktopIsDragging()).toBe(true);
  });

  it("ラッソ pending で true", () => {
    desktopSetIcons(makeEntries(1));
    _inputState.btnDown = true;
    _inputState.btnHeld = true;
    desktopHandleInput(600, 200, vi.fn());
    expect(desktopIsDragging()).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  desktopUpdate — アイコンドラッグ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("desktopUpdate — アイコンドラッグ", () => {
  beforeEach(() => {
    desktopSetIcons(makeEntries(3));
  });

  it("ドラッグ後マウスリリースでドラッグ解除", () => {
    const c0 = cellCenter(0, 0);
    _inputState.btnDown = true;
    _inputState.btnHeld = true;
    desktopHandleInput(c0.x, c0.y, vi.fn());
    expect(_testing.dragMode).toBe("pending");
    _inputState.btnDown = false;

    // ドラッグ開始
    _inputState.dragging = true;
    desktopUpdate(c0.x + 50, c0.y);
    expect(_testing.dragMode).toBe("dragging");

    // リリース
    _inputState.btnUp = true;
    _inputState.btnHeld = false;
    _inputState.dragging = false;
    desktopUpdate(c0.x + 50, c0.y);
    expect(_testing.dragMode).toBe("none");
  });

  it("ドラッグなしクリックで単一選択に切り替わる", () => {
    const c0 = cellCenter(0, 0);
    const c1 = cellCenter(0, 1);

    // 複数選択
    _inputState.btnDown = true;
    desktopHandleInput(c0.x, c0.y, vi.fn());
    _inputState.ctrl = true;
    desktopHandleInput(c1.x, c1.y, vi.fn());
    expect(_testing.selectedSet.size).toBe(2);

    // c0 を通常クリック → pending → release (ドラッグなし)
    _inputState.ctrl = false;
    _inputState.btnHeld = true;
    desktopHandleInput(c0.x, c0.y, vi.fn());
    _inputState.btnDown = false;

    _inputState.btnUp = true;
    _inputState.btnHeld = false;
    desktopUpdate(c0.x, c0.y);
    // pending から release → アイコン 0 のみ選択
    expect(_testing.selectedSet.size).toBe(1);
    expect(_testing.selectedSet.has(0)).toBe(true);
  });

  it("ドロップでアイコンのグリッド座標が更新される", () => {
    const c0 = cellCenter(0, 0);
    _inputState.btnDown = true;
    _inputState.btnHeld = true;
    desktopHandleInput(c0.x, c0.y, vi.fn());
    _inputState.btnDown = false;

    // ドラッグ開始
    _inputState.dragging = true;
    // セル (0,1) の位置へドラッグ (CELL_H 分下)
    const target = cellCenter(0, 1);
    desktopUpdate(target.x, target.y);

    // リリース
    _inputState.btnUp = true;
    _inputState.btnHeld = false;
    _inputState.dragging = false;
    desktopUpdate(target.x, target.y);

    // アイコン 0 と 1 が入れ替わる (衝突交換)
    const entries = _testing.iconEntries;
    expect(entries[0].gridRow).toBe(1);
    expect(entries[1].gridRow).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  desktopDraw — クラッシュしないことの確認
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("desktopDraw", () => {
  it("アイコンあり・選択ありで例外を投げない", () => {
    desktopSetIcons(makeEntries(3));
    _testing.selectedSet.add(0);
    expect(() => desktopDraw()).not.toThrow();
  });

  it("空アイコンで例外を投げない", () => {
    desktopSetIcons([]);
    expect(() => desktopDraw()).not.toThrow();
  });

  it("7文字を超えるラベルのアイコンで例外を投げない", () => {
    desktopSetIcons([
      {
        name: "dolphin",
        label: "DOLPHIN",
        icon: "dolphin",
      },
    ]);
    _testing.selectedSet.add(0);
    expect(() => desktopDraw()).not.toThrow();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  drawDesktopIcon レイアウト (ASCII 仕様準拠)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("アイコンレイアウト — ASCII 仕様準拠", () => {
  it("7文字ラベルのウィジェット相対座標が仕様に一致する", () => {
    // 仕様 ASCII は 5x5 フォント。GLYPH_W=5 は本番同一なので水平座標は完全一致、
    // 垂直はグリフ高非依存の位置 (アイコン上端・ラベル上端) を検証する。
    const L = _testing.computeIconLayout(0, 0, 7); // 7 グリフ
    const wx = L.haloX;
    const wy = L.haloY;

    // ── 水平 (仕様: セル幅57, 枠55, アイコン列6, ラベル背景5..51, 文字8) ──
    expect(L.haloW).toBe(57); // ウィジェット全幅
    expect(L.boxX - wx).toBe(1); // 角丸枠 左端
    expect(L.boxW).toBe(55); // 角丸枠 幅
    expect(L.iconPlateX - wx).toBe(5); // アイコンプレート左端
    expect(L.iconX - wx).toBe(6); // アイコン本体左端
    expect(L.labelBgX - wx).toBe(5); // ラベル背景左端
    expect(L.labelBgW).toBe(47); // ラベル背景幅 (文字41 + 余白6)
    expect(L.textX - wx).toBe(8); // 文字左端

    // ── 垂直 (グリフ高非依存: 仕様 row 5/6/27/29) ──
    expect(L.iconPlateY - wy).toBe(5);
    expect(L.iconY - wy).toBe(6);
    expect(L.labelBgY - wy).toBe(27);
    expect(L.textY - wy).toBe(29);
  });

  it("短いラベルでもボックス全幅は最長ラベル基準で固定", () => {
    const L = _testing.computeIconLayout(0, 0, 1); // 1 グリフ
    // ボックス全幅は 7 文字時と同じ 57 に固定 (余った幅はディザで埋まる)。
    // ラベル背景だけが文字数に応じて縮む (文字5 + 余白6 = 11)。
    expect(L.haloW).toBe(57);
    expect(L.labelBgW).toBe(11);
  });

  it("8文字以上のラベルは 7 グリフ幅 (省略マーク込み) で固定", () => {
    // AMETHYST (8文字) → "AMETHY" + 省略マーク = 7 グリフ → 7文字ラベルと同幅
    const L7 = _testing.computeIconLayout(0, 0, 7);
    const L8 = _testing.computeIconLayout(0, 0, 7); // 省略後も 7 グリフ
    expect(L8.haloW).toBe(L7.haloW);
    expect(L8.labelBgW).toBe(47);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ラベル省略 (三点リーダ)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("ラベル省略 (三点リーダ)", () => {
  it("7 文字以内はそのまま (省略なし)", () => {
    expect(_testing.truncateLabel("TESSERA")).toEqual({
      text: "TESSERA",
      ellipsis: false,
    });
    expect(_testing.truncateLabel("LIFE")).toEqual({
      text: "LIFE",
      ellipsis: false,
    });
  });

  it("8 文字以上は先頭 6 文字 + 省略マーク", () => {
    expect(_testing.truncateLabel("AMETHYST")).toEqual({
      text: "AMETHY",
      ellipsis: true,
    });
  });

  it("省略ラベルの描画で三点リーダ (pset×3) を打つ", () => {
    desktopSetIcons([{ name: "AMETHYST", label: "AMETHYST", icon: "default" }]);
    GPUMock.pset.mockClear();
    desktopDraw();
    // ラッソ/ドラッグ無しなので pset は省略マークの 3 点のみ
    expect(GPUMock.pset).toHaveBeenCalledTimes(3);
  });

  it("7 文字以内のラベル描画では pset を呼ばない (省略マーク無し)", () => {
    desktopSetIcons([{ name: "TESSERA", label: "TESSERA", icon: "default" }]);
    GPUMock.pset.mockClear();
    desktopDraw();
    expect(GPUMock.pset).not.toHaveBeenCalled();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  1 アイコン = 1 セル
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("1 アイコン = 1 セル", () => {
  it("各アイコンは 1 セルを占め、次のアイコンは隣接セルに置かれる", () => {
    desktopSetIcons(makeEntries(3));
    const e = _testing.iconEntries;
    // 列優先配置: 2 番目は 1 番目の同列・次行
    expect(e[1].gridCol).toBe(e[0].gridCol);
    expect(e[1].gridRow).toBe(e[0].gridRow + 1);
  });

  it("ラベル長に関わらず単一セル (gridRowSpan は廃止)", () => {
    desktopSetIcons([{ name: "test", label: "VERYLONGLABEL", icon: "test" }]);
    const e = _testing.iconEntries[0];
    expect(e.gridRowSpan).toBeUndefined();
    expect(typeof e.gridRow).toBe("number");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  6 列レイアウト (360px 幅)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("6 列レイアウト (360px 幅)", () => {
  it("360px 幅にアイコンが 6 列ちょうど収まる", () => {
    const { GRID_MARGIN_X, CELL_W } = _testing;
    const cols = Math.floor((360 - GRID_MARGIN_X * 2) / CELL_W);
    expect(cols).toBe(6);
  });

  it("選択ボックスの左右余白が 5px で対称になる", () => {
    const { GRID_MARGIN_X, CELL_W } = _testing;
    const col0X = GRID_MARGIN_X + 0 * CELL_W;
    const col5X = GRID_MARGIN_X + 5 * CELL_W;
    const L0 = _testing.computeIconLayout(col0X, 0, 7);
    const L5 = _testing.computeIconLayout(col5X, 0, 7);
    // 左端 (1 列目) ボックスの左余白 = 5px
    expect(L0.boxX).toBe(5);
    // 右端 (6 列目) ボックスの右端から画面端 (360) までの余白 = 5px
    expect(360 - (L5.boxX + L5.boxW)).toBe(5);
  });

  it("隣接するボックス間の間隔が 4px になる", () => {
    const { GRID_MARGIN_X, CELL_W } = _testing;
    const L0 = _testing.computeIconLayout(GRID_MARGIN_X, 0, 7);
    const L1 = _testing.computeIconLayout(GRID_MARGIN_X + CELL_W, 0, 7);
    expect(L1.boxX - (L0.boxX + L0.boxW)).toBe(4);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  キーボード操作 — 矢印キー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("キーボード操作 — 矢印キー", () => {
  // 2×2 グリッドに固定配置:
  //   (col,row)  0=(0,0)  2=(1,0)
  //             1=(0,1)  3=(1,1)
  function arrange2x2() {
    desktopSetIcons(makeEntries(4));
    const e = _testing.iconEntries;
    e[0].gridCol = 0;
    e[0].gridRow = 0;
    e[1].gridCol = 0;
    e[1].gridRow = 1;
    e[2].gridCol = 1;
    e[2].gridRow = 0;
    e[3].gridCol = 1;
    e[3].gridRow = 1;
  }

  /** キーを 1 回押して更新する (フレーム前後で入力をリセット) */
  function pressKey(code) {
    resetInput();
    _inputState.keys.add(code);
    desktopUpdate(0, 0, vi.fn());
    resetInput();
  }

  beforeEach(arrange2x2);

  it("未選択で矢印キーを押すと左上のアイコンが選択される", () => {
    focusIconViaClick(0);
    _testing.selectedSet.clear();
    pressKey("ArrowDown");
    expect(_testing.selectedSet.has(0)).toBe(true);
    expect(_testing.selectedSet.size).toBe(1);
  });

  it("右キーで隣の列の同じ行へ移動する", () => {
    focusIconViaClick(0); // (0,0)
    pressKey("ArrowRight");
    expect(_testing.selectedSet.has(2)).toBe(true); // (1,0)
    expect(_testing.selectedSet.size).toBe(1);
  });

  it("下キーで同じ列の次の行へ移動する", () => {
    focusIconViaClick(0); // (0,0)
    pressKey("ArrowDown");
    expect(_testing.selectedSet.has(1)).toBe(true); // (0,1)
  });

  it("左キーで隣の列へ戻る", () => {
    focusIconViaClick(2); // (1,0)
    pressKey("ArrowLeft");
    expect(_testing.selectedSet.has(0)).toBe(true); // (0,0)
  });

  it("上キーで同じ列の前の行へ移動する", () => {
    focusIconViaClick(1); // (0,1)
    pressKey("ArrowUp");
    expect(_testing.selectedSet.has(0)).toBe(true); // (0,0)
  });

  it("列の端では上下移動しない", () => {
    focusIconViaClick(1); // (0,1) 最下行
    pressKey("ArrowDown");
    expect(_testing.selectedSet.has(1)).toBe(true); // 変わらず
    expect(_testing.selectedSet.size).toBe(1);
  });

  it("デスクトップにフォーカスが無いとキーが効かない", () => {
    focusIconViaClick(0);
    desktopBlur();
    pressKey("ArrowRight");
    expect(_testing.selectedSet.has(0)).toBe(true); // 移動しない
    expect(_testing.selectedSet.has(2)).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  キーボード操作 — Enter 起動
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("キーボード操作 — Enter 起動", () => {
  it("Enter で選択中アイコンの openByName が呼ばれる", () => {
    desktopSetIcons(makeEntries(3));
    focusIconViaClick(0);
    const openByName = vi.fn();
    _inputState.keys.add("Enter");
    desktopUpdate(0, 0, openByName);
    expect(openByName).toHaveBeenCalledWith("app0");
    resetInput();
  });

  it("未選択なら Enter で何も起動しない", () => {
    desktopSetIcons(makeEntries(3));
    focusIconViaClick(0);
    _testing.selectedSet.clear();
    const openByName = vi.fn();
    _inputState.keys.add("Enter");
    desktopUpdate(0, 0, openByName);
    expect(openByName).not.toHaveBeenCalled();
    resetInput();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  キーボード操作 — 頭文字入力 (type-ahead)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("キーボード操作 — 頭文字入力", () => {
  // 列 0 に縦積み: 0=NOTEPAD 1=NEXUS 2=FILES
  function arrangeNamed() {
    desktopSetIcons([
      { name: "notepad", label: "NOTEPAD", icon: "notepad" },
      { name: "nexus", label: "NEXUS", icon: "nexus" },
      { name: "files", label: "FILES", icon: "files" },
    ]);
  }

  /** 1 文字入力して更新する */
  function typeChar(ch) {
    resetInput();
    _inputState.chars = [ch];
    desktopUpdate(0, 0, vi.fn());
    resetInput();
  }

  beforeEach(arrangeNamed);

  it("頭文字で最初の一致アイコンへ移動する", () => {
    focusIconViaClick(0);
    _testing.selectedSet.clear();
    typeChar("f");
    expect(_testing.selectedSet.has(2)).toBe(true); // FILES
  });

  it("同じ頭文字を続けて押すとラウンドロビンする", () => {
    focusIconViaClick(0);
    _testing.selectedSet.clear();

    typeChar("n"); // → NOTEPAD (index 0)
    expect(_testing.selectedSet.has(0)).toBe(true);

    typeChar("n"); // → NEXUS (index 1)
    expect(_testing.selectedSet.has(1)).toBe(true);

    typeChar("n"); // → NOTEPAD (index 0) へ循環
    expect(_testing.selectedSet.has(0)).toBe(true);
  });

  it("大文字・小文字を区別しない", () => {
    focusIconViaClick(0);
    _testing.selectedSet.clear();
    typeChar("F");
    expect(_testing.selectedSet.has(2)).toBe(true); // FILES
  });

  it("一致が無ければ選択は変わらない", () => {
    focusIconViaClick(0); // NOTEPAD 選択
    typeChar("z");
    expect(_testing.selectedSet.has(0)).toBe(true);
    expect(_testing.selectedSet.size).toBe(1);
  });
});

