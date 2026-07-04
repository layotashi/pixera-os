/**
 * @module wm/about
 * about.js — ウィンドウ ABOUT パネルと ⇄ ボディの dither ディゾルブ遷移
 *
 * ヘッダー右クリック → ABOUT でウィンドウのボディ領域に説明パネルを表示し、
 * ボディ ⇄ ABOUT の切替を Bayer 4x4 の ordered dither で溶暗遷移させる。
 * 状態 (_aboutMode / _aboutAnim) は各 win オブジェクトに保持する。
 *
 * ボディ側 (アプリの onDraw) の描画は wm.js の safeOnDraw に依存するため、
 * aboutSetDeps({ drawContent }) で注入する (wm → about の一方向依存)。
 */

import * as GPU from "../core/gpu.js";
import { drawText, GLYPH_W, GLYPH_H } from "../core/font.js";
import { BAYER_4x4 } from "../core/dither.js";
import { wrapText } from "./text_wrap.js";

/** @type {{ drawContent: (win:object, cr:object)=>void }} */
let _deps = {
  drawContent: () => {},
};

/** ボディ描画 (wm.js の safeOnDraw) を注入する。 */
export function aboutSetDeps(deps) {
  _deps = { ..._deps, ...deps };
}

/** ディゾルブのフレーム数 (60fps で約 0.2 秒。ディザの texture が見える程度) */
const ABOUT_ANIM_FRAMES = 12;

/**
 * ABOUT パネルを描画する。ボディ背景は drawWindowFrame 冒頭で塗り済み。
 * 「ABOUT」見出し + 区切り線 + 折り返した説明 + 下部に復帰ヒント。
 */
export function drawAboutPanel(win, cr) {
  const pad = 5;
  const x = cr.x + pad;
  const lineH = GLYPH_H + 3;
  let y = cr.y + pad;

  drawText(x, y, "ABOUT", 1);
  y += GLYPH_H + 2;
  GPU.hline(cr.x + 2, cr.x + cr.w - 3, y, 1);
  y += 4;

  const maxChars = Math.max(1, Math.floor((cr.w - pad * 2) / (GLYPH_W + 1)));
  for (const line of wrapText(win.about, maxChars)) {
    drawText(x, y, line, 1);
    y += lineH;
  }

  // 下部の復帰ヒント (ボディをクリックで戻る)
  const hint = "CLICK TO RETURN";
  drawText(x, cr.y + cr.h - GLYPH_H - 1, hint, 1);
}

/** ディゾルブ遷移を開始する (既に遷移中なら無視) */
export function startAboutTransition(win, toMode) {
  if (win._aboutAnim) return;
  win._aboutAnim = { to: toMode, t: 0, cw: 0, ch: 0, from: null, toBuf: null };
}

/** content rect の現在のピクセルをバッファにコピーする */
function _snapshotRect(cr) {
  const buf = new Uint8Array(cr.w * cr.h);
  for (let yy = 0; yy < cr.h; yy++) {
    for (let xx = 0; xx < cr.w; xx++) {
      buf[yy * cr.w + xx] = GPU.pget(cr.x + xx, cr.y + yy);
    }
  }
  return buf;
}

/** 指定した面 (about or ボディ) を content rect に描画する (スナップショット用) */
function _renderAboutFace(win, cr, aboutMode) {
  GPU.fillRect(cr.x, cr.y, cr.w, cr.h, 0);
  GPU.setClip(cr.x, cr.y, cr.w, cr.h);
  if (aboutMode) {
    drawAboutPanel(win, cr);
  } else if (win.onDraw) {
    const scrollY = win._scrollable && win._vScroll ? win._vScroll.offset : 0;
    const drawCr = scrollY
      ? { x: cr.x, y: cr.y - scrollY, w: cr.w, h: cr.h }
      : cr;
    _deps.drawContent(win, drawCr);
  }
  GPU.resetClip();
}

/**
 * ABOUT ⇄ ボディのディゾルブを 1 フレーム描画する。
 * 初回に from/to 両面をスナップショットし、以降は Bayer 閾値を進めて合成する。
 */
export function drawAboutTransition(win, cr) {
  const anim = win._aboutAnim;
  // content rect サイズが遷移中に変わったら (リサイズ等) 即座に確定する
  if (anim.from && (cr.w !== anim.cw || cr.h !== anim.ch)) {
    win._aboutMode = anim.to;
    win._aboutAnim = null;
    return;
  }
  if (!anim.from) {
    anim.cw = cr.w;
    anim.ch = cr.h;
    _renderAboutFace(win, cr, win._aboutMode); // FROM = 現在の面
    anim.from = _snapshotRect(cr);
    _renderAboutFace(win, cr, anim.to); // TO = 遷移先の面
    anim.toBuf = _snapshotRect(cr);
  }
  // Bayer 4x4 (0..15) を閾値に、t に応じて from→to を ordered dither で混ぜる
  const thr = Math.round(anim.t * 17); // 0 → 全 from, 17 → 全 to
  for (let yy = 0; yy < cr.h; yy++) {
    const brow = BAYER_4x4[yy & 3]; // BAYER_4x4 は [row][col] の 2 次元配列
    for (let xx = 0; xx < cr.w; xx++) {
      const idx = yy * cr.w + xx;
      const v = brow[xx & 3] < thr ? anim.toBuf[idx] : anim.from[idx];
      GPU.pset(cr.x + xx, cr.y + yy, v);
    }
  }
  anim.t += 1 / ABOUT_ANIM_FRAMES;
  if (anim.t >= 1) {
    win._aboutMode = anim.to;
    win._aboutAnim = null;
  }
}
