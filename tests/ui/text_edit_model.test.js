/**
 * text_edit_model.test.js — TextEditModel（純粋な文書/選択/Undo エンジン）の単体テスト。
 *
 * TextArea から切り出した編集コアの回帰ガード。Ports/GPU 非依存なのでモック不要。
 * 選択範囲・矩形選択・単語境界・Undo コアレスなど、従来テストが無かった中核を固める。
 */
import { describe, it, expect } from "vitest";
import { TextEditModel } from "@/ui/text_edit_model.js";

/** 選択アンカーとカーソルを一度に設定するテストヘルパ。 */
function selectRange(m, ar, ac, cr, cc) {
  m.selectionAnchorRow = ar;
  m.selectionAnchorCol = ac;
  m.cursorRow = cr;
  m.cursorCol = cc;
}

describe("TextEditModel 初期化", () => {
  it("テキストを行に分割し、カーソルを 1 行目末尾に置く", () => {
    const m = new TextEditModel("AB\nCDE", 100);
    expect(m.lines).toEqual(["AB", "CDE"]);
    expect(m.cursorRow).toBe(0);
    expect(m.cursorCol).toBe(2);
    expect(m.getText()).toBe("AB\nCDE");
  });

  it("maxLines で行数を切り詰める", () => {
    const m = new TextEditModel("A\nB\nC", 2);
    expect(m.lines).toEqual(["A", "B"]);
  });
});

describe("ストリーム選択", () => {
  it("正規化された範囲を返す（逆向き選択も昇順に）", () => {
    const m = new TextEditModel("HELLO WORLD", 100);
    selectRange(m, 0, 8, 0, 2); // アンカーがカーソルより後ろ
    expect(m._getSelectionRange()).toEqual([0, 2, 0, 8]);
  });

  it("アンカーとカーソルが同一なら選択なし (null)", () => {
    const m = new TextEditModel("HELLO", 100);
    selectRange(m, 0, 2, 0, 2);
    expect(m._getSelectionRange()).toBe(null);
  });

  it("単一行の選択を削除しカーソルを開始位置へ", () => {
    const m = new TextEditModel("HELLO WORLD", 100);
    selectRange(m, 0, 0, 0, 6); // "HELLO "
    expect(m._deleteSelection()).toBe(true);
    expect(m.getText()).toBe("WORLD");
    expect(m.cursorRow).toBe(0);
    expect(m.cursorCol).toBe(0);
    expect(m.selectionAnchorRow).toBe(null);
  });

  it("複数行の選択を削除し行を結合する", () => {
    const m = new TextEditModel("ABC\nDEF\nGHI", 100);
    selectRange(m, 0, 1, 2, 1); // "BC\nDEF\nG"
    m._deleteSelection();
    expect(m.getText()).toBe("AHI");
  });

  it("selectedCharCount は選択文字数（改行含む）を返す", () => {
    const m = new TextEditModel("ABC\nDEF", 100);
    selectRange(m, 0, 1, 1, 1); // "BC\nD" = 4 文字
    expect(m.selectedCharCount()).toBe(4);
  });
});

describe("矩形選択", () => {
  it("矩形範囲のテキストを列で切り出す", () => {
    const m = new TextEditModel("ABCD\nEFGH\nIJKL", 100);
    m.boxSelection = { anchorRow: 0, anchorCol: 1, cursorRow: 2, cursorCol: 3 };
    expect(m._getBoxSelectionText()).toBe("BC\nFG\nJK");
  });

  it("矩形範囲を各行から削除する", () => {
    const m = new TextEditModel("ABCD\nEFGH", 100);
    m.boxSelection = { anchorRow: 0, anchorCol: 1, cursorRow: 1, cursorCol: 3 };
    expect(m._deleteBoxSelection()).toBe(true);
    expect(m.getText()).toBe("AD\nEH");
    expect(m.boxSelection).toBe(null);
  });

  it("selectedCharCount は矩形の合計文字数を返す", () => {
    const m = new TextEditModel("ABCD\nEFGH", 100);
    m.boxSelection = { anchorRow: 0, anchorCol: 1, cursorRow: 1, cursorCol: 3 };
    expect(m.selectedCharCount()).toBe(4); // 各行 2 文字 × 2 行
  });
});

describe("単語境界", () => {
  it("左境界は同カテゴリの連なりの先頭へ", () => {
    const m = new TextEditModel("FOO BAR", 100);
    expect(m._findWordBoundaryLeft(0, 7)).toEqual({ row: 0, col: 4 }); // "BAR" の先頭
  });

  it("右境界は同カテゴリの連なりの直後へ", () => {
    const m = new TextEditModel("FOO BAR", 100);
    expect(m._findWordBoundaryRight(0, 0)).toEqual({ row: 0, col: 3 }); // "FOO" の後
  });

  it("行頭での左境界は前行の末尾へ", () => {
    const m = new TextEditModel("AB\nCD", 100);
    expect(m._findWordBoundaryLeft(1, 0)).toEqual({ row: 0, col: 2 });
  });
});

describe("Undo / Redo", () => {
  it("編集前スナップショットを記録し、applyUndo で復元する", () => {
    const m = new TextEditModel("AB", 100);
    const before = m._snapshot();
    m.lines[0] = "ABC";
    m.cursorCol = 3;
    m._recordEdit(before, "struct");

    expect(m.applyUndo()).toBe(true);
    expect(m.getText()).toBe("AB");
    expect(m.applyRedo()).toBe(true);
    expect(m.getText()).toBe("ABC");
  });

  it("連続 type 編集は 1 ステップにコアレスされる", () => {
    const m = new TextEditModel("A", 100);
    const b1 = m._snapshot();
    m.lines[0] = "AB";
    m._recordEdit(b1, "type");
    const b2 = m._snapshot();
    m.lines[0] = "ABC";
    m._recordEdit(b2, "type"); // 時間窓内 → コアレス（b2 は積まれない）

    expect(m.applyUndo()).toBe(true);
    expect(m.getText()).toBe("A"); // 2 編集がまとめて取り消される
    expect(m.applyUndo()).toBe(false); // それ以上は無い
  });

  it("struct 編集はコアレスせず別ステップになる", () => {
    const m = new TextEditModel("A", 100);
    const b1 = m._snapshot();
    m.lines[0] = "AB";
    m._recordEdit(b1, "type");
    const b2 = m._snapshot();
    m.lines[0] = "ABC";
    m._recordEdit(b2, "struct");

    m.applyUndo();
    expect(m.getText()).toBe("AB");
    m.applyUndo();
    expect(m.getText()).toBe("A");
  });

  it("空スタックでの applyUndo / applyRedo は false", () => {
    const m = new TextEditModel("A", 100);
    expect(m.applyUndo()).toBe(false);
    expect(m.applyRedo()).toBe(false);
  });

  it("clearHistory で履歴が消える", () => {
    const m = new TextEditModel("A", 100);
    m._recordEdit(m._snapshot(), "struct");
    m.clearHistory();
    expect(m.applyUndo()).toBe(false);
  });

  it("snapshotForUndo は現在状態を 1 ステップとして積む", () => {
    const m = new TextEditModel("A", 100);
    m.snapshotForUndo();
    m.lines[0] = "AZ";
    expect(m.applyUndo()).toBe(true);
    expect(m.getText()).toBe("A");
  });
});
