/**
 * @module system_sfx
 * system_sfx.js — システム SFX のフック配線 (ルート層)
 *
 * どのシステムイベント (ウィンドウ開閉・ダイアログ・ボタン・メニュー等) で
 * どの SFX を鳴らすかを、各サブシステム (wm / ui) のコールバック注入点へ
 * 配線する。実際に音を鳴らす責務は core/sfx.js が持つ。
 *
 * この配線を core/ ではなくルート層に置くのは、wm/ ui/ への import を
 * 最下層 (core) から排除し、依存方向を「上→下」の一方向に保つため。
 *
 * ── 使用例 (kernel.js) ──
 *   import { initSystemSfxHooks } from "./system_sfx.js";
 *   initSystemSfxHooks();
 */

import { playSystemSfx, setSystemSfxEnabled } from "./core/sfx.js";
import { isSystemSfxOn } from "./config.js";
import { wmSetSfxCallbacks } from "./wm/index.js";
import { dialogSetSfxOnOpen } from "./ui/Dialog.js";
import { buttonSetSfxOnClick } from "./ui/widgets/PushButton.js";
import { toggleSetSfxOnChange } from "./ui/widgets/ToggleButton.js";
import { listboxSetSfxOnSelect } from "./ui/widgets/ListBox.js";
import { dropdownSetSfxOnSelect } from "./ui/widgets/DropDown.js";
import { radioSetSfxOnChange } from "./ui/widgets/RadioButton.js";

/**
 * WM・Dialog・UI ウィジェットに SFX コールバックを一括注入する。
 * kernel.js のブートシーケンスで 1 回呼ぶ。
 */
export function initSystemSfxHooks() {
  // ── config.js の永続値で初期状態を同期 ──
  setSystemSfxEnabled(isSystemSfxOn());

  // ── WM フック ──
  wmSetSfxCallbacks({
    onOpen: () => playSystemSfx("winOpen"),
    onClose: () => playSystemSfx("winClose"),
    onMaximize: () => playSystemSfx("maximize"),
    onMenu: () => playSystemSfx("menuOpen"),
    onMenuItem: () => playSystemSfx("menuSelect"),
  });

  // ── Dialog フック ──
  dialogSetSfxOnOpen((variant) => {
    if (variant === "danger") {
      playSystemSfx("dialogDanger");
    } else {
      playSystemSfx("dialogOpen");
    }
  });

  // ── UI ウィジェットフック ──
  buttonSetSfxOnClick(() => playSystemSfx("btnClick"));
  toggleSetSfxOnChange(() => playSystemSfx("toggle"));
  radioSetSfxOnChange(() => playSystemSfx("toggle"));
  listboxSetSfxOnSelect(() => playSystemSfx("listSelect"));
  dropdownSetSfxOnSelect(() => playSystemSfx("listSelect"));
}
