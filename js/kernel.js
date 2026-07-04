/**
 * @module kernel
 * kernel.js — ブートストラップ・メインループ
 *
 * エントリポイント。各サブシステムを初期化し、
 * requestAnimationFrame ベースのメインループを起動する。
 * index.html の <script type="module"> から読み込まれる。
 *
 * ブートシーケンス:
 *   1. GPU / Input 初期化
 *   2. UI ポート注入 (core → ui の DI)
 *   3. UI ↔ WM コールバック配線
 *   4. パレット復元
 *   5. フォント読み込み (スプラッシュ描画に必要)
 *   6. スプラッシュ演出 + 残りアセットの並行読み込み
 *   7. ディザトランジションでデスクトップにフェードイン
 *   8. メインループ開始
 */

import { initGpu, vram } from "./core/gpu.js";
import { initInput, resetInput, updateInputLog } from "./core/input.js";
import { initFont, getAllGlyphs, setGlyphs } from "./core/font.js";
import { initCursor, setCursorHidden } from "./core/cursor.js";
import { initIcon } from "./core/icon.js";
import { initTextIcon } from "./core/text_icon.js";
import { initAppIcon } from "./core/app_icon.js";
import * as VFS from "./core/vfs.js";
import { loadUserFonts } from "./core/user_fonts.js";

// ── UI ポート注入用: コアモジュールの namespace インポート ──
import * as gpuModule from "./core/gpu.js";
import * as fontModule from "./core/font.js";
import * as iconModule from "./core/icon.js";
import * as inputModule from "./core/input.js";
import * as textIconModule from "./core/text_icon.js";
import * as ditherModule from "./core/dither.js";
import { initWallpaper } from "./wallpaper.js";
import { update, draw } from "./app/app.js";
import { updateVramDump } from "./app/vram_dump.js";
// input_overlay.js は app.js 内で named import — initInputOverlay は不要
// (セマンティックイベントログは input.js が生成する)
import * as WM from "./wm/index.js";
import { WidgetGroup, initPorts } from "./ui/index.js";
import {
  transportSetPianoRollCallbacks,
  transportSetIsHostFocused,
} from "./audio/transport.js";
import { tracks, setPlayheadPos } from "./app/studio/piano_roll.js";
import * as Storage from "./core/storage.js";
import * as Config from "./config.js";
import { runSplash, fadeInDesktop } from "./splash.js";
import { initSystemSfxHooks } from "./system_sfx.js";

// ── メインループ ──

function mainLoop() {
  updateInputLog(); // セマンティックイベントログ構築 (wmUpdate の前)

  // ── VRAM ダンプモード (デバッグ用) ──
  // ダンプモード中は WM / アプリの入力処理をスキップし、
  // ダンプモジュールが入力を独占する。描画は継続。
  // DEV_MODE 時のみ有効化する。オーバーレイ描画 (app.js) も DEV_MODE
  // ゲート付きのため、本番では「画面に何も出ないまま入力を乗っ取られる」
  // ことがないようここでも揃える。
  const dumpBusy = Config.DEV_MODE ? updateVramDump() : false;

  if (!dumpBusy) {
    WM.wmUpdate();
    update();
  }
  draw();

  resetInput();

  requestAnimationFrame(mainLoop);
}

// ── ブート ──

