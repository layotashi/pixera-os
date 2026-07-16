/**
 * synesta.test.js — SYNESTA (音楽アプリ群の統合入口) の起動・一括終了・グループ終了検出。
 *
 * SYNESTA は窓を持たないメタアプリで、SYNTH / ROLL / TRANSPORT / TRACK / OSCILLO / CHORD を束ねて
 * まとめて開閉する。WM ファサードをモックし、登録時の launch / isRunning / onClose と、
 * 毎フレームの synestaUpdate() を直接叩いて挙動を検証する:
 *   - launch: 全メンバーを開く
 *   - synestaUpdate: メンバーが 1 つでも閉じられたら残りも畳む (全開なら何もしない)
 *   - onClose: 全メンバーを閉じる
 *   - 閉じるのを拒んだメンバー (onBeforeClose キャンセル) は残る
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── WM ファサードのモック (openSet で開閉状態を模す) ──
const h = vi.hoisted(() => {
  const openSet = new Set();
  const close = (name) => {
    const had = openSet.has(name);
    openSet.delete(name);
    return had;
  };
  return {
    openSet,
    defaultClose: close,
    wmRegister: vi.fn(),
    wmOpenOrFocus: vi.fn((name) => openSet.add(name)),
    wmIsOpenByName: vi.fn((name) => openSet.has(name)),
    wmCloseByName: vi.fn(close),
  };
});

vi.mock("@/wm/index.js", () => ({
  wmRegister: h.wmRegister,
  wmOpenOrFocus: h.wmOpenOrFocus,
  wmIsOpenByName: h.wmIsOpenByName,
  wmCloseByName: h.wmCloseByName,
}));

import { synestaUpdate } from "@/app/synesta.js";

// 登録時に渡された opts (launch / isRunning / onClose) を取り出す。
const regCall = h.wmRegister.mock.calls[0];
const APP_NAME = regCall[0];
const opts = regCall[2];

const MEMBERS = ["OSCILLO", "CHORD", "TRANSPORT", "TRACK", "SYNTH", "ROLL"];

beforeEach(() => {
  // wmCloseByName の実装を既定へ戻す (前テストの上書きを解除)
  h.wmCloseByName.mockImplementation(h.defaultClose);
  // SYNESTA のセッション状態をリセット (_session=false)
  opts.onClose();
  h.openSet.clear();
  h.wmOpenOrFocus.mockClear();
  h.wmIsOpenByName.mockClear();
  h.wmCloseByName.mockClear();
});

describe("SYNESTA — 起動 / 終了のまとまり", () => {
  it("SYNESTA として 1 つの入口で登録される", () => {
    expect(APP_NAME).toBe("SYNESTA");
    expect(opts.dev).toBe(true);
    expect(typeof opts.launch).toBe("function");
    expect(typeof opts.onClose).toBe("function");
    expect(typeof opts.isRunning).toBe("function");
  });

  it("launch: 全メンバー (SYNTH/ROLL/TRANSPORT/TRACK/OSCILLO/CHORD) を開き、isRunning が true になる", () => {
    opts.launch();
    for (const m of MEMBERS) expect(h.openSet.has(m)).toBe(true);
    expect(opts.isRunning()).toBe(true);
  });

  it("isRunning: 起動前は false", () => {
    expect(opts.isRunning()).toBe(false);
  });

  it("synestaUpdate: 全メンバーが開いている間は何もしない", () => {
    opts.launch();
    h.wmCloseByName.mockClear();
    synestaUpdate();
    expect(h.wmCloseByName).not.toHaveBeenCalled();
    expect(h.openSet.size).toBe(MEMBERS.length);
  });

  it("synestaUpdate: メンバーが 1 つ閉じられたら残りもまとめて閉じる", () => {
    opts.launch();
    h.openSet.delete("SYNTH"); // ユーザーが SYNTH ウィンドウを閉じた
    synestaUpdate();
    expect(h.openSet.size).toBe(0); // 残りも畳まれる
    expect(opts.isRunning()).toBe(false);
  });

  it("synestaUpdate: 全メンバーが閉じ切ったらセッションだけ終える", () => {
    opts.launch();
    h.openSet.clear(); // 最後の 1 つまで閉じた
    synestaUpdate();
    expect(opts.isRunning()).toBe(false);
  });

  it("onClose: 全メンバーを閉じる", () => {
    opts.launch();
    opts.onClose();
    expect(h.openSet.size).toBe(0);
    expect(opts.isRunning()).toBe(false);
  });

  it("一括終了で onBeforeClose をキャンセルしたメンバーは残る (破棄確認の尊重)", () => {
    opts.launch();
    // ROLL だけは閉じをキャンセルする (破棄確認ダイアログを出した想定)
    h.wmCloseByName.mockImplementation((name) => {
      if (name === "ROLL") return false;
      return h.defaultClose(name);
    });
    h.openSet.delete("TRACK"); // どれか 1 つが閉じられて teardown をトリガ
    synestaUpdate();
    expect(h.openSet.has("ROLL")).toBe(true); // ROLL は残る
    expect(h.openSet.has("SYNTH")).toBe(false); // 他は閉じる
    expect(h.openSet.has("OSCILLO")).toBe(false);
  });
});
