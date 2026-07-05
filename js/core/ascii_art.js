/**
 * @module core/ascii_art
 * ascii_art.js — ASCII Art 変換エンジン (文字濃淡ハーフトーニング)
 *
 * 文字グリフの塗り面積率 (density) に基づき、RGBA 画像データを
 * 文字の濃淡で表現する。ディザリング (dither.js) と対をなす、
 * もう一つの 1-bit 画像表現手法。
 *
 * 手法:
 *   Tone-based ASCII Art — 各文字の density (前景ピクセル数 / 総ピクセル数) を
 *   事前計算し、画像の各ブロックの平均輝度に最も近い density の文字を割り当てる。
 *   ラインプリンタ時代 (1960s–) から続く古典的アルゴリズム。
 *
 * 前処理:
 *   dither.js と同じ Percentile Stretch + Gamma 補正パイプラインを使用し、
 *   コントラスト調整の一貫性を保つ。
 *
 * 依存:
 *   core/font.js — getGlyph() でグリフビットマップを取得し density を算出
 */

import { getGlyph, drawText, GLYPH_W, GLYPH_H } from "./font.js";
import { onFontChange } from "../config.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ASCII 可視文字の範囲 */
const FIRST_CHAR = 0x20;
const LAST_CHAR = 0x7e;

/** 1 グリフのピクセル数 */
let TOTAL_PIXELS = GLYPH_W * GLYPH_H;

/**
 * 豆腐 (未定義グリフのプレースホルダ箱) とみなす、同一ビットマップの最小重複数。
 * PIXERA OS フォントでは未定義スロット (英小文字など) が同一の箱グリフで埋まる。
 * これ以上重複する非空ビットマップは豆腐と判定し tone ramp から除外する。
 * 偶発的な字形一致 (5x5 では稀に起こる) を誤除外しないための閾値。
 */
const TOFU_MIN = 4;

/** 描画時の文字セルピッチ (drawText と同じ) */
export let CELL_W = GLYPH_W + 1;
export let CELL_H = GLYPH_H + 1;

