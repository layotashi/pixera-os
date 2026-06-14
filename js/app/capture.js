/**
 * @module app/capture
 * capture.js — CAPTURE ウィンドウ (スクリーンショット + 動画撮影 + GIF ループ)
 *
 * 仮想画面 or 個別ウィンドウのスクリーンキャプチャ機能。
 * delay=0 で即時、１〜10 でタイマー撮影。
 * 特定ウィンドウ撮影時は自動的に最前面に昇格してからキャプチャ。
 * GIF ループ機能: VRAM フレームを蓄積し、自前 GIF89a エンコーダで
 * アニメーション GIF としてダウンロード。
 *
 * 排他制御: 動画録画と GIF ループは GPU キャプチャバッファを共有するため
 * 同時実行を禁止する (_isContinuousRecordingBusy)。
 * リサイズ検出: ウィンドウ単体録画中にサイズ変更を検出した場合は自動停止する。
 *
 * update/draw から参照される状態を export する。
 */

import { VRAM_WIDTH, VRAM_HEIGHT, getScale, palette } from "../config.js";
import * as GPU from "../core/gpu.js";
import { encodeGifN } from "../core/gif.js";
import { drawIcon, ICON_W, ICON_H } from "../core/icon.js";
import { drawText, textWidth, GLYPH_H } from "../core/font.js";
import * as WM from "../wm/index.js";
import * as UI from "../ui/index.js";
import { initAudio, getAudioStream } from "../core/audio.js";
import {
  getDiagOffset,
  ensureLut,
  applyVramIndexed,
  getDisplayPalette,
} from "../core/pixel_grid.js";

const APP_NAME = "CAPTURE";

// ── GIF ループ撮影設定 ──
const GIF_FPS_OPTIONS = [10, 12, 15]; // 選択可能な FPS
const GIF_MAX_DURATION = 10; // 最大撮影時間 (秒)
const GIF_DEFAULT_DURATION = 3; // デフォルト撮影時間 (秒)
const GIF_DEFAULT_FPS = 12; // デフォルト FPS

// ── スクリーンショット状態 ──
let screenshotPending = false;
let screenshotCount = 0;
let screenshotTimerEnd = 0;
let screenshotDelay = 0;
let screenshotTargetId = -1; // -1 = Full screen
let screenshotScale = 2; // 撮影倍率 (1,2,4,8)

// ── 動画撮影状態 ──
let isRecording = false;
let mediaRecorder = null;
let recordChunks = [];
let recordStartTime = 0;
let recordCanvas = null;
let recordCtx = null;
let recordTimerEnd = 0;
let recordPending = false;
let recordMimeType = "";
let recordTargetId = -1; // 録画開始時にロック
let recordCapW = 0; // 録画開始時のキャプチャ幅 (リサイズ検出用)
let recordCapH = 0; // 録画開始時のキャプチャ高さ (リサイズ検出用)

// ── GIF ループ撮影状態 ──
let isGifRecording = false;
let gifFrames = [];
let gifStartTime = 0;
let gifDuration = GIF_DEFAULT_DURATION;
let gifFps = GIF_DEFAULT_FPS;
let gifFrameInterval = 0; // ms — 1/fps
let gifLastFrameTime = 0;
let gifTimerEnd = 0;
let gifPending = false;
let gifEncoding = false; // エンコード中フラグ
let gifTargetId = -1; // 録画開始時にロック
let gifFrameWidth = VRAM_WIDTH;
let gifFrameHeight = VRAM_HEIGHT;

/**
 * 動画 / GIF いずれかの連続録画セッションが進行中か。
 * カウントダウン (Delay)・録画中・エンコード中をすべて含む。
 * 動画と GIF は GPU キャプチャバッファを時分割で使用するため、
 * 同時に複数の連続録画を走らせてはならない。
 * @returns {boolean}
 */
function _isContinuousRecordingBusy() {
  return (
    isRecording ||
    recordTimerEnd > 0 ||
    recordPending ||
    isGifRecording ||
    gifTimerEnd > 0 ||
    gifPending ||
    gifEncoding
  );
}

