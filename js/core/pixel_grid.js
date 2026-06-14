/**
 * @module core/pixel_grid
 * pixel_grid.js — 表示エフェクト (Vignette + Diagonal scanline)
 *
 * 1-bit VRAM を 1:1 で RGBA に展開し、Diagonal scanline と Vignette を
 * 適用する純粋関数群。DOM/Canvas に依存しない。
 *
 * パイプライン:
 *   VRAM (Uint8Array, 0/1)
 *     → applyVramRgba    (4-entry LUT で RGBA に展開、Diagonal scanline 同時適用)
 *     → applyVignette    (中心保護の楕円ビネット)
 *
 * 4色パレット:
 *   0: bg ドット
 *   1: fg ドット
 *   2: bg + 斜線暗化
 *   3: fg + 斜線暗化
 *
 * 撤廃済み (BACKLOG「Pixel Grid / Glow / Noise の撤廃」参照):
 *   - CELL=3 のジオメトリ拡大 (Pixel Grid)
 *   - Glow (gap 位置の隣接ピクセル色着色)
 *   - Noise (RGB ランダム揺らぎ)
 *
 * 注: ファイル名は移行期のため pixel_grid.js のまま。
 *     追って refactor コミットで display_fx.js に改名する。
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  パラメータ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ビネットパラメータ */
let _vignetteEnabled = true;
let _vignetteStrength = 0.30;
let _vignetteRadius = 0.10;

/** 斜線パラメータ */
let _diagEnabled = true;
let _diagSpacing = 12;
let _diagThickness = 4;
let _diagDarkness = 0.20;
let _diagSpeed = 20; // px/s (VRAM 座標系)

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Diagonal hit テーブル
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 斜線ヒットテーブル。
 * インデックス i に対応する VRAM 座標が斜線位置なら 1、それ以外は 0。
 * spacing/thickness 変更時に _rebuildDiagHit() で再構築する。
 */
