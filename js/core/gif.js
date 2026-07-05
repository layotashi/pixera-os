/**
 * @module core/gif
 * gif.js — GIF89a エンコーダ (1-bit / 2色パレット特化)
 *
 * PIXERA OS の 1-bit VRAM データから GIF89a アニメーションを生成する。
 * 2 色固定パレットに特化しているため、汎用 GIF エンコーダよりも
 * はるかにシンプルかつ高速に動作する。
 *
 * GIF89a フォーマット概要:
 *   Header → Logical Screen Descriptor → Global Color Table
 *   → Netscape Application Extension (ループ)
 *   → (Graphic Control Extension → Image Descriptor → LZW 圧縮データ) × N フレーム
 *   → Trailer
 *
 * 外部依存: なし (ゼロ依存原則に準拠)
 */

/**
 * GIF として「クリーン」に再生できる fps 候補（GIF 専用 UI の選択肢の SSoT）。
 *
 * GIF のフレーム遅延はセンチ秒(1/100s)整数でしか書けない
 * （_buildGraphicControlExtension の round(delayMs/10)）。ゆえに 100 の約数のみ
 * round(100/fps) が割り切れ、速度・ループ長がズレない
 * （例: 12→8cs=12.5fps / 15→7cs≒14.3fps とズレる）。上限は 50:
 * 1cs(=100fps) はブラウザが 10cs へクランプするため GIF では無効。
 * MP4 は μ秒精度で不問なので、TESSERA 側 FPS_OPTIONS はより広い集合を別に持つ。
 */
export const GIF_CLEAN_FPS = [10, 20, 25, 50];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LZW 圧縮 (2色パレット用)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * LZW 圧縮を実行する。
 *
 * GIF の LZW は可変長コード (minCodeSize+1 ビットから開始) で辞書を構築する。
 * 2 色パレットの場合 minCodeSize=2 (GIF仕様: 最小2)、
 * 初期コードサイズは 3 ビットから始まる。
 *
 * @param {Uint8Array} pixels  0/1 のピクセルインデックス配列
 * @param {number}     minCodeSize  最小コードサイズ (2色パレットでは 2)
 * @returns {Uint8Array}  LZW 圧縮されたバイト列 (サブブロック形式)
 */
export function lzwEncode(pixels, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const maxDictSize = 4096; // GIF LZW は 12ビットまで

  // 辞書: key = "prefix,suffix" → code
  // 2色では辞書エントリが限られるため Map で十分高速
  let dict = new Map();

  // ビットバッファ → バイト列
  let bitBuf = 0;
  let bitCount = 0;
  const output = [];

  /** 可変長コードをビットバッファに書き込む */
  function writeCode(code) {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      output.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCount -= 8;
    }
  }

  /** 辞書をリセット (Clear Code 発行時) */
  function resetDict() {
    dict.clear();
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  }

  // ── エンコード本体 ──
  writeCode(clearCode);

  if (pixels.length === 0) {
    writeCode(eoiCode);
    // 残りビットをフラッシュ
    if (bitCount > 0) output.push(bitBuf & 0xff);
    return _packSubBlocks(output);
  }

  let current = pixels[0]; // 現在のプレフィックス (初期値: 最初のピクセル)

  for (let i = 1; i < pixels.length; i++) {
    const next = pixels[i];
    const key = (current << 12) | next; // 2色なので current は 0 or 1; 数値キーで高速化

    if (dict.has(key)) {
      current = dict.get(key);
    } else {
      writeCode(current);
      if (nextCode < maxDictSize) {
        dict.set(key, nextCode++);
        // コードサイズ拡張チェック
        // 標準 GIF デコーダとの同期のため、エンコーダは遅延拡張 (>) を使用。
        // デコーダの辞書構築は 1 エントリ遅れるため、デコーダ側の >= と
        // 対になることで同じフレームで codeSize が切り替わる。
        if (nextCode > 1 << codeSize && codeSize < 12) {
          codeSize++;
        }
      } else {
        // 辞書が満杯 → クリアして再構築
        writeCode(clearCode);
        resetDict();
      }
      current = next;
    }
  }

  // 最後のプレフィックスを出力
  writeCode(current);
  writeCode(eoiCode);

  // 残りビットをフラッシュ
  if (bitCount > 0) output.push(bitBuf & 0xff);

  return _packSubBlocks(output);
}

