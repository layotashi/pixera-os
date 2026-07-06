/**
 * remeasure.test.js — フォント切替時のウィジェット再計測テスト
 *
 * ports.js をモックし、GLYPH_W / GLYPH_H を動的に変更して
 * _computeDerivedConstants() → remeasure() の一連を検証する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── ports.js モック (全 export let を網羅) ──
vi.mock("@/ui/ports.js", () => ({
  GLYPH_W: 5,
  GLYPH_H: 7,
  ICON_W: 7,
  ICON_H: 7,
  fillRect: vi.fn(),
  drawRoundRect: vi.fn(),
  drawRect: vi.fn(),
  hline: vi.fn(),
  vline: vi.fn(),
  pset: vi.fn(),
  setClip: vi.fn(),
  resetClip: vi.fn(),
  pushClip: vi.fn(),
  popClip: vi.fn(),
  drawText: vi.fn(),
  drawIcon: vi.fn(),
  drawTextIcon: vi.fn(),
  keyDown: vi.fn(() => false),
  keyHeld: vi.fn(() => false),
  getCharQueue: vi.fn(() => []),
  getPasteText: vi.fn(() => null),
  mouseHasShift: vi.fn(() => false),
  ctrlDown: vi.fn(() => false),
  BAYER_4x4: Array.from({ length: 16 }, () => 0),
  BAYER_8x8: Array.from({ length: 64 }, () => 0),
}));

// ── scrollbar.js モック ──
vi.mock("@/ui/scrollbar.js", () => ({
  SCROLLBAR_SLOT_WIDTH: 10,
  SCROLLBAR_W: 7,
  SCROLLBAR_MARGIN: 1,
  createScrollState: (vp, ct) => ({
    offset: 0,
    viewport: vp,
    content: ct,
    _thumbDrag: false,
    _dragStartPos: 0,
    _dragStartOffset: 0,
  }),
  scrollBy: vi.fn(),
  scrollTo: vi.fn(),
  scrollMaxOffset: vi.fn(() => 0),
  scrollNeeded: vi.fn(() => false),
  scrollEnsureVisible: vi.fn(),
  scrollIsDragging: vi.fn(() => false),
  scrollDragReset: vi.fn(),
  scrollSetContent: vi.fn(),
  scrollSetViewport: vi.fn(),
  drawVScrollbar: vi.fn(),
  drawVScrollSep: vi.fn(),
  drawVScrollbarSlot: vi.fn(),
  drawHScrollbar: vi.fn(),
  drawHScrollSep: vi.fn(),
  drawHScrollbarSlot: vi.fn(),
  vScrollbarSlotThumbArea: vi.fn(() => ({ x: 0, y: 0, w: 0, h: 0 })),
  handleVScrollInput: vi.fn(),
}));

// ── vfs.js モック (VfsBrowser 用) ──
vi.mock("@/core/vfs.js", () => ({
  flattenTree: vi.fn(() => []),
  mkdir: vi.fn(),
  stat: vi.fn(() => null),
  joinPath: (...p) => p.join("/"),
  basename: (p) => p.split("/").pop(),
  parentPath: (p) => p.split("/").slice(0, -1).join("/"),
  move: vi.fn(),
}));

import * as ports from "@/ui/ports.js";
import {
  _computeDerivedConstants,
  BUTTON_PADDING,
  textWidth,
  buttonAutoWidth,
} from "@/ui/ui_helpers.js";

// 派生定数を動的に参照するため * import
import * as helpers from "@/ui/ui_helpers.js";

import { Widget } from "@/ui/Widget.js";
import { WidgetGroup } from "@/ui/WidgetGroup.js";
import { Label } from "@/ui/widgets/Label.js";
import { PushButton } from "@/ui/widgets/PushButton.js";
import { ToggleButton } from "@/ui/widgets/ToggleButton.js";
import { RadioButton } from "@/ui/widgets/RadioButton.js";
import { NumberBox } from "@/ui/widgets/NumberBox.js";
import { TextBox } from "@/ui/widgets/TextBox.js";
import { Slider } from "@/ui/widgets/Slider.js";
import { DropDown } from "@/ui/widgets/DropDown.js";
import { ListBox } from "@/ui/widgets/ListBox.js";
import { TextArea } from "@/ui/widgets/TextArea.js";
import { TreeView } from "@/ui/widgets/TreeView.js";

// SCROLLBAR_SLOT_WIDTH (モック値)
const SCROLLBAR_SLOT_WIDTH = 10;

// ── ヘルパー ──

/** モック上の GLYPH_W/GLYPH_H を変更し、派生定数を再算出する */
function setFont(glyphW, glyphH) {
  ports.GLYPH_W = glyphW;
  ports.GLYPH_H = glyphH;
  _computeDerivedConstants();
}

