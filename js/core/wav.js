/**
 * @module core/wav
 * wav.js — WAV (RIFF) コーデック
 *
 * PCM 音声データの WAV エンコード・デコードをゼロ依存で提供する。
 * gif.js が 1-bit 画像の GIF エンコードを担うように、
 * wav.js は音声データの WAV 入出力を担う。
 *
 * SYNESTA の WAV エクスポート、VFS 上の WAV ファイル読み込み、
 * システム SFX のカスタムサウンド等で使用される。
 *
 * WAV (RIFF) フォーマット概要:
 *   RIFF Header (12 bytes): "RIFF" + fileSize-8 + "WAVE"
 *   fmt  Chunk  (24 bytes): "fmt " + 16 + PCM(1) + channels + sampleRate
 *                            + byteRate + blockAlign + bitsPerSample
 *   data Chunk  (8+N bytes): "data" + dataSize + PCM samples
 *
 * 対応フォーマット:
 *   - エンコード: モノラル / ステレオ、8-bit (unsigned) / 16-bit (signed)
 *   - デコード: モノラル / ステレオ、8-bit / 16-bit PCM (audioFormat=1)
 *
 * 外部依存: なし (ゼロ依存原則に準拠)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** RIFF ヘッダサイズ (bytes) */
const RIFF_HEADER_SIZE = 12;

/** fmt チャンクサイズ (ヘッダ 8 + PCM データ 16 = 24 bytes) */
const FMT_CHUNK_SIZE = 24;

/** data チャンクヘッダサイズ (bytes) */
const DATA_HEADER_SIZE = 8;

/** WAV ヘッダ全体のサイズ (RIFF + fmt + data ヘッダ) */
const WAV_HEADER_SIZE = RIFF_HEADER_SIZE + FMT_CHUNK_SIZE + DATA_HEADER_SIZE;

/** PCM フォーマットコード */
const AUDIO_FORMAT_PCM = 1;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  エンコード
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * PCM サンプルデータを WAV (RIFF) バイナリにエンコードする。
 *
 * @param {Float32Array|Float32Array[]} samples
 *   モノラル: Float32Array (-1.0〜+1.0)
 *   ステレオ: [leftChannel, rightChannel] (各 Float32Array、同一長)
 * @param {number} sampleRate  サンプルレート (Hz) — 例: 44100, 48000
 * @param {number} [bitDepth=16]  ビット深度 (8 or 16)
 * @returns {ArrayBuffer}  WAV バイナリ
 * @throws {Error}  不正なパラメータ
 *
 * @example
 * // モノラル 16-bit 44100Hz
 * const wav = encodeWav(float32Samples, 44100);
 *
 * // ステレオ 16-bit 48000Hz
 * const wav = encodeWav([leftCh, rightCh], 48000, 16);
 */
export function encodeWav(samples, sampleRate, bitDepth = 16) {
  // ── 入力検証 ──
  if (!sampleRate || sampleRate <= 0) {
    throw new Error(`Invalid sampleRate: ${sampleRate}`);
  }
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`Unsupported bitDepth: ${bitDepth} (must be 8 or 16)`);
  }

  // チャンネル正規化: Float32Array → [Float32Array]
  let channels;
  if (Array.isArray(samples)) {
    channels = samples;
  } else if (samples instanceof Float32Array) {
    channels = [samples];
  } else {
    throw new Error("samples must be Float32Array or Float32Array[]");
  }

  const numChannels = channels.length;
  if (numChannels < 1 || numChannels > 2) {
    throw new Error(
      `Unsupported channel count: ${numChannels} (must be 1 or 2)`,
    );
  }

  const numSamples = channels[0].length;
  if (numSamples === 0) {
    throw new Error("samples must not be empty");
  }

  // ステレオ時、チャンネル長が一致することを確認
  if (numChannels === 2 && channels[1].length !== numSamples) {
    throw new Error("Stereo channels must have equal length");
  }

  // ── サイズ計算 ──
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const fileSize = WAV_HEADER_SIZE + dataSize;

  // ── バッファ確保 ──
  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  let offset = 0;

  // ── RIFF ヘッダ ──
  writeString(view, offset, "RIFF");
  offset += 4;
  view.setUint32(offset, fileSize - 8, true);
  offset += 4;
  writeString(view, offset, "WAVE");
  offset += 4;

  // ── fmt チャンク ──
  writeString(view, offset, "fmt ");
  offset += 4;
  view.setUint32(offset, 16, true);
  offset += 4; // チャンクサイズ (PCM = 16)
  view.setUint16(offset, AUDIO_FORMAT_PCM, true);
  offset += 2; // audioFormat
  view.setUint16(offset, numChannels, true);
  offset += 2; // numChannels
  view.setUint32(offset, sampleRate, true);
  offset += 4; // sampleRate
  view.setUint32(offset, byteRate, true);
  offset += 4; // byteRate
  view.setUint16(offset, blockAlign, true);
  offset += 2; // blockAlign
  view.setUint16(offset, bitDepth, true);
  offset += 2; // bitsPerSample

  // ── data チャンク ──
  writeString(view, offset, "data");
  offset += 4;
  view.setUint32(offset, dataSize, true);
  offset += 4;

  // ── PCM サンプル書き込み (インターリーブ) ──
  if (bitDepth === 16) {
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const s = clampSample(channels[ch][i]);
        // Float → 16-bit signed (-32768〜32767)
        const val = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
        view.setInt16(offset, val, true);
        offset += 2;
      }
    }
  } else {
    // 8-bit unsigned (0〜255, 128 = 無音)
    const u8 = new Uint8Array(buffer);
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const s = clampSample(channels[ch][i]);
        // Float → 8-bit unsigned (0〜255)
        u8[offset] = ((s + 1) * 0.5 * 255 + 0.5) | 0;
        offset += 1;
      }
    }
  }

  return buffer;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  デコード
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * WAV (RIFF) バイナリを PCM サンプルデータにデコードする。
 *
 * @param {ArrayBuffer} arrayBuffer  WAV バイナリ
 * @returns {{
 *   samples: Float32Array[],
 *   sampleRate: number,
 *   channels: number,
 *   bitDepth: number,
 *   duration: number
 * }}
 * @throws {Error}  不正なフォーマット
 *
 * @example
 * const { samples, sampleRate, channels, bitDepth, duration } = decodeWav(wavBuf);
 * // samples[0] = left (or mono), samples[1] = right (ステレオ時)
 */