/** 出力解像度ラベルを更新 */
function refreshOutputLabel() {
  let w, h;
  if (screenshotTargetId < 0) {
    w = VRAM_WIDTH;
    h = VRAM_HEIGHT;
  } else {
    const r = WM.wmGetWindowRect(screenshotTargetId);
    if (r) {
      w = r.w;
      h = r.h;
    } else {
      w = VRAM_WIDTH;
      h = VRAM_HEIGHT;
    }
  }
  lblOutput.text = `${w * screenshotScale}x${h * screenshotScale} px`;
}

/** ドロップダウンの項目を更新 */
function refreshTargetItems() {
  const wins = WM.wmGetWindowList().filter((w) => w.title !== APP_NAME);
  const items = ["Full screen", ...wins.map((w) => w.title)];
  ddTarget.items = items;
  if (ddTarget.selectedIndex >= items.length) {
    ddTarget.selectedIndex = 0;
    screenshotTargetId = -1;
  }
  refreshOutputLabel();
}

/** 撮影を開始 (delay=0 なら即時予約、>0 ならタイマー開始) */
function startCapture() {
  if (screenshotTimerEnd > 0 || recordTimerEnd > 0 || gifTimerEnd > 0) return;
  refreshTargetItems();
  if (screenshotDelay === 0) {
    screenshotPending = true;
  } else {
    screenshotTimerEnd = performance.now() + screenshotDelay * 1000;
  }
}

function doScreenshotDownload() {
  let resultCanvas;

  if (screenshotTargetId < 0) {
    // ── Full screen: 合成済み canvas (VRAM 1:1) から取得 ──
    const src = GPU.getCanvas();
    // src は VRAM_WIDTH x VRAM_HEIGHT (CELL 撤廃後は等倍)
    const srcW = VRAM_WIDTH;
    const srcH = VRAM_HEIGHT;
    const outW = srcW * screenshotScale;
    const outH = srcH * screenshotScale;
    resultCanvas = document.createElement("canvas");
    resultCanvas.width = outW;
    resultCanvas.height = outH;
    const octx = resultCanvas.getContext("2d");
    octx.imageSmoothingEnabled = false;
    octx.drawImage(src, 0, 0, srcW, srcH, 0, 0, outW, outH);
  } else {
    // ── 個別ウィンドウ: オフスクリーンキャプチャ ──
    const r = WM.wmGetWindowRect(screenshotTargetId);
    if (!r) return;
    GPU.beginCapture(r.w, r.h);
    WM.wmDrawSingleWindow(screenshotTargetId);
    resultCanvas = GPU.endCapture(screenshotScale);
  }

  resultCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    screenshotCount++;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `screenshot_${ts}_${screenshotCount}.png`;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, "image/png");
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  動画撮影
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 利用可能な録画 MIME タイプを検出 */
function detectRecordingMimeType() {
  const types = [
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4;codecs=avc1",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const t of types) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(t)
    )
      return t;
  }
  return "";
}

/** 経過時間を mm:ss にフォーマット */
function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

/** 録画フォーマットラベル (MP4 / WebM) */
function recordFormatLabel() {
  if (!recordMimeType) recordMimeType = detectRecordingMimeType();
  if (!recordMimeType) return "(N/A)";
  return recordMimeType.startsWith("video/mp4") ? "(MP4)" : "(WebM)";
}

/** Record ボタン押下: 状態に応じて開始 / 停止 / キャンセル */
function toggleRecording() {
  if (isRecording) {
    stopRecording();
    return;
  }
  if (recordTimerEnd > 0) {
    // カウントダウン中 → キャンセル
    recordTimerEnd = 0;
    labelRecordStatus.text = recordFormatLabel();
    return;
  }
  // 他の録画セッション or カウントダウン中は開始禁止
  if (screenshotTimerEnd > 0 || _isContinuousRecordingBusy()) return;

  // AudioContext を確保 (ユーザー操作コンテキスト内で呼ぶ必要がある)
  initAudio();

  if (screenshotDelay === 0) {
    recordPending = true;
  } else {
    recordTimerEnd = performance.now() + screenshotDelay * 1000;
  }
}

