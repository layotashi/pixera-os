/**
 * @module app/bricker
 * bricker.js — BRICKER: Ultimate 1-bit Edition
 *
 * 「ブロック崩し」を面白くするために考えたこと:
 *
 *   1. CATCH & AIM (戦略性)
 *      長押しでボールをパドル上にキャッチ。照準線が表示され、
 *      離すと狙った方向に発射。受動的だったゲームが能動的に変わる。
 *
 *   2. SMASH (リスク = リターン)
 *      ボールがパドルに当たる瞬間にクリック → 貫通ファイアボール化。
 *      タイミング猶予はわずか 5 フレーム。失敗すると何も起きない。
 *      成功すると 3 ブロック貫通 + 大量パーティクル → 脳汁。
 *
 *   3. POWER-UPS (サプライズと発見)
 *      一部ブロックからアイテムが落下:
 *        M = マルチボール (3 分裂)
 *        W = ワイドパドル (一定時間拡大)
 *        F = ファイアボール (貫通 5 発分)
 *        S = スローモーション (一定時間減速)
 *        + = 1UP
 *      「何が来るか分からない」ワクワク感。
 *
 *   4. COMBO CHAIN (マスタリー)
 *      ボールがパドルに触れずにブロックを連続破壊するとコンボ加算。
 *      高コンボは高スコアだけでなく、画面がどんどん派手になる。
 *      上手い人ほど美しい画面が見られるご褒美。
 *
 *   5. ADVANCING BLOCKS (緊張感)
 *      一定間隔でブロック群が 1 行分下降する。
 *      パドルラインまで来たら即ゲームオーバー。
 *      安全に時間をかけるプレイを許さない。「急がないと！」
 *
 *   6. JUICE (手触り)
 *      パドルの打撃変形、ボール速度に比例する軌跡長、
 *      コンボ倍率に応じた画面フリッカー、ブロック破壊時の
 *      方向性デブリ、画面シェイク、クリア時の花火。
 */

import * as GPU from "../core/gpu.js";
import { drawText, GLYPH_W, GLYPH_H } from "../core/font.js";
import * as GameUtils from "./game_utils.js";

const APP_NAME = "BRICKER";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const W = 260;
const H = 310;

const TOP_BAR = GLYPH_H + 7;

// ── ブロック ──
const BLOCK_COLS = 10;
const BLOCK_ROWS = 7;
const BLOCK_WIDTH = 22;
const BLOCK_HEIGHT = 8;
const BLOCK_GAP = 2;
const BLOCK_AREA_WIDTH =
  BLOCK_COLS * BLOCK_WIDTH + (BLOCK_COLS - 1) * BLOCK_GAP;
const BLOCK_OFFSET_X = ((W - BLOCK_AREA_WIDTH) / 2) | 0;
const BLOCK_OFFSET_Y0 = TOP_BAR + 8;

// ── パドル ──
const PADDLE_WIDTH_DEFAULT = 36;
const PADDLE_WIDTH_WIDE = 54;
const PADDLE_HEIGHT = 5;
const PADDLE_Y = H - 28;

// ── ボール ──
const BALL_SIZE = 3;
const SPEED0 = 1.6;
const SPEED_INC = 0.12;
const SUB_STEPS = 4;

// ── パーティクル ──
const PARTICLE_MAX = 150;

// ── パワーアップ ──
const POWERUP_SIZE = 11;
const POWERUP_SPEED = 0.65;
const POWERUP_TYPES = ["M", "W", "F", "S", "+"];

// ── スマッシュ ──
const SMASH_GRACE_FRAMES = 5;
const SMASH_PIERCE = 3;

// ── ブロック下降 ──
const ADVANCE_INTERVAL = 800;
const ADVANCE_PIXELS = BLOCK_HEIGHT + BLOCK_GAP;

// ── キャッチ ──
const AIM_LINE_LEN = 50;

// ── 残機上限 ──
const MAX_LIVES = 5;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {"ready"|"serve"|"playing"|"catching"|"gameover"|"clear"} */
let gameState = "ready";
let score = 0;
let lives = 3;
let level = 1;
let hiScore = 0;
let frame = 0;

// パドル
let paddleX = (W - PADDLE_WIDTH_DEFAULT) / 2;
let paddleWidth = PADDLE_WIDTH_DEFAULT;
let padSquash = 0;

// アイテムタイマー
let wideTimer = 0;
let slowTimer = 0;

// ── ボール (マルチボール対応: 配列) ──
/** @type {{x:number, y:number, dx:number, dy:number, fire:number, trail:{x:number,y:number}[]}[]} */
let balls = [];

// ── ブロック ──
/** @type {{hp:number, tp:number, item:string|null, shakeTimer:number}[]} */
let blocks = [];
let blockOffsetY = 0;
let advanceTimer = 0;

// ── パワーアップ落下物 ──
/** @type {{x:number, y:number, type:string}[]} */
let items = [];

// ── パーティクル ──
/** @type {{x:number, y:number, dx:number, dy:number, life:number, maxLife:number, sz:number}[]} */
let particles = [];