export function decodeWav(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < WAV_HEADER_SIZE) {
    throw new Error("Invalid WAV: too short");
  }

  const view = new DataView(arrayBuffer);
  let offset = 0;

  // ── RIFF ヘッダ検証 ──
  if (readString(view, offset, 4) !== "RIFF") {
    throw new Error("Invalid WAV: missing RIFF header");
  }
  offset += 4;
  // const riffSize = view.getUint32(offset, true);
  offset += 4;
  if (readString(view, offset, 4) !== "WAVE") {
    throw new Error("Invalid WAV: missing WAVE identifier");
  }
  offset += 4;

  // ── チャンク走査 ──
  let fmtFound = false;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= arrayBuffer.byteLength) {
    const chunkId = readString(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    offset += 8;

    if (chunkId === "fmt ") {
      if (chunkSize < 16) {
        throw new Error("Invalid WAV: fmt chunk too small");
      }
      audioFormat = view.getUint16(offset, true);
      numChannels = view.getUint16(offset + 2, true);
      sampleRate = view.getUint32(offset + 4, true);
      // byteRate = view.getUint32(offset + 8, true);
      // blockAlign = view.getUint16(offset + 12, true);
      bitDepth = view.getUint16(offset + 14, true);
      fmtFound = true;
    } else if (chunkId === "data") {
      dataOffset = offset;
      dataSize = chunkSize;
      // fmt が先に見つかっていれば data の位置が確定 → ループ脱出
      if (fmtFound) break;
    }

    // 次のチャンクへ (2 バイトアラインメント)
    offset += chunkSize + (chunkSize & 1);
  }

  // ── 検証 ──
  if (!fmtFound) {
    throw new Error("Invalid WAV: missing fmt chunk");
  }
  if (dataSize === 0) {
    throw new Error("Invalid WAV: missing data chunk");
  }
  if (audioFormat !== AUDIO_FORMAT_PCM) {
    throw new Error(
      `Unsupported WAV format: ${audioFormat} (only PCM supported)`,
    );
  }
  if (numChannels < 1 || numChannels > 2) {
    throw new Error(`Unsupported channel count: ${numChannels}`);
  }
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`Unsupported bitDepth: ${bitDepth} (must be 8 or 16)`);
  }
  if (sampleRate <= 0) {
    throw new Error(`Invalid sampleRate: ${sampleRate}`);
  }

  // ── PCM デコード ──
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const numSamples = Math.floor(dataSize / blockAlign);

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(new Float32Array(numSamples));
  }

  let readOff = dataOffset;
  if (bitDepth === 16) {
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const val = view.getInt16(readOff, true);
        // 16-bit signed → Float (-1.0〜+1.0)
        channels[ch][i] = val / 0x8000;
        readOff += 2;
      }
    }
  } else {
    // 8-bit unsigned → Float
    const u8 = new Uint8Array(arrayBuffer);
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        // 0〜255 → -1.0〜+1.0 (128 = 0.0)
        channels[ch][i] = (u8[readOff] - 128) / 128;
        readOff += 1;
      }
    }
  }

  const duration = numSamples / sampleRate;

  return {
    samples: channels,
    sampleRate,
    channels: numChannels,
    bitDepth,
    duration,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  内部ユーティリティ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * DataView に ASCII 文字列を書き込む。
 * @param {DataView} view
 * @param {number} offset
 * @param {string} str
 */
function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * DataView から ASCII 文字列を読み取る。
 * @param {DataView} view
 * @param {number} offset
 * @param {number} length
 * @returns {string}
 */
function readString(view, offset, length) {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += String.fromCharCode(view.getUint8(offset + i));
  }
  return result;
}

/**
 * サンプル値を -1.0〜+1.0 にクランプする。
 * @param {number} v
 * @returns {number}
 */
function clampSample(v) {
  if (v > 1) return 1;
  if (v < -1) return -1;
  return v;
}

