/**
 * @module app/studio/studio
 * studio.js — STUDIO ウィンドウ
 *
 * 音楽制作関連機能を統合した単一ウィンドウ。
 * Transport (常時表示) + タブ切替 (INST / PIANO_ROLL) で構成される。
 *
 * 閉じるとき:
 *   - 再生中なら即停止
 *   - 未保存データがあれば確認ダイアログ (モーダル) を表示
 *   - 閉じた場合は全状態をリセット (再度開くと新規状態)
 */

import { hline } from "../../core/gpu.js";
import { wmOpen, wmClose, wmRegister } from "../../wm/index.js";
import {
  TabBar,
  PushButton,
  WidgetGroup,
  HBox,
  FOCUS_MARGIN,
  openConfirmDialog,
} from "../../ui/index.js";
import {
  drawTransport,
  onTransportInput,
  measureTransport,
  resetTransport,
} from "../../audio/transport.js";
import {
  stopPlayback,
  resetPlaybackEngine,
  renderToBuffer,
} from "../../audio/playback_engine.js";
import { resetDefaultChannel } from "../../core/audio.js";
import { encodeWav } from "../../core/wav.js";
import { writeFileBinary } from "../../core/vfs.js";
import { openFileDialog } from "../../ui/FileDialog.js";
import {
  drawSynth,
  onSynthInput,
  measureSynth,
  resetSynth,
  remeasureSynth,
} from "./synth_panel.js";
import {
  drawPianoRoll,
  onPianoRollInput,
  tracks,
  resetPianoRoll,
  remeasurePianoRoll,
  measurePianoRoll,
} from "./piano_roll.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const APP_NAME = "STUDIO";
const PADDING = 5;
const SEPARATOR_HEIGHT = 1;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  タブ (遅延初期化)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let activeTab = 0;

let tabBar;
let btnExport;
let tabWidgets;
let tabBarLayout;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  レイアウト計算 (遅延: _initWidgets 内で実行)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let transportSize;
let tabBarSize;

/** Transport セクションの高さ (コンテンツ + 上下パディング) */
let transportHeight;

/** タブバーセクションの高さ (コンテンツ + 上下パディング) */
let tabBarHeight;

/** タブコンテンツ上端までのオーバーヘッド */
let overhead;

let _ready = false;

