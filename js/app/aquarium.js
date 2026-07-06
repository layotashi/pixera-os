/**
 * @module app/aquarium
 * aquarium.js — AQUARIUM (1-bit 水槽)
 *
 * 1-bit ピクセルアートの魚が群れで泳ぐ「映える画面」専用ウィンドウ。
 * After Dark の水槽スクリーンセーバーの PIXERA OS 的再解釈。
 *
 * 仕様:
 *   - 5 匹のエンゼルフィッシュが boids 風の単純規則で泳ぐ
 *     (中央引力 + 個体反発 + 壁反発 + 餌追従)
 *   - 各魚は 2 フレームの尾びれアニメ (assets/fish/ の PNG、個体ごとに
 *     位相をずらして泳ぐ)。スプライトは左向きが基準で、右へ泳ぐ時のみ反転する。
 *   - クリックで餌を落とすと、近くの魚が寄ってきて食べる
 *   - 葉のある水草 + 上昇する気泡で水槽を演出
 *   - 水は前景色で塗りつぶし、魚・水草・気泡・餌は背景色でコントラストさせる
 *     (OS 標準の配色とは反転させ、水槽らしい濃色の水を表現)
 */

import { pset, fillRect } from "../core/gpu.js";
import { getFishFrame, FISH_W, FISH_H } from "../core/fish.js";
import { wmOpen, wmRegister } from "../wm/index.js";

const APP_NAME = "AQUARIUM";

const WIN_W = 200;
const WIN_H = 140;

// 水面をボディ上端から少し下げる (ヘッダー/ボディ区切り線との重なり回避)
const WATER_TOP = 3;

// 水 = 前景色、魚・水草・気泡・餌 = 背景色 (OS 標準配色の反転)
const WATER_COLOR = 1;
const DECOR_COLOR = 0;

/**
 * エンゼルフィッシュの 1 フレームを描画する。
 * スプライトは左向きが基準の絵 (口先が左、尾びれが右) のため、
 * flipX=true で右向きに反転する。
 * アウトライン画素は水色 (WATER_COLOR) で塗って水になじませ、
 * 本体画素のみ DECOR_COLOR で視認できるようにする。
 */