// ── フォント変更リスナー ──
onFontChange(() => {
  TOTAL_PIXELS = GLYPH_W * GLYPH_H;
  CELL_W = GLYPH_W + 1;
  CELL_H = GLYPH_H + 1;
  _cachedRamp = null;
  _tofuSig = undefined;
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  内部状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {{ ch: string, density: number }[] | null} */
let _cachedRamp = null;

/**
 * フォント全体から確定した豆腐 (未定義プレースホルダ箱) のビットマップ署名。
 * undefined = 未算出, null = 豆腐なし, string = 豆腐署名。
 * @type {string | null | undefined}
 */
let _tofuSig = undefined;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Density 計算
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * グリフビットマップの塗り面積率を算出する。
 *
 * @param {Uint8Array} glyph  0/1 のビットマップ配列
 * @returns {number}  density (0.0 = 空白, 1.0 = 全塗り)
 */
export function calcDensity(glyph) {
  let count = 0;
  for (let i = 0; i < glyph.length; i++) count += glyph[i];
  return count / glyph.length;
}

/**
 * グリフビットマップを文字列署名に変換する (豆腐検出用)。
 * 同一ビットマップは同一署名になる。
 *
 * @param {Uint8Array} glyph  0/1 のビットマップ配列
 * @returns {string}
 */
function glyphSignature(glyph) {
  let s = "";
  for (let i = 0; i < glyph.length; i++) s += glyph[i];
  return s;
}

/**
 * フォント全体 (ASCII 0x20–0x7E) を走査し、豆腐 (未定義グリフの
 * プレースホルダ箱) のビットマップ署名を確定する (キャッシュ付き)。
 *
 * 未定義スロットは同一の箱グリフで繰り返し現れるため、非空ビットマップのうち
 * 最頻の署名を豆腐とみなす。TOFU_MIN 個以上重複していなければ豆腐なし (null)。
 *
 * フォント全体から一度だけ確定するので、個々の tone ramp に豆腐文字が
 * 1 個しか含まれなくても (例: preset の "o")、確実に除外できる。
 *
 * @returns {string | null}  豆腐署名、なければ null
 */
function getTofuSignature() {
  if (_tofuSig !== undefined) return _tofuSig;
  const freq = new Map();
  for (let c = FIRST_CHAR; c <= LAST_CHAR; c++) {
    const glyph = getGlyph(String.fromCharCode(c));
    if (!glyph) continue;
    if (calcDensity(glyph) === 0) continue; // 空白は対象外
    const sig = glyphSignature(glyph);
    freq.set(sig, (freq.get(sig) || 0) + 1);
  }
  let sig = null;
  let n = 0;
  for (const [s, count] of freq) {
    if (count > n) {
      n = count;
      sig = s;
    }
  }
  _tofuSig = n >= TOFU_MIN ? sig : null;
  return _tofuSig;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Tone Ramp
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * フォントのグリフデータから density ランプ (tone ramp) を構築する。
 *
 * density = 前景ピクセル数 / 総ピクセル数。
 * density の昇順にソートされた配列を返す (先頭が最も明るい = 塗り面積が少ない)。
 *
 * @param {string} [chars]  使用文字セット (省略時は ASCII 0x20–0x7E 全文字)
 * @returns {{ ch: string, density: number }[]}  density 昇順ソート済み
 */
export function buildToneRamp(chars) {
  if (!chars) {
    chars = "";
    for (let c = FIRST_CHAR; c <= LAST_CHAR; c++) {
      chars += String.fromCharCode(c);
    }
  }

  // ── 豆腐 (未定義グリフのプレースホルダ箱) を除外しつつグリフ収集 ──
  // 豆腐署名はフォント全体から確定する (getTofuSignature)。これにより
  // ramp に豆腐文字が 1 個しか含まれなくても (例: preset の "o") 確実に落とす。
  // (豆腐は塗り潰し箱 = density が高いため、除外しないと最暗部に箱が出る)
  const tofuSig = getTofuSignature();
  const ramp = [];
  for (const ch of chars) {
    const glyph = getGlyph(ch);
    if (!glyph) continue;
    if (tofuSig !== null && glyphSignature(glyph) === tofuSig) continue;
    ramp.push({ ch, density: calcDensity(glyph) });
  }

  // density 昇順 (同 density なら文字コード順)
  ramp.sort(
    (a, b) => a.density - b.density || a.ch.charCodeAt(0) - b.ch.charCodeAt(0),
  );

  return ramp;
}

/**
 * デフォルトの tone ramp を取得する (キャッシュ付き)。
 * font.js が initFont() で初期化済みであることが前提。
 *
 * @returns {{ ch: string, density: number }[]}
 */
export function getDefaultRamp() {
  if (!_cachedRamp) {
    _cachedRamp = buildToneRamp();
  }
  return _cachedRamp;
}

/**
 * デフォルトランプのキャッシュをクリアする。
 * フォント切り替え時等に呼ぶ。
 */
export function clearRampCache() {
  _cachedRamp = null;
}

/**
 * tone ramp を文字列として取得する (表示・デバッグ用)。
 *
 * @param {{ ch: string, density: number }[]} ramp
 * @returns {string}
 */
export function getRampString(ramp) {
  return ramp.map((e) => e.ch).join("");
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  サイズ算出
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ソース画像のアスペクト比を維持しつつ、
 * maxCols × maxRows に収まる最大の cols × rows を算出する。
 *
 * 文字セルの縦横比 (CELL_W : CELL_H) に応じて、画面上のアスペクト比を
 * 維持するよう cols/rows を補正する。5x5 フォントではセルは正方形 (6×6)
 * になるが、将来寸法が変わっても CELL_W/CELL_H から動的に算出する。
 *
 * @param {number} srcW  ソース画像の幅
 * @param {number} srcH  ソース画像の高さ
 * @param {number} maxCols  最大列数
 * @param {number} maxRows  最大行数
 * @returns {{ cols: number, rows: number }}
 */
export function calcAsciiSize(srcW, srcH, maxCols, maxRows) {
  const cellAspect = CELL_W / CELL_H; // 5x5 フォントでは 6/6 = 1.0 (正方形セル)
  const srcAspect = srcW / srcH;

  // adjustedAspect = 画面上の正しいアスペクト比を得るための cols/rows 比
  const adjustedAspect = srcAspect / cellAspect;

  let cols, rows;
  if (adjustedAspect * maxRows <= maxCols) {
    // rows が制約
    rows = maxRows;
    cols = Math.round(rows * adjustedAspect);
  } else {
    // cols が制約
    cols = maxCols;
    rows = Math.round(cols / adjustedAspect);
  }

  return {
    cols: Math.max(1, Math.min(cols, maxCols)),
    rows: Math.max(1, Math.min(rows, maxRows)),
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  内部ヘルパー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * tone ramp から targetDensity に最も近い文字を二分探索で取得する。
 *
 * @param {{ ch: string, density: number }[]} ramp  density 昇順ソート済み
 * @param {number} targetDensity  目標 density (0.0–1.0)
 * @returns {string}  最近傍の文字
 */
export function findNearest(ramp, targetDensity) {
  let lo = 0;
  let hi = ramp.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ramp[mid].density < targetDensity) lo = mid + 1;
    else hi = mid;
  }

  // lo は density >= targetDensity の先頭。lo-1 と比較して最近傍を選択
  if (lo > 0) {
    const dLo = Math.abs(ramp[lo].density - targetDensity);
    const dPrev = Math.abs(ramp[lo - 1].density - targetDensity);
    if (dPrev < dLo) lo--;
  }

  return ramp[lo].ch;
}

/**
 * スカラー場 (0..1, cols×rows) を tone ramp で文字グリッドへ変換する（共有コア）。
 * 場を文字濃淡に落とす「決定」はこの 1 関数に集約する（プレビューも書き出しも同一）。
 * グリフのラスタライズ（文字→ピクセル）はホスト側の責務（レイアウトが異なるため）。
 *
 * @param {Float32Array|number[]} field  長さ cols*rows、各 0..1
 * @param {number} cols  文字グリッド列数
 * @param {number} rows  文字グリッド行数
 * @param {{ ch: string, density: number }[]} ramp  density 昇順ソート済み
 * @returns {string[]}  行ごとの文字列（length=rows、各 length=cols）
 */
export function renderAsciiLines(field, cols, rows, ramp) {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      let v = field[base + c];
      if (v < 0) v = 0;
      else if (v > 1) v = 1;
      line += findNearest(ramp, v);
    }
    lines.push(line);
  }
  return lines;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  変換 API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * RGBA 画像データを文字濃淡で ASCII Art 文字グリッドに変換する。
 *
 * ソース画像を cols × rows のブロックに分割し、
 * 各ブロックの平均輝度 (BT.709) を tone ramp の最近傍文字にマッピングする。
 *
 * 前処理 (Percentile Stretch + Gamma) は dither.js と同じアルゴリズム。
 *
 * @param {Uint8ClampedArray} rgba  ソース RGBA ピクセルデータ (srcW × srcH × 4)
 * @param {number} srcW  ソース幅
 * @param {number} srcH  ソース高さ
 * @param {number} cols  出力列数 (文字数)
 * @param {number} rows  出力行数 (文字数)
 * @param {object} [opts]
 * @param {{ ch: string, density: number }[]} [opts.ramp]   カスタム tone ramp (省略時はデフォルト)
 * @param {boolean} [opts.invert=false]  明暗反転
 * @param {number}  [opts.gamma=1.0]     ガンマ補正値 (0.5–2.0)
 * @param {number}  [opts.low=1.0]       Percentile Stretch 下位 (0–50)
 * @param {number}  [opts.high=99.0]     Percentile Stretch 上位 (50–100)
 * @returns {string[]}  行ごとの文字列配列 (length = rows, 各文字列の length = cols)
 */
export function asciiRGBA(rgba, srcW, srcH, cols, rows, opts = {}) {
  const ramp = opts.ramp || getDefaultRamp();
  const invert = opts.invert || false;
  const gamma = opts.gamma ?? 1.0;
  const stretchLow = opts.low ?? 1.0;
  const stretchHigh = opts.high ?? 99.0;

  // ランプが空の場合はスペースで埋める
  if (ramp.length === 0) {
    return Array.from({ length: rows }, () => " ".repeat(cols));
  }

  const blockW = srcW / cols;
  const blockH = srcH / rows;
  const invGamma = 1.0 / gamma;

  // ── Pass 1: 各ブロックの平均輝度 + ヒストグラム ──
  const totalBlocks = cols * rows;
  const lumBuf = new Float32Array(totalBlocks);
  const hist = new Uint32Array(256);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = (c * blockW) | 0;
      const x1 = Math.min(((c + 1) * blockW) | 0, srcW);
      const y0 = (r * blockH) | 0;
      const y1 = Math.min(((r + 1) * blockH) | 0, srcH);

      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const si = (sy * srcW + sx) * 4;
          sum +=
            rgba[si] * 0.2126 + rgba[si + 1] * 0.7152 + rgba[si + 2] * 0.0722;
          count++;
        }
      }

      const avg = count > 0 ? sum / count : 0;
      lumBuf[r * cols + c] = avg;
      hist[Math.min(255, avg | 0)]++;
    }
  }

  // ── Percentile Stretch 閾値算出 ──
  const lowCount = ((totalBlocks * stretchLow) / 100) | 0;
  const highCount = ((totalBlocks * stretchHigh) / 100) | 0;
  let cumul = 0;
  let loVal = 0;
  let hiVal = 255;
  for (let i = 0; i < 256; i++) {
    cumul += hist[i];
    if (cumul <= lowCount) loVal = i;
    if (cumul < highCount) hiVal = i;
  }
  hiVal = Math.max(hiVal, loVal + 1); // ゼロ除算防止
  const range = hiVal - loVal;

  // ── Pass 2: Stretch + Gamma + 文字マッピング ──
  const result = [];

  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      // Percentile Stretch: [loVal, hiVal] → [0, 1]
      let v = (lumBuf[r * cols + c] - loVal) / range;
      if (v < 0) v = 0;
      if (v > 1) v = 1;

      // Gamma 補正
      if (invGamma !== 1.0) v = v ** invGamma;

      // 反転
      if (invert) v = 1 - v;

      // 輝度 → density マッピング
      // 高輝度 (v→1) = 画面上で明るい → density が高い文字 (塗り面積が多い)
      const targetDensity = v;
      line += findNearest(ramp, targetDensity);
    }
    result.push(line);
  }

  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画 API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ASCII Art 文字グリッドを VRAM に描画する。
 *
 * 各行を drawText で描画する。行間は CELL_H (= GLYPH_H + 1) ピクセル。
 *
 * @param {string[]} lines  行ごとの文字列配列
 * @param {number} x  描画先 X
 * @param {number} y  描画先 Y
 * @param {number} c  描画色 (0 or 1)
 */
export function drawAsciiArt(lines, x, y, c) {
  for (let r = 0; r < lines.length; r++) {
    drawText(x, y + r * CELL_H, lines[r], c);
  }
}

