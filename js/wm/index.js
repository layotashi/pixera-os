/**
 * @module wm
 * index.js — ウィンドウマネージャ ファサード
 *
 * wm.js / desktop.js のすべてのパブリック API を re-export する。
 * 外部モジュールは `"../wm/index.js"` のみを import すればよい。
 */

export {
  // 定数
  HEADER_HEIGHT,
  CONTENT_PADDING,
  FOOTER_HEIGHT,

  // UI コールバック注入
  wmSetUiCallbacks,

  // SFX コールバック注入
  wmSetSfxCallbacks,

  // レイアウト
  wmSetWorkAreaTop,
  wmGetWorkAreaTop,

  // ウィンドウ登録・操作
  wmRegister,
  wmGetRegistry,
  wmGetContentRect,
  wmOpenByName,
  wmOpenOrFocus,
  wmOpen,
  wmClose,
  wmGetWindowList,
  wmGetWindowRect,
  wmIsFocused,
  wmIsModalOpen,
  wmSetTitle,
  wmFocus,
  wmSetContentSize,
  wmGetScroll,
  wmAttachScroll,
  wmSetFullscreen,
  wmToggleFullscreen,
  wmIsFullscreen,

  // メインループ
  wmUpdate,
  wmDraw,
  wmDrawSingleWindow,

  // カーソル・ツールチップ
  wmRequestCursor,
  wmSetTooltip,
} from "./wm.js";

// ── デスクトップアイコン ──
export {
  desktopSetIcons,
  desktopSetWorkAreaTop,
} from "./desktop.js";

