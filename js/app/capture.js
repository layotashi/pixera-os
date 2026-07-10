/**
 * @module app/capture
 * capture.js — CAPTURE ウィンドウ (スクリーンショット + 動画撮影 + GIF ループ)
 *
 * 仮想画面 or 個別ウィンドウのスクリーンキャプチャ機能。
 * delay=0 で即時、１〜10 でタイマー撮影。
 * 特定ウィンドウ撮影時は自動的に最前面に昇格してからキャプチャ。
 * GIF ループ機能: VRAM フレームを蓄積し、自前 GIF89a エンコーダで
 * 純 2 色 1-bit のアニメーション GIF としてダウンロードする。表示エフェクト
 * (Diagonal / Vignette) は画面の雰囲気であって作品ではないため焼き込まない
 * (X 等の再エンコードで色境界が滲む主因になるため)。fps は GIF_CLEAN_FPS 限定。
 *
 * 排他制御: 動画録画と GIF ループは GPU キャプチャバッファを共有するため
 * 同時実行を禁止する (_isContinuousRecordingBusy)。
 * リサイズ検出: ウィンドウ単体録画中にサイズ変更を検出した場合は自動停止する。
 *
 * ── 動画録画の A/V 同期 ──
 * 録画の時間基準は **オーディオのサンプル時計ひとつだけ** とする。
 *   映像フレーム i の提示時刻 = i / RECORD_FPS   (CFR。落ちたフレームは直前の絵を複製)
 *   PCM サンプル k の時刻     = k / sampleRate
 * 両者は同じ原点 (PCM 収録開始時のオーディオ時刻) を持つので、原点も速度も一致する。
 * 毎フレーム「今あるべきフレーム番号」を getPcmElapsed() から逆算して追いつかせ
 * (core/av_sync.js)、映像は WebCodecs で、音声は AudioWorklet の PCM タップで拾い、
 * core/mp4.js の自前 muxer で明示的なタイムスタンプとして書き込む。
 *
 * 以前は canvas.captureStream + MediaStreamAudioDestinationNode を MediaRecorder に
 * 渡していた。この場合、映像は compositor の時計・音声は AudioContext の時計で刻まれ、
 * 両者の対応づけは UA の内部実装任せになる。こちらからタイムスタンプは見えず、ずれの
 * 測定も補正もできない (固定の遅延値を足しても環境依存で合わない)。この経路は
 * WebCodecs / AudioWorklet 非対応環境のフォールバックとしてのみ残す。
 *
 * update/draw から参照される状態を export する。
 */

import { VRAM_WIDTH, VRAM_HEIGHT, getScale, palette } from "../config.js";
import * as GPU from "../core/gpu.js";
import { encodeGif, GIF_CLEAN_FPS } from "../core/gif.js";
import { drawIcon, ICON_W, ICON_H } from "../core/icon.js";
import { drawText, textWidth, GLYPH_H } from "../core/font.js";
import * as WM from "../wm/index.js";
import * as UI from "../ui/index.js";
import {
  initAudio,
  getAudioStream,
  startPcmCapture,
  stopPcmCapture,
  getPcmElapsed,
  isPcmCaptureSupported,
} from "../core/audio.js";
import { createMp4Encoder, isMp4Supported } from "../core/mp4.js";
import { framesDueAt, fitPcmToVideo } from "../core/av_sync.js";
import { triggerDownload } from "../core/art_export.js";
import { renderWallpaperBuffer } from "../wallpaper.js";

const APP_NAME = "CAPTURE";

// ── GIF ループ撮影設定 ──
// fps は GIF_CLEAN_FPS (100 の約数のみ) を使う。理由は gif.js の同定数コメント参照。
const GIF_FPS_OPTIONS = GIF_CLEAN_FPS; // [10, 20, 25, 50]
const GIF_MAX_DURATION = 10; // 最大撮影時間 (秒)
const GIF_DEFAULT_DURATION = 3; // デフォルト撮影時間 (秒)
const GIF_DEFAULT_FPS = 20; // デフォルト FPS (TESSERA 既定と一致)