/** 録画を実際に開始 */
function doStartRecording() {
  if (isRecording) return;

  // 録画開始時にターゲットをロック
  recordTargetId = screenshotTargetId;
  let capW, capH;
  if (recordTargetId < 0) {
    capW = VRAM_WIDTH;
    capH = VRAM_HEIGHT;
  } else {
    const r = WM.wmGetWindowRect(recordTargetId);
    if (r) {
      capW = r.w;
      capH = r.h;
    } else {
      recordTargetId = -1;
      capW = VRAM_WIDTH;
      capH = VRAM_HEIGHT;
    }
  }

  recordCapW = capW;
  recordCapH = capH;

  // 録画用オフスクリーン canvas (VRAM 1:1 + 追加スケーリング)
  const outW = capW * screenshotScale;
  const outH = capH * screenshotScale;
  recordCanvas = document.createElement("canvas");
  recordCanvas.width = outW;
  recordCanvas.height = outH;
  recordCtx = recordCanvas.getContext("2d");
  recordCtx.imageSmoothingEnabled = false;

  // 映像ストリーム (60fps)
  const videoStream = recordCanvas.captureStream(60);

  // 合成ストリーム (映像 + 音声)
  const combinedStream = new MediaStream();
  videoStream.getVideoTracks().forEach((t) => combinedStream.addTrack(t));
  const audioStream = getAudioStream();
  if (audioStream) {
    audioStream.getAudioTracks().forEach((t) => combinedStream.addTrack(t));
  }

  // MIME タイプ決定 (MP4 優先、WebM フォールバック)
  recordMimeType = detectRecordingMimeType();
  if (!recordMimeType) {
    labelRecordStatus.text = "ERR";
    recordCanvas = null;
    recordCtx = null;
    return;
  }

  // 高ビットレートでピクセルパーフェクトを維持
  const bitrate = Math.max(outW * outH * 30, 10_000_000);

  mediaRecorder = new MediaRecorder(combinedStream, {
    mimeType: recordMimeType,
    videoBitsPerSecond: bitrate,
  });

  recordChunks = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordChunks.push(e.data);
  };
  mediaRecorder.onstop = doRecordingDownload;
  mediaRecorder.start();

  isRecording = true;
  recordStartTime = performance.now();
}

/** 録画を停止 */
function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  mediaRecorder.stop();
  isRecording = false;
  labelRecordStatus.text = recordFormatLabel();
}

