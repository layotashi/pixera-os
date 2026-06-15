/**
 * @module app/aquarium
 * aquarium.js — AQUARIUM (1-bit 水槽) のプロトタイプ
 *
 * 1-bit ピクセルアートの魚が群れで泳ぐ「映える画面」専用ウィンドウ。
 * After Dark の水槽スクリーンセーバーの SYNESTA 的再解釈。
 *
 * プロトタイプ仕様:
 *   - 5 匹の魚が boids 風の単純規則で泳ぐ (中央への引力 + 個体間反発 + 壁反発)
 *   - 魚はサイズ違い 2 種 (大魚 11×5、小魚 7×3)
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
//  魚スプライト (1-bit ピクセル)
//  '#' = ピクセル, ' ' = 透過
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 大魚 (右向き、11×5)
const FISH_LARGE = [
  "   ####    ",
  " ########  ",
  "###########",
  " ########  ",
  "   ####    ",
];

// 小魚 (右向き、7×3)
const FISH_SMALL = [
  " ##### ",
  "#######",
  " ##### ",
];

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

function spriteW(sprite) {
  return sprite[0].length;
}
function spriteH(sprite) {
  return sprite.length;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  魚オブジェクト
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {{x:number,y:number,vx:number,vy:number,sprite:string[]}[]} */
let fish = [];

// contentRect の最新寸法 (onDraw でキャッシュ、physics と境界判定で使う)
let _crW = WIN_W;
let _crH = WIN_H;

function _initFish() {
  fish = [];
  for (let i = 0; i < 5; i++) {
    const large = i < 2;
    const sprite = large ? FISH_LARGE : FISH_SMALL;
    fish.push({
      x: Math.random() * (_crW - spriteW(sprite) - 4) + 2,
      y: Math.random() * (_crH - spriteH(sprite) - 4) + 2,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 0.5,
      sprite,
    });
  }
}

function _tickFish(localMx, localMy) {
  // Boids 風: 中央引力 + 個体反発 + 壁反発 + マウス忌避
  const cx = _crW / 2;
  const cy = _crH / 2;
  for (let i = 0; i < fish.length; i++) {
    const f = fish[i];
    const sw = spriteW(f.sprite);
    const sh = spriteH(f.sprite);
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
    if (f.x < 2) f.vx += 0.1;
    if (f.x > _crW - sw - 2) f.vx -= 0.1;
    if (f.y < 4) f.vy += 0.1;
    if (f.y > _crH - sh - 12) f.vy -= 0.1; // 下端は水草分の余裕
    // マウス忌避
    if (localMx >= 0 && localMx < _crW && localMy >= 0 && localMy < _crH) {
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
  { xRatio: 0.10, h: 18 },
  { xRatio: 0.22, h: 12 },
  { xRatio: 0.38, h: 22 },
  { xRatio: 0.55, h: 14 },
  { xRatio: 0.72, h: 20 },
  { xRatio: 0.88, h: 16 },
];

let frame = 0;

function drawSeaweed(cr) {
  const baseY = cr.y + cr.h - 2;
  for (const w of SEAWEED) {
    const wx = Math.floor(cr.w * w.xRatio);
    const swayX = Math.sin(frame * 0.02 + wx * 0.1) * 1.5;
    for (let dy = 0; dy < w.h; dy++) {
      const sway = swayX * (dy / w.h);
      pset(cr.x + wx + Math.round(sway), baseY - dy, 1);
    }
  }
}

function drawBubbles(cr) {
  // 気泡を 3 つ、上昇するアニメーション
  for (let i = 0; i < 3; i++) {
    const cycle = cr.h + 20;
    const t = (frame + i * 80) % cycle;
    const baseX = Math.floor(cr.w * (0.20 + i * 0.25));
    const x = baseX + Math.sin(t * 0.05) * 3;
    const y = cr.h - 4 - t;
    if (y > 2 && y < cr.h - 2) {
      pset(cr.x + (x | 0), cr.y + (y | 0), 1);
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画 / 入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let lastMx = -1;
let lastMy = -1;

function onDraw(cr) {
  // contentRect 寸法をキャッシュ (physics と onInput が使う)
  _crW = cr.w;
  _crH = cr.h;
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