// ── マット (額装) 設定 ──
// SNS (X 等) の角丸表示で外周デザインが欠けるのを防ぐため、ウィンドウ撮影時に
// 四辺均等の余白を足し、対象を中央に額装する。余白は現在の壁紙をそのまま延長して敷く
// (壁紙は解像度非依存＝拡大劣化なし)。Full screen はデスクトップ全体が既に額なので対象外。
const MATTE_MIN_PAD = 4; // 最小余白 (px)
const MATTE_MAX_PAD = 128; // 最大余白 (px)
const MATTE_DEFAULT_PAD = 24; // デフォルト余白 (px)
const MATTE_PAD_STEP = 4; // 余白の増減ステップ (px)

// ── スクリーンショット状態 ──
let screenshotPending = false;
let screenshotCount = 0;
let screenshotTimerEnd = 0;
let screenshotDelay = 0;
let screenshotTargetId = -1; // -1 = Full screen
let screenshotScale = 2; // 撮影倍率 (1-10 の整数)
let matteEnabled = false; // マット (額装) の ON/OFF
let mattePadding = MATTE_DEFAULT_PAD; // マット余白 (px, 各辺)

// ── 動画撮影設定 ──
/** 録画フレームレート (固定)。録画の時間軸はこの値で刻む (CFR)。
 *  30fps にしているのは、録画の毎フレーム処理 (合成 + new VideoFrame スナップショット +
 *  エンコード投入 + GC) がメインスレッドを占有し、同じスレッドで捌く MIDI 入力・演奏の
 *  発音スケジューリングを遅らせてジッタを生むため。fps を下げるとこの毎フレーム負荷が
 *  そのまま比例して減り、リアルタイム演奏の余地が広がる。30fps は画面録画として標準的で
 *  1-bit UI では見た目の劣化もほぼ無い。A/V 同期は fps 非依存 (core/av_sync.js) なので
 *  この値を変えても映像と音声のずれは生じない。 */
const RECORD_FPS = 30;
/** 1 tick で追いつかせる最大フレーム数 (タブ復帰直後の暴走を防ぐ。数 tick で収束する) */
const RECORD_MAX_CATCHUP = RECORD_FPS * 5;

// ── 動画撮影状態 ──
let isRecording = false;
let recordCanvas = null;
let recordCtx = null;
let recordTimerEnd = 0;
let recordPending = false;
let recordStarting = false; // エンコーダ/PCM タップの起動待ち (非同期)
let recordFinishing = false; // 停止後のエンコード・書き出し中
let recordTargetId = -1; // 録画開始時にロック
let recordCapW = 0; // 録画開始時のキャプチャ幅 (リサイズ検出用, コンテンツ実寸)
let recordCapH = 0; // 録画開始時のキャプチャ高さ (リサイズ検出用, コンテンツ実寸)
let recordPad = 0; // 録画開始時にロックしたマット余白 (px, 0 = マット無し)

// ── 決定的録画 (WebCodecs + 自前 muxer) ──
// 映像と音声を「オーディオのサンプル時計」という単一の時間基準に揃える経路。
let recordEncoder = null; // createMp4Encoder() の戻り。null なら MediaRecorder 経路
let recordFrames = 0; // 投入済みフレーム数 = 録画の時間基準 (recordFrames / RECORD_FPS 秒)

// ── MediaRecorder フォールバック (WebCodecs / AudioWorklet 非対応環境) ──
// この経路の A/V 整合は UA 任せで、こちらからは検証も補正もできない。
let mediaRecorder = null;
let recordChunks = [];
let recordMimeType = "";
let recordStartTime = 0; // フォールバック経路の経過表示用 (performance.now)

// ── GIF ループ撮影状態 ──
let isGifRecording = false;
let gifFrames = [];
let gifStartTime = 0;
let gifDuration = GIF_DEFAULT_DURATION;
let gifFps = GIF_DEFAULT_FPS;
let gifFrameInterval = 0; // ms — 1/fps
let gifTimerEnd = 0;
let gifPending = false;
let gifEncoding = false; // エンコード中フラグ
let gifTargetId = -1; // 録画開始時にロック
let gifFrameWidth = VRAM_WIDTH; // コンテンツ実寸 (リサイズ検出用)
let gifFrameHeight = VRAM_HEIGHT; // コンテンツ実寸 (リサイズ検出用)
let gifPad = 0; // 録画開始時にロックしたマット余白 (px, 0 = マット無し)

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
    recordStarting ||
    recordFinishing ||
    isGifRecording ||
    gifTimerEnd > 0 ||
    gifPending ||
    gifEncoding
  );
}