function drawFishSprite(frameIdx, x, y, flipX) {
  const frame = getFishFrame(frameIdx);
  if (!frame) return;
  const { fgBuf, bgBuf } = frame;
  for (let dy = 0; dy < FISH_H; dy++) {
    for (let dx = 0; dx < FISH_W; dx++) {
      const idx = dy * FISH_W + dx;
      if (!fgBuf[idx] && !bgBuf[idx]) continue; // 透過
      const px = flipX ? x + (FISH_W - 1 - dx) : x + dx;
      pset(px, y + dy, fgBuf[idx] ? DECOR_COLOR : WATER_COLOR);
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  魚 / 餌
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {{x:number,y:number,vx:number,vy:number,phase:number}[]} */
let fish = [];
/** @type {{x:number,y:number}[]} 餌ペレット (上から沈む) */
let food = [];

// contentRect の最新寸法 (onDraw でキャッシュ、physics と境界判定で使う)
let _crW = WIN_W;
let _crH = WIN_H;

function _initFish() {
  fish = [];
  food = [];
  for (let i = 0; i < 5; i++) {
    fish.push({
      x: Math.random() * (_crW - FISH_W - 4) + 2,
      y: Math.random() * (_crH - FISH_H - WATER_TOP - 5) + WATER_TOP + 1,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 0.5,
      phase: (Math.random() * 8) | 0, // 尾びれアニメの位相 (群れを desync)
    });
  }
}

function _tickFood() {
  // 餌は沈み、底に達したら消える
  for (const p of food) p.y += 0.4;
  food = food.filter((p) => p.y < _crH - 3);
}

function _tickFish() {
  // Boids 風: 中央引力 + 個体反発 + 壁反発 + 餌追従
  const cx = _crW / 2;
  const cy = _crH / 2;
  for (let i = 0; i < fish.length; i++) {
    const f = fish[i];
    const fcx = f.x + FISH_W / 2;
    const fcy = f.y + FISH_H / 2;

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

    // 餌追従: 一番近い餌へ向かう。十分近ければ食べる。
    let best = null;
    let bestD2 = 70 * 70; // 探知範囲
    for (const p of food) {
      const dx = p.x - fcx;
      const dy = p.y - fcy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = p;
      }
    }
    if (best) {
      const dx = best.x - fcx;
      const dy = best.y - fcy;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      f.vx += (dx / d) * 0.25;
      f.vy += (dy / d) * 0.25;
      if (d < 5) best._eaten = true; // 食べた印
    }

    // 壁反発
    if (f.x < 2) f.vx += 0.1;
    if (f.x > _crW - FISH_W - 2) f.vx -= 0.1;
    if (f.y < WATER_TOP + 1) f.vy += 0.1;
    if (f.y > _crH - FISH_H - 12) f.vy -= 0.1; // 下端は水草分の余裕

    // 速度上限 + 摩擦
    const sp = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
    if (sp > 1.6) {
      f.vx *= 1.6 / sp;
      f.vy *= 1.6 / sp;
    }
    f.vx *= 0.98;
    f.vy *= 0.98;
    f.x += f.vx;
    f.y += f.vy;
  }
  // 食べられた餌を除去
  if (food.some((p) => p._eaten)) food = food.filter((p) => !p._eaten);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  水草 / 気泡 / 餌の描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SEAWEED = [
  { xRatio: 0.08, h: 20 },
  { xRatio: 0.2, h: 13 },
  { xRatio: 0.36, h: 24 },
  { xRatio: 0.54, h: 15 },
  { xRatio: 0.7, h: 22 },
  { xRatio: 0.88, h: 17 },
];

let frame = 0;

function drawSeaweed(cr) {
  const baseY = cr.y + cr.h - 1;
  for (const w of SEAWEED) {
    const wx = cr.x + Math.floor(cr.w * w.xRatio);
    for (let dy = 0; dy < w.h; dy++) {
      const t = dy / w.h; // 0=根元, 1=先端 (先端ほど揺れる)
      const sway = Math.sin(frame * 0.03 + w.xRatio * 20 + dy * 0.4) * 2.2 * t;
      const sx = wx + Math.round(sway);
      const y = baseY - dy;
      pset(sx, y, DECOR_COLOR); // 主茎
      // 葉: 数 px おきに左右交互に張り出す
      if (dy > 1 && dy % 4 === 0) {
        pset(sx + (dy % 8 === 0 ? 1 : -1), y, DECOR_COLOR);
      }
    }
  }
}

function drawBubbles(cr) {
  const N = 6;
  for (let i = 0; i < N; i++) {
    const cycle = cr.h + 30;
    const t = (frame * (0.5 + (i % 3) * 0.2) + i * 47) % cycle;
    const baseX = cr.x + Math.floor(cr.w * (0.12 + i * 0.14));
    const x = baseX + Math.round(Math.sin(t * 0.06 + i) * 3);
    const y = cr.y + cr.h - 3 - t;
    if (y > cr.y + WATER_TOP + 1 && y < cr.y + cr.h - 2) {
      pset(x | 0, y | 0, DECOR_COLOR);
      if (i % 3 === 0) pset((x | 0) + 1, y | 0, DECOR_COLOR); // 大きめの泡
    }
  }
}

function drawFood(cr) {
  for (const p of food) {
    pset(cr.x + (p.x | 0), cr.y + (p.y | 0), DECOR_COLOR);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画 / 入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDraw(cr) {
  _crW = cr.w;
  _crH = cr.h;
  frame++;

  _tickFood();
  _tickFish();

  // 水面 (ボディ上端から少し下げて塗る。塗りの上端がそのまま水面線になる)
  fillRect(cr.x, cr.y + WATER_TOP, cr.w, cr.h - WATER_TOP, WATER_COLOR);

  drawSeaweed(cr);
  drawFood(cr);
  drawBubbles(cr);

  for (const f of fish) {
    // 尾びれアニメ: 8 フレームごとにフレーム切替 (位相をずらして個体差)
    const wf = ((frame + f.phase * 4) >> 3) & 1;
    // スプライトは左向き基準 → 右へ泳ぐ時のみ反転
    drawFishSprite(wf, cr.x + (f.x | 0), cr.y + (f.y | 0), f.vx >= 0);
  }
}

function onInput(ev) {
  if (ev.type === "down") {
    // クリックで餌を落とす (上限 8 個)
    if (
      ev.localX >= 0 &&
      ev.localX < _crW &&
      ev.localY >= WATER_TOP &&
      ev.localY < _crH
    ) {
      food.push({ x: ev.localX, y: ev.localY });
      if (food.length > 8) food.shift();
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
      about:
        "A 1-bit aquarium. The fish school using simple flocking rules. " +
        "Click in the tank to drop food, and the fish will come to eat it.",
      noResize: true,
      noMaximize: true,
      padding: "none", // 水面・水草を枠端まで描く（ボディ内側の余白を消す）
    });
  },
  { category: "EXPERIMENT" },
);
