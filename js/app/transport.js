/**
 * @module app/transport
 * transport.js — TRANSPORT ウィンドウ (共有トランスポートの操作面)
 *
 * 音楽制作機能の再設計・第 3 弾 (SYNTH / ROLL に続く)。DAW / トラッカーの
 * 「トランスポートバー」に相当する、全音楽アプリ共通の再生コントローラ。
 * 実体は持たず、共有サービス app/music/transport.js (1 本の時計) を操作するだけ。
 * ROLL などのシーケンサはその時計を「読んで」自分のノートを鳴らすので、この窓の
 * 再生 / 停止 / テンポ / ループはそのまま全アプリへ効く (相互連携の中枢)。
 *
 * ── レイアウト (1 段) ──
 *   [▶][■][●] | ♩=[BPM] [METRO] | [LOOP] [開始小節]-[終了小節]
 *   将来の DAW 化で画面上端に固定表示される横長トランスポートバーの姿に寄せた 1 段構成
 *   (旧 SYNESTA と同じ薄い横並び)。区切りは VSep で「再生 | テンポ | ループ」に分ける。
 *   フッタ: 左に状態 + 位置 (STOP/PLAY/REC  bar.beat.sub)、右にループ範囲。
 *
 * ── UI 設計 (CRAP) ──
 *   Proximity : VSep で「再生」「テンポ」「ループ」の 3 群に分離。
 *   Repetition: アイコンボタンは SYNTH/ROLL と同じ 1-bit トグル/プッシュの語彙。
 *   Alignment : 1 行内で縦中央揃え (HBox エンジン)。
 *   Contrast  : 再生中/録音中/ループ ON はボタン反転で強調 (1-bit の on/off)。
 *
 * ── ボタン ──
 *   ▶  Play/Pause  … 現在位置から再生 / 一時停止 (位置保持)。Space でも切替 (窓フォーカス時)。
 *   ■  Stop        … 停止して先頭 (ループ ON ならループ開始小節) へ戻す。
 *   ●  Record      … 録音の入/切。停止中に押すと再生も始まる。取り込み先 (Sampler /
 *                     Arrangement) は今後追加で、現状は状態 + 表示 + 連携 API。
 *   METRO          … メトロノーム (拍頭でクリック。強拍は高音)。拍ごとに左右へ振れる。
 *   LOOP           … ループの入/切。範囲は開始〜終了小節の 2 つの NumberBox。
 */

import { drawText, textWidth } from "../core/font.js";
import { drawIcon, ICON_W, ICON_H } from "../core/icon.js";
import { keyDown, keyHeld } from "../core/input.js";
import { isCapturing } from "../core/gpu.js";
import { wmOpen, wmRegister, wmIsFocused } from "../wm/index.js";
import * as transport from "./music/transport.js";
import {
  WidgetGroup,
  HBox,
  ToggleButton,
  PushButton,
  NumberBox,
  Label,
  VSep,
  FOCUS_MARGIN,
  GAP,
} from "../ui/index.js";
import { BPM_MIN, BPM_MAX, DEFAULT_BPM } from "../config.js";

export const APP_NAME = "TRANSPORT";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** アイコンボタンの内寸パディング / ボーダー (SYNTH の再生ボタンと同寸) */
const BTN_PADDING = 8;
const BTN_BORDER = 4;
const BTN_W = ICON_W + BTN_PADDING + BTN_BORDER;
const BTN_H = ICON_H + BTN_PADDING + BTN_BORDER;

/** ループ範囲 (小節) の指定域。開始 = ループ先頭小節、終了 = ループ末尾小節 (両端含む)。 */
const LOOP_BAR_MIN = 1;
const LOOP_BAR_MAX = 64;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィジェット + レイアウト (遅延初期化)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let playBtn, stopBtn, recBtn, metroToggle, loopToggle;
let bpmBox, startBarBox, endBarBox;
let bpmSpacer, eqLabel, dashLabel, vsep1, vsep2;
let group;
let _ready = false;

/** 開始小節 (1 始まり, 含む) → ループ開始 beat */
function startBarToBeat(bar) {
  return transport.barToBeat(bar);
}
/** 終了小節 (1 始まり, 含む) → ループ終了 beat (その小節の末尾 = 次小節の頭) */
function endBarToBeat(bar) {
  return transport.barToBeat(bar + 1);
}

/** NumberBox の値からループ範囲を組み立てて共有トランスポートへ反映する。 */
function applyLoopFromBoxes() {
  let s = startBarBox.value;
  let e = endBarBox.value;
  if (e < s) e = s; // 終了は開始以上 (最小 1 小節ループ)
  if (endBarBox.value !== e) endBarBox.value = e; // クランプを表示へ戻す
  transport.setLoop(startBarToBeat(s), endBarToBeat(e), loopToggle.value);
}

