/**
 * core/sfx.js — システム SFX 再生層テスト
 *
 * createSfxChannels / playSfx をモックして、playSystemSfx の
 * 有効/無効切替・SFX 名→MIDI ノートマッピング・後勝ち debounce を検証。
 * フック配線 (initSystemSfxHooks) は tests/system_sfx.test.js を参照。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── モック: core/audio.js ──
const _mockChannels = {};
const _playSfxCalls = [];

vi.mock("@/core/audio.js", () => ({
  createSfxChannels: (defs) => {
    // 各キーに対して SynthChannel のスタブを生成
    const result = {};
    for (const key of Object.keys(defs)) {
      result[key] = { name: key, ...defs[key] };
      _mockChannels[key] = result[key];
    }
    return result;
  },
  playSfx: (ch, note, duration) => {
    _playSfxCalls.push({ ch, note, duration });
  },
}));

// ── テスト対象 ──
import {
  playSystemSfx,
  setSystemSfxEnabled,
  isSystemSfxEnabled,
  _resetSfx,
  _flushPendingSfx,
} from "@/core/sfx.js";

// ── テスト ──

function resetAll() {
  _playSfxCalls.length = 0;
  _resetSfx();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  playSystemSfx
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("playSystemSfx", () => {
  beforeEach(resetAll);

  it("playSfx に duration 引数を渡す", () => {
    playSystemSfx("winOpen");
    _flushPendingSfx();
    expect(_playSfxCalls).toHaveLength(1);
    expect(_playSfxCalls[0].note).toBe(72); // C5
    expect(_playSfxCalls[0].ch.name).toBe("winOpen");
    expect(typeof _playSfxCalls[0].duration).toBe("number");
    expect(_playSfxCalls[0].duration).toBeGreaterThan(0);
  });

  it("2 回目は同じチャンネルを再利用する", () => {
    playSystemSfx("winOpen");
    _flushPendingSfx();
    const ch1 = _playSfxCalls[0].ch;
    playSystemSfx("winOpen");
    _flushPendingSfx();
    expect(_playSfxCalls[1].ch).toBe(ch1);
  });

  it("各 SFX イベントが正しい MIDI ノートで呼ばれる", () => {
    const expected = {
      winOpen: 72,
      winClose: 60,
      maximize: 67,
      dialogOpen: 65,
      dialogDanger: 55,
      btnClick: 76,
      toggle: 74,
      menuOpen: 69,
      menuSelect: 72,
    };
    for (const [name, note] of Object.entries(expected)) {
      _playSfxCalls.length = 0;
      playSystemSfx(name);
      _flushPendingSfx();
      expect(_playSfxCalls[0].note).toBe(note);
    }
  });

  it("存在しない SFX 名では playSfx が呼ばれない", () => {
    playSystemSfx("nonExistent");
    _flushPendingSfx();
    expect(_playSfxCalls).toHaveLength(0);
  });

  it("同一フレーム内の複数 SFX は最後のものだけ再生される (後勝ち debounce)", () => {
    playSystemSfx("winOpen");
    playSystemSfx("btnClick");
    playSystemSfx("dialogOpen");
    _flushPendingSfx();
    expect(_playSfxCalls).toHaveLength(1);
    expect(_playSfxCalls[0].ch.name).toBe("dialogOpen");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  setSystemSfxEnabled / isSystemSfxEnabled
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("setSystemSfxEnabled", () => {
  beforeEach(resetAll);

  it("デフォルトは有効", () => {
    expect(isSystemSfxEnabled()).toBe(true);
  });

  it("無効にすると playSystemSfx が何もしない", () => {
    setSystemSfxEnabled(false);
    playSystemSfx("winOpen");
    _flushPendingSfx();
    expect(_playSfxCalls).toHaveLength(0);
  });

  it("再度有効にすると再生される", () => {
    setSystemSfxEnabled(false);
    setSystemSfxEnabled(true);
    playSystemSfx("winOpen");
    _flushPendingSfx();
    expect(_playSfxCalls).toHaveLength(1);
  });

  it("isSystemSfxEnabled が状態を反映する", () => {
    setSystemSfxEnabled(false);
    expect(isSystemSfxEnabled()).toBe(false);
    setSystemSfxEnabled(true);
    expect(isSystemSfxEnabled()).toBe(true);
  });
});