/** 録画ファイルをダウンロード (MediaRecorder.onstop コールバック) */
function doRecordingDownload() {
  const ext = recordMimeType.startsWith("video/mp4") ? "mp4" : "webm";
  const blob = new Blob(recordChunks, { type: recordMimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.download = `recording_${ts}.${ext}`;
  a.href = url;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  recordChunks = [];
  recordCanvas = null;
  recordCtx = null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GIF ループ撮影
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** GIF Loop ボタン押下: 状態に応じて開始 / キャンセル */
function toggleGifRecording() {
  if (isGifRecording) {
    stopGifRecording();
    return;
  }
  if (gifTimerEnd > 0) {
    // カウントダウン中 → キャンセル
    gifTimerEnd = 0;
    labelGifStatus.text = "(GIF)";
    return;
  }
  if (gifEncoding) return; // エンコード中は禁止
  // 他の録画セッション or カウントダウン中は開始禁止
  if (screenshotTimerEnd > 0 || _isContinuousRecordingBusy()) return;

  if (screenshotDelay === 0) {
    gifPending = true;
  } else {
    gifTimerEnd = performance.now() + screenshotDelay * 1000;
  }
}

/** GIF 録画を実際に開始 */
function doStartGifRecording() {
  if (isGifRecording) return;

  // 録画開始時にターゲットとフレームサイズをロック
  gifTargetId = screenshotTargetId;
  if (gifTargetId < 0) {
    gifFrameWidth = VRAM_WIDTH;
    gifFrameHeight = VRAM_HEIGHT;
  } else {
    const r = WM.wmGetWindowRect(gifTargetId);
    if (r) {
      gifFrameWidth = r.w;
      gifFrameHeight = r.h;
    } else {
      gifTargetId = -1;
      gifFrameWidth = VRAM_WIDTH;
      gifFrameHeight = VRAM_HEIGHT;
    }
  }

  gifFrames = [];
  gifFrameInterval = 1000 / gifFps;
  gifLastFrameTime = 0;
  isGifRecording = true;
  gifStartTime = performance.now();
}

/** GIF 録画を停止してエンコード・ダウンロード */
function stopGifRecording() {
  if (!isGifRecording) return;
  isGifRecording = false;

  if (gifFrames.length === 0) {
    labelGifStatus.text = "(GIF)";
    return;
  }

  gifEncoding = true;
  labelGifStatus.text = "Encoding...";

  // エンコードを次のフレームに遅延して UI を更新させる
  setTimeout(() => {
    const bg = [...palette.bg];
    const fg = [...palette.fg];
    const pal = getDisplayPalette(fg, bg);
    // gifFrames は 4 色 indexed フレーム (bg / fg / bg+diag / fg+diag)
    // フレームサイズは VRAM 等倍 (CELL 撤廃後)
    const blob = encodeGifN(
      gifFrames,
      gifFrames[0].width,
      gifFrames[0].height,
      pal,
      gifFps,
      screenshotScale,
    );

    // ダウンロード
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `loop_${ts}.gif`;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    gifFrames = [];
    gifEncoding = false;
    labelGifStatus.text = "(GIF)";
  }, 0);
}

/**
 * VRAM のスナップショットを取得 (4 色 indexed フレーム: bg/fg/bg+diag/fg+diag)。
 * ウィンドウ単体録画時、ウィンドウが閉じられたかリサイズされた場合は null を返す。
 * @returns {{ data: Uint8Array, width: number, height: number }|null}
 */
function captureVramSnapshot() {
  const fg = palette.fg;
  const bg = palette.bg;
  ensureLut(fg, bg);

  if (gifTargetId < 0) {
    // Full screen: VRAM を 4 色 indexed に変換 (1:1)
    const len = VRAM_WIDTH * VRAM_HEIGHT;
    return applyVramIndexed(
      GPU.vram.subarray(0, len),
      VRAM_WIDTH,
      VRAM_HEIGHT,
      getDiagOffset(),
    );
  }
  // ウィンドウ単体: オフスクリーンキャプチャ
  const r = WM.wmGetWindowRect(gifTargetId);
  // ウィンドウが閉じられた or リサイズされた
  if (!r || r.w !== gifFrameWidth || r.h !== gifFrameHeight) return null;
  GPU.beginCapture(gifFrameWidth, gifFrameHeight);
  WM.wmDrawSingleWindow(gifTargetId);
  return GPU.endCaptureIndexed();
}

// ── ウィジェット (遅延初期化) ──
let lblTarget, ddTarget;
let lblScale, ddScale;
let lblOutputHdr, lblOutput;
let lblDelay, nbDelay, labelSeconds;
let lblCapture, btnCapture, lblCountdown;
let lblRecord, btnRecord, labelRecordStatus;
let lblGif, btnGif, labelGifStatus;
let lblGifDuration, nbGifDuration, labelGifDurSec;
let lblGifFps, ddGifFps;
let sepScreenshot, sepRecord;
let screenshotWidgets;
let captureRoot;
let _ready = false;

function _initWidgets() {
  if (_ready) return;
  _ready = true;

  // Row 1: Target: [dropdown]
  lblTarget = new UI.Label(0, 0, "Target:");
  ddTarget = new UI.DropDown(0, 0, ["Full screen"], 0, (i) => {
    if (i === 0) {
      screenshotTargetId = -1;
    } else {
      const wins = WM.wmGetWindowList().filter((w) => w.title !== APP_NAME);
      screenshotTargetId = wins[i - 1] ? wins[i - 1].id : -1;
    }
    refreshOutputLabel();
  });

  // Row 2: Scale: [dropdown]
  lblScale = new UI.Label(0, 0, "Scale:");
  ddScale = new UI.DropDown(0, 0, ["X1", "X2", "X4", "X8"], 1, (i) => {
    screenshotScale = [1, 2, 4, 8][i];
    refreshOutputLabel();
  });
  ddScale.tooltip = "Output magnification";

  // Row 3: Output: {dynamic} — フッターに移動
  lblOutputHdr = new UI.Label(0, 0, "Output:");
  lblOutput = new UI.Label(0, 0, "");

  // Row 4: Delay: [number] sec
  lblDelay = new UI.Label(0, 0, "Delay:");
  nbDelay = new UI.NumberBox(0, 0, 0, 10, 0, 1, (v) => {
    screenshotDelay = v;
  });
  nbDelay.tooltip = "Delay before capture (0 = instant)";
  labelSeconds = new UI.Label(0, 0, "sec");

  // Row 5: Capture: [rec icon]
  lblCapture = new UI.Label(0, 0, "Capture:");
  btnCapture = new UI.PushButton(0, 0, "", startCapture);
  btnCapture.icon = "rec";
  btnCapture.w = ICON_W + 8 + 4;
  btnCapture.h = ICON_H + 8 + 4;
  btnCapture.tooltip = "Capture screenshot";
  lblCountdown = new UI.Label(0, 0, "");

  // Row 6: Record: [rec/stop button] [status label]
  lblRecord = new UI.Label(0, 0, "Record:");
  btnRecord = new UI.PushButton(0, 0, "", toggleRecording);
  btnRecord.icon = "rec";
  btnRecord.w = ICON_W + 8 + 4;
  btnRecord.h = ICON_H + 8 + 4;
  btnRecord.tooltip = "Start/stop video recording";
  labelRecordStatus = new UI.Label(0, 0, "");

  // Row 7: GIF Dur: [number] sec
  lblGifDuration = new UI.Label(0, 0, "GIF Dur:");
  nbGifDuration = new UI.NumberBox(
    0,
    0,
    1,
    GIF_MAX_DURATION,
    GIF_DEFAULT_DURATION,
    1,
    (v) => {
      gifDuration = v;
    },
  );
  nbGifDuration.tooltip = "GIF loop duration (1-10 sec)";
  labelGifDurSec = new UI.Label(0, 0, "sec");

  // Row 8: GIF FPS: [dropdown]
  lblGifFps = new UI.Label(0, 0, "GIF FPS:");
  ddGifFps = new UI.DropDown(
    0,
    0,
    GIF_FPS_OPTIONS.map((f) => `${f} fps`),
    GIF_FPS_OPTIONS.indexOf(GIF_DEFAULT_FPS),
    (i) => {
      gifFps = GIF_FPS_OPTIONS[i];
    },
  );
  ddGifFps.tooltip = "GIF frame rate";

  // Row 9: GIF Loop: [rec/stop button] [status label]
  lblGif = new UI.Label(0, 0, "GIF Loop:");
  btnGif = new UI.PushButton(0, 0, "", toggleGifRecording);
  btnGif.icon = "rec";
  btnGif.w = ICON_W + 8 + 4;
  btnGif.h = ICON_H + 8 + 4;
  btnGif.tooltip = "Record GIF loop";
  labelGifStatus = new UI.Label(0, 0, "(GIF)");

  // ── HSep セパレータ ──
  sepScreenshot = new UI.HSep(0, 0, 0);
  sepRecord = new UI.HSep(0, 0, 0);

  // ── ラベル左端を揃えてレイアウト ──
  const lblW = Math.max(
    lblTarget.w,
    lblScale.w,
    lblDelay.w,
    lblCapture.w,
    lblRecord.w,
    lblGifDuration.w,
    lblGifFps.w,
    lblGif.w,
  );
  lblTarget.w = lblW;
  lblScale.w = lblW;
  lblDelay.w = lblW;
  lblCapture.w = lblW;
  lblRecord.w = lblW;
  lblGifDuration.w = lblW;
  lblGifFps.w = lblW;
  lblGif.w = lblW;

  // ── Box レイアウト ──
  captureRoot = UI.VBox([
    UI.HBox([lblTarget, ddTarget]),
    UI.HBox([lblScale, ddScale]),
    UI.HBox([lblDelay, nbDelay, labelSeconds]),
    sepScreenshot,
    UI.HBox([lblCapture, btnCapture, lblCountdown]),
    UI.HBox([lblRecord, btnRecord, labelRecordStatus]),
    sepRecord,
    UI.HBox([lblGifDuration, nbGifDuration, labelGifDurSec]),
    UI.HBox([lblGifFps, ddGifFps]),
    UI.HBox([lblGif, btnGif, labelGifStatus]),
  ]);
  captureRoot.layout(UI.FOCUS_MARGIN, UI.FOCUS_MARGIN);

  refreshOutputLabel();

  // フォーマットラベル初期化
  labelRecordStatus.text = recordFormatLabel();

  screenshotWidgets = new UI.WidgetGroup(captureRoot.leaves());
}

function onSshotDraw(contentRect) {
  _initWidgets();
  refreshTargetItems();
  // 録画状態に応じてアイコンを動的切り替え
  btnRecord.icon = isRecording ? "stop" : "rec";
  btnGif.icon = isGifRecording ? "stop" : "rec";
  screenshotWidgets.draw(contentRect);
}

WM.wmRegister(APP_NAME, () => {
  _initWidgets();
  return WM.wmOpen(
    -1,
    -1,
    0,
    0,
    APP_NAME,
    onSshotDraw,
    (ev) => screenshotWidgets.update(ev),
    () => captureRoot.measure(),
    {
      footer: true,
      onDrawFooter: (footerRect) => {
        refreshOutputLabel();
        drawText(footerRect.x, footerRect.y, lblOutput.text, 1);
      },
      onRelayout: () => {
        screenshotWidgets.remeasureAll();
        // ラベル幅再統一
        const capLabels = [
          lblTarget,
          lblScale,
          lblDelay,
          lblCapture,
          lblRecord,
          lblGifDuration,
          lblGifFps,
          lblGif,
        ];
        const lblW = Math.max(...capLabels.map((l) => l.w));
        for (const l of capLabels) l.w = lblW;
        captureRoot.layout(UI.FOCUS_MARGIN, UI.FOCUS_MARGIN);
      },
    },
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  app.js の update/draw から呼ばれるヘルパー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** update() から呼ぶ: タイマーカウントダウンを進める */
export function updateScreenshotTimer() {
  if (screenshotTimerEnd > 0) {
    const remain = screenshotTimerEnd - performance.now();
    if (remain <= 0) {
      screenshotTimerEnd = 0;
      lblCountdown.text = "";
      screenshotPending = true;
    } else {
      const sec = Math.ceil(remain / 1000);
      lblCountdown.text = `${sec}...`;
    }
  }
}

/** draw() から呼ぶ: タイマーカウントダウン オーバーレイを描画 */
export function drawScreenshotOverlay() {
  if (screenshotTimerEnd > 0) {
    const remain = screenshotTimerEnd - performance.now();
    if (remain > 0) {
      const sec = String(Math.ceil(remain / 1000));
      const tw = textWidth(sec);
      const tx = ((VRAM_WIDTH - tw) / 2) | 0;
      const ty = 4;
      GPU.fillRect(tx - 4, ty - 2, tw + 8, GLYPH_H + 4, 0);
      drawText(tx, ty, sec, 1);
    }
  }
}

/** draw() 末尾 (flush 後) から呼ぶ: 予約されたスクリーンショットを実行 */
export function executePendingScreenshot() {
  if (screenshotPending) {
    screenshotPending = false;
    doScreenshotDownload();
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  動画撮影 — app.js 連携
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** update() から呼ぶ: 録画カウントダウンを進め、経過時間を更新 */
export function updateRecordingTimer() {
  if (recordTimerEnd > 0) {
    const remain = recordTimerEnd - performance.now();
    if (remain <= 0) {
      recordTimerEnd = 0;
      labelRecordStatus.text = "";
      recordPending = true;
    } else {
      const sec = Math.ceil(remain / 1000);
      labelRecordStatus.text = `${sec}...`;
    }
  }
  if (isRecording) {
    labelRecordStatus.text = formatElapsed(performance.now() - recordStartTime);
  }
}

/** draw() から呼ぶ: 録画カウントダウン オーバーレイを描画 */
export function drawRecordingOverlay() {
  if (recordTimerEnd > 0) {
    const remain = recordTimerEnd - performance.now();
    if (remain > 0) {
      const sec = String(Math.ceil(remain / 1000));
      const tw = textWidth(sec);
      const tx = ((VRAM_WIDTH - tw) / 2) | 0;
      const ty = 4;
      GPU.fillRect(tx - 4, ty - 2, tw + 8, GLYPH_H + 4, 0);
      drawText(tx, ty, sec, 1);
    }
  }
}

/**
 * draw() 末尾 (flush 後) から呼ぶ:
 * 予約された録画を開始し、録画中は毎フレーム録画 canvas にコピー。
 * ウィンドウ単体録画中にウィンドウが閉じられた/リサイズされた場合は自動停止する。
 */
export function commitRecording() {
  if (recordPending) {
    recordPending = false;
    doStartRecording();
  }
  if (isRecording && recordCtx) {
    if (recordTargetId < 0) {
      // Full screen
      const src = GPU.getCanvas();
      recordCtx.drawImage(src, 0, 0, recordCanvas.width, recordCanvas.height);
    } else {
      // ウィンドウ単体: オフスクリーンキャプチャ
      const r = WM.wmGetWindowRect(recordTargetId);
      if (!r || r.w !== recordCapW || r.h !== recordCapH) {
        stopRecording(); // ウィンドウが閉じられた or リサイズされた
        return;
      }
      GPU.beginCapture(recordCapW, recordCapH);
      WM.wmDrawSingleWindow(recordTargetId);
      const frameCanvas = GPU.endCapture(1);
      recordCtx.drawImage(
        frameCanvas,
        0,
        0,
        recordCanvas.width,
        recordCanvas.height,
      );
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GIF ループ撮影 — app.js 連携
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** update() から呼ぶ: GIF カウントダウンを進め、撮影時間を監視 */
export function updateGifTimer() {
  // ── カウントダウン (Delay) ──
  if (gifTimerEnd > 0) {
    const remain = gifTimerEnd - performance.now();
    if (remain <= 0) {
      gifTimerEnd = 0;
      labelGifStatus.text = "";
      gifPending = true;
    } else {
      const sec = Math.ceil(remain / 1000);
      labelGifStatus.text = `${sec}...`;
    }
  }
  // ── 録画中: 経過時間表示 + 自動停止 ──
  if (isGifRecording) {
    const elapsed = performance.now() - gifStartTime;
    if (elapsed >= gifDuration * 1000) {
      stopGifRecording();
    } else {
      labelGifStatus.text = formatElapsed(elapsed);
    }
  }
}

/** draw() から呼ぶ: GIF カウントダウン オーバーレイを描画 */
export function drawGifOverlay() {
  if (gifTimerEnd > 0) {
    const remain = gifTimerEnd - performance.now();
    if (remain > 0) {
      const sec = String(Math.ceil(remain / 1000));
      const tw = textWidth(sec);
      const tx = ((VRAM_WIDTH - tw) / 2) | 0;
      const ty = 4;
      GPU.fillRect(tx - 4, ty - 2, tw + 8, GLYPH_H + 4, 0);
      drawText(tx, ty, sec, 1);
    }
  }
}

/**
 * draw() 末尾 (flush 後) から呼ぶ:
 * 予約された GIF 録画を開始し、録画中は FPS 間隔で VRAM スナップショットを蓄積。
 * ウィンドウ単体録画中にウィンドウが閉じられた/リサイズされた場合は自動停止する。
 */
export function commitGifRecording() {
  if (gifPending) {
    gifPending = false;
    doStartGifRecording();
  }
  if (isGifRecording) {
    const now = performance.now();
    if (now - gifLastFrameTime >= gifFrameInterval) {
      const snap = captureVramSnapshot();
      if (snap) {
        gifFrames.push(snap);
      } else {
        // ターゲットウィンドウが閉じられた or リサイズされた
        stopGifRecording();
        return;
      }
      gifLastFrameTime = now;
    }
  }
}

