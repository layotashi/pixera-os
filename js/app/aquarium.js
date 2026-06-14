/**
 * @module app/aquarium
 * aquarium.js — AQUARIUM (1-bit 水槽) のプロトタイプ
 *
 * 1-bit ピクセルアートの魚が群れで泳ぐ「映える画面」専用ウィンドウ。
 * After Dark の水槽スクリーンセーバーの SYNESTA 的再解釈。
 *
 * プロトタイプ仕様:
 *   - 5 匹の魚が boids 風の単純規則で泳ぐ (中央への引力 + 個体間反発 + 壁反発)
 *   - 魚はサイズ違い 2 種 (大魚 7×4、小魚 5×3)
 *   - クリックで魚が散る (escape)
 *   - 水草が窓底に飾られている (装飾)
 *
 * 未実装 (本格化時の検討事項):
 *   - 多様な魚種スプライト (PAINT 連携 / SPRITE エディタ)
 *   - 餌を与えるインタラクション
 *   - 命名・繁殖などの Tamagotchi 的要素 (スコープ膨張に注意)
 *   - 気泡・泡音の SE
 */

import { fillRect, pset, hline, vline } from "../core/gpu.js";
import { wmOpen, wmRegister } from "../wm/index.js";

const APP_NAME = "AQUARIUM";

const WIN_W = 200;
const WIN_H = 140;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  魚スプライト (5x3 と 7x4 の 1-bit ピクセル)
//  '#' = ピクセル, ' ' = 透過
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 大魚 (右向き)
const FISH_LARGE = [
  "  ###  ",
  "######>",
  "######>",
  "  ###  ",
].map((s) => s.replace(/[#>]/g, "#").replace(/[^#]/g, " "));

// 小魚 (右向き)
const FISH_SMALL = [
  " ### ",
  "#####",
  " ### ",
].map((s) => s);

function drawSprite(sprite, x, y, flipX) {
  const h = sprite.length;
  const w = sprite[0].length;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (sprite[dy][dx] === "#") {
        const px = flipX ? x + (w - 1 - dx) : x + dx;
        pset(px, y + dy, 1);
      }
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  魚オブジェクト
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {{x:number,y:number,vx:number,vy:number,sprite:string[]}[]} */
let fish = [];

function _initFish() {
  fish = [];
  for (let i = 0; i < 5; i++) {
    const large = i < 2;
    fish.push({
      x: Math.random() * (WIN_W - 16) + 8,
      y: Math.random() * (WIN_H - 16) + 8,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 0.5,
      sprite: large ? FISH_LARGE : FISH_SMALL,
    });
  }
}

function _tickFish(localMx, localMy) {
  // Boids 風: 中央引力 + 個体反発 + 壁反発 + マウス忌避
  const cx = WIN_W / 2;
  const cy = WIN_H / 2;
  for (let i = 0; i < fish.length; i++) {
    const f = fish[i];
    // 中央への引力 (弱い)
    f.vx += (cx - f.x) * 0.0002;
    f.vy += (cy - f.y) * 0.0002;
    // 個体間反発
    for (let j = 0; j < fish.length; j++) {
      if (i === j) continue;
      const g = fish[j];
      const dx = f.x - g.x;
      const dy = f.y - g.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 200 && d2 > 0) {
        const inv = 1 / Math.sqrt(d2);
        f.vx += dx * inv * 0.05;
        f.vy += dy * inv * 0.05;
      }
    }
    // 壁反発
    if (f.x < 8) f.vx += 0.1;
    if (f.x > WIN_W - 14) f.vx -= 0.1;
    if (f.y < 8) f.vy += 0.1;
    if (f.y > WIN_H - 12) f.vy -= 0.1;
    // マウス忌避
    if (localMx >= 0 && localMx < WIN_W && localMy >= 0 && localMy < WIN_H) {
      const dx = f.x - localMx;
      const dy = f.y - localMy;
      const d2 = dx * dx + dy * dy;
      if (d2 < 400 && d2 > 0) {
        const inv = 1 / Math.sqrt(d2);
        f.vx += dx * inv * 0.3;
        f.vy += dy * inv * 0.3;
      }
    }
    // 速度上限 + 摩擦
    const sp = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
    if (sp > 1.5) {
      f.vx *= 1.5 / sp;
      f.vy *= 1.5 / sp;
    }
    f.vx *= 0.98;
    f.vy *= 0.98;
    // 位置更新
    f.x += f.vx;
    f.y += f.vy;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  水草 (装飾)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SEAWEED = [
  { x: 20, h: 18 },
  { x: 40, h: 12 },
  { x: 70, h: 22 },
  { x: 110, h: 14 },
  { x: 140, h: 20 },
  { x: 170, h: 16 },
];

let frame = 0;

function drawSeaweed(cr) {
  const baseY = cr.y + WIN_H - 2;
  for (const w of SEAWEED) {
    const swayX = Math.sin(frame * 0.02 + w.x * 0.1) * 1.5;
    for (let dy = 0; dy < w.h; dy++) {
      const sway = swayX * (dy / w.h);
      pset(cr.x + w.x + Math.round(sway), baseY - dy, 1);
    }
  }
}

function drawBubbles(cr) {
  // 軽い気泡
  for (let i = 0; i < 3; i++) {
    const t = (frame + i * 80) % 240;
    const x = 30 + i * 50 + Math.sin(t * 0.05) * 3;
    const y = WIN_H - 2 - t;
    if (y > 2) {
      pset(cr.x + x | 0, cr.y + y, 1);
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画 / 入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let lastMx = -1;
let lastMy = -1;

function onDraw(cr) {
  frame++;
  _tickFish(lastMx, lastMy);

  drawSeaweed(cr);
  drawBubbles(cr);

  for (const f of fish) {
    drawSprite(f.sprite, cr.x + (f.x | 0), cr.y + (f.y | 0), f.vx < 0);
  }

  // 水槽の枠 (上端の水面)
  hline(cr.x, cr.x + cr.w - 1, cr.y, 1);
}

function onInput(ev) {
  lastMx = ev.localX;
  lastMy = ev.localY;
  if (ev.type === "down") {
    // クリックで全魚が散る
    for (const f of fish) {
      const dx = f.x - ev.localX;
      const dy = f.y - ev.localY;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      f.vx += (dx / d) * 2;
      f.vy += (dy / d) * 2;
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    _initFish();
    return wmOpen(-1, -1, WIN_W, WIN_H, APP_NAME, onDraw, onInput, null, {
      noResize: true,
      noMaximize: true,
    });
  },
  { category: "EXPERIMENT" },
);