async function boot() {
  try {
    initGpu();
    initInput();

    // ── エフェクトパラメータを display_fx へ反映 ──
    // initGpu() の後 (onEffectChange コールバック登録済み) に実行。
    // 保存値があれば復元し、無ければ既定 (EFFECT_DEFAULTS) のまま、いずれにせよ
    // _fireEffectCallbacks() を「常に」発火して display_fx を現在値に同期する。
    // (以前は保存値がある時だけ発火していたため、新規アクセス時に UI 上の既定値が
    //  実描画へ反映されず、一度値を変えるまで反映されないバグがあった)
    {
      const savedEffect = Storage.load("effect", null);
      if (savedEffect) Config._restoreEffectParams(savedEffect);
      Config._fireEffectCallbacks();
    }

    // ── ui ↔ wm コールバック接続 (循環依存回避) ──
    WM.wmSetUiCallbacks({
      flushPopups: () => WidgetGroup.flushPopups(),
      hasOpenPopup: () => WidgetGroup.hasOpenPopup(),
      hasTextInputFocus: () => WidgetGroup.hasTextInputFocus(),
      dispatchPopupInput: (sx, sy, ev) =>
        WidgetGroup.dispatchPopupInput(sx, sy, ev),
    });
    WidgetGroup.setWmCallbacks({
      setTooltip: WM.wmSetTooltip,
      requestCursor: WM.wmRequestCursor,
    });

    // ── transport → piano_roll コールバック接続 (層逆転回避) ──
    transportSetPianoRollCallbacks({
      getTracks: () => tracks,
      setPlayheadPos,
    });

    // ── transport ホストフォーカス判定 (STUDIO ウィンドウ依存) ──
    transportSetIsHostFocused(() => WM.wmIsFocused("STUDIO"));

    // ── システム SFX フック注入 ──
    initSystemSfxHooks();

    // ── config 永続化コールバック (責務分離) ──
    Config.configSetSaveCallback((key, value) => {
      switch (key) {
        case "palette":
          Storage.savePalette(value);
          break;
        case "resolution":
          Storage.saveResolution(value.w, value.h);
          break;
        case "customPalette":
          Storage.saveCustomPalette(value);
          break;
        case "effect":
        case "headerPad":
        case "contentPad":
        case "inputOverlay":
        case "systemSfx":
        case "fontId":
        case "invert":
          Storage.save(key, value);
          break;
      }
    });

    document.body.style.background = "#333";

    // ── 保存されたパレットを復元 ──
    const savedPalette = Storage.loadPalette(null);
    if (
      savedPalette &&
      (Config.PALETTES[savedPalette] ||
        savedPalette === Config.CUSTOM_PALETTE_NAME)
    ) {
      Config.setPalette(savedPalette);
    }

    // ── フォント切替コールバック (config → font.js の間接呼び出し) ──
    // 全フォントが 5x5 同一寸法のため、切替はグリフ内容のスワップのみ。
    // 寸法・アイコン・ports 再注入は不要 (content-swap)。
    Config.configSetFontSwitchCallback(async (fontDef) => {
      if (fontDef._glyphs) setGlyphs(fontDef._glyphs);
    });

    // ── フォント PNG の読み込み (スプラッシュ描画に必須) ──
    const initialFont = Config.getSystemFont();
    await initFont(
      `./assets/font/${initialFont.file}`,
      initialFont.glyphW,
      initialFont.glyphH,
      initialFont.cols,
    );
    // 組込デフォルトのグリフをスナップショットしてレジストリに格納する。
    // (ユーザーフォントから default へ戻す切替も content-swap で行えるように)
    Config.setFontGlyphs("default", getAllGlyphs());

    // ── ユーザーフォント (FONTSMITH 製) の登録と選択復元 ──
    VFS.initVfs();
    loadUserFonts();
    const savedFontId = Config.getSystemFontId();
    if (savedFontId !== "default") {
      const g = Config.getFontGlyphs(savedFontId);
      if (g) setGlyphs(g); // 保存されていたユーザーフォントを適用
    }

    // ── スプラッシュ演出 + 残りアセットの並行読み込み ──
    // フォント読み込み完了後、スプラッシュ演出と残りアセットを並行実行する。
    // 両方が完了してからデスクトップへ遷移する。
    const [
      /* splash */
    ] = await Promise.all([
      runSplash(),
      (async () => {
        await initCursor(); // カーソルPNGの読み込み
        await initIcon(`./assets/${initialFont.iconDir}/manifest.json`); // アイコンPNGの読み込み
        await initAppIcon(); // アプリアイコンPNGの読み込み
        await initTextIcon(`./assets/${initialFont.textIconDir}/manifest.json`); // テキストアイコンPNGの読み込み
        await initWallpaper(); // 壁紙の読み込み
      })(),
    ]);

    // ── UI ポート注入 (core → ui の依存逆転) ──
    // フォント・アイコンのロード完了後に呼ぶことで、
    // GLYPH_W/H ・ ICON_W/H が実際のフォントを反映した状態で
    // 派生定数 (BUTTON_AUTO_HEIGHT 等) を算出する。
    initPorts({
      gpu: gpuModule,
      font: fontModule,
      icon: iconModule,
      input: inputModule,
      textIcon: textIconModule,
      dither: ditherModule,
    });

    // ── wm.js 等の派生定数をロード済みフォントで再計算 ──
    // モジュール評価時に GLYPH_H=7 で算出された定数を
    // 実際のフォントに合わせて更新する。
    Config._fireFontChangeCallbacks();

    // ── デスクトップのフェードイン ──
    // メインループ開始前に1フレーム分の描画を行い VRAM スナップショットを取得し、
    // ディザトランジションでフェードインする。
    WM.wmUpdate();
    update();
    draw();
    const desktopSnapshot = new Uint8Array(vram);
    await fadeInDesktop(desktopSnapshot);

    // ── ブラウザウィンドウリサイズ時にスケールを再算出 ──
    window.addEventListener("resize", () => Config.autoScale());

    // ── フォーカス復帰時にスケールを再算出 ──
    // 全画面中の Alt+Tab でフォーカスを失うと resize イベントが縮小値で発火するが
    // autoScale() 側でスキップする。復帰時にここで正しい値に再計算する。
    window.addEventListener("focus", () => Config.autoScale());

    // ── テストフック (visual review harness 用) ──
    // tools/capture.mjs などのオフブラウザツールが SYNESTA の起動完了を
    // 検知し、ウィンドウを開いて canvas をスクリーンショットするためのフック。
    // 通常運用には影響しない (= 単なる名前空間注入)。
    /** @type {any} */ (window).__synesta = {
      booted: true,
      wmOpenByName: WM.wmOpenByName,
      wmGetRegistry: WM.wmGetRegistry,
      wmGetWindowList: WM.wmGetWindowList,
      wmGetWindowRect: WM.wmGetWindowRect,
      wmGetContentRect: WM.wmGetContentRect,
      // フルスクリーン検証用 (capture からの操作)
      wmSetFullscreen: WM.wmSetFullscreen,
      wmIsFullscreen: WM.wmIsFullscreen,
      // capture.mjs が screenshot 撮影前に視覚効果 (Diagonal scanline /
      // Vignette) を切るために使う。production には影響しない。
      setEffect: Config.setEffectParam,
      // capture.mjs がレビュー精度向上のためカーソルを隠す。production 不変。
      setCursorHidden,
    };

    mainLoop();
  } catch (e) {
    console.error("[SYNESTA] Boot failed:", e);
    document.body.style.background = "#000";
    document.body.style.color = "#f00";
    document.body.style.fontFamily = "monospace";
    document.body.style.padding = "20px";
    document.body.textContent = `SYNESTA boot failed: ${e.message}`;
  }
}

boot();