function _initWidgets() {
  if (_ready) return;
  _ready = true;

  tabBar = new TabBar(
    0,
    0,
    ["INST", "PIANO_ROLL", "ARRANGEMENT", "MIXER"],
    (index) => {
      activeTab = index;
    },
  );
  btnExport = new PushButton(0, 0, "EXPORT WAV", exportWav);
  btnExport.tooltip = "Render loop range to WAV and save to VFS";
  tabWidgets = new WidgetGroup([tabBar, btnExport]);

  transportSize = measureTransport();

  tabBarLayout = HBox([tabBar, btnExport], PADDING);
  tabBarLayout.layout(0, 0);
  tabBarSize = tabWidgets.measure();

  transportHeight = transportSize.h + PADDING * 2;
  tabBarHeight = tabBarSize.h + PADDING * 2;
  overhead =
    transportHeight + SEPARATOR_HEIGHT + tabBarHeight + SEPARATOR_HEIGHT;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力ルーティング用キャッシュ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 最後の描画時のコンテンツ幅 (onInput で Transport 中央揃えに使用) */
let lastContentWidth = 0;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function drawStudio(contentRect) {
  _initWidgets();
  lastContentWidth = contentRect.w;

  // ── Transport (水平中央揃え) ──
  const tcr = {
    x: contentRect.x + (((contentRect.w - transportSize.w) / 2) | 0),
    y: contentRect.y + PADDING,
    w: transportSize.w,
    h: transportSize.h,
  };
  drawTransport(tcr);

  // 区切り線
  hline(
    contentRect.x,
    contentRect.x + contentRect.w - 1,
    contentRect.y + transportHeight,
    1,
  );

  // ── タブバー ──
  const tabY = contentRect.y + transportHeight + SEPARATOR_HEIGHT + PADDING;
  tabWidgets.draw({
    x: contentRect.x + FOCUS_MARGIN,
    y: tabY,
    w: contentRect.w,
    h: tabBarSize.h,
  });

  // 区切り線
  hline(
    contentRect.x,
    contentRect.x + contentRect.w - 1,
    contentRect.y + transportHeight + SEPARATOR_HEIGHT + tabBarHeight,
    1,
  );

  // ── タブコンテンツ ──
  const contentY = contentRect.y + overhead;
  const tabCr = {
    x: contentRect.x,
    y: contentY,
    w: contentRect.w,
    h: Math.max(0, contentRect.y + contentRect.h - contentY),
  };
  if (activeTab === 0) {
    drawSynth(tabCr);
  } else if (activeTab === 1) {
    drawPianoRoll(tabCr);
  } else if (activeTab === 2) {
    // drawArrangement(tabCr);
  } else if (activeTab === 3) {
    // drawMixer(tabCr);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onStudioInput(ev) {
  _initWidgets();
  if (ev.localY < transportHeight) {
    // ── Transport へルーティング (中央揃えオフセット) ──
    const ox = ((lastContentWidth - transportSize.w) / 2) | 0;
    onTransportInput({
      ...ev,
      localX: ev.localX - ox,
      localY: ev.localY - PADDING,
    });
  } else if (ev.localY < transportHeight + SEPARATOR_HEIGHT + tabBarHeight) {
    // ── タブバーへルーティング ──
    tabWidgets.update({
      ...ev,
      localX: ev.localX - FOCUS_MARGIN,
      localY: ev.localY - (transportHeight + SEPARATOR_HEIGHT + PADDING),
    });
  } else {
    // ── アクティブタブへルーティング ──
    const adjusted = {
      ...ev,
      localX: ev.localX,
      localY: ev.localY - overhead,
    };
    if (activeTab === 0) {
      onSynthInput(adjusted);
    } else if (activeTab === 1) {
      onPianoRollInput(adjusted);
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  測定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function measureStudio() {
  _initWidgets();
  const synthSize = measureSynth();
  const prSize = measurePianoRoll();
  const w = Math.max(
    transportSize.w,
    tabWidgets.measure().w + FOCUS_MARGIN * 2,
    synthSize.w,
    prSize.w,
  );
  const h = overhead + Math.max(synthSize.h, 281);
  return { w, h };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WAV Export
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ループ範囲のノートを WAV にオフラインレンダリングし、
 * FileDialog (Save) で選択されたパスに書き出す。
 */
function exportWav() {
  openFileDialog("save", {
    title: "EXPORT WAV",
    defaultPath: "/Music",
    defaultName: "export.wav",
    filter: [".wav"],
    onResult: (path) => {
      if (!path) return;

      // 拡張子が .wav でなければ付与
      if (!path.toLowerCase().endsWith(".wav")) {
        path += ".wav";
      }

      // オフラインレンダリング
      const { samples, sampleRate } = renderToBuffer({ sampleRate: 44100 });

      if (samples.length === 0) return; // ノートなし or 範囲 0

      // WAV エンコード
      const wavBuffer = encodeWav(samples, sampleRate, 16);

      // VFS に書き出し
      writeFileBinary(path, wavBuffer);
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  閉じる・リセット
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** STUDIO ウィンドウ ID */
let studioWinId = -1;

/** 未保存データがあるか判定 */
function hasUnsavedWork() {
  return tracks.some((t) => t.notes.length > 0);
}

/** 全サブシステムの状態を初期値にリセット */
function resetAllStudioState() {
  // オーディオエンジン (音を止める)
  resetDefaultChannel();
  resetPlaybackEngine();

  // UI ウィジェット
  resetTransport();
  resetPianoRoll();
  resetSynth();

  // タブ
  activeTab = 0;
  tabBar.setActive(0);
}

/**
 * onBeforeClose コールバック。
 * false を返すと閉じをキャンセルする。
 */
function onStudioBeforeClose() {
  // 再生中なら即停止
  stopPlayback();

  if (hasUnsavedWork()) {
    openConfirmDialog("DISCARD UNSAVED CHANGES?", {
      variant: "danger",
      onOk: () => {
        resetAllStudioState();
        wmClose(studioWinId);
      },
    });
    return false;
  }

  resetAllStudioState();
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    _initWidgets();
    studioWinId = wmOpen(
      -1,
      -1,
      0,
      0,
      APP_NAME,
      drawStudio,
      onStudioInput,
      measureStudio,
      {
        about:
          "A music workstation. Use the transport to play and record, and " +
          "switch between the instrument and piano-roll tabs to build a track.",
        onBeforeClose: onStudioBeforeClose,
        onRelayout: () => {
          tabBar.remeasure();
          btnExport.remeasure();
          tabBarLayout.layout(0, 0);
          tabBarSize = tabWidgets.measure();
          tabBarHeight = tabBarSize.h + PADDING * 2;
          overhead =
            transportHeight +
            SEPARATOR_HEIGHT +
            tabBarHeight +
            SEPARATOR_HEIGHT;
          remeasureSynth();
          remeasurePianoRoll();
        },
      },
    );
    return studioWinId;
  },
  { category: "CREATIVE", dev: true },
);

