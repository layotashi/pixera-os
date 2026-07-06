/**
 * @module app/aquaria
 * aquaria.js — AQUARIA (1-bit 水槽)
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
 *   - NOTEPAD と同じ見た目の縦横スクロールバー + ステッパーボタンをボディ右端/下端に
 *     装飾として表示する (AQUARIA はスクロール不可のため常に 100% 表示・操作不可)
 *
 * 水槽の縦構成 (ボディ内枠線の内側、上から):
 *   1px 枠線 (BG) → 水上の空間 (BG, AIR_H px) → 水と魚 (FG) → 砂 (BG, 起伏あり, SAND_H px)
 */

import { pset, fillRect, drawRect, vline } from "../core/gpu.js";
import { getFishFrame, FISH_W, FISH_H } from "../core/fish.js";
import { wmOpen, wmRegister } from "../wm/index.js";

const APP_NAME = "AQUARIA";

const WIN_W = 200;
const WIN_H = 140;

// ── 水槽レイアウト (ローカル座標、cr 起点) ──
const BORDER = 1; // ボディ内枠線の太さ
const AIR_H = 10; // 水上の空間の高さ
const SAND_H = 10; // 水槽底の砂の厚み (基準値、起伏で ±数px 変動)
const WATER_TOP_LOCAL = BORDER + AIR_H; // 水面 (この行から水)

// 枠線・水上の空間・砂 = 背景色、水と魚 = 前景色
const BORDER_COLOR = 0;
const AIR_COLOR = 0;
const WATER_COLOR = 1;
const SAND_COLOR = 0;
// 水草・気泡・餌・魚本体 = 背景色 (水=前景色に対してコントラスト)
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

/** 砂の基準上端 (ローカル座標、起伏を含まない平均値) */
function _sandBaseTop() {
  return _crH - BORDER - SAND_H;
}

/** 指定 x (ローカル座標) における砂表面のなだらかな起伏オフセット (px) */
function _sandWaveAt(localX) {
  return Math.round(
    Math.sin(localX * 0.15) * 1.6 + Math.sin(localX * 0.05 + 1.7) * 1.0,
  );
}

function _initFish() {
  fish = [];
  food = [];
  const waterBottom = _sandBaseTop();
  for (let i = 0; i < 5; i++) {
    fish.push({
      x: Math.random() * (_crW - FISH_W - BORDER * 2 - 2) + BORDER + 1,
      y:
        Math.random() * (waterBottom - WATER_TOP_LOCAL - FISH_H - 2) +
        WATER_TOP_LOCAL +
        1,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 0.5,
      phase: (Math.random() * 8) | 0, // 尾びれアニメの位相 (群れを desync)
    });
  }
}

