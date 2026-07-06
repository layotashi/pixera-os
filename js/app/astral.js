/**
 * @module app/astral
 * astral.js — ASTRAL (1-bit 星空観測所) のプロトタイプ
 *
 * 動く 1-bit 星空を窓に表示する「映える画面」専用アプリ。
 * クリックすると星に名前を付けられる (フッターに表示)。
 *
 * プロトタイプ仕様:
 *   - ランダム生成された 50 個の星 (固定 seed で再現可能)
 *   - 星はサイズ違い 3 段階 (大: 3px 十字, 中: 2px, 小: 1px)
 *   - 時間経過で空が左へゆっくり流れる (日周運動の擬似)
 *   - クリックで最も近い星にカーソル → 名前入力 UI (簡略版: 自動命名)
 *
 * 未実装 (本格化時の検討事項):
 *   - 本物の星カタログ (Yale Bright Star) を JSON で同梱
 *   - 緯度経度 + 日時から実際の天体位置を計算
 *   - 命名済み星の VFS 保存 (/.astral/log.txt)
 *   - 星座線描画 (実在 or 空想)
 *   - 流れ星のランダム演出
 */

import { pset, fillRect, hline, vline } from "../core/gpu.js";
import { drawText, GLYPH_W, GLYPH_H } from "../core/font.js";
import { wmOpen, wmRegister } from "../wm/index.js";

const APP_NAME = "ASTRAL";

const WIN_W = 220;
const WIN_H = 160;
const FOOTER_H = GLYPH_H + 4;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  星生成 (固定 seed)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function mulberry32(seed) {
  let s = seed;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAR_FIELD_W = WIN_W * 2; // 横スクロール用に倍幅

function generateStars() {
  const rng = mulberry32(20260615);
  const stars = [];
  for (let i = 0; i < 80; i++) {
    const r = rng();
    const size = r < 0.6 ? 1 : r < 0.9 ? 2 : 3; // 大半は小さい
    stars.push({
      x: rng() * STAR_FIELD_W,
      y: rng() * (WIN_H - FOOTER_H - 4) + 2,
      size,
      name: null,
      id: i,
    });
  }
  return stars;
}

let stars = generateStars();
let scrollX = 0;
let frame = 0;
/** @type {{id:number,name:string}|null} 最後に命名された星の情報 (footer 表示用) */
let lastNamed = null;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  星名生成 (擬似)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PREFIXES = ["ALPHA", "BETA", "GAMMA", "DELTA", "EPSILON", "ZETA", "ETA"];
const CONSTELLATIONS = ["LYRAE", "CYGNI", "ORIONIS", "AQUILAE", "URSAE", "DRACONIS", "MENSAE"];

function autoName(starId) {
  // 番号ベースでカタログ風の擬似ラテン名を生成
  const pref = PREFIXES[starId % PREFIXES.length];
  const cons = CONSTELLATIONS[(starId * 7) % CONSTELLATIONS.length];
  return `${pref} ${cons}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画 / 入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function drawStar(cr, star) {
  const x = cr.x + Math.floor(((star.x - scrollX) % STAR_FIELD_W + STAR_FIELD_W) % STAR_FIELD_W);
  if (x < cr.x || x >= cr.x + cr.w) return;
  const y = cr.y + Math.floor(star.y);
  if (y < cr.y + 1 || y >= cr.y + cr.h - FOOTER_H) return;

  if (star.size === 1) {
    pset(x, y, 1);
  } else if (star.size === 2) {
    pset(x, y, 1);
    pset(x + 1, y, 1);
    pset(x, y + 1, 1);
    pset(x + 1, y + 1, 1);
  } else {
    // 3 = 十字 (約 3x3 の星)
    pset(x, y - 1, 1);
    pset(x - 1, y, 1);
    pset(x, y, 1);
    pset(x + 1, y, 1);
    pset(x, y + 1, 1);
  }

  // 命名済みは小さなマーカー (右肩に ★ 風の pset)
  if (star.name) {
    pset(x + 2, y - 2, 1);
    pset(x + 3, y - 2, 1);
  }
}

function onDraw(cr) {
  frame++;
  // 空が西へゆっくり流れる
  scrollX += 0.15;

  // 星描画
  for (const s of stars) drawStar(cr, s);

  // 仮の地平線 (フッターの上の区切り)
  const horizonY = cr.y + cr.h - FOOTER_H - 1;
  hline(cr.x, cr.x + cr.w - 1, horizonY, 1);

  // フッター: 最後に命名した星 or 案内
  const footerY = horizonY + 3;
  if (lastNamed) {
    drawText(cr.x + 2, footerY, `LOG: ${lastNamed.name}`, 1);
  } else {
    drawText(cr.x + 2, footerY, "CLICK A STAR TO NAME IT", 1);
  }
}

function _screenStarPos(star) {
  return ((star.x - scrollX) % STAR_FIELD_W + STAR_FIELD_W) % STAR_FIELD_W;
}

function onInput(ev) {
  if (ev.type !== "down") return;
  // 最も近い星 (15px 以内) を探して命名
  let best = null;
  let bestD = 15 * 15;
  for (const s of stars) {
    const sx = _screenStarPos(s);
    const dx = sx - ev.localX;
    const dy = s.y - ev.localY;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) {
      bestD = d2;
      best = s;
    }
  }
  if (best) {
    if (!best.name) best.name = autoName(best.id);
    lastNamed = { id: best.id, name: best.name };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    return wmOpen(-1, -1, WIN_W, WIN_H, APP_NAME, onDraw, onInput, null, {
      noResize: true,
      noMaximize: true,
      about:
        "A generated 1-bit starfield that drifts slowly westward. Click " +
        "near a star to give it a catalog name; the last name is logged " +
        "at the bottom.",
    });
  },
  { category: "EXPERIMENT" },
);