function _initWidgets() {
  if (_ready) return;
  _ready = true;

  // ── 再生系ボタン ──
  playBtn = new ToggleButton(0, 0, "", (v) => {
    if (v) transport.play(); // 現在位置から再生 (再開)
    else transport.stop(); // 一時停止 (位置は保持)
  });
  playBtn.icon = "play";
  playBtn.w = BTN_W;
  playBtn.h = BTN_H;
  playBtn.tooltip = "Play / Pause";

  stopBtn = new PushButton(0, 0, "", () => {
    transport.rewind(); // 停止して先頭 (ループ先頭) へ戻す
  });
  stopBtn.icon = "stop";
  stopBtn.w = BTN_W;
  stopBtn.h = BTN_H;
  stopBtn.tooltip = "Stop and rewind";

  recBtn = new ToggleButton(0, 0, "", (v) => {
    if (v) transport.startRecording(); // 録音 (停止中なら再生も開始)
    else transport.stopRecording(); // パンチアウト (再生は継続)
  });
  recBtn.icon = "rec";
  recBtn.w = BTN_W;
  recBtn.h = BTN_H;
  recBtn.tooltip = "Record";

  // ── テンポ (♩ = BPM) ──
  // ♩ 四分音符アイコンは手動描画するため、その占有領域だけを空 Label で確保する
  // (HBox の stretch で bpmSpacer.y が ICON_H 高さの縦中央に決まる)。
  bpmSpacer = new Label(0, 0, "");
  bpmSpacer.w = ICON_W + 2;
  bpmSpacer.h = ICON_H;
  eqLabel = new Label(0, 0, "=");
  bpmBox = new NumberBox(0, 0, BPM_MIN, BPM_MAX, transport.getTempo(), 1, (v) => {
    transport.setTempo(v);
  });
  bpmBox.defaultValue = DEFAULT_BPM;
  bpmBox.tooltip = "Tempo (BPM)";

  metroToggle = new ToggleButton(
    0,
    0,
    "",
    (v) => {
      transport.setMetronomeEnabled(v);
    },
    transport.isMetronomeEnabled(),
  );
  metroToggle.icon = "metro-l";
  metroToggle.w = BTN_W;
  metroToggle.h = BTN_H;
  metroToggle.tooltip = "Metronome";

  // ── ループ ──
  const loop = transport.getLoop();
  const bpb = transport.getBeatsPerBar();
  const startBar = Math.floor(loop.start / bpb) + 1;
  const endBar = Math.max(startBar, Math.round(loop.end / bpb));

  loopToggle = new ToggleButton(
    0,
    0,
    "",
    () => {
      applyLoopFromBoxes(); // ON/OFF を範囲と一緒に反映
    },
    loop.on,
  );
  loopToggle.icon = "loop";
  loopToggle.w = BTN_W;
  loopToggle.h = BTN_H;
  loopToggle.tooltip = "Loop on / off";

  startBarBox = new NumberBox(
    0,
    0,
    LOOP_BAR_MIN,
    LOOP_BAR_MAX,
    startBar,
    1,
    applyLoopFromBoxes,
  );
  startBarBox.tooltip = "Loop start bar";
  endBarBox = new NumberBox(
    0,
    0,
    LOOP_BAR_MIN,
    LOOP_BAR_MAX,
    endBar,
    1,
    applyLoopFromBoxes,
  );
  endBarBox.tooltip = "Loop end bar";
  dashLabel = new Label(0, 0, "-");

  vsep1 = new VSep(0, 0, BTN_H);
  vsep2 = new VSep(0, 0, BTN_H);

  // ── レイアウト (1 段: 再生 | テンポ | ループ を薄い横並びに)。将来の DAW 化で画面上端に
  //    固定表示される横長トランスポートバーの姿へ寄せる (旧 SYNESTA と同じ 1 段構成)。 ──
  const root = HBox(
    [
      playBtn, stopBtn, recBtn,
      vsep1,
      bpmSpacer, eqLabel, bpmBox, metroToggle,
      vsep2,
      loopToggle, startBarBox, dashLabel, endBarBox,
    ],
    GAP,
  );
  group = new WidgetGroup(root, { x: FOCUS_MARGIN, y: FOCUS_MARGIN });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  毎フレーム: 共有クロック更新 + キー + 表示同期
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Space で再生トグル (窓フォーカス時・テキスト入力中は無視)。素=1.1.1 から /
 *  Shift=停止位置から。ROLL と同一の共有仕様 (transport.toggleFromSpace) を使う。 */
function handleKeys() {
  if (!wmIsFocused(APP_NAME)) return;
  const focused = WidgetGroup.getFocused();
  if (focused && focused.isTextInput) return;
  if (keyDown("Space")) {
    transport.toggleFromSpace(keyHeld("ShiftLeft") || keyHeld("ShiftRight"));
  }
}

/** NumberBox / トグルの値を共有トランスポートの状態へ同期する (外部での変更 = .song 読み込みや
 *  SYNESTA 新規起動の初期化を UI へ反映する)。直接代入なので onChange は発火しない。ユーザーが
 *  ウィジェットを操作しても onChange 経由でモデルが同値になるので競合しない。 */
function syncWidgetsFromModel() {
  const bpm = transport.getTempo();
  if (bpmBox.value !== bpm) bpmBox.value = bpm;
  const loop = transport.getLoop();
  const bpb = transport.getBeatsPerBar();
  const startBar = Math.floor(loop.start / bpb) + 1;
  const endBar = Math.max(startBar, Math.round(loop.end / bpb));
  if (startBarBox.value !== startBar) startBarBox.value = startBar;
  if (endBarBox.value !== endBar) endBarBox.value = endBar;
  if (loopToggle.value !== loop.on) loopToggle.value = loop.on;
  const metro = transport.isMetronomeEnabled();
  if (metroToggle.value !== metro) metroToggle.value = metro;
}

/** ボタン/アイコンの見た目を共有トランスポートの状態に同期する。 */
function syncState() {
  syncWidgetsFromModel();
  const playing = transport.isPlaying();
  playBtn.value = playing;
  playBtn.icon = playing ? "pause" : "play";
  recBtn.value = transport.isRecording();

  // メトロノームのアイコンを拍ごとに左右へ振る (再生中 & 有効時のみ)。
  if (transport.isMetronomeEnabled() && playing) {
    const swing = Math.floor(transport.getPosition()) % 2;
    metroToggle.icon = swing === 0 ? "metro-l" : "metro-r";
  } else {
    metroToggle.icon = "metro-l";
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function drawTransport(cr) {
  _initWidgets();
  // 共有クロックを進める (メトロノーム含む)。誰が呼んでも冪等なので ROLL と同時でも安全。
  transport.update();
  // CAPTURE の二度描きでキーが二重発火しないようガード (SYNTH/ROLL と同じ)。
  if (!isCapturing()) handleKeys();
  syncState();

  group.draw(cr);

  // ♩ 四分音符アイコンを手動描画 (bpmSpacer は ICON_H 高で作ってあるので x/y が正解)。
  drawIcon("note-quarter", cr.x + bpmSpacer.x, cr.y + bpmSpacer.y, 1);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  フッタ (状態 + 位置 / ループ範囲)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function drawFooter(fr) {
  _initWidgets();

  // 左: 状態 + 位置 (bar.beat.sub)
  const state = transport.isRecording()
    ? "REC"
    : transport.isPlaying()
      ? "PLAY"
      : "STOP";
  drawText(fr.x, fr.y, `${state}  ${transport.formatPosition()}`, 1);

  // 右: ループ範囲 (小節)
  const loop = transport.getLoop();
  const bpb = transport.getBeatsPerBar();
  const right = loop.on
    ? `LOOP ${Math.floor(loop.start / bpb) + 1}-${Math.round(loop.end / bpb)}`
    : "LOOP OFF";
  drawText(fr.x + fr.w - textWidth(right), fr.y, right, 1);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力 / 測定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onTransportInput(ev) {
  _initWidgets();
  group.update(ev);
}

function measureTransport() {
  _initWidgets();
  return group.measure();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    _initWidgets();
    return wmOpen(
      -1,
      -1,
      0,
      0,
      APP_NAME,
      drawTransport,
      onTransportInput,
      measureTransport,
      {
        about:
          "The shared transport bar for the music apps. Play, pause, stop, and " +
          "record drive one global clock; ROLL and other sequencers follow it, so " +
          "these controls apply everywhere at once. Set the tempo (BPM), toggle the " +
          "metronome (clicks on each beat, accented downbeats), and set the loop " +
          "range in bars. Space toggles play/pause while this window is focused. " +
          "Record arms the shared record state for future capture apps (Sampler / " +
          "Arrangement); it also starts playback.",
        footer: true,
        onDrawFooter: (fr) => drawFooter(fr),
      },
    );
  },
  // SYNESTA メンバー: アイコン / ランチャーには出さず、SYNESTA からまとめて起動する。
  { category: "CREATIVE", shortName: "TRANSP", dev: true, hidden: true, noIcon: true },
);