/** マットが有効か (ウィンドウ対象かつトグル ON)。Full screen では常に無効。 */
function matteActive() {
  return screenshotTargetId >= 0 && matteEnabled;
}

/**
 * 対象ウィンドウをキャプチャバッファに描画する。pad>0 ならマット (額装) 付き:
 * 壁紙を敷いた (w+2pad)×(h+2pad) の下地の上に、ウィンドウを (pad,pad) にずらして描く。
 * 呼び出し後はキャプチャバッファがアクティブなので、呼び元で
 * GPU.endCapture()/endCaptureRaw() を実行すること。
 * @param {number} id  ウィンドウ ID
 * @param {number} w  ウィンドウ幅 (コンテンツ実寸)
 * @param {number} h  ウィンドウ高さ (コンテンツ実寸)
 * @param {number} pad  マット余白 (px, 0 でマット無し)
 */
function beginWindowCapture(id, w, h, pad) {
  if (pad > 0) {
    const matte = renderWallpaperBuffer(w + pad * 2, h + pad * 2);
    GPU.beginCapture(w + pad * 2, h + pad * 2, matte);
    WM.wmDrawSingleWindow(id, pad, pad);
  } else {
    GPU.beginCapture(w, h);
    WM.wmDrawSingleWindow(id);
  }
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
  if (matteActive()) {
    w += mattePadding * 2;
    h += mattePadding * 2;
  }
  lblOutput.text = `${w * screenshotScale}x${h * screenshotScale} px`;
}

