/**
 * @module audio/transport
 * transport.js — トランスポート UI ウィジェット
 *
 * 再生制御ボタン・BPM・ループ範囲を表示するウィジェット。
 * 再生エンジンの実体は playback_engine.js に分離されている。
 *
 * 描画・入力・測定関数をエクスポートし、
 * app_studio.js が STUDIO ウィンドウ内に配置する。
 */

import * as Config from "../config.js";
import * as PE from "./playback_engine.js";
import { keyDown } from "../core/input.js";
import { drawIcon, ICON_W, ICON_H } from "../core/icon.js";
import * as UI from "../ui/index.js";

// re-export: kernel.js → playback_engine.js へのコールバック注入
export { transportSetPianoRollCallbacks } from "./playback_engine.js";

// ── ホストウィンドウ フォーカス判定コールバック ──
let _isHostFocused = () => true;

/**
 * Space キー等のグローバルショートカットを
 * ホストウィンドウがフォーカス中の場合のみ有効にするためのコールバックを設定する。
 * @param {() => boolean} fn  ホストウィンドウがフォーカス中なら true を返す関数
 */
export function transportSetIsHostFocused(fn) {
  _isHostFocused = fn;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ループ範囲 NumberBox 同期
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function syncStartNbs() {
  const p = PE.stepToPos(PE.getLoopStart());
  numberBoxStartBar.value = p.bar;
  numberBoxStartBeat.value = p.beat;
  numberBoxStartSub.value = p.sub;
}

function syncEndNbs() {
  const p = PE.stepToPos(PE.getLoopEnd());
  numberBoxEndBar.value = p.bar;
  numberBoxEndBeat.value = p.beat;
  numberBoxEndSub.value = p.sub;
}

function onLoopStartChange() {
  const step = PE.posToStep(
    numberBoxStartBar.value,
    numberBoxStartBeat.value,
    numberBoxStartSub.value,
  );
  const result = PE.setLoopStart(step);
  // 整合後の値でNBを再同期
  const ps = PE.stepToPos(result.start);
  numberBoxStartBar.value = ps.bar;
  numberBoxStartBeat.value = ps.beat;
  numberBoxStartSub.value = ps.sub;
  const pe = PE.stepToPos(result.end);
  numberBoxEndBar.value = pe.bar;
  numberBoxEndBeat.value = pe.beat;
  numberBoxEndSub.value = pe.sub;
}

function onLoopEndChange() {
  const step = PE.posToStep(
    numberBoxEndBar.value,
    numberBoxEndBeat.value,
    numberBoxEndSub.value,
  );
  const result = PE.setLoopEnd(step);
  const ps = PE.stepToPos(result.start);
  numberBoxStartBar.value = ps.bar;
  numberBoxStartBeat.value = ps.beat;
  numberBoxStartSub.value = ps.sub;
  const pe = PE.stepToPos(result.end);
  numberBoxEndBar.value = pe.bar;
  numberBoxEndBeat.value = pe.beat;
  numberBoxEndSub.value = pe.sub;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィジェット定義 (遅延初期化)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ボタンのパディング (px): 両側 */
const BUTTON_PADDING = 8;
/** ボタンのボーダー幅 (px) */
const BUTTON_BORDER_WIDTH = 4;

let buttonPlay;
let buttonStop;
let labelBpm;
let numberBoxBpm;
let toggleLoop;
let toggleMetronome;
let labelPositionValue;
let vsep1;
let vsep2;
let numberBoxStartBar;
let numberBoxStartBeat;
let numberBoxStartSub;
let numberBoxEndBar;
let numberBoxEndBeat;
let numberBoxEndSub;
let transportGroup;
let transportRoot;
/** BPM 行の四分音符アイコン用スペーサー (手動描画される icon の位置基準) */
let bpmSpacer;
let _ready = false;

function _initWidgets() {
  if (_ready) return;
  _ready = true;

  buttonPlay = new UI.ToggleButton(0, 0, "", (v) => {
    if (v) {
      PE.startPlayback();
    } else {
      PE.pausePlayback();
    }
  });
  buttonPlay.icon = "play";
  buttonPlay.w = ICON_W + BUTTON_PADDING + BUTTON_BORDER_WIDTH;
  buttonPlay.h = ICON_H + BUTTON_PADDING + BUTTON_BORDER_WIDTH;
  buttonPlay.tooltip = "Play / Pause";

  buttonStop = new UI.PushButton(0, 0, "", () => {
    PE.stopPlayback();
    buttonPlay.value = false;
    toggleMetronome.icon = "metro-l";
  });
  buttonStop.icon = "stop";
  buttonStop.w = ICON_W + BUTTON_PADDING + BUTTON_BORDER_WIDTH;
  buttonStop.h = ICON_H + BUTTON_PADDING + BUTTON_BORDER_WIDTH;
  buttonStop.tooltip = "Stop and rewind";

  labelBpm = new UI.Label(0, 0, "=");
  numberBoxBpm = new UI.NumberBox(
    0,
    0,
    Config.BPM_MIN,
    Config.BPM_MAX,
    Config.DEFAULT_BPM,
    1,
    (v) => {
      PE.setBpm(v);
    },
  );
  numberBoxBpm.tooltip = "Set tempo (BPM)";

  toggleLoop = new UI.ToggleButton(0, 0, "", (v) => {
    PE.playbackSetLooping(v);
  });
  toggleLoop.icon = "loop";
  toggleLoop.w = ICON_W + 8 + 4;
  toggleLoop.h = ICON_H + 8 + 4;
  toggleLoop.value = true;
  toggleLoop.tooltip = "Toggle loop";

  toggleMetronome = new UI.ToggleButton(0, 0, "", (v) => {
    PE.playbackSetMetronomeEnabled(v);
  });
  toggleMetronome.icon = "metro-l";
  toggleMetronome.w = ICON_W + 8 + 4;
  toggleMetronome.h = ICON_H + 8 + 4;
  toggleMetronome.value = true;
  toggleMetronome.tooltip = "Toggle metronome";

  // ── POS 表示 (数値のみ) ──
  labelPositionValue = new UI.Label(0, 0, "1.1.1");

  // ── 垂直セパレータ ──
  vsep1 = new UI.VSep(0, 0, 1);
  vsep2 = new UI.VSep(0, 0, 1);

  // ── ループ START ──
  numberBoxStartBar = new UI.NumberBox(
    0,
    0,
    1,
    PE.PIANO_ROLL_TOTAL_BARS + 1,
    1,
    1,
    onLoopStartChange,
  );
  numberBoxStartBeat = new UI.NumberBox(
    0,
    0,
    1,
    PE.PIANO_ROLL_BEATS_PER_BAR,
    1,
    1,
    onLoopStartChange,
  );
  numberBoxStartSub = new UI.NumberBox(
    0,
    0,
    1,
    Config.PIANO_ROLL_STEPS_PER_BEAT,
    1,
    1,
    onLoopStartChange,
  );
  numberBoxStartBar.tooltip = "Loop start bar";
  numberBoxStartBeat.tooltip = "Loop start beat";
  numberBoxStartSub.tooltip = "Loop start sub-beat";
  syncStartNbs();

  // ── ループ END ──
  numberBoxEndBar = new UI.NumberBox(
    0,
    0,
    1,
    PE.PIANO_ROLL_TOTAL_BARS + 1,
    9,
    1,
    onLoopEndChange,
  );
  numberBoxEndBeat = new UI.NumberBox(
    0,
    0,
    1,
    PE.PIANO_ROLL_BEATS_PER_BAR,
    1,
    1,
    onLoopEndChange,
  );
  numberBoxEndSub = new UI.NumberBox(
    0,
    0,
    1,
    Config.PIANO_ROLL_STEPS_PER_BEAT,
    1,
    1,
    onLoopEndChange,
  );
  numberBoxEndBar.tooltip = "Loop end bar";
  numberBoxEndBeat.tooltip = "Loop end beat";
  numberBoxEndSub.tooltip = "Loop end sub-beat";
  syncEndNbs();

  // ── レイアウト (1行: play stop pos | ♩= bpm metro | start loop end) ──
  const M = UI.FOCUS_MARGIN;
  const GAP = 4;
  const BTN_H = ICON_H + BUTTON_PADDING + BUTTON_BORDER_WIDTH;
  const nbGap = UI.FOCUS_MARGIN * 2 + 1;

  // VSep の高さをボタン高に合わせる
  vsep1.h = BTN_H;
  vsep2.h = BTN_H;

  // BPM アイコン用スペーサー (手動描画される四分音符アイコンの占有領域)。
  // natural h = ICON_H にしておくことで HBox stretch loop が
  //   bpmSpacer.y = row_top + (maxH − ICON_H) / 2
  // を自動算出する。これが ICON_H 高さの icon を行に縦中央配置する正解の y。
  // drawTransport ではこの bpmSpacer.x / .y をそのまま icon の左上に使う。
  bpmSpacer = new UI.Label(0, 0, "");
  bpmSpacer.w = ICON_W + 2; // ICON_W + 右余白 2px
  bpmSpacer.h = ICON_H;

  const startNbs = UI.HBox(
    [numberBoxStartBar, numberBoxStartBeat, numberBoxStartSub],
    nbGap,
  );
  const endNbs = UI.HBox(
    [numberBoxEndBar, numberBoxEndBeat, numberBoxEndSub],
    nbGap,
  );

  transportRoot = UI.HBox(
    [
      buttonPlay,
      buttonStop,
      labelPositionValue,
      vsep1,
      bpmSpacer,
      labelBpm,
      numberBoxBpm,
      toggleMetronome,
      vsep2,
      startNbs,
      toggleLoop,
      endNbs,
    ],
    GAP,
  );
  // WidgetGroup(root, opts) は初期 layout (M, M) + auto-layout を実行
  transportGroup = new UI.WidgetGroup(transportRoot, { x: M, y: M });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  毎フレーム更新
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 毎フレーム呼ばれ、キー入力とプレイヘッド位置を更新する */
export function updateTransport() {
  // Space キーで Play/Pause トグル
  // (テキスト入力中 or ホストウィンドウ非フォーカス時は無視)
  const focusedWidget = UI.WidgetGroup.getFocused();
  if (
    keyDown("Space") &&
    (!focusedWidget || !focusedWidget.isTextInput) &&
    _isHostFocused()
  ) {
    PE.togglePlayPause();
  }

  // エンジンにプレイヘッド位置を更新させる
  PE.updatePlayhead();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画・入力・測定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function drawTransport(cr) {
  _initWidgets();
  const isPlaying = PE.playbackIsPlaying();
  const isPaused = PE.playbackIsPaused();

  // Play ボタンのアイコンを状態に応じて切替
  buttonPlay.value = isPlaying;
  buttonPlay.icon = isPlaying ? "pause" : "play";

  // メトロノームアイコン: 拍位置に合わせて左右交互に切替 (2拍で1往復)
  if (PE.playbackIsMetronomeEnabled() && (isPlaying || isPaused)) {
    const step = PE.getCurrentStep();
    const beatPhase = (step / Config.PIANO_ROLL_STEPS_PER_BEAT) % 2;
    toggleMetronome.icon = beatPhase < 1 ? "metro-l" : "metro-r";
  }

  // 位置表示を更新 (bar.beat.sub — Ableton Live 形式)
  const step = isPlaying
    ? PE.getCurrentStep()
    : isPaused
      ? PE.playbackGetPlayStartStep()
      : 0;
  const posText = PE.formatPos(step);
  labelPositionValue.text = posText;
  labelPositionValue.w = UI.textWidth(posText);

  transportGroup.draw(cr);

  // BPM 行の四分音符アイコンを手動描画。
  // bpmSpacer は natural h=ICON_H で作られているため、HBox stretch 後の
  // bpmSpacer.x / .y がそのまま icon の正しい左上座標になる。
  drawIcon("note-quarter", cr.x + bpmSpacer.x, cr.y + bpmSpacer.y, 1);
}

export function onTransportInput(ev) {
  transportGroup.update(ev);
}

export function measureTransport() {
  _initWidgets();
  return transportGroup.measure();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  再生状態エクスポート (synth_panel.js で参照)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 再生中かどうかを返す */
export function isTransportPlaying() {
  return PE.playbackIsPlaying();
}

/**
 * トランスポート UI ウィジェットの状態を初期値にリセットする。
 * resetPlaybackEngine() の後に呼び、エンジンの値と同期する。
 */
export function resetTransport() {
  _initWidgets();
  numberBoxBpm.value = Config.DEFAULT_BPM;
  toggleLoop.value = true;
  toggleMetronome.value = true;
  buttonPlay.value = false;
  buttonPlay.icon = "play";
  toggleMetronome.icon = "metro-l";
  syncStartNbs();
  syncEndNbs();
}

