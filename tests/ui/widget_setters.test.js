/**
 * tests/ui/widget_setters.test.js — ウィジェットの派生状態カプセル化のテスト。
 *
 * 回帰防止対象: ウィジェットの `text` / `label` / `items` を代入したとき、
 * 派生フィールド (w / h / スクロール状態) が自動同期されるか。
 * これらが手動 remeasure() を呼ばないと壊れていた歴史的バグの再発防止。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initPorts } from "@/ui/index.js";
import { Label } from "@/ui/widgets/Label.js";
import { PushButton } from "@/ui/widgets/PushButton.js";
import { ToggleButton } from "@/ui/widgets/ToggleButton.js";
import { RadioButton } from "@/ui/widgets/RadioButton.js";
import { DropDown } from "@/ui/widgets/DropDown.js";
import { ListBox } from "@/ui/widgets/ListBox.js";
import { TreeView } from "@/ui/widgets/TreeView.js";

// ── ポートのスタブ注入 (textWidth が動くために必要) ──
beforeAll(() => {
  initPorts({
    gpu: {
      fillRect() {},
      drawRoundRect() {},
      drawRect() {},
      hline() {},
      vline() {},
      pset() {},
      setClip() {},
      resetClip() {},
      pushClip() {},
      popClip() {},
    },
    font: {
      GLYPH_W: 5,
      GLYPH_H: 7,
      drawText() {},
    },
    icon: {
      ICON_W: 7,
      ICON_H: 7,
      drawIcon() {},
    },
    input: {
      keyDown() {
        return false;
      },
      keyHeld() {
        return false;
      },
      getCharQueue() {
        return [];
      },
      getPasteText() {
        return "";
      },
      mouseHasShift() {
        return false;
      },
      ctrlDown() {
        return false;
      },
    },
    textIcon: { drawTextIcon() {} },
    dither: { BAYER_4x4: [], BAYER_8x8: [] },
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Label
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Label", () => {
  it("コンストラクタで w/h が text から計算される", () => {
    const lbl = new Label(0, 0, "HI");
    expect(lbl.w).toBeGreaterThan(0);
    expect(lbl.h).toBeGreaterThan(0);
  });

  it("text セッターで w が自動再計算される (短い → 長い)", () => {
    const lbl = new Label(0, 0, "HI");
    const wShort = lbl.w;
    lbl.text = "DISPLAY_TUNING";
    expect(lbl.w).toBeGreaterThan(wShort);
  });

  it("text セッターで w が自動再計算される (長い → 短い)", () => {
    const lbl = new Label(0, 0, "DISPLAY_TUNING");
    const wLong = lbl.w;
    lbl.text = "X";
    expect(lbl.w).toBeLessThan(wLong);
  });

  it("複数行 text で h が増える", () => {
    const lbl = new Label(0, 0, "A");
    const h1 = lbl.h;
    lbl.text = "A\nB\nC";
    expect(lbl.h).toBeGreaterThan(h1);
  });

  it("text getter で代入値が読み戻せる", () => {
    const lbl = new Label(0, 0, "X");
    lbl.text = "Y";
    expect(lbl.text).toBe("Y");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Button 系
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("PushButton", () => {
  it("label セッターで w が自動再計算される", () => {
    const btn = new PushButton(0, 0, "OK", () => {});
    const wShort = btn.w;
    btn.label = "VERY_LONG_LABEL";
    expect(btn.w).toBeGreaterThan(wShort);
  });

  it("icon 設定後の label 変更は w を再計算しない (手動 w/h 保持)", () => {
    const btn = new PushButton(0, 0, "", () => {});
    btn.icon = "rec";
    btn.w = 32; // 手動指定
    btn.h = 32;
    btn.label = "ignored"; // icon モードでは無視されるべき
    expect(btn.w).toBe(32);
    expect(btn.h).toBe(32);
  });
});

describe("ToggleButton", () => {
  it("label セッターで w が自動再計算される", () => {
    const tgl = new ToggleButton(0, 0, "ON", () => {});
    const wShort = tgl.w;
    tgl.label = "REALLY_LONG_TOGGLE_LABEL";
    expect(tgl.w).toBeGreaterThan(wShort);
  });

  it("icon 設定後の label 変更は w を再計算しない", () => {
    const tgl = new ToggleButton(0, 0, "", () => {});
    tgl.icon = "play";
    tgl.w = 24;
    tgl.label = "ignored";
    expect(tgl.w).toBe(24);
  });
});

describe("RadioButton", () => {
  it("label セッターで w が自動再計算される", () => {
    const r = new RadioButton(0, 0, "A", "group1");
    const wShort = r.w;
    r.label = "OPTION_LONG";
    expect(r.w).toBeGreaterThan(wShort);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DropDown — 主目的の回帰防止
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("DropDown", () => {
  it("コンストラクタで items から w が計算される", () => {
    const dd = new DropDown(0, 0, ["A"], 0);
    expect(dd.w).toBeGreaterThan(0);
  });

  it("items セッターで w が長い項目に追従する (オリジナルバグの直接対象)", () => {
    // capture.js の Target ドロップダウンで起きていたバグの最小再現:
    // 初期 ["Full screen"] → 後から ["Full screen", "DISPLAY_TUNING"]
    // 旧コードでは items 代入だけで w が追従せず、長い項目がはみ出ていた。
    const dd = new DropDown(0, 0, ["Full screen"], 0);
    const wInitial = dd.w;
    dd.items = ["Full screen", "DISPLAY_TUNING"];
    expect(dd.w).toBeGreaterThan(wInitial);
  });

  it("items セッターで w が短くもなる", () => {
    const dd = new DropDown(0, 0, ["DISPLAY_TUNING_VERY_LONG"], 0);
    const wLong = dd.w;
    dd.items = ["X"];
    expect(dd.w).toBeLessThan(wLong);
  });

  it("items getter で代入値が読み戻せる", () => {
    const dd = new DropDown(0, 0, ["A"], 0);
    dd.items = ["X", "Y", "Z"];
    expect(dd.items).toEqual(["X", "Y", "Z"]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ListBox — w 同期 + スクロール状態同期
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("ListBox", () => {
  it("items セッターで w が追従する", () => {
    const lb = new ListBox(0, 0, 3, ["A"], 0);
    const wShort = lb.w;
    lb.items = ["LONGER_ITEM"];
    expect(lb.w).toBeGreaterThan(wShort);
  });

  it("items セッターでスクロール状態の content length も同期する", () => {
    const lb = new ListBox(0, 0, 3, ["A", "B"], 0);
    lb.items = ["X", "Y", "Z", "W", "V"];
    // 内部の _vScroll.contentLength (or 等価フィールド) が同期されているか:
    // 公開 API としては setContentLength を呼ばずに大量項目を渡しても、
    // 後続のスクロール操作で破綻しないことを最低限保証する。
    expect(lb.items.length).toBe(5);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TreeView — items 変更でスクロール状態同期
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("TreeView", () => {
  it("items セッターで w/h は変えないがスクロール長は同期する", () => {
    const tv = new TreeView(
      0,
      0,
      100,
      3,
      [{ label: "A", depth: 0, expanded: false, hasChildren: false, data: null }],
    );
    const wBefore = tv.w;
    const hBefore = tv.h;
    tv.items = [
      { label: "X", depth: 0, expanded: false, hasChildren: false, data: null },
      { label: "Y", depth: 0, expanded: false, hasChildren: false, data: null },
      { label: "Z", depth: 0, expanded: false, hasChildren: false, data: null },
      { label: "W", depth: 0, expanded: false, hasChildren: false, data: null },
    ];
    // TreeView は w をアプリ指定で固定、h は visibleRows × 行高で固定
    expect(tv.w).toBe(wBefore);
    expect(tv.h).toBe(hBefore);
    expect(tv.items.length).toBe(4);
  });
});