/** ドロップダウンの項目を更新 */
function refreshTargetItems() {
  const wins = WM.wmGetWindowList().filter((w) => w.title !== APP_NAME);
  const items = ["Full screen", ...wins.map((w) => w.title)];
  ddTarget.items = items; // setter が w/h を自動再計算
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
    // ── 個別ウィンドウ: オフスクリーンキャプチャ (マット付きなら額装) ──
    const r = WM.wmGetWindowRect(screenshotTargetId);
    if (!r) return;
    const pad = matteActive() ? mattePadding : 0;
    beginWindowCapture(screenshotTargetId, r.w, r.h, pad);
    resultCanvas = GPU.endCapture(screenshotScale);
  }

  resultCanvas.toBlob((blob) => {
    if (!blob) return;
    screenshotCount++;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    triggerDownload(blob, `screenshot_${ts}_${screenshotCount}.png`);
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

/** タイムスタンプ付きファイル名 */
function stampedName(ext) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `recording_${ts}.${ext}`;
}

/**
 * 決定的録画 (映像と音声が単一の時間基準を共有する経路) が使えるか。
 * WebCodecs で映像を自前エンコード + AudioWorklet で PCM を直接収録する。
 */
function canRecordDeterministic() {
  return isMp4Supported() && isPcmCaptureSupported();
}

/** 録画フォーマットラベル (MP4 / WebM) */
function recordFormatLabel() {
  if (canRecordDeterministic()) return "(MP4)";
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

/**
 * 録画ターゲット (ウィンドウ / Full screen) とフレーム寸法を確定し、
 * 合成用オフスクリーン canvas を用意する。
 * @returns {{outW:number, outH:number}}
 */
function lockRecordTarget() {
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
  // マット余白を録画開始時にロック (Full screen は対象外)
  recordPad = recordTargetId >= 0 && matteEnabled ? mattePadding : 0;

  // 録画用オフスクリーン canvas (マット込みフレーム × 追加スケーリング)。
  // H.264 は偶数寸法が前提なので、エンコーダの丸めと canvas を一致させる。
  let outW = (capW + recordPad * 2) * screenshotScale;
  let outH = (capH + recordPad * 2) * screenshotScale;
  if (outW & 1) outW++;
  if (outH & 1) outH++;

  recordCanvas = document.createElement("canvas");
  recordCanvas.width = outW;
  recordCanvas.height = outH;
  recordCtx = recordCanvas.getContext("2d");
  recordCtx.imageSmoothingEnabled = false;
  return { outW, outH };
}

/** 録画用 canvas / エンコーダ / PCM タップを解放する */
function releaseRecordResources() {
  recordCanvas = null;
  recordCtx = null;
  recordEncoder = null;
  recordFrames = 0;
}

/** 録画を実際に開始 (非同期 — エンコーダ設定と PCM タップの起動を待つ) */
async function doStartRecording() {
  if (isRecording || recordStarting) return;
  recordStarting = true;
  try {
    const { outW, outH } = lockRecordTarget();

    if (canRecordDeterministic()) {
      try {
        recordEncoder = await createMp4Encoder(outW, outH, RECORD_FPS);
        await startPcmCapture();
        recordFrames = 0;
        isRecording = true;
        return;
      } catch (e) {
        console.warn("[capture] deterministic recording unavailable:", e);
        if (recordEncoder) recordEncoder.abort();
        recordEncoder = null;
      }
    }

    if (!startMediaRecorderFallback()) {
      labelRecordStatus.text = "ERR";
      releaseRecordResources();
    }
  } catch (e) {
    console.error("[capture] failed to start recording:", e);
    labelRecordStatus.text = "ERR";
    releaseRecordResources();
  } finally {
    recordStarting = false;
  }
}

/**
 * MediaRecorder 経路で開始する (WebCodecs / AudioWorklet が無い環境の保険)。
 * 映像は canvas の captureStream、音声は MediaStreamAudioDestinationNode。
 * 両者のタイムスタンプは UA が独立に付けるため、A/V の整合はこちらでは保証できない。
 * @returns {boolean} 開始できたか
 */
function startMediaRecorderFallback() {
  recordMimeType = detectRecordingMimeType();
  if (!recordMimeType) return false;

  const videoStream = recordCanvas.captureStream(RECORD_FPS);
  const combinedStream = new MediaStream();
  videoStream.getVideoTracks().forEach((t) => combinedStream.addTrack(t));
  const audioStream = getAudioStream();
  if (audioStream) {
    audioStream.getAudioTracks().forEach((t) => combinedStream.addTrack(t));
  }

  // 高ビットレートでピクセルパーフェクトを維持
  const bitrate = Math.max(
    recordCanvas.width * recordCanvas.height * 30,
    10_000_000,
  );

  mediaRecorder = new MediaRecorder(combinedStream, {
    mimeType: recordMimeType,
    videoBitsPerSecond: bitrate,
  });

  recordChunks = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    const ext = recordMimeType.startsWith("video/mp4") ? "mp4" : "webm";
    const blob = new Blob(recordChunks, { type: recordMimeType });
    triggerDownload(blob, stampedName(ext));
    recordChunks = [];
    releaseRecordResources();
  };
  mediaRecorder.start();

  isRecording = true;
  recordFrames = 0;
  recordStartTime = performance.now();
  return true;
}

/** 録画を停止し、書き出す */
function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  if (!recordEncoder) {
    if (mediaRecorder) mediaRecorder.stop();
    mediaRecorder = null;
    labelRecordStatus.text = recordFormatLabel();
    return;
  }
  finishDeterministicRecording();
}

/**
 * 決定的録画を締める。PCM を映像の長さちょうどに揃えてから mux する。
 *
 * PCM の先頭サンプルと映像フレーム 0 は同じオーディオ時刻を原点に持つ
 * (startPcmCapture が返す startTime)。停止は最後のフレーム描画より必ず後になるので、
 * fitPcmToVideo は通常「末尾を数 ms 切る」方向に働く。
 */
async function finishDeterministicRecording() {
  const encoder = recordEncoder;
  const frames = recordFrames;
  recordEncoder = null;
  recordFinishing = true;
  labelRecordStatus.text = "Encoding...";

  try {
    const { samples, sampleRate } = await stopPcmCapture();
    if (frames === 0) throw new Error("no frames captured");
    const pcm = fitPcmToVideo(samples, frames, RECORD_FPS, sampleRate);
    const blob = await encoder.finish({ samples: pcm, sampleRate });
    triggerDownload(blob, stampedName("mp4"));
    labelRecordStatus.text = recordFormatLabel();
  } catch (e) {
    console.error("[capture] recording export failed:", e);
    encoder.abort();
    labelRecordStatus.text = "ERR";
  } finally {
    recordFinishing = false;
    releaseRecordResources();
  }
}