/**
 * バイト列を GIF サブブロック形式 (最大 255 バイト + 長さプレフィックス) にパックする。
 * 末尾に Block Terminator (0x00) を付与する。
 *
 * @param {number[]} data  圧縮済みバイト配列
 * @returns {Uint8Array}  サブブロック形式のバイト列
 */
function _packSubBlocks(data) {
  const result = [];
  let offset = 0;
  while (offset < data.length) {
    const chunkSize = Math.min(255, data.length - offset);
    result.push(chunkSize);
    for (let i = 0; i < chunkSize; i++) {
      result.push(data[offset++]);
    }
  }
  result.push(0x00); // Block Terminator
  return new Uint8Array(result);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GIF89a 構造体ビルダー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * GIF89a ヘッダ + Logical Screen Descriptor を生成する。
 * @param {number} width   画像幅
 * @param {number} height  画像高さ
 * @returns {Uint8Array}
 */
function _buildHeader(width, height) {
  const buf = new Uint8Array(13);
  // Signature + Version: "GIF89a"
  buf[0] = 0x47; // G
  buf[1] = 0x49; // I
  buf[2] = 0x46; // F
  buf[3] = 0x38; // 8
  buf[4] = 0x39; // 9
  buf[5] = 0x61; // a
  // Logical Screen Width (little-endian)
  buf[6] = width & 0xff;
  buf[7] = (width >> 8) & 0xff;
  // Logical Screen Height (little-endian)
  buf[8] = height & 0xff;
  buf[9] = (height >> 8) & 0xff;
  // Packed field: GCT Flag=1, Color Resolution=1 (2bit), Sort=0, GCT Size=1 (2^(1+1)=4 entries)
  // 2色パレットだが GIF は最低 2^(n+1) エントリ → n=0 で 2 エントリ
  buf[10] = 0x80 | (0 << 4) | 0; // GCT=1, CR=0(1bit), Sort=0, Size=0 (2 entries)
  buf[11] = 0; // Background Color Index
  buf[12] = 0; // Pixel Aspect Ratio
  return buf;
}

/**
 * Global Color Table (2 エントリ = 6 バイト) を生成する。
 * @param {number[]} bgRgb  背景色 [R, G, B]
 * @param {number[]} fgRgb  前景色 [R, G, B]
 * @returns {Uint8Array}
 */
function _buildGlobalColorTable(bgRgb, fgRgb) {
  return new Uint8Array([
    bgRgb[0],
    bgRgb[1],
    bgRgb[2], // Index 0: BG
    fgRgb[0],
    fgRgb[1],
    fgRgb[2], // Index 1: FG
  ]);
}

/**
 * Netscape Application Extension (無限ループ) を生成する。
 * @param {number} loopCount  ループ回数 (0 = 無限ループ)
 * @returns {Uint8Array}
 */
function _buildNetscapeExtension(loopCount = 0) {
  return new Uint8Array([
    0x21, // Extension Introducer
    0xff, // Application Extension Label
    0x0b, // Block Size (11)
    // "NETSCAPE2.0"
    0x4e,
    0x45,
    0x54,
    0x53,
    0x43,
    0x41,
    0x50,
    0x45,
    0x32,
    0x2e,
    0x30,
    0x03, // Sub-block size
    0x01, // Sub-block ID
    loopCount & 0xff,
    (loopCount >> 8) & 0xff, // Loop count (little-endian)
    0x00, // Block Terminator
  ]);
}

/**
 * Graphic Control Extension を生成する。
 * @param {number} delayMs  フレーム表示時間 (ミリ秒)
 * @returns {Uint8Array}
 */
function _buildGraphicControlExtension(delayMs) {
  // GIF の delay は 1/100 秒単位
  const delayCs = Math.max(1, Math.round(delayMs / 10));
  return new Uint8Array([
    0x21, // Extension Introducer
    0xf9, // Graphic Control Label
    0x04, // Block Size
    0x00, // Packed: Disposal=0 (none), User Input=0, Transparent=0
    delayCs & 0xff,
    (delayCs >> 8) & 0xff, // Delay (little-endian, 1/100s)
    0x00, // Transparent Color Index (unused)
    0x00, // Block Terminator
  ]);
}

/**
 * Image Descriptor を生成する。
 * @param {number} width   フレーム幅
 * @param {number} height  フレーム高さ
 * @returns {Uint8Array}
 */
function _buildImageDescriptor(width, height) {
  return new Uint8Array([
    0x2c, // Image Separator
    0x00,
    0x00, // Left Position
    0x00,
    0x00, // Top Position
    width & 0xff,
    (width >> 8) & 0xff, // Width
    height & 0xff,
    (height >> 8) & 0xff, // Height
    0x00, // Packed: No Local CT, Not Interlaced
  ]);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  パブリック API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 1-bit フレーム配列から GIF89a アニメーションをエンコードする。
 *
 * @param {Array<Uint8Array>} frames  VRAM スナップショットの配列 (各要素: 0/1 の Uint8Array)
 * @param {number} width      フレーム幅 (px)
 * @param {number} height     フレーム高さ (px)
 * @param {number[]} bgRgb    背景色 [R, G, B]
 * @param {number[]} fgRgb    前景色 [R, G, B]
 * @param {number} fps        フレームレート
 * @param {number} [scale=1]  出力倍率 (整数)
 * @returns {Blob}  image/gif の Blob
 */
export function encodeGif(frames, width, height, bgRgb, fgRgb, fps, scale = 1) {
  const outW = width * scale;
  const outH = height * scale;
  const delayMs = 1000 / fps;
  const minCodeSize = 2; // GIF 仕様: 最小 2

  // ── 各パーツを構築 ──
  const parts = [];
  parts.push(_buildHeader(outW, outH));
  parts.push(_buildGlobalColorTable(bgRgb, fgRgb));
  parts.push(_buildNetscapeExtension(0)); // 無限ループ

  for (let i = 0; i < frames.length; i++) {
    parts.push(_buildGraphicControlExtension(delayMs));
    parts.push(_buildImageDescriptor(outW, outH));

    // 最小コードサイズ (1バイト)
    parts.push(new Uint8Array([minCodeSize]));

    // フレームデータ: scale > 1 の場合はピクセル繰り返しで拡大
    let pixelData;
    if (scale <= 1) {
      pixelData = frames[i];
    } else {
      pixelData = _scaleFrame(frames[i], width, height, scale);
    }
    parts.push(lzwEncode(pixelData, minCodeSize));
  }

  // Trailer
  parts.push(new Uint8Array([0x3b]));

  return new Blob(parts, { type: "image/gif" });
}

/**
 * フレームを整数倍にニアレストネイバー拡大する。
 * @param {Uint8Array} src     元フレーム (indexed)
 * @param {number}     srcW    元幅
 * @param {number}     srcH    元高さ
 * @param {number}     scale   倍率
 * @returns {Uint8Array}  拡大後のフレーム
 */
function _scaleFrame(src, srcW, srcH, scale) {
  const dstW = srcW * scale;
  const dstH = srcH * scale;
  const dst = new Uint8Array(dstW * dstH);
  for (let sy = 0; sy < srcH; sy++) {
    const srcRow = sy * srcW;
    const dstRowBase = sy * scale * dstW;
    for (let sx = 0; sx < srcW; sx++) {
      const val = src[srcRow + sx];
      const dstColBase = sx * scale;
      for (let dy = 0; dy < scale; dy++) {
        const dstRow = dstRowBase + dy * dstW + dstColBase;
        for (let dx = 0; dx < scale; dx++) {
          dst[dstRow + dx] = val;
        }
      }
    }
  }
  return dst;
}

