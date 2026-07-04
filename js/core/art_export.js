/**
 * @module core/art_export
 * art_export.js — 1-bit アートの「合成 → 書き出し」パイプライン（アプリ非依存・共有）。
 *
 * 入力は常に「art 解像度の 1-bit バッファ」。これを額縁マット付きで base 解像度に中央合成し、
 * 整数 ×scale で拡大して PNG / GIF / MP4 として保存する。サイズモデル（出力 = base ×scale）と
 * フレーム捕捉はアプリ側の責務、合成と符号化・ダウンロードはここに集約する。
 * TESSERA が使う共有モジュール（北極星 B の延長＝出力も共有）。
 *
 * 書き出しは**作品そのもの＝純粋な 2 色 1-bit**。SYNESTA 仮想 OS 側の表示エフェクト
 * （Diagonal scanline / Vignette）は画面の雰囲気であって作品ではないため、PNG/GIF/MP4 とも
 * 一切焼き込まない（PNG も GPU.endCapture を介さず palette 2 色で直接ラスタライズする）。
 * invert（白黒反転）は全形式とも bg/fg のスワップで表現する。
 */

import { palette } from "../config.js";
import { encodeGif } from "./gif.js";
import { encodeMp4, isMp4Supported, isMp4AudioSupported } from "./mp4.js";

export { isMp4Supported };

/**
 * art 解像度の 1-bit バッファを base 解像度に中央合成する（周囲は 0＝額縁マット）。
 * art = base − 2·pad なので端数なく上下左右対称。
 * @param {Uint8Array} artBuf  art 解像度の 1-bit バッファ
 * @returns {Uint8Array} base 解像度の 1-bit バッファ
 */
export function composeMatte(artBuf, artW, artH, baseW, baseH) {
  const out = new Uint8Array(baseW * baseH);
  const x0 = (baseW - artW) >> 1,
    y0 = (baseH - artH) >> 1;
  for (let y = 0; y < artH; y++) {
    const sy = y * artW;
    out.set(artBuf.subarray(sy, sy + artW), (y0 + y) * baseW + x0);
  }
  return out;
}

/**
 * Blob をファイル名付きでダウンロードさせる（<a download> クリック）。
 * js/ 全体でこの 1 実装のみが URL.createObjectURL を使う (SSoT)。
 */
export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.download = filename;
  a.href = url;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 1-bit バッファを palette 2 色で canvas にラスタライズ（CRT 効果なし・整数 ×scale）。
 * @param {number[]} fg  [r,g,b]（ink=1）
 * @param {number[]} bg  [r,g,b]（=0）
 * @returns {HTMLCanvasElement}
 */
function bufToCanvas(buf, w, h, scale, fg, bg) {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    const c = buf[i] ? fg : bg;
    const o = i * 4;
    d[o] = c[0];
    d[o + 1] = c[1];
    d[o + 2] = c[2];
    d[o + 3] = 255;
  }
  const c1 = document.createElement("canvas");
  c1.width = w;
  c1.height = h;
  c1.getContext("2d").putImageData(img, 0, 0);
  if (scale <= 1) return c1;
  const out = document.createElement("canvas");
  out.width = w * scale;
  out.height = h * scale;
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = false; // 整数倍 NN（ぼかさない）
  ctx.drawImage(c1, 0, 0, w * scale, h * scale);
  return out;
}

/**
 * base 1-bit バッファを整数 ×scale で PNG 化してダウンロードする（純粋 2 色・CRT なし）。
 * @param {Uint8Array} baseBuf  base 解像度の 1-bit バッファ
 * @param {boolean} invert      白黒反転（bg/fg をスワップ）
 */
export function downloadPng(baseBuf, baseW, baseH, scale, invert, filename) {
  let bg = palette.bg,
    fg = palette.fg;
  if (invert) {
    const t = bg;
    bg = fg;
    fg = t;
  }
  const canvas = bufToCanvas(baseBuf, baseW, baseH, scale, fg, bg);
  canvas.toBlob((blob) => {
    if (blob) triggerDownload(blob, filename);
  }, "image/png");
}

/**
 * base 1-bit フレーム列を GIF / MP4 にエンコードしてダウンロードする。
 * エンコーダが ×scale 拡大する。GIF は同期、MP4 は WebCodecs（非同期・タイムアウト付）。
 * @param {Uint8Array[]} frames  base 解像度の 1-bit フレーム列
 * @param {"gif"|"mp4"} format
 * @param {(s:string)=>void} [onStatus]  進捗テキスト通知（任意）
 * @param {{samples:Float32Array, sampleRate:number}|null} [audio]  MP4 に多重化する
 *   PCM 音声（モノラル・任意）。AAC 非対応環境では音声を落とし、status で明示する。
 * @returns {Promise<void>}
 */
export function exportVideo(
  frames,
  baseW,
  baseH,
  scale,
  invert,
  fps,
  format,
  filename,
  onStatus,
  audio = null,
) {
  let bg = palette.bg,
    fg = palette.fg;
  if (invert) {
    const t = bg;
    bg = fg;
    fg = t;
  }
  const status = (s) => onStatus && onStatus(s);

  if (format === "mp4") {
    status("ENCODING MP4...");
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("MP4 encode timeout")), 30000),
    );
    const run = async () => {
      let aud = audio;
      let doneNote = "";
      if (aud && !(await isMp4AudioSupported(aud.sampleRate))) {
        aud = null; // 音声だけ落として映像は書き出す
        doneNote = "MP4 SAVED - NO AUDIO (AAC N/A)";
      }
      const blob = await encodeMp4(frames, baseW, baseH, bg, fg, fps, scale, aud);
      triggerDownload(blob, filename);
      status(doneNote);
    };
    return Promise.race([run(), timeout]).catch((err) => {
      console.error("[art_export] MP4 encode failed:", err);
      status("MP4 ENCODE ERROR");
    });
  }

  // GIF: 自前エンコーダで同期。次フレームに遅延して "ENCODING" を見せる。
  status("ENCODING GIF...");
  return new Promise((resolve) =>
    setTimeout(() => {
      const blob = encodeGif(frames, baseW, baseH, bg, fg, fps, scale);
      triggerDownload(blob, filename);
      status("");
      resolve();
    }, 30),
  );
}

/** 1-bit バッファを NN で dw×dh へ拡大/縮小する。 */
export function resampleNN(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sRow = (((y * sh) / dh) | 0) * sw;
    const dRow = y * dw;
    for (let x = 0; x < dw; x++) out[dRow + x] = src[sRow + (((x * sw) / dw) | 0)];
  }
  return out;
}