/**
 * 現在の画面 (or 対象ウィンドウ) を録画用 canvas に合成する。
 * @returns {boolean} 合成できたか (false = ウィンドウが閉じられた/リサイズされた)
 */
function composeRecordFrame() {
  if (recordTargetId < 0) {
    // Full screen
    recordCtx.drawImage(
      GPU.getCanvas(),
      0,
      0,
      recordCanvas.width,
      recordCanvas.height,
    );
    return true;
  }
  // ウィンドウ単体: オフスクリーンキャプチャ (マット付きなら額装)
  const r = WM.wmGetWindowRect(recordTargetId);
  if (!r || r.w !== recordCapW || r.h !== recordCapH) return false;
  beginWindowCapture(recordTargetId, recordCapW, recordCapH, recordPad);
  const frameCanvas = GPU.endCapture(1);
  recordCtx.drawImage(
    frameCanvas,
    0,
    0,
    recordCanvas.width,
    recordCanvas.height,
  );
  return true;
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
  // マット余白を録画開始時にロック (Full screen は対象外)
  gifPad = gifTargetId >= 0 && matteEnabled ? mattePadding : 0;

  gifFrames = [];
  gifFrameInterval = 1000 / gifFps;
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
    // 純 2 色 1-bit で書き出す (Diagonal / Vignette は焼き込まない)。
    // palette.bg/fg は invert 反映済みなので、そのまま渡せば画面の明暗と一致する。
    // フレームサイズは録画開始時にロックした値 (VRAM 等倍 or ウィンドウ実寸 + マット余白)。
    // マット (壁紙由来) は実 1-bit コンテンツなので純 2 色 GIF にそのまま焼ける。
    const blob = encodeGif(
      gifFrames,
      gifFrameWidth + gifPad * 2,
      gifFrameHeight + gifPad * 2,
      palette.bg,
      palette.fg,
      gifFps,
      screenshotScale,
    );

    // ダウンロード
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    triggerDownload(blob, `loop_${ts}.gif`);

    gifFrames = [];
    gifEncoding = false;
    labelGifStatus.text = "(GIF)";
  }, 0);
}

/**
 * VRAM のスナップショットを純 2 色 1-bit フレーム (0/1 の Uint8Array) として取得する。
 * 表示エフェクト (Diagonal / Vignette) は焼き込まない。
 * ウィンドウ単体録画時、ウィンドウが閉じられたかリサイズされた場合は null を返す。
 * @returns {Uint8Array|null}
 */
function captureVramSnapshot() {
  if (gifTargetId < 0) {
    // Full screen: 生 VRAM (0/1) を 1:1 でコピー
    const len = VRAM_WIDTH * VRAM_HEIGHT;
    return GPU.vram.slice(0, len);
  }
  // ウィンドウ単体: オフスクリーンキャプチャ (生 1-bit, マット付きなら額装)
  const r = WM.wmGetWindowRect(gifTargetId);
  // ウィンドウが閉じられた or リサイズされた (比較はコンテンツ実寸で行う)
  if (!r || r.w !== gifFrameWidth || r.h !== gifFrameHeight) return null;
  beginWindowCapture(gifTargetId, gifFrameWidth, gifFrameHeight, gifPad);
  return GPU.endCaptureRaw();
}

// ── ウィジェット (遅延初期化) ──
let lblTarget, ddTarget;
let lblScale, nbScale;
let lblMatte, tglMatte;
let lblMargin, nbMargin, lblMarginPx;
let lblOutputHdr, lblOutput;
let lblDelay, nbDelay, labelSeconds;
let lblCapture, btnCapture, lblCountdown;
let lblRecord, btnRecord, labelRecordStatus;
let lblGif, btnGif, labelGifStatus;
let lblGifDuration, nbGifDuration, labelGifDurSec;
let lblGifFps, ddGifFps;
let sepScreenshot, sepRecord;
let matteRow, marginRow; // 出し分け対象の行 Box (Full screen / トグル状態で表示切替)
let screenshotWidgets;
let captureRoot;
let _ready = false;

/** 左端を揃える対象ラベル一覧 (幅統一に使う) */
function allCapLabels() {
  return [
    lblTarget,
    lblScale,
    lblMatte,
    lblMargin,
    lblDelay,
    lblCapture,
    lblRecord,
    lblGifDuration,
    lblGifFps,
    lblGif,
  ];
}