// ── コンボ ──
let combo = 0;
let comboTimer = 0;
let bestCombo = 0;

// ── スマッシュ ──
let smashGraceFrames = 0;

// ── 演出 ──
let shakeTimer = 0;
let flashTimer = 0;
let mouseLocalX = W / 2;
let aimAngle = -Math.PI / 2;
let speed = SPEED0;

/** ポーズ中フラグ */
let paused = false;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  サウンド
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let sfx = null;

function initSfx() {
  if (sfx) return;
  sfx = GameUtils.createSfxChannels({
    hit: { wave: "sq50", adsr: [1, 40, 0, 20], vol: 22 },
    break: { wave: "tri", adsr: [1, 60, 0, 30], vol: 18 },
    wall: { wave: "sq25", adsr: [1, 15, 0, 10], vol: 12 },
    die: { wave: "noise", adsr: [1, 200, 0, 150], vol: 25 },
    item: { wave: "sq50", adsr: [1, 80, 0, 40], vol: 20 },
    smash: { wave: "saw", adsr: [1, 120, 0, 80], vol: 28 },
    serve: { wave: "tri", adsr: [1, 30, 0, 20], vol: 16 },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ユーティリティ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ブロック生成
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function generateBlocks(level) {
  blocks = [];
  blockOffsetY = 0;
  // レベルが上がるとブロックが速く降下する
  advanceTimer = Math.max(ADVANCE_INTERVAL - (level - 1) * 60, 400);

  for (let r = 0; r < BLOCK_ROWS; r++) {
    for (let c = 0; c < BLOCK_COLS; c++) {
      let tp = 0;
      let hp = 1;
      let item = null;

      // Lv1: 全部通常。アイテム多めで楽しさを教える
      if (level === 1) {
        if (r === 1 && c === 4) item = "M";
        if (r === 0 && (c === 1 || c === BLOCK_COLS - 2)) item = "W";
      }

      // Lv2: 最上段硬化 + ファイアアイテム
      if (level >= 2 && r === 0) {
        tp = 1;
        hp = 2;
      }
      if (level === 2 && r === 2 && c === 4) item = "F";

      // Lv3: 上2段硬化 + 鋼鉄壁
      if (level >= 3 && r <= 1) {
        tp = 1;
        hp = 2;
      }
      if (level >= 3 && (c === 0 || c === BLOCK_COLS - 1) && r >= 4) {
        tp = 2;
        hp = 99;
      }
      if (level === 3 && r === 3 && c === 4) item = "S";

      // Lv4: チェッカー硬化
      if (level >= 4 && (r + c) % 2 === 0 && tp === 0) {
        tp = 1;
        hp = 2;
      }
      if (level === 4 && r === 0 && c === 4) item = "+";

      // Lv5: 鋼鉄の迷路
      if (level >= 5 && r === 2 && (c === 2 || c === BLOCK_COLS - 3)) {
        tp = 2;
        hp = 99;
      }
      if (level >= 5 && r === 3 && c === 4) {
        tp = 2;
        hp = 99;
      }

      // Lv6+: 上下段硬化 + 散りばめた鋼鉄
      if (level >= 6) {
        if (r === 0 || r === BLOCK_ROWS - 1) {
          tp = 1;
          hp = 2;
        }
        if ((r === 1 || r === BLOCK_ROWS - 2) && c % 3 === 0) {
          tp = 2;
          hp = 99;
        }
      }

      // ランダムアイテム (レベルが上がると出現率低下)
      const itemRate = Math.max(0.12 - (level - 1) * 0.015, 0.04);
      if (!item && tp !== 2 && Math.random() < itemRate) {
        // Lv3 以降は + (1UP) をランダムから除外
        const pool = level >= 3 ? ["M", "W", "F", "S"] : POWERUP_TYPES;
        const weights =
          level >= 3 ? [0.3, 0.3, 0.2, 0.2] : [0.25, 0.25, 0.2, 0.2, 0.1];
        let r2 = Math.random();
        for (let k = 0; k < pool.length; k++) {
          r2 -= weights[k];
          if (r2 <= 0) {
            item = pool[k];
            break;
          }
        }
      }

      blocks.push({ hp, tp, item, shakeTimer: 0 });
    }
  }
}

function blockRect(i) {
  const r = (i / BLOCK_COLS) | 0;
  const c = i % BLOCK_COLS;
  return {
    x: BLOCK_OFFSET_X + c * (BLOCK_WIDTH + BLOCK_GAP),
    y: BLOCK_OFFSET_Y0 + r * (BLOCK_HEIGHT + BLOCK_GAP) + blockOffsetY,
    w: BLOCK_WIDTH,
    h: BLOCK_HEIGHT,
  };
}

function breakable() {
  let n = 0;
  for (const b of blocks) if (b.hp > 0 && b.tp !== 2) n++;
  return n;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  パーティクル
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function emitParticles(cx, cy, n, baseAngle, spread) {
  const hasDir = baseAngle !== undefined;
  for (let i = 0; i < n; i++) {
    if (particles.length >= PARTICLE_MAX) particles.shift();
    let a;
    if (hasDir) {
      a = baseAngle + (Math.random() - 0.5) * (spread || 1.0);
    } else {
      a = Math.random() * Math.PI * 2;
    }
    const s = 0.5 + Math.random() * 2.8;
    const life = 14 + ((Math.random() * 10) | 0);
    const sz = Math.random() < 0.3 ? 2 : 1;
    particles.push({
      x: cx,
      y: cy,
      dx: Math.cos(a) * s,
      dy: Math.sin(a) * s,
      life,
      maxLife: life,
      sz,
    });
  }
}

function emitLargeParticles(cx, cy, n) {
  for (let i = 0; i < n; i++) {
    if (particles.length >= PARTICLE_MAX) particles.shift();
    const a = Math.random() * Math.PI * 2;
    const s = 1.5 + Math.random() * 3.5;
    const life = 20 + ((Math.random() * 16) | 0);
    particles.push({
      x: cx,
      y: cy,
      dx: Math.cos(a) * s,
      dy: Math.sin(a) * s,
      life,
      maxLife: life,
      sz: 2,
    });
  }
}

function updateParticles() {
  GameUtils.tickParticles(particles, 0.07, 0.98);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ボール管理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createBall(x, y, dx, dy) {
  return { x, y, dx, dy, fire: 0, trail: [] };
}

function serveBall() {
  const x = paddleX + paddleWidth / 2 - BALL_SIZE / 2;
  const y = PADDLE_Y - BALL_SIZE - 1;
  balls = [createBall(x, y, 0, 0)];
  items = [];
}

function launchBall(ball, angle) {
  ball.dx = Math.cos(angle) * speed;
  ball.dy = Math.sin(angle) * speed;
}

function splitBall(srcBall) {
  const spd =
    Math.sqrt(srcBall.dx * srcBall.dx + srcBall.dy * srcBall.dy) || speed;
  const base = Math.atan2(srcBall.dy, srcBall.dx);
  for (let k = -1; k <= 1; k += 2) {
    const a = base + k * 0.5;
    const nb = createBall(
      srcBall.x,
      srcBall.y,
      Math.cos(a) * spd,
      Math.sin(a) * spd,
    );
    nb.fire = srcBall.fire;
    balls.push(nb);
  }
  emitLargeParticles(srcBall.x + BALL_SIZE / 2, srcBall.y + BALL_SIZE / 2, 8);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  パワーアップ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function spawnItem(x, y, type) {
  items.push({ x: x - POWERUP_SIZE / 2, y, type });
}

function collectItem(type) {
  initSfx();
  switch (type) {
    case "M":
      // マルチボール: 全ボールを分裂 → 倍々で増える
      {
        const src = balls.slice();
        for (const b of src) splitBall(b);
      }
      flashTimer = 4;
      GameUtils.playSfx(sfx?.item, 76);
      break;
    case "W":
      // ワイドパドル: 取るたびに延長 (累積)
      wideTimer += 480;
      flashTimer = 3;
      GameUtils.playSfx(sfx?.item, 72);
      break;
    case "F":
      for (const b of balls) b.fire = Math.max(b.fire, 5);
      flashTimer = 5;
      GameUtils.playSfx(sfx?.item, 79);
      break;
    case "S":
      slowTimer = 360;
      flashTimer = 3;
      GameUtils.playSfx(sfx?.item, 67);
      break;
    case "+":
      if (lives < MAX_LIVES) lives++;
      flashTimer = 8;
      shakeTimer = 6;
      GameUtils.playSfx(sfx?.item, 84);
      break;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ゲーム制御
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function initLevel(lv) {
  level = lv;
  // レベルが上がるとボールが速くなる
  speed = SPEED0 + (lv - 1) * SPEED_INC;
  generateBlocks(lv);
  serveBall();
  combo = 0;
  comboTimer = 0;
  items = [];
  wideTimer = 0;
  slowTimer = 0;
  smashGraceFrames = 0;
}

function newGame() {
  score = 0;
  lives = 3;
  bestCombo = 0;
  initLevel(1);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  毎フレーム更新
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function clampPad() {
  paddleX = clamp(paddleX, 1, W - 1 - paddleWidth);
}

function tick() {
  // ── ポーズ判定 ──
  paused = app.isPaused();
  if (paused) return;

  frame++;
  if (shakeTimer > 0) shakeTimer--;
  if (flashTimer > 0) flashTimer--;
  if (padSquash > 0) padSquash--;
  if (smashGraceFrames > 0) smashGraceFrames--;

  if (comboTimer > 0) {
    comboTimer--;
    if (comboTimer === 0) {
      if (combo > bestCombo) bestCombo = combo;
      combo = 0;
    }
  }

  updateParticles();

  for (const bl of blocks) {
    if (bl.shakeTimer > 0) bl.shakeTimer--;
  }

  // パドル幅更新
  if (wideTimer > 0) {
    wideTimer--;
    paddleWidth = PADDLE_WIDTH_WIDE;
  } else {
    paddleWidth = PADDLE_WIDTH_DEFAULT;
  }

  const timeScale = slowTimer > 0 ? 0.5 : 1.0;
  if (slowTimer > 0) slowTimer--;

  // ── SERVE ──
  if (gameState === "serve") {
    paddleX = mouseLocalX - paddleWidth / 2;
    clampPad();
    if (balls.length > 0) {
      balls[0].x = paddleX + paddleWidth / 2 - BALL_SIZE / 2;
      balls[0].y = PADDLE_Y - BALL_SIZE - 1;
    }
    return;
  }

  // ── CATCHING ──
  if (gameState === "catching") {
    paddleX = mouseLocalX - paddleWidth / 2;
    clampPad();
    const padCX = paddleX + paddleWidth / 2;
    const relX = mouseLocalX - padCX;
    aimAngle = -Math.PI / 2 + (relX / (W * 0.4)) * 0.8;
    aimAngle = clamp(aimAngle, -Math.PI * 0.85, -Math.PI * 0.15);
    if (balls.length > 0) {
      balls[0].x = paddleX + paddleWidth / 2 - BALL_SIZE / 2;
      balls[0].y = PADDLE_Y - BALL_SIZE - 1;
      balls[0].dx = 0;
      balls[0].dy = 0;
    }
    tickAdvance();
    return;
  }

  if (gameState !== "playing") return;

  // ── パドル移動 ──
  paddleX = mouseLocalX - paddleWidth / 2;
  clampPad();

  // ── ブロック下降 ──
  tickAdvance();

  // ── アイテム落下 ──
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    it.y += POWERUP_SPEED;
    if (
      it.y + POWERUP_SIZE >= PADDLE_Y &&
      it.y <= PADDLE_Y + PADDLE_HEIGHT &&
      it.x + POWERUP_SIZE > paddleX &&
      it.x < paddleX + paddleWidth
    ) {
      collectItem(it.type);
      items.splice(i, 1);
      continue;
    }
    if (it.y > H + 10) items.splice(i, 1);
  }

  // ── ボール更新 ──
  for (let bi = balls.length - 1; bi >= 0; bi--) {
    const ball = balls[bi];

    ball.trail.push({ x: ball.x, y: ball.y });
    const maxTrail =
      3 +
      Math.min(6, (Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy) * 2) | 0);
    while (ball.trail.length > maxTrail) ball.trail.shift();

    for (let s = 0; s < SUB_STEPS; s++) {
      ball.x += (ball.dx * timeScale) / SUB_STEPS;
      ball.y += (ball.dy * timeScale) / SUB_STEPS;

      // 壁反射
      if (ball.x < 1) {
        ball.x = 1;
        ball.dx = Math.abs(ball.dx);
        GameUtils.playSfx(sfx?.wall, 90);
      }
      if (ball.x + BALL_SIZE > W - 1) {
        ball.x = W - 1 - BALL_SIZE;
        ball.dx = -Math.abs(ball.dx);
        GameUtils.playSfx(sfx?.wall, 90);
      }
      if (ball.y < TOP_BAR) {
        ball.y = TOP_BAR;
        ball.dy = Math.abs(ball.dy);
        GameUtils.playSfx(sfx?.wall, 88);
      }

      // 底辺落下
      if (ball.y + BALL_SIZE > H - 1) {
        emitParticles(ball.x + BALL_SIZE / 2, H - 4, 12, -Math.PI / 2, 1.5);
        balls.splice(bi, 1);
        if (balls.length === 0) {
          lives--;
          shakeTimer = 16;
          GameUtils.playSfx(sfx?.die, 36);
          if (lives <= 0) {
            gameState = "gameover";
            if (score > hiScore) hiScore = score;
            if (combo > bestCombo) bestCombo = combo;
            emitLargeParticles(W / 2, H / 2, 25);
          } else {
            gameState = "serve";
            serveBall();
            combo = 0;
            comboTimer = 0;
          }
        }
        break;
      }

      // パドル反射
      if (
        ball.dy > 0 &&
        ball.y + BALL_SIZE >= PADDLE_Y &&
        ball.y + BALL_SIZE <= PADDLE_Y + PADDLE_HEIGHT + 3 &&
        ball.x + BALL_SIZE > paddleX &&
        ball.x < paddleX + paddleWidth
      ) {
        const hit = (ball.x + BALL_SIZE / 2 - paddleX) / paddleWidth;
        const ang = -Math.PI / 2 + (hit - 0.5) * 1.4;
        const spd = Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy);
        ball.dx = Math.cos(ang) * spd;
        ball.dy = Math.sin(ang) * spd;
        if (ball.dy > -0.3) ball.dy = -0.3;
        ball.y = PADDLE_Y - BALL_SIZE;

        const cap = SPEED0 + level * 0.5;
        if (spd < cap) {
          ball.dx *= 1.008;
          ball.dy *= 1.008;
        }

        padSquash = 5;
        smashGraceFrames = SMASH_GRACE_FRAMES;
        emitParticles(ball.x + BALL_SIZE / 2, PADDLE_Y, 3, -Math.PI / 2, 0.8);
        GameUtils.playSfx(sfx?.hit, 60 + ((combo * 2) % 24));
        // パドルに戻ったらコンボリセット
        if (combo > bestCombo) bestCombo = combo;
        combo = 0;
      }

      // ブロック衝突
      for (let i = 0; i < blocks.length; i++) {
        const bl = blocks[i];
        if (bl.hp <= 0) continue;
        const br = blockRect(i);
        if (
          ball.x + BALL_SIZE > br.x &&
          ball.x < br.x + br.w &&
          ball.y + BALL_SIZE > br.y &&
          ball.y < br.y + br.h
        ) {
          // 反射 (ファイア時は貫通)
          if (ball.fire <= 0) {
            const oL = ball.x + BALL_SIZE - br.x;
            const oR = br.x + br.w - ball.x;
            const oT = ball.y + BALL_SIZE - br.y;
            const oB = br.y + br.h - ball.y;
            const m = Math.min(oL, oR, oT, oB);
            if (m === oL || m === oR) ball.dx = -ball.dx;
            else ball.dy = -ball.dy;
          }

          if (bl.tp !== 2) {
            bl.hp--;
            if (bl.hp <= 0) {
              combo++;
              comboTimer = 120;
              score += 10 * combo * level;
              const dir = Math.atan2(ball.dy, ball.dx);
              emitParticles(
                br.x + br.w / 2,
                br.y + br.h / 2,
                4 + Math.min(combo, 8),
                dir,
                1.2,
              );
              if (combo >= 5)
                emitLargeParticles(br.x + br.w / 2, br.y + br.h / 2, combo);
              if (combo >= 10) flashTimer = 2;
              if (bl.item) spawnItem(br.x + br.w / 2, br.y + br.h / 2, bl.item);
              GameUtils.playSfx(sfx?.break, 72 + Math.min(combo * 2, 24));
            } else {
              score += 5;
              bl.shakeTimer = 4;
              emitParticles(br.x + br.w / 2, br.y + br.h / 2, 2);
              GameUtils.playSfx(sfx?.wall, 80);
            }
          } else {
            emitParticles(br.x + br.w / 2, br.y + br.h / 2, 2);
            bl.shakeTimer = 3;
            GameUtils.playSfx(sfx?.wall, 70);
          }

          if (ball.fire > 0) {
            ball.fire--;
          } else {
            break;
          }
        }
      }
    }
  }

  // ── クリア判定 ──
  if (breakable() === 0) {
    gameState = "clear";
    if (score > hiScore) hiScore = score;
    if (combo > bestCombo) bestCombo = combo;
    for (let i = 0; i < 8; i++) {
      emitLargeParticles(
        15 + Math.random() * (W - 30),
        BLOCK_OFFSET_Y0 + Math.random() * 50,
        6,
      );
    }
    flashTimer = 6;
    shakeTimer = 8;
  }
}

function tickAdvance() {
  advanceTimer--;
  if (advanceTimer <= 0) {
    advanceTimer = Math.max(ADVANCE_INTERVAL - (level - 1) * 60, 400);
    blockOffsetY += ADVANCE_PIXELS;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].hp <= 0) continue;
      const br = blockRect(i);
      if (br.y + br.h >= PADDLE_Y - 2) {
        gameState = "gameover";
        if (score > hiScore) hiScore = score;
        if (combo > bestCombo) bestCombo = combo;
        shakeTimer = 20;
        emitLargeParticles(W / 2, PADDLE_Y, 30);
        return;
      }
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDraw(contentRect) {
  tick();

  // gameover/clear 状態ではシェイクを抑制 (テキストを読みやすく)
  const { sx, sy } = GameUtils.calcShake(shakeTimer, gameState, ["gameover", "clear"]);
  const ox = contentRect.x + sx;
  const oy = contentRect.y + sy;

  GPU.fillRect(contentRect.x - 3, contentRect.y - 3, W + 6, H + 6, 0);
  GPU.drawRect(ox, oy, W, H, 1);

  // ── HUD ──
  const scoreTxt = `${String(score).padStart(7, "0")}`;
  drawText(ox + 4, oy + 3, scoreTxt, 1);
  const lvTxt = `LV${level}`;
  drawText(GameUtils.centerTextX(ox, W, lvTxt), oy + 3, lvTxt, 1);
  // 残機: 小さなパドルアイコン (実線 7x3)
  for (let i = 0; i < Math.min(lives, MAX_LIVES); i++) {
    const lx = ox + W - 10 - i * 10;
    const ly = oy + 3;
    GPU.fillRect(lx, ly, 7, 3, 1);
    GPU.hline(lx + 1, lx + 5, ly + 1, 0);
  }
  GPU.hline(ox + 1, ox + W - 2, oy + TOP_BAR - 1, 1);

  // ── スロー表示 ──
  if (slowTimer > 0 && (slowTimer > 60 || frame % 6 < 4)) {
    const st2 = "SLOW";
    drawText(GameUtils.centerTextX(ox, W, st2), oy + TOP_BAR + 1, st2, 1);
  }

  // ── ブロック ──
  for (let i = 0; i < blocks.length; i++) {
    const bl = blocks[i];
    if (bl.hp <= 0) continue;
    const br = blockRect(i);
    const bsx = bl.shakeTimer > 0 ? (Math.random() * 2 - 1) | 0 : 0;
    const x = ox + br.x + bsx;
    const y = oy + br.y;

    if (bl.tp === 0) {
      GPU.fillRect(x, y, br.w, br.h, 1);
      GPU.hline(x + 1, x + br.w - 2, y + br.h - 1, 0);
    } else if (bl.tp === 1) {
      if (bl.hp >= 2) {
        GPU.fillRect(x, y, br.w, br.h, 1);
        GPU.drawCheckerboard(x + 1, y + 1, br.w - 2, br.h - 2, 0);
      } else {
        GPU.drawRect(x, y, br.w, br.h, 1);
        const mx2 = (x + br.w / 2) | 0;
        const my2 = (y + br.h / 2) | 0;
        GPU.drawLine(x + 2, y + 1, mx2, my2, 1);
        GPU.drawLine(mx2, my2, x + br.w - 3, y + br.h - 2, 1);
      }
    } else {
      GPU.drawRect(x, y, br.w, br.h, 1);
      GPU.drawRect(x + 2, y + 2, br.w - 4, Math.max(br.h - 4, 1), 1);
      GPU.fillRect((x + br.w / 2) | 0, (y + br.h / 2) | 0, 1, 1, 1);
    }

    // アイテムインジケータ
    if (bl.item && bl.tp !== 2) {
      const ix = (x + (br.w - GLYPH_W) / 2) | 0;
      const iy = (y + (br.h - GLYPH_H) / 2) | 0;
      drawText(ix, iy, bl.item, bl.hp >= 2 ? 1 : 0);
    }
  }

  // ── パワーアップ (落下中) ──
  for (const it of items) {
    const ix = (ox + it.x) | 0;
    const iy = (oy + it.y) | 0;
    GPU.fillRect(ix, iy, POWERUP_SIZE, POWERUP_SIZE, 0);
    GPU.drawRect(ix, iy, POWERUP_SIZE, POWERUP_SIZE, 1);
    // テキストは 1px 余白を確保して中央描画
    const tx = (ix + (POWERUP_SIZE - GLYPH_W) / 2) | 0;
    const ty = (iy + (POWERUP_SIZE - GLYPH_H) / 2) | 0;
    drawText(tx, ty, it.type, 1);
    if (frame % 8 < 4)
      GPU.drawRect(ix - 1, iy - 1, POWERUP_SIZE + 2, POWERUP_SIZE + 2, 1);
  }

  // ── ボール軌跡 & ボール ──
  for (const ball of balls) {
    for (let i = 0; i < ball.trail.length; i++) {
      const t = ball.trail[i];
      const ratio = i / ball.trail.length;
      if (ratio > 0.5 || ball.fire > 0) {
        GPU.fillRect(ox + ((t.x + 1) | 0), oy + ((t.y + 1) | 0), 1, 1, 1);
      }
    }
    const bbx = ox + (ball.x | 0);
    const bby = oy + (ball.y | 0);
    GPU.fillRect(bbx, bby, BALL_SIZE, BALL_SIZE, 1);
    if (ball.fire > 0) {
      GPU.fillRect(bbx - 1, bby + 1, 1, 1, 1);
      GPU.fillRect(bbx + BALL_SIZE, bby + 1, 1, 1, 1);
      GPU.fillRect(bbx + 1, bby - 1, 1, 1, 1);
      GPU.fillRect(bbx + 1, bby + BALL_SIZE, 1, 1, 1);
      if (frame % 4 < 2)
        GPU.invertRect(bbx - 1, bby - 1, BALL_SIZE + 2, BALL_SIZE + 2);
    }
  }

  // ── パドル ──
  const ppx = ox + (paddleX | 0);
  const ppy = oy + PADDLE_Y;

  if (padSquash > 0) {
    const squashAmt = padSquash / 5;
    const sw = paddleWidth + ((squashAmt * 6) | 0);
    const sh = Math.max(PADDLE_HEIGHT - ((squashAmt * 2) | 0), 2);
    const sqx = (ppx - (sw - paddleWidth) / 2) | 0;
    const sqy = ppy + (PADDLE_HEIGHT - sh);
    GPU.fillRect(sqx, sqy, sw, sh, 1);
    GPU.hline(sqx + 2, sqx + sw - 3, sqy + 1, 0);
  } else {
    GPU.fillRect(ppx, ppy, paddleWidth, PADDLE_HEIGHT, 1);
    GPU.hline(ppx + 2, ppx + paddleWidth - 3, ppy + 1, 0);
    if (wideTimer > 0) {
      GPU.fillRect(ppx, ppy - 1, 2, 1, 1);
      GPU.fillRect(ppx + paddleWidth - 2, ppy - 1, 2, 1, 1);
      if (wideTimer > 120 || frame % 8 < 5) {
        GPU.vline(ppx, ppy - 1, ppy + PADDLE_HEIGHT, 1);
        GPU.vline(ppx + paddleWidth - 1, ppy - 1, ppy + PADDLE_HEIGHT, 1);
      }
    }
  }

  // ── パーティクル ──
  for (const p of particles) {
    const ppx2 = (ox + p.x) | 0;
    const ppy2 = (oy + p.y) | 0;
    const ratio = p.life / p.maxLife;
    if (ratio > 0.6) GPU.fillRect(ppx2, ppy2, p.sz, p.sz, 1);
    else if (ratio > 0.3) GPU.fillRect(ppx2, ppy2, 1, 1, 1);
    else if (frame % 2 === 0) GPU.fillRect(ppx2, ppy2, 1, 1, 1);
  }

  // ── コンボ表示 ──
  if (combo > 1 && comboTimer > 0) {
    const ct = `${combo}x COMBO`;
    const tw = GameUtils.textWidth(ct);
    const cx = GameUtils.centerTextX(ox, W, ct);
    const cy = oy + PADDLE_Y - 18;

    if (combo >= 10) {
      GPU.fillRect(cx - 4, cy - 2, tw + 8, GLYPH_H + 4, 1);
      drawText(cx, cy, ct, 0);
      if (frame % 6 < 3) GPU.invertRect(cx - 5, cy - 3, tw + 10, GLYPH_H + 6);
    } else if (combo >= 5) {
      GPU.fillRect(cx - 2, cy - 1, tw + 4, GLYPH_H + 2, 1);
      drawText(cx, cy, ct, 0);
    } else {
      drawText(cx, cy, ct, 1);
    }
  }

  // ── スマッシュ判定猛予表示 ──
  if (smashGraceFrames > 0 && gameState === "playing") {
    const stx = ox + ((paddleX + paddleWidth / 2) | 0);
    GPU.fillRect(stx - 1, oy + PADDLE_Y - 8, 3, 5, 1);
    GPU.fillRect(stx, oy + PADDLE_Y - 2, 1, 1, 1);
  }

  // ── キャッチ中の照準線 ──
  if (gameState === "catching" && balls.length > 0) {
    const bcx = ox + (balls[0].x | 0) + BALL_SIZE / 2;
    const bcy = oy + (balls[0].y | 0) + BALL_SIZE / 2;
    for (let t = 0; t < AIM_LINE_LEN; t += 4) {
      const px2 = (bcx + Math.cos(aimAngle) * t) | 0;
      const py2 = (bcy + Math.sin(aimAngle) * t) | 0;
      GPU.fillRect(px2, py2, 1, 1, 1);
    }
    const ex = (bcx + Math.cos(aimAngle) * AIM_LINE_LEN) | 0;
    const ey = (bcy + Math.sin(aimAngle) * AIM_LINE_LEN) | 0;
    GPU.fillRect(ex - 1, ey - 1, 3, 3, 1);
  }

  // ── 画面フラッシュ ──
  if (flashTimer > 0 && flashTimer % 2 === 0) {
    GPU.invertRect(ox + 1, oy + TOP_BAR, W - 2, H - TOP_BAR - 1);
  }

  // ── 迫り来る警告 ──
  if (gameState === "playing" || gameState === "catching") {
    let lowestY = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].hp <= 0) continue;
      const br = blockRect(i);
      if (br.y + br.h > lowestY) lowestY = br.y + br.h;
    }
    const danger = lowestY / (PADDLE_Y - 10);
    if (danger > 0.7) {
      const wy = oy + lowestY + 3;
      for (let x2 = ox + 2; x2 < ox + W - 2; x2 += 4) GPU.fillRect(x2, wy, 2, 1, 1);
      if (danger > 0.85 && frame % 10 < 5)
        drawText(ox + 3, wy + 2, "DANGER!", 1);
    }

    // 下降タイマーバー
    const ratio = 1 - advanceTimer / ADVANCE_INTERVAL;
    const barW = ((W - 4) * ratio) | 0;
    if (barW > 0) GPU.fillRect(ox + 2, oy + H - 2, barW, 1, 1);
  }

  // ── 状態オーバーレイ ──
  if (gameState === "ready") {
    GameUtils.drawOverlay(ox, oy, W, H, [
      "BRICKER",
      "",
      "MOUSE: MOVE",
      "CLICK: LAUNCH",
      "HOLD: CATCH & AIM",
      "",
      "SMASH AT IMPACT!",
      "",
      "CLICK TO START",
    ]);
  } else if (gameState === "serve") {
    // サーブテキストをパドルの上方に表示 (画面内に収まる位置)
    const t = frame % 40 < 28 ? "CLICK TO LAUNCH" : "";
    if (t) {
      drawText(GameUtils.centerTextX(ox, W, t), oy + PADDLE_Y - 20, t, 1);
    }
    const ht = "HOLD: CATCH & AIM";
    if (frame % 80 < 50) {
      drawText(GameUtils.centerTextX(ox, W, ht), oy + PADDLE_Y - 10, ht, 1);
    }
  } else if (gameState === "gameover") {
    GameUtils.drawOverlay(ox, oy, W, H, [
      "GAME OVER",
      "",
      `SCORE ${score}`,
      bestCombo > 1 ? `BEST COMBO x${bestCombo}` : "",
      hiScore > 0 ? `HI ${hiScore}` : "",
      "",
      "CLICK TO RETRY",
    ]);
  } else if (gameState === "clear") {
    GameUtils.drawOverlay(ox, oy, W, H, [
      `LEVEL ${level} CLEAR!`,
      "",
      `SCORE ${score}`,
      bestCombo > 1 ? `BEST x${bestCombo}` : "",
      "",
      "CLICK: NEXT LEVEL",
    ]);
  }

  // ── ポーズオーバーレイ ──
  if (paused && gameState !== "ready") {
    GameUtils.drawPauseOverlay(ox, oy, W, H);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onInput(ev) {
  if (ev.type === "hover" || ev.type === "held" || ev.type === "down") {
    mouseLocalX = ev.localX;
  }

  if (ev.type === "down") {
    initSfx();
    switch (gameState) {
      case "ready":
        newGame();
        gameState = "serve";
        break;
      case "serve":
        if (balls.length > 0) {
          launchBall(balls[0], -Math.PI / 2 + (Math.random() - 0.5) * 0.5);
        }
        gameState = "playing";
        GameUtils.playSfx(sfx?.serve, 72);
        break;
      case "playing":
        if (smashGraceFrames > 0) {
          // ── スマッシュ成功! ──
          smashGraceFrames = 0;
          flashTimer = 3;
          shakeTimer = 4;
          GameUtils.playSfx(sfx?.smash, 48);
          for (const b of balls) {
            if (b.dy < 0) {
              b.fire = Math.max(b.fire, SMASH_PIERCE);
              b.dx *= 1.15;
              b.dy *= 1.15;
              emitLargeParticles(b.x + BALL_SIZE / 2, b.y + BALL_SIZE / 2, 10);
              break;
            }
          }
        }
        break;
      case "gameover":
        newGame();
        gameState = "serve";
        break;
      case "clear":
        initLevel(level + 1);
        gameState = "serve";
        break;
    }
  }

  // ── キャッチ開始 ──
  if (ev.type === "held" && gameState === "playing" && balls.length === 1) {
    const ball = balls[0];
    if (
      ball.dy > 0 &&
      ball.y + BALL_SIZE >= PADDLE_Y - 4 &&
      ball.y + BALL_SIZE <= PADDLE_Y + PADDLE_HEIGHT + 4 &&
      ball.x + BALL_SIZE > paddleX - 2 &&
      ball.x < paddleX + paddleWidth + 2
    ) {
      gameState = "catching";
      ball.dx = 0;
      ball.dy = 0;
      combo = 0;
      comboTimer = 0;
    }
  }

  // ── キャッチ解除 ──
  if (ev.type === "up" && gameState === "catching") {
    if (balls.length > 0) launchBall(balls[0], aimAngle);
    gameState = "playing";
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  footer / リセット
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDrawFooter(footerRect) {
  drawText(footerRect.x, footerRect.y, `${String(score).padStart(7, "0")}`, 1);
  const hi = `HI:${String(hiScore).padStart(7, "0")}`;
  drawText(footerRect.x + footerRect.w - GameUtils.textWidth(hi), footerRect.y, hi, 1);
  const lv = `LV${level}`;
  drawText(GameUtils.centerTextX(footerRect.x, footerRect.w, lv), footerRect.y, lv, 1);
}

function onBeforeClose() {
  gameState = "ready";
  score = 0;
  lives = 3;
  level = 1;
  paddleX = (W - PADDLE_WIDTH_DEFAULT) / 2;
  paddleWidth = PADDLE_WIDTH_DEFAULT;
  mouseLocalX = W / 2;
  speed = SPEED0;
  particles = [];
  balls = [];
  items = [];
  blocks = [];
  combo = 0;
  comboTimer = 0;
  bestCombo = 0;
  shakeTimer = 0;
  flashTimer = 0;
  padSquash = 0;
  wideTimer = 0;
  slowTimer = 0;
  smashGraceFrames = 0;
  frame = 0;
  paused = false;
  blockOffsetY = 0;
  advanceTimer = ADVANCE_INTERVAL;
  generateBlocks(1);
  serveBall();
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  初期化 & 登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

generateBlocks(1);
serveBall();

const app = GameUtils.registerGameApp({
  name: APP_NAME,
  width: W,
  height: H,
  onDraw,
  onInput,
  onDrawFooter,
  onBeforeClose,
  category: "GAMES",
});

