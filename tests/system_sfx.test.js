/**
 * system_sfx.js — システム SFX フック配線テスト
 *
 * wm / ui の各注入点をモックし、initSystemSfxHooks() が正しいコールバックを
 * 配線すること、注入されたコールバック経由で対応する SFX が鳴ること、
 * config の初期値が _enabled に同期されることを検証する。
 * 再生層そのものの検証は tests/core/sfx.test.js を参照。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── モック: core/audio.js (再生層が使う) ──
const _mockChannels = {};
const _playSfxCalls = [];

vi.mock("@/core/audio.js", () => ({
  createSfxChannels: (defs) => {
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

// ── モック: wm/index.js ──
let _wmSfxCallbacks = null;
vi.mock("@/wm/index.js", () => ({
  wmSetSfxCallbacks: (cbs) => {
    _wmSfxCallbacks = cbs;
  },
}));

// ── モック: ui/Dialog.js ──
let _dialogSfxFn = null;
vi.mock("@/ui/Dialog.js", () => ({
  dialogSetSfxOnOpen: (fn) => {
    _dialogSfxFn = fn;
  },
}));

// ── モック: ui/widgets/PushButton.js ──
let _buttonSfxFn = null;
vi.mock("@/ui/widgets/PushButton.js", () => ({
  buttonSetSfxOnClick: (fn) => {
    _buttonSfxFn = fn;
  },
}));

// ── モック: ui/widgets/ToggleButton.js ──
let _toggleSfxFn = null;
vi.mock("@/ui/widgets/ToggleButton.js", () => ({
  toggleSetSfxOnChange: (fn) => {
    _toggleSfxFn = fn;
  },
}));

// ── モック: ui/widgets/RadioButton.js ──
let _radioSfxFn = null;
vi.mock("@/ui/widgets/RadioButton.js", () => ({
  radioSetSfxOnChange: (fn) => {
    _radioSfxFn = fn;
  },
}));

// ── モック: ui/widgets/ListBox.js ──
let _listSfxFn = null;
vi.mock("@/ui/widgets/ListBox.js", () => ({
  listboxSetSfxOnSelect: (fn) => {
    _listSfxFn = fn;
  },
}));

// ── モック: ui/widgets/DropDown.js ──
let _dropdownSfxFn = null;
vi.mock("@/ui/widgets/DropDown.js", () => ({
  dropdownSetSfxOnSelect: (fn) => {
    _dropdownSfxFn = fn;
  },
}));

// ── モック: config.js ──
let _mockSystemSfxOn = true;
vi.mock("@/config.js", () => ({
  isSystemSfxOn: () => _mockSystemSfxOn,
}));

// ── テスト対象 ──
import { initSystemSfxHooks } from "@/system_sfx.js";
import { setSystemSfxEnabled, isSystemSfxEnabled, _resetSfx, _flushPendingSfx } from "@/core/sfx.js";

// ── テスト ──

function resetAll() {
  _playSfxCalls.length = 0;
  _wmSfxCallbacks = null;
  _dialogSfxFn = null;
  _buttonSfxFn = null;
  _toggleSfxFn = null;
  _radioSfxFn = null;
  _listSfxFn = null;
  _dropdownSfxFn = null;
  _mockSystemSfxOn = true;
  _resetSfx();
}

describe("initSystemSfxHooks", () => {
  beforeEach(resetAll);

  it("WM SFX コールバックを注入する", () => {
    initSystemSfxHooks();
    expect(_wmSfxCallbacks).not.toBeNull();
    expect(typeof _wmSfxCallbacks.onOpen).toBe("function");
    expect(typeof _wmSfxCallbacks.onClose).toBe("function");
    expect(typeof _wmSfxCallbacks.onMaximize).toBe("function");
    expect(typeof _wmSfxCallbacks.onMenu).toBe("function");
    expect(typeof _wmSfxCallbacks.onMenuItem).toBe("function");
  });

  it("Dialog SFX コールバックを注入する", () => {
    initSystemSfxHooks();
    expect(_dialogSfxFn).not.toBeNull();
  });

  it("Button SFX コールバックを注入する", () => {
    initSystemSfxHooks();
    expect(_buttonSfxFn).not.toBeNull();
  });

  it("Toggle SFX コールバックを注入する", () => {
    initSystemSfxHooks();
    expect(_toggleSfxFn).not.toBeNull();
  });

  it("List / DropDown SFX コールバックを注入する", () => {
    initSystemSfxHooks();
    expect(_listSfxFn).not.toBeNull();
    expect(_dropdownSfxFn).not.toBeNull();
  });

  it("WM onOpen コールバックが winOpen SFX を再生する", () => {
    initSystemSfxHooks();
    _wmSfxCallbacks.onOpen();
    _flushPendingSfx();
    expect(_playSfxCalls).toHaveLength(1);
    expect(_playSfxCalls[0].ch.name).toBe("winOpen");
  });

  it("WM onClose コールバックが winClose SFX を再生する", () => {
    initSystemSfxHooks();
    _wmSfxCallbacks.onClose();
    _flushPendingSfx();
    expect(_playSfxCalls).toHaveLength(1);
    expect(_playSfxCalls[0].ch.name).toBe("winClose");
  });

  it("WM onMaximize コールバックが maximize SFX を再生する", () => {
    initSystemSfxHooks();
    _wmSfxCallbacks.onMaximize();
    _flushPendingSfx();
    expect(_playSfxCalls).toHaveLength(1);
    expect(_playSfxCalls[0].ch.name).toBe("maximize");
  });

  it("WM onMenu コールバックが menuOpen SFX を再生する", () => {
    initSystemSfxHooks();
    _wmSfxCallbacks.onMenu();
    _flushPendingSfx();
    expect(_playSfxCalls).toHaveLength(1);
    expect(_playSfxCalls[0].ch.name).toBe("menuOpen");
  });

  it("WM onMenuItem コールバックが menuSelect SFX を再生する", () => {
    initSystemSfxHooks();
    _wmSfxCallbacks.onMenuItem();
    _flushPendingSfx();
    expect(_playSfxCalls).toHaveLength(1);
    expect(_playSfxCalls[0].ch.name).toBe("menuSelect");
  });

  it("Dialog default variant → dialogOpen SFX", () => {
    initSystemSfxHooks();
    _dialogSfxFn("default");
    _flushPendingSfx();
    expect(_playSfxCalls[0].ch.name).toBe("dialogOpen");
  });

  it("Dialog danger variant → dialogDanger SFX", () => {
    initSystemSfxHooks();
    _dialogSfxFn("danger");
    _flushPendingSfx();
    expect(_playSfxCalls[0].ch.name).toBe("dialogDanger");
  });

  it("Button コールバック → btnClick SFX", () => {
    initSystemSfxHooks();
    _buttonSfxFn();
    _flushPendingSfx();
    expect(_playSfxCalls[0].ch.name).toBe("btnClick");
  });

  it("Toggle コールバック → toggle SFX", () => {
    initSystemSfxHooks();
    _toggleSfxFn();
    _flushPendingSfx();
    expect(_playSfxCalls[0].ch.name).toBe("toggle");
  });

  it("Radio コールバック → toggle SFX", () => {
    initSystemSfxHooks();
    _radioSfxFn();
    _flushPendingSfx();
    expect(_playSfxCalls[0].ch.name).toBe("toggle");
  });

  it("List / DropDown コールバック → listSelect SFX", () => {
    initSystemSfxHooks();
    _listSfxFn();
    _flushPendingSfx();
    expect(_playSfxCalls[0].ch.name).toBe("listSelect");
    _playSfxCalls.length = 0;
    _dropdownSfxFn();
    _flushPendingSfx();
    expect(_playSfxCalls[0].ch.name).toBe("listSelect");
  });

  it("SFX 無効時はコールバック経由でも再生されない", () => {
    initSystemSfxHooks();
    setSystemSfxEnabled(false);
    _wmSfxCallbacks.onOpen();
    _dialogSfxFn("default");
    _buttonSfxFn();
    _toggleSfxFn();
    _flushPendingSfx();
    expect(_playSfxCalls).toHaveLength(0);
  });

  it("config の初期値が false の場合、_enabled が false に同期される", () => {
    _mockSystemSfxOn = false;
    initSystemSfxHooks();
    expect(isSystemSfxEnabled()).toBe(false);
    _wmSfxCallbacks.onOpen();
    _flushPendingSfx();
    expect(_playSfxCalls).toHaveLength(0);
  });

  it("同一フレーム内の複数 SFX は最後のものだけ再生される (後勝ち debounce)", () => {
    initSystemSfxHooks();
    _wmSfxCallbacks.onOpen(); // winOpen
    _buttonSfxFn(); // btnClick
    _dialogSfxFn("default"); // dialogOpen
    _flushPendingSfx();
    expect(_playSfxCalls).toHaveLength(1);
    expect(_playSfxCalls[0].ch.name).toBe("dialogOpen");
  });
});
