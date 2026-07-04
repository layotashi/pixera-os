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
  drawRect: vi.fn(),
  invertRect: vi.fn(),
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
    desktopSetIcons(makeEntries(3));
    const entries = _testing.iconEntries;
    // 行数 = (360 - 12 - 4*2) / 33 = 340/33 = 10
    // 3 アイコンなら全て col=0
    expect(entries[0]).toMatchObject({ gridCol: 0, gridRow: 0 });
    expect(entries[1]).toMatchObject({ gridCol: 0, gridRow: 1 });
    expect(entries[2]).toMatchObject({ gridCol: 0, gridRow: 2 });
  });

  it("行数を超えると次の列に配置される", () => {
    // maxRows = 10 → 11番目は col=1, row=0
    desktopSetIcons(makeEntries(11));
    const entries = _testing.iconEntries;
    expect(entries[10].gridCol).toBe(1);
    expect(entries[10].gridRow).toBe(0);
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