/**
 * マット関連行の可視性を同期する。
 * matteRow  : ウィンドウ対象のときのみ (Full screen はマット無し)。
 * marginRow : さらにマット ON のときのみ。
 * 1-bit UI ではグレーアウトできないため show/hide で表現する。
 */
function refreshMatteVisibility() {
  const isWindow = screenshotTargetId >= 0;
  matteRow.visible = isWindow;
  marginRow.visible = isWindow && matteEnabled;
}

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

  // Row 2: Scale: [number]
  lblScale = new UI.Label(0, 0, "Scale:");
  nbScale = new UI.NumberBox(0, 0, 1, 10, screenshotScale, 1, (v) => {
    screenshotScale = v;
    refreshOutputLabel();
  });
  nbScale.tooltip = "Output magnification (1-10x)";

  // Matte: [toggle] — ウィンドウ撮影時のみ表示 (Full screen はマット無し)
  lblMatte = new UI.Label(0, 0, "Matte:");
  tglMatte = new UI.ToggleButton(
    0,
    0,
    "ON",
    (v) => {
      matteEnabled = v;
      refreshOutputLabel();
    },
    matteEnabled,
  );
  tglMatte.tooltip = "Frame the window with a wallpaper margin (defeats SNS corner rounding)";

  // Margin: [number] px — マット ON 時のみ表示
  lblMargin = new UI.Label(0, 0, "Margin:");
  nbMargin = new UI.NumberBox(
    0,
    0,
    MATTE_MIN_PAD,
    MATTE_MAX_PAD,
    mattePadding,
    MATTE_PAD_STEP,
    (v) => {
      mattePadding = v;
      refreshOutputLabel();
    },
  );
  nbMargin.tooltip = "Matte margin around the window (px per side)";
  lblMarginPx = new UI.Label(0, 0, "px");

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
  const capLabels = allCapLabels();
  const lblW = Math.max(...capLabels.map((l) => l.w));
  for (const l of capLabels) l.w = lblW;

  // ── 出し分け対象の行 Box (可視性は refreshMatteVisibility が制御) ──
  matteRow = UI.HBox([lblMatte, tglMatte]);
  marginRow = UI.HBox([lblMargin, nbMargin, lblMarginPx]);

  // ── Box レイアウト ──
  captureRoot = UI.VBox([
    UI.HBox([lblTarget, ddTarget]),
    UI.HBox([lblScale, nbScale]),
    matteRow,
    marginRow,
    UI.HBox([lblDelay, nbDelay, labelSeconds]),
    sepScreenshot,
    UI.HBox([lblCapture, btnCapture, lblCountdown]),
    UI.HBox([lblRecord, btnRecord, labelRecordStatus]),
    sepRecord,
    UI.HBox([lblGifDuration, nbGifDuration, labelGifDurSec]),
    UI.HBox([lblGifFps, ddGifFps]),
    UI.HBox([lblGif, btnGif, labelGifStatus]),
  ]);

  refreshOutputLabel();
  // 初期可視性を確定させる (初回 measure が正しい行数を返すよう WidgetGroup 生成前に)
  refreshMatteVisibility();

  // フォーマットラベル初期化
  labelRecordStatus.text = recordFormatLabel();

  // WidgetGroup(root) は初期 layout + draw/update/measure 前の auto-layout を実行
  screenshotWidgets = new UI.WidgetGroup(captureRoot);
}