let _diagHit = new Uint8Array([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);

function _rebuildDiagHit() {
  // 余裕として +2 サンプル分長めに確保 (ホットループの境界判定を省略するため)
  const size = _diagSpacing + 2;
  _diagHit = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    _diagHit[i] = i % _diagSpacing < _diagThickness ? 1 : 0;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  斜線アニメーション
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _diagOffset = 0;
let _lastTime = 0;

/** 斜線オフセットを performance.now() ベースで進める。flush() 先頭で呼ぶ */
export function tickDiag() {
  const now = performance.now();
  if (_lastTime > 0) {
    const dt = (now - _lastTime) / 1000;
    _diagOffset = (_diagOffset + _diagSpeed * dt) % (_diagSpacing * 1000);
  }
  _lastTime = now;
}

/** 現在の斜線オフセットを返す */
export function getDiagOffset() {
  return _diagOffset;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  4 色 LUT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 4 色 LUT (packed RGBA, little-endian ABGR)
 * Index: 0=bg, 1=fg, 2=bg+diag, 3=fg+diag
 * インデックス算出: `v + (hit << 1)` (v∈{0,1}, hit∈{0,1})
 */
const _lut = new Uint32Array(4);

/** LUT 変更検知用 (パレット変更の追従) */
let _lutFg0 = -1,
  _lutFg1 = -1,
  _lutFg2 = -1;
let _lutBg0 = -1,
  _lutBg1 = -1,
  _lutBg2 = -1;

/** RGB → packed ABGR (little-endian) */
function pack(r, g, b) {
  return r | (g << 8) | (b << 16) | 0xff000000;
}

/** チャンネルを 0-255 にクランプ + 四捨五入 */
function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
}

/**
 * パレット変更時に 4 色 LUT を再構築する。
 * @param {number[]} fg  前景色 [R, G, B]
 * @param {number[]} bg  背景色 [R, G, B]
 */
export function rebuildLut(fg, bg) {
  _lutFg0 = fg[0];
  _lutFg1 = fg[1];
  _lutFg2 = fg[2];
  _lutBg0 = bg[0];
  _lutBg1 = bg[1];
  _lutBg2 = bg[2];

  _lut[0] = pack(bg[0], bg[1], bg[2]);
  _lut[1] = pack(fg[0], fg[1], fg[2]);

  // diag OFF → darkness=0 → dm=1 → 暗化なし
  const dm = 1 - (_diagEnabled ? _diagDarkness : 0);
  _lut[2] = pack(clamp(bg[0] * dm), clamp(bg[1] * dm), clamp(bg[2] * dm));
  _lut[3] = pack(clamp(fg[0] * dm), clamp(fg[1] * dm), clamp(fg[2] * dm));
}

/**
 * パレットが変わったかチェックし、必要なら LUT を再構築する。
 * @param {number[]} fg
 * @param {number[]} bg
 */
export function ensureLut(fg, bg) {
  if (
    fg[0] !== _lutFg0 ||
    fg[1] !== _lutFg1 ||
    fg[2] !== _lutFg2 ||
    bg[0] !== _lutBg0 ||
    bg[1] !== _lutBg1 ||
    bg[2] !== _lutBg2
  ) {
    rebuildLut(fg, bg);
  }
}

/** Diagonal パラメータ変更時に LUT を強制再構築 */
function _forceRebuildLut() {
  if (_lutFg0 < 0) return;
  rebuildLut([_lutFg0, _lutFg1, _lutFg2], [_lutBg0, _lutBg1, _lutBg2]);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  applyVramRgba — VRAM → RGBA (1:1, Diagonal 同時適用)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 1-bit VRAM を 1:1 で RGBA (Uint32Array) に展開する。
 * Diagonal scanline は LUT の暗化エントリ (2, 3) で同時適用される。
 *
 * @param {Uint32Array} out32   出力先 (w*h 要素、packed RGBA)
 * @param {Uint8Array}  vram    1-bit VRAM (0 or 1)
 * @param {number}      w       VRAM 幅
 * @param {number}      h       VRAM 高さ
 * @param {number}      diagOff 斜線オフセット (px, VRAM 座標系)
 */
export function applyVramRgba(out32, vram, w, h, diagOff) {
  const doff = Math.floor(diagOff);
  const lut = _lut;
  const S = _diagSpacing;
  const dh = _diagHit;

  for (let y = 0; y < h; y++) {
    const rowBase = y * w;
    for (let x = 0; x < w; x++) {
      const v = vram[rowBase + x]; // 0 or 1
      const base = (((x + y - doff) % S) + S) % S;
      const hit = dh[base];
      out32[rowBase + x] = lut[v + (hit << 1)];
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  applyVramIndexed — VRAM → indexed Uint8Array (GIF 用)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 1-bit VRAM を 1:1 で indexed-color に変換する。
 * 出力値は 0-3 のパレットインデックス。GIF エンコード用。
 *
 * @param {Uint8Array} vram     1-bit VRAM (0/1)
 * @param {number}     w        VRAM 幅
 * @param {number}     h        VRAM 高さ
 * @param {number}     diagOff  斜線オフセット (px)
 * @returns {{ data: Uint8Array, width: number, height: number }}
 */
export function applyVramIndexed(vram, w, h, diagOff) {
  const out = new Uint8Array(w * h);
  const doff = Math.floor(diagOff);
  const S = _diagSpacing;
  const dh = _diagHit;

  for (let y = 0; y < h; y++) {
    const rowBase = y * w;
    for (let x = 0; x < w; x++) {
      const v = vram[rowBase + x];
      const base = (((x + y - doff) % S) + S) % S;
      const hit = dh[base];
      out[rowBase + x] = v + (hit << 1);
    }
  }
  return { data: out, width: w, height: h };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  getDisplayPalette — 4 色パレット (GIF 用)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 現在のパレットから 4 色 RGB 配列を返す (GIF エンコード用)。
 * @param {number[]} fg  前景色 [R, G, B]
 * @param {number[]} bg  背景色 [R, G, B]
 * @returns {number[][]}  [[R,G,B], ...] (4 エントリ)
 */
export function getDisplayPalette(fg, bg) {
  const dm = 1 - (_diagEnabled ? _diagDarkness : 0);
  return [
    [bg[0], bg[1], bg[2]], // 0: bg
    [fg[0], fg[1], fg[2]], // 1: fg
    [clamp(bg[0] * dm), clamp(bg[1] * dm), clamp(bg[2] * dm)], // 2: bg+diag
    [clamp(fg[0] * dm), clamp(fg[1] * dm), clamp(fg[2] * dm)], // 3: fg+diag
  ];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Vignette LUT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {Uint16Array|null} factor 0-256 (256 = 変化なし) */
let _vignetteLut = null;
let _vignetteLutW = 0;
let _vignetteLutH = 0;

/**
 * ビネット factor LUT を構築する。
 * initGpu() と Config.onResize() で呼ぶ。
 * @param {number} w  画像幅 (物理ピクセル = VRAM 幅)
 * @param {number} h  画像高さ (物理ピクセル = VRAM 高さ)
 */
export function rebuildVignetteLut(w, h) {
  _vignetteLutW = w;
  _vignetteLutH = h;
  const size = w * h;
  _vignetteLut = new Uint16Array(size);

  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const SQRT2 = Math.SQRT2;
  const rDist = _vignetteRadius * SQRT2;
  const range = SQRT2 - rDist;

  for (let py = 0; py < h; py++) {
    const ny = (py - cy) / cy;
    const ny2 = ny * ny;
    const rowOff = py * w;
    for (let px = 0; px < w; px++) {
      const nx = (px - cx) / cx;
      const d = Math.sqrt(nx * nx + ny2);
      if (d <= rDist) {
        _vignetteLut[rowOff + px] = 256; // 変化なし
      } else {
        const intensity = (_vignetteStrength * (d - rDist)) / range;
        const factor = 1 - Math.min(intensity, 1);
        _vignetteLut[rowOff + px] = ((factor * 256 + 0.5) | 0);
      }
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  applyVignette — 楕円ビネット (連続 RGB 暗化)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * RGBA バッファにビネット効果を適用する。
 * 楕円形 (aspect-corrected) の連続 RGB 乗算暗化。
 *
 * LUT が構築済みかつサイズが一致する場合は高速パス (整数演算のみ)、
 * そうでなければフォールバック (Math.sqrt 直接計算) を使用する。
 *
 * @param {Uint8ClampedArray|Uint8Array} pixels  RGBA ピクセルデータ
 * @param {number} w  画像幅
 * @param {number} h  画像高さ
 */
export function applyVignette(pixels, w, h) {
  if (_vignetteLut && _vignetteLutW === w && _vignetteLutH === h) {
    // 高速パス: LUT から factor を引いて整数演算
    const lut = _vignetteLut;
    const len = w * h;
    for (let i = 0; i < len; i++) {
      const f = lut[i];
      if (f >= 256) continue; // 中心付近 — 完全スキップ
      const idx = i << 2;
      pixels[idx] = (pixels[idx] * f + 128) >> 8;
      pixels[idx + 1] = (pixels[idx + 1] * f + 128) >> 8;
      pixels[idx + 2] = (pixels[idx + 2] * f + 128) >> 8;
    }
    return;
  }

  // フォールバック: LUT なし (endCapture 等でサイズ不一致時)
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const SQRT2 = Math.SQRT2;
  const rDist = _vignetteRadius * SQRT2;
  const range = SQRT2 - rDist;

  for (let py = 0; py < h; py++) {
    const ny = (py - cy) / cy;
    const ny2 = ny * ny;
    for (let px = 0; px < w; px++) {
      const nx = (px - cx) / cx;
      const d = Math.sqrt(nx * nx + ny2);
      if (d <= rDist) continue;
      const intensity = (_vignetteStrength * (d - rDist)) / range;
      const factor = 1 - Math.min(intensity, 1);
      const idx = (py * w + px) * 4;
      pixels[idx] = Math.round(pixels[idx] * factor);
      pixels[idx + 1] = Math.round(pixels[idx + 1] * factor);
      pixels[idx + 2] = Math.round(pixels[idx + 2] * factor);
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  動的パラメータ setter / getter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function isVignetteEnabled() {
  return _vignetteEnabled;
}
export function setVignetteEnabled(v) {
  _vignetteEnabled = !!v;
}
export function setVignetteStrength(v) {
  _vignetteStrength = v;
}
export function setVignetteRadius(v) {
  _vignetteRadius = v;
}

export function setDiagEnabled(v) {
  _diagEnabled = !!v;
  _forceRebuildLut();
}
export function setDiagDarkness(v) {
  _diagDarkness = v;
  _forceRebuildLut();
}
export function setDiagSpeed(v) {
  _diagSpeed = v;
}
export function setDiagSpacing(v) {
  _diagSpacing = v;
  _rebuildDiagHit();
}
export function setDiagThickness(v) {
  _diagThickness = v;
  _rebuildDiagHit();
}