function _tickFood() {
  // 餌は沈み、砂に達したら消える
  for (const p of food) p.y += 0.4;
  const sandTop = _sandBaseTop();
  food = food.filter((p) => p.y < sandTop);
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
    if (f.x < BORDER + 1) f.vx += 0.1;
    if (f.x > _crW - FISH_W - BORDER - 1) f.vx -= 0.1;
    if (f.y < WATER_TOP_LOCAL + 1) f.vy += 0.1;
    if (f.y > _sandBaseTop() - FISH_H) f.vy -= 0.1; // 砂の手前で反転

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

/**
 * 水槽本体を描画する: 内枠線 (FG) → 水上の空間 (FG) → 水 (BG) → 砂 (FG, 起伏あり)。
 * 砂は起伏で基準線より上下する分があるため、水は先に領域全体を塗ってから
 * 砂で上書きする (起伏の谷間にも水色が正しく残る)。
 */
function drawTank(cr) {
  drawRect(cr.x, cr.y, cr.w, cr.h, BORDER_COLOR);

  const innerX = cr.x + BORDER;
  const innerW = cr.w - BORDER * 2;
  const innerTop = cr.y + BORDER;
  const innerBottom = cr.y + cr.h - BORDER - 1; // 内側の最終行 (inclusive)
  const airBottom = innerTop + AIR_H; // 水面 (この行から水)

  fillRect(innerX, innerTop, innerW, AIR_H, AIR_COLOR);
  fillRect(innerX, airBottom, innerW, innerBottom - airBottom + 1, WATER_COLOR);

  const sandTopBase = cr.y + _sandBaseTop();
  for (let x = innerX; x < innerX + innerW; x++) {
    const top = sandTopBase + _sandWaveAt(x - cr.x);
    vline(x, top, innerBottom, SAND_COLOR);
  }
}

function drawSeaweed(cr) {
  const baseY = cr.y + _sandBaseTop();
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

// 泡・餌の形状: '#' = 水と逆の色 (DECOR_COLOR), '-' = 水と同じ色 (WATER_COLOR, 中を透けさせる)
const BUBBLE_SHAPES = [["#"], ["##", "##"], ["-#-", "#-#", "-#-"]];
const FOOD_SHAPE = ["###", "#-#", "###"];

function drawShape(shape, x, y) {
  for (let dy = 0; dy < shape.length; dy++) {
    const row = shape[dy];
    for (let dx = 0; dx < row.length; dx++) {
      const ch = row[dx];
      if (ch === "#") pset(x + dx, y + dy, DECOR_COLOR);
      else if (ch === "-") pset(x + dx, y + dy, WATER_COLOR);
    }
  }
}

function drawBubbles(cr) {
  const N = 6;
  const bottomY = cr.y + _sandBaseTop(); // 発生位置 (砂の上)
  const topY = cr.y + WATER_TOP_LOCAL; // 水面 (ここで消える)
  const cycle = bottomY - topY + 30;
  for (let i = 0; i < N; i++) {
    const t = (frame * (0.5 + (i % 3) * 0.2) + i * 47) % cycle;
    const baseX = cr.x + Math.floor(cr.w * (0.12 + i * 0.14));
    const x = baseX + Math.round(Math.sin(t * 0.06 + i) * 3);
    const y = bottomY - t;
    if (y > topY + 1 && y < bottomY) {
      drawShape(BUBBLE_SHAPES[i % BUBBLE_SHAPES.length], x | 0, y | 0);
    }
  }
}

function drawFood(cr) {
  for (const p of food) {
    // 3x3 形状の中心が p.x/p.y (物理演算上の座標) に来るよう -1 オフセット
    drawShape(FOOD_SHAPE, cr.x + (p.x | 0) - 1, cr.y + (p.y | 0) - 1);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画 / 入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDraw(cr) {
  // 水槽本体はコンテンツ領域いっぱいに描く。縦横スクロールバー + ステッパー + コーナーは
  // WM 標準 chrome が枠端 (コンテンツ領域の外側に確保されたスロット) に描画するため、
  // アプリ側では一切扱わない。
  const tankRect = { x: cr.x, y: cr.y, w: cr.w, h: cr.h };

  _crW = cr.w;
  _crH = cr.h;
  frame++;

  _tickFood();
  _tickFish();

  drawTank(tankRect);
  drawSeaweed(tankRect);
  drawFood(tankRect);
  drawBubbles(tankRect);

  for (const f of fish) {
    // 尾びれアニメ: 8 フレームごとにフレーム切替 (位相をずらして個体差)
    const wf = ((frame + f.phase * 4) >> 3) & 1;
    // スプライトは左向き基準 → 右へ泳ぐ時のみ反転
    drawFishSprite(wf, tankRect.x + (f.x | 0), tankRect.y + (f.y | 0), f.vx >= 0);
  }
}

function onInput(ev) {
  if (ev.type === "down") {
    // クリックで餌を落とす (水面〜砂の手前のみ、上限 8 個)
    if (
      ev.localX >= BORDER &&
      ev.localX < _crW - BORDER &&
      ev.localY >= WATER_TOP_LOCAL &&
      ev.localY < _sandBaseTop()
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
        "A 1-bit fish tank. The fish school using simple flocking rules. " +
        "Click in the tank to drop food, and the fish will come to eat it.",
      noResize: true,
      noMaximize: true,
      padding: "none", // 水面・水草を枠端まで描く（ボディ内側の余白を消す）
    });
  },
  { category: "EXPERIMENT" },
);