/** GLYPH_W=gw での textWidth */
function tw(s, gw = ports.GLYPH_W) {
  if (s.length === 0) return 0;
  return s.length * (gw + 1) - 1;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  _computeDerivedConstants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("_computeDerivedConstants", () => {
  it("5x7 フォントで派生定数を正しく算出", () => {
    setFont(5, 7);
    expect(helpers.BUTTON_AUTO_HEIGHT).toBe(7 + 8 + 4); // 19
    expect(helpers.LABEL_LINE_HEIGHT).toBe(7 + 4); // 11
    expect(helpers.LISTBOX_ITEM_HEIGHT).toBe(7 + 8); // 15
    expect(helpers.DROPDOWN_ITEM_HEIGHT).toBe(7 + 8); // 15
    expect(helpers.DROPDOWN_CHECK_WIDTH).toBe(7 + 3); // 10
    expect(helpers.TREEVIEW_ITEM_HEIGHT).toBe(7 + 8); // 15
    expect(helpers.TREEVIEW_INDENT).toBe((5 + 1) * 2); // 12
    expect(helpers.TEXTAREA_LINE_HEIGHT).toBe(7 + 3); // 10
  });

  it("5x5 フォントで派生定数を正しく算出", () => {
    setFont(5, 5);
    expect(helpers.BUTTON_AUTO_HEIGHT).toBe(5 + 8 + 4); // 17
    expect(helpers.LABEL_LINE_HEIGHT).toBe(5 + 4); // 9
    expect(helpers.LISTBOX_ITEM_HEIGHT).toBe(5 + 8); // 13
    expect(helpers.DROPDOWN_ITEM_HEIGHT).toBe(5 + 8); // 13
    expect(helpers.DROPDOWN_CHECK_WIDTH).toBe(7 + 3); // 10 (ICON_W 依存)
    expect(helpers.TREEVIEW_ITEM_HEIGHT).toBe(5 + 8); // 13
    expect(helpers.TREEVIEW_INDENT).toBe((5 + 1) * 2); // 12 (GLYPH_W 不変)
    expect(helpers.TEXTAREA_LINE_HEIGHT).toBe(5 + 3); // 8
  });

  it("GLYPH_W が変わると TREEVIEW_INDENT も変わる", () => {
    setFont(4, 5);
    expect(helpers.TREEVIEW_INDENT).toBe((4 + 1) * 2); // 10
    setFont(5, 7); // 元に戻す
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Widget.remeasure (基底)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Widget 基底 remeasure", () => {
  it("デフォルトは no-op で w/h を変更しない", () => {
    const w = new Widget(0, 0, 100, 50);
    w.remeasure();
    expect(w.w).toBe(100);
    expect(w.h).toBe(50);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  各ウィジェットの remeasure
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Label.remeasure", () => {
  beforeEach(() => setFont(5, 7));

  it("単行ラベルの h が GLYPH_H に更新される", () => {
    const lbl = new Label(0, 0, "Hello");
    expect(lbl.h).toBe(7);

    setFont(5, 5);
    lbl.remeasure();
    expect(lbl.w).toBe(tw("Hello")); // 29 (不変)
    expect(lbl.h).toBe(5);
  });

  it("複数行ラベルの h が LABEL_LINE_HEIGHT ベースで更新される", () => {
    const lbl = new Label(0, 0, "AB\nCD\nEF");
    // 5x7: h = (3-1)*11 + 7 = 22+7 = 29
    expect(lbl.h).toBe(29);

    setFont(5, 5);
    lbl.remeasure();
    // 5x5: h = (3-1)*9 + 5 = 18+5 = 23
    expect(lbl.h).toBe(23);
  });

  it("w は最長行に追従する", () => {
    const lbl = new Label(0, 0, "AB\nCDEF");
    // 5x7: w = tw("CDEF") = 4*6-1 = 23
    expect(lbl.w).toBe(23);

    lbl.text = "AB\nCDEFGH";
    lbl.remeasure();
    expect(lbl.w).toBe(tw("CDEFGH")); // 6*6-1 = 35
  });
});

describe("PushButton.remeasure", () => {
  beforeEach(() => setFont(5, 7));

  it("テキストボタンの w/h が更新される", () => {
    const btn = new PushButton(0, 0, "OK", () => {});
    // 5x7: w = tw("OK")+12 = 11+12 = 23, h = 19
    expect(btn.w).toBe(23);
    expect(btn.h).toBe(19);

    setFont(5, 5);
    btn.remeasure();
    expect(btn.w).toBe(23); // GLYPH_W 不変なので同じ
    expect(btn.h).toBe(17);
  });

  it("アイコンボタンは remeasure をスキップする", () => {
    const btn = new PushButton(0, 0, "", () => {});
    btn.icon = 1;
    btn.w = 42;
    btn.h = 42;

    setFont(5, 5);
    btn.remeasure();
    // アイコンボタンは w/h を保持
    expect(btn.w).toBe(42);
    expect(btn.h).toBe(42);
  });
});

describe("ToggleButton.remeasure", () => {
  beforeEach(() => setFont(5, 7));

  it("テキストボタンの h が更新される", () => {
    const btn = new ToggleButton(0, 0, "ON", () => {});
    expect(btn.h).toBe(19);

    setFont(5, 5);
    btn.remeasure();
    expect(btn.h).toBe(17);
  });

  it("アイコンボタンは remeasure をスキップする", () => {
    const btn = new ToggleButton(0, 0, "", () => {});
    btn.icon = 2;
    btn.w = 30;
    btn.h = 30;

    setFont(5, 5);
    btn.remeasure();
    expect(btn.w).toBe(30);
    expect(btn.h).toBe(30);
  });
});

describe("RadioButton.remeasure", () => {
  beforeEach(() => setFont(5, 7));

  it("w/h が更新される", () => {
    const rb = new RadioButton(0, 0, "Option", "grp", () => {});
    const w7 = buttonAutoWidth("Option");
    expect(rb.w).toBe(w7);
    expect(rb.h).toBe(19);

    setFont(5, 5);
    rb.remeasure();
    expect(rb.w).toBe(buttonAutoWidth("Option")); // GLYPH_W 同じ → 同値
    expect(rb.h).toBe(17);
  });
});

describe("NumberBox.remeasure", () => {
  beforeEach(() => setFont(5, 7));

  it("digits ベースで w が、BUTTON_AUTO_HEIGHT で h が更新される", () => {
    // digits は内部で max の桁数から自動計算される
    const nb = new NumberBox(0, 0, 0, 99, 0, 1, () => {});
    // digits = String(99).length = 2
    const w7 = tw("00") + BUTTON_PADDING * 2 + 4; // 11 + 12 = 23
    expect(nb.w).toBe(w7);
    expect(nb.h).toBe(19);

    setFont(5, 5);
    nb.remeasure();
    expect(nb.w).toBe(w7); // GLYPH_W 同じ → 同値
    expect(nb.h).toBe(17);
  });
});

describe("TextBox.remeasure", () => {
  beforeEach(() => setFont(5, 7));

  it("widthChars ベースで w, BUTTON_AUTO_HEIGHT で h が更新される", () => {
    const tb = new TextBox(0, 0, 10, 20, "", () => {});
    const charW = 5 + 1; // GLYPH_W + 1
    const innerW = 10 * charW + 5; // widthChars * charW + GLYPH_W
    const expectedW = innerW + BUTTON_PADDING * 2 + 4; // 65 + 12 = 77
    expect(tb.w).toBe(expectedW);
    expect(tb.h).toBe(19);

    setFont(5, 5);
    tb.remeasure();
    expect(tb.w).toBe(expectedW); // GLYPH_W 同じ → 同値
    expect(tb.h).toBe(17);
  });
});

describe("Slider.remeasure", () => {
  beforeEach(() => setFont(5, 7));

  it("h のみ更新、w はアプリ指定値を保持", () => {
    const sl = new Slider(0, 0, 120, 0, 100, 50, () => {});
    expect(sl.w).toBe(120);
    expect(sl.h).toBe(19);

    setFont(5, 5);
    sl.remeasure();
    expect(sl.w).toBe(120); // 不変
    expect(sl.h).toBe(17);
  });
});

describe("DropDown.remeasure", () => {
  beforeEach(() => setFont(5, 7));

  it("items の最大幅 + チェック幅 + アイコン幅 で w が更新される", () => {
    const items = ["ABC", "DE"];
    const dd = new DropDown(0, 0, items, 0, () => {});
    const maxW = tw("ABC"); // 17
    const CHECK_W = 7 + 3; // ICON_W + 3 = 10
    const expectedW = maxW + CHECK_W + BUTTON_PADDING * 2 + 7 + 8; // 17+10+8+7+8 = 50
    expect(dd.w).toBe(expectedW);
    expect(dd.h).toBe(19);

    setFont(5, 5);
    dd.remeasure();
    // w は GLYPH_W/ICON_W 不変なので同値
    expect(dd.w).toBe(expectedW);
    expect(dd.h).toBe(17);
  });
});

describe("ListBox.remeasure", () => {
  beforeEach(() => setFont(5, 7));

  it("visibleRows × LISTBOX_ITEM_HEIGHT + 4 で h が更新される", () => {
    const lb = new ListBox(0, 0, 5, ["ABC", "DE"], 0, () => {});
    const maxW = tw("ABC"); // 17
    const expectedW = maxW + BUTTON_PADDING * 2 + SCROLLBAR_SLOT_WIDTH + 4; // 17+8+10+4 = 39
    expect(lb.w).toBe(expectedW);
    expect(lb.h).toBe(5 * 15 + 4); // 79 (LISTBOX_ITEM_HEIGHT=15)

    setFont(5, 5);
    lb.remeasure();
    expect(lb.w).toBe(expectedW);
    expect(lb.h).toBe(5 * 13 + 4); // 69 (LISTBOX_ITEM_HEIGHT=13)
  });
});

describe("TextArea.remeasure", () => {
  beforeEach(() => setFont(5, 7));

  it("visibleRows × TEXTAREA_LINE_HEIGHT で h が更新される", () => {
    const ta = new TextArea(0, 0, 20, 5, 100, "", () => {});
    const charW = 5 + 1;
    const innerW = 20 * charW + 5; // 125
    const expectedW = innerW + BUTTON_PADDING * 2 + SCROLLBAR_SLOT_WIDTH + 4; // 125+8+10+4 = 147
    const innerH_7 = 5 * 10 - 1; // TEXTAREA_LINE_HEIGHT=10 → 49
    const expectedH_7 = innerH_7 + BUTTON_PADDING * 2 + SCROLLBAR_SLOT_WIDTH + 4; // 49+8+10+4 = 71
    expect(ta.w).toBe(expectedW);
    expect(ta.h).toBe(expectedH_7);

    setFont(5, 5);
    ta.remeasure();
    const innerH_5 = 5 * 8 - 1; // TEXTAREA_LINE_HEIGHT=8 → 39
    const expectedH_5 = innerH_5 + BUTTON_PADDING * 2 + SCROLLBAR_SLOT_WIDTH + 4; // 39+8+10+4 = 61
    expect(ta.w).toBe(expectedW);
    expect(ta.h).toBe(expectedH_5);
  });
});

describe("TreeView.remeasure", () => {
  beforeEach(() => setFont(5, 7));

  it("visibleRows × TREEVIEW_ITEM_HEIGHT + 4 で h が更新される", () => {
    const tv = new TreeView(
      0,
      0,
      100,
      5,
      [],
      () => {},
      () => {},
      () => {},
    );
    expect(tv.w).toBe(100); // アプリ指定
    expect(tv.h).toBe(5 * 15 + 4); // 79

    setFont(5, 5);
    tv.remeasure();
    expect(tv.w).toBe(100); // 不変
    expect(tv.h).toBe(5 * 13 + 4); // 69
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WidgetGroup.remeasureAll
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("WidgetGroup.remeasureAll", () => {
  beforeEach(() => setFont(5, 7));

  it("グループ内の全ウィジェットの remeasure() を呼ぶ", () => {
    const lbl = new Label(0, 0, "Test");
    const btn = new PushButton(0, 20, "Go", () => {});
    const group = new WidgetGroup([lbl, btn]);

    expect(lbl.h).toBe(7);
    expect(btn.h).toBe(19);

    setFont(5, 5);
    group.remeasureAll();

    expect(lbl.h).toBe(5);
    expect(btn.h).toBe(17);
  });

  it("空グループでもエラーにならない", () => {
    const group = new WidgetGroup([]);
    expect(() => group.remeasureAll()).not.toThrow();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  フォント切替シナリオ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("フォント切替シナリオ: 5x7 → 5x5 → 5x7", () => {
  it("5x7 → 5x5 → 5x7 の往復で元のサイズに戻る", () => {
    setFont(5, 7);
    const lbl = new Label(0, 0, "AB\nCD");
    const btn = new PushButton(0, 0, "OK", () => {});
    const lb = new ListBox(0, 0, 4, ["X"], 0, () => {});
    const ta = new TextArea(0, 0, 10, 3, 50, "", () => {});

    const origLblH = lbl.h;
    const origBtnH = btn.h;
    const origLbH = lb.h;
    const origTaH = ta.h;

    // 5x5 に切替
    setFont(5, 5);
    lbl.remeasure();
    btn.remeasure();
    lb.remeasure();
    ta.remeasure();

    expect(lbl.h).not.toBe(origLblH);
    expect(btn.h).not.toBe(origBtnH);
    expect(lb.h).not.toBe(origLbH);
    expect(ta.h).not.toBe(origTaH);

    // 5x7 に戻す
    setFont(5, 7);
    lbl.remeasure();
    btn.remeasure();
    lb.remeasure();
    ta.remeasure();

    expect(lbl.h).toBe(origLblH);
    expect(btn.h).toBe(origBtnH);
    expect(lb.h).toBe(origLbH);
    expect(ta.h).toBe(origTaH);
  });

  it("ユーザーデータ (TextArea.lines, NumberBox.value) は remeasure で消えない", () => {
    setFont(5, 7);
    const ta = new TextArea(0, 0, 10, 3, 50, "Hello\nWorld", () => {});
    const nb = new NumberBox(0, 0, 0, 999, 42, 1, () => {});

    setFont(5, 5);
    ta.remeasure();
    nb.remeasure();

    // ユーザーデータが保持されていることを確認
    expect(nb.value).toBe(42);
    // TextArea のテキストが保持されていることを確認
    expect(ta.getText()).toBe("Hello\nWorld");
  });
});