function onSshotDraw(contentRect) {
  _initWidgets();
  refreshTargetItems();
  refreshMatteVisibility();
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
      about:
        "Captures the screen or a single window as a PNG, video, or " +
        "looping GIF. Set a delay for a timed shot.",
      footer: true,
      onDrawFooter: (footerRect) => {
        refreshOutputLabel();
        drawText(footerRect.x, footerRect.y, lblOutput.text, 1);
      },
      onRelayout: () => {
        screenshotWidgets.remeasureAll();
        // ラベル幅再統一
        const capLabels = allCapLabels();
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
    // 経過表示も録画の時間基準そのもの (書き出されるフレーム数 / fps) から出す。
    // 決定的経路では recordFrames が唯一の「録画時間」で、performance.now() は使わない。
    const elapsedMs = recordEncoder
      ? (recordFrames / RECORD_FPS) * 1000
      : performance.now() - recordStartTime;
    labelRecordStatus.text = formatElapsed(elapsedMs);
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
 * 予約された録画を開始し、録画中は毎フレーム録画 canvas に合成してエンコーダへ投入する。
 * ウィンドウ単体録画中にウィンドウが閉じられた/リサイズされた場合は自動停止する。
 *
 * ── 同期の要点 ──
 * 映像フレームの投入本数は「収録中の PCM と同じオーディオ時計」で決める
 * (getPcmElapsed → framesDueAt)。rAF が遅れてもフレーム番号は時刻から逆算されるので、
 * 出力の映像時間軸 (フレーム i の提示時刻 = i / RECORD_FPS) と音声時間軸
 * (サンプル k の時刻 = k / sampleRate) は原点も速度も一致する。
 *
 * canvas.captureStream + MediaRecorder に任せていた頃は、映像を compositor の時計で、
 * 音声を AudioContext の時計で刻み、両者の対応づけを UA に委ねていた。こちらからは
 * タイムスタンプが見えず、ずれの測定も補正もできなかった (フォールバック経路には残る)。
 */
export function commitRecording() {
  if (recordPending) {
    recordPending = false;
    // 非同期に開始する (エンコーダ設定 + worklet 読み込み)。完了までフレームは進めない。
    doStartRecording();
  }
  if (!isRecording || !recordCtx) return;

  // MediaRecorder 経路: canvas を更新するだけで UA が好きなタイミングで拾う
  if (!recordEncoder) {
    if (!composeRecordFrame()) stopRecording();
    return;
  }

  // 今あるべきフレーム番号を音の時計から逆算する。まだ次のフレームの時刻に達していなければ
  // 何もしない (rAF が 60Hz を超えるディスプレイでも、書き出す本数は RECORD_FPS のまま)。
  const due = framesDueAt(getPcmElapsed(), RECORD_FPS);
  if (recordFrames >= due) return;

  if (!composeRecordFrame()) {
    stopRecording(); // ウィンドウが閉じられた or リサイズされた
    return;
  }

  // 取りこぼしたぶんは直前の絵を複製して埋め、フレーム番号と時刻の対応を保つ (CFR)。
  const limit = Math.min(due, recordFrames + RECORD_MAX_CATCHUP);
  while (recordFrames < limit) {
    recordEncoder.addFrame(recordCanvas);
    recordFrames++;
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
 *
 * 捕捉は「前回捕捉時刻からの経過」ではなく「録画開始からの経過時間」を基準に、
 * 今あるべきフレーム数まで追いつかせる方式で行う。requestAnimationFrame の
 * tick 間隔 (ディスプレイのリフレッシュレート依存、通常 60Hz≒16.7ms) は
 * gifFrameInterval (例: 50fps=20ms) と綺麗に割り切れないことが多く、
 * 「前回捕捉時刻」を基準にすると tick 境界で毎回わずかに超過した分が切り捨てられ、
 * 実効キャプチャ間隔が gifFrameInterval よりシステマティックに間延びする
 * (例: 60Hz 環境で 50fps 指定 → 実際は約 30fps しか捕捉されない)。
 * GIF は捕捉フレーム数 × (1/fps) で再生時間が決まるため、フレームが目減りした分
 * だけ実際の録画時間より短く再生され、早回し (fast-forward) して見えてしまう。
 * 開始時刻からの絶対経過時間で「あるべきフレーム数」を都度計算すれば、
 * tick 粒度に起因するズレは蓄積せず平均で正しい fps に収束する。
 */
export function commitGifRecording() {
  if (gifPending) {
    gifPending = false;
    doStartGifRecording();
  }
  if (isGifRecording) {
    const now = performance.now();
    const targetFrameCount =
      Math.floor((now - gifStartTime) / gifFrameInterval) + 1;
    while (gifFrames.length < targetFrameCount) {
      const snap = captureVramSnapshot();
      if (!snap) {
        // ターゲットウィンドウが閉じられた or リサイズされた
        stopGifRecording();
        return;
      }
      gifFrames.push(snap);
    }
  }
}
