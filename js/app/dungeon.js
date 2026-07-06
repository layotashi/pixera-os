/**
 * @module app/dungeon
 * dungeon.js — DUNGEON: 1-bit ローグライク（潜行）
 *
 * 手続き生成されたダンジョンを潜り、モンスターを倒しながら
 * 階層を降りていくターン制ローグライク。
 *
 * 1-bit 美学に合わせた表現:
 *   - 視界内 (lit)     … 壁=実線ブロック / 床=中央の点
 *   - 探索済み (seen)  … 壁=チェッカーで「記憶」を薄く表現
 *   - 未探索 (unknown) … 暗闇 (描画しない)
 *
 * 操作:
 *   - 移動 / 攻撃: 矢印キー or WASD（敵に向かって移動 = bump 攻撃）
 *   - 待機:        Space / .
 *   - リトライ:    R / Enter（死亡後）
 *
 * ターン構造（古典ローグライク準拠）:
 *   プレイヤーが 1 アクション → 全モンスターが行動 → 視界再計算
 */

import { fillRect, drawRect, pset, drawCheckerboard } from "../core/gpu.js";
import { drawText, GLYPH_H } from "../core/font.js";
import { keyDown } from "../core/input.js";
import * as GameUtils from "./game_utils.js";

const APP_NAME = "DUNGEON";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  寸法
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** タイル 1 マスの描画サイズ (px) */
const TILE = 9;
const MAP_COLS = 28;
const MAP_ROWS = 24;
const MAP_W = MAP_COLS * TILE; // 252
const MAP_H = MAP_ROWS * TILE; // 216

/** 上部メッセージ行の高さ (px) */
const MSG_H = GLYPH_H + 4; // 9

/** ゲーム領域 (registerGameApp に渡す固定サイズ) */
const W = MAP_W; // 252
const H = MSG_H + MAP_H; // 225

/** 視界半径 (タイル) */
const LIGHT_RADIUS = 6;

/** モンスターがプレイヤーを察知して追跡を始める距離 (タイル) */
const AGGRO_RANGE = 8;

// タイル種別
const WALL = 0;
const FLOOR = 1;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  モンスター定義
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * type キーがそのまま表示グリフ。
 *   hp   … 最大体力
 *   atk  … 攻撃力（プレイヤーへのダメージ）
 *   xp   … 撃破時の獲得経験値
 *   name … メッセージ表示名
 *   min  … 出現可能な最小階層
 */
const MONSTERS = {
  r: { hp: 3, atk: 1, xp: 2, name: "rat", min: 1 },
  k: { hp: 5, atk: 2, xp: 4, name: "kobold", min: 2 },
  o: { hp: 8, atk: 3, xp: 7, name: "orc", min: 4 },
  T: { hp: 14, atk: 5, xp: 14, name: "troll", min: 7 },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** タイルマップ (WALL / FLOOR) */
let map = new Uint8Array(MAP_COLS * MAP_ROWS);
/** 現在視界内か */
let visible = new Uint8Array(MAP_COLS * MAP_ROWS);
/** 一度でも見たか (記憶) */
let explored = new Uint8Array(MAP_COLS * MAP_ROWS);

/** プレイヤー */
const player = {
  x: 0,
  y: 0,
  hp: 20,
  maxHp: 20,
  atk: 4,
  xp: 0,
  level: 1,
  depth: 1,
  gold: 0,
};

/** 下り階段の位置 */
const stairs = { x: 0, y: 0 };

/** モンスター配列 [{x,y,type,hp}] */
let monsters = [];
/** アイテム配列 [{x,y,kind}] kind: "potion" | "gold" */
let items = [];

/** "playing" | "dead" */
let state = "playing";

/** 最新メッセージ */
let message = "";

/** ダメージ時の画面シェイク残量 */
let shakeTimer = 0;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  小道具
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const idx = (x, y) => y * MAP_COLS + x;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < MAP_COLS && y < MAP_ROWS;
const isWall = (x, y) => !inBounds(x, y) || map[idx(x, y)] === WALL;

/** a..b の整数を返す (両端含む) */
function randInt(a, b) {
  return a + ((Math.random() * (b - a + 1)) | 0);
}

function msg(s) {
  message = s;
}

function monsterAt(x, y) {
  for (const m of monsters) if (m.x === x && m.y === y) return m;
  return null;
}

function itemAt(x, y) {
  for (const it of items) if (it.x === x && it.y === y) return it;
  return null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ダンジョン生成
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function carveRoom(rx, ry, rw, rh) {
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      map[idx(x, y)] = FLOOR;
    }
  }
}

/** 2 点を L 字の通路でつなぐ */
function carveCorridor(ax, ay, bx, by) {
  let x = ax;
  let y = ay;
  while (x !== bx) {
    map[idx(x, y)] = FLOOR;
    x += Math.sign(bx - x);
  }
  while (y !== by) {
    map[idx(x, y)] = FLOOR;
    y += Math.sign(by - y);
  }
  map[idx(x, y)] = FLOOR;
}

/** 床タイルのうち、誰も占有していない空きマスをランダムに返す（rooms[0] は除外可） */
function randomFloor(avoidStartRoom) {
  for (let tries = 0; tries < 200; tries++) {
    const room = rooms[randInt(avoidStartRoom && rooms.length > 1 ? 1 : 0, rooms.length - 1)];
    const x = randInt(room.x, room.x + room.w - 1);
    const y = randInt(room.y, room.y + room.h - 1);
    if (map[idx(x, y)] !== FLOOR) continue;
    if (x === player.x && y === player.y) continue;
    if (x === stairs.x && y === stairs.y) continue;
    if (monsterAt(x, y) || itemAt(x, y)) continue;
    return { x, y };
  }
  return null;
}

let rooms = [];

function genDungeon(depth) {
  // 部屋が 2 つ未満なら作り直し（プレイヤー位置と階段位置を分離するため）
  for (let attempt = 0; attempt < 20; attempt++) {
    map.fill(WALL);
    rooms = [];
    for (let i = 0; i < 80 && rooms.length < 9; i++) {
      const rw = randInt(4, 7);
      const rh = randInt(3, 6);
      const rx = randInt(1, MAP_COLS - rw - 1);
      const ry = randInt(1, MAP_ROWS - rh - 1);
      // 既存の部屋と (1 マスの余白を含めて) 重なるならスキップ
      let ok = true;
      for (const o of rooms) {
        if (
          rx <= o.x + o.w &&
          rx + rw >= o.x &&
          ry <= o.y + o.h &&
          ry + rh >= o.y
        ) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      carveRoom(rx, ry, rw, rh);
      rooms.push({
        x: rx,
        y: ry,
        w: rw,
        h: rh,
        cx: (rx + rw / 2) | 0,
        cy: (ry + rh / 2) | 0,
      });
    }
    if (rooms.length >= 2) break;
  }

  // 部屋を順番に通路でつなぐ
  for (let i = 1; i < rooms.length; i++) {
    carveCorridor(rooms[i - 1].cx, rooms[i - 1].cy, rooms[i].cx, rooms[i].cy);
  }

  // プレイヤーは最初の部屋、階段は最後の部屋
  player.x = rooms[0].cx;
  player.y = rooms[0].cy;
  stairs.x = rooms[rooms.length - 1].cx;
  stairs.y = rooms[rooms.length - 1].cy;

  // エンティティ配置
  monsters = [];
  items = [];
  const monsterCount = Math.min(3 + depth, 14);
  for (let i = 0; i < monsterCount; i++) {
    const p = randomFloor(true);
    if (!p) break;
    const pool = Object.keys(MONSTERS).filter((k) => MONSTERS[k].min <= depth);
    const type = pool[randInt(0, pool.length - 1)];
    monsters.push({ x: p.x, y: p.y, type, hp: MONSTERS[type].hp });
  }
  for (let i = 0; i < randInt(1, 3); i++) {
    const p = randomFloor(true);
    if (p) items.push({ x: p.x, y: p.y, kind: "potion" });
  }
  for (let i = 0; i < randInt(1, 3); i++) {
    const p = randomFloor(true);
    if (p) items.push({ x: p.x, y: p.y, kind: "gold" });
  }

  recomputeFov();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  視界 (FOV)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * プレイヤーから半径内の各マスへ Bresenham でレイを飛ばし、
 * 壁にぶつかるまでを可視とする。壁そのものは可視（部屋の境界が見える）。
 */
function recomputeFov() {
  visible.fill(0);
  const px = player.x;
  const py = player.y;
  visible[idx(px, py)] = 1;
  explored[idx(px, py)] = 1;

  for (let ty = py - LIGHT_RADIUS; ty <= py + LIGHT_RADIUS; ty++) {
    for (let tx = px - LIGHT_RADIUS; tx <= px + LIGHT_RADIUS; tx++) {
      if (!inBounds(tx, ty)) continue;
      const dx = tx - px;
      const dy = ty - py;
      if (dx * dx + dy * dy > LIGHT_RADIUS * LIGHT_RADIUS) continue;
      castRay(px, py, tx, ty);
    }
  }
}

/** (x0,y0) から (x1,y1) へレイを飛ばし、通過マスを可視化。壁で停止。 */
function castRay(x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  // 始点はスキップして 1 歩ずつ進む
  while (true) {
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
    const i = idx(x, y);
    visible[i] = 1;
    explored[i] = 1;
    if (map[i] === WALL) break; // 壁は見えるが、その先は遮蔽
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ターン処理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** プレイヤーの移動 / 攻撃を試みる。壁への bump は何もしない（ターン消費なし）。 */
function tryPlayerMove(dx, dy) {
  const nx = player.x + dx;
  const ny = player.y + dy;
  if (isWall(nx, ny)) return;

  const m = monsterAt(nx, ny);
  if (m) {
    playerAttack(m);
    endTurn();
    return;
  }

  player.x = nx;
  player.y = ny;

  // アイテム取得
  const it = itemAt(nx, ny);
  if (it) pickup(it);

  // 階段に乗ったら降りる（モンスターターンはスキップ）
  if (nx === stairs.x && ny === stairs.y) {
    descend();
    return;
  }

  endTurn();
}

function playerAttack(m) {
  const def = MONSTERS[m.type];
  const dmg = player.atk + randInt(0, 1);
  m.hp -= dmg;
  if (m.hp <= 0) {
    monsters.splice(monsters.indexOf(m), 1);
    gainXp(def.xp);
    msg(`You slay the ${def.name}.`);
  } else {
    msg(`You hit the ${def.name} for ${dmg}.`);
  }
}

function pickup(it) {
  if (it.kind === "potion") {
    const heal = 8;
    player.hp = Math.min(player.maxHp, player.hp + heal);
    msg(`You quaff a potion (+${heal} HP).`);
  } else {
    const g = randInt(5, 15);
    player.gold += g;
    msg(`You pick up ${g} gold.`);
  }
  items.splice(items.indexOf(it), 1);
}

function descend() {
  player.depth++;
  // 降りるとわずかに回復
  player.hp = Math.min(player.maxHp, player.hp + 3);
  msg(`You descend to depth ${player.depth}.`);
  genDungeon(player.depth);
}

function gainXp(n) {
  player.xp += n;
  while (player.xp >= xpNeed(player.level)) {
    player.xp -= xpNeed(player.level);
    levelUp();
  }
}

function xpNeed(level) {
  return 6 + level * 4;
}

function levelUp() {
  player.level++;
  player.maxHp += 4;
  player.hp = player.maxHp;
  player.atk += 1;
  msg(`Level up! You are now level ${player.level}.`);
}

/** プレイヤーアクション後: 全モンスターが行動 → 視界更新 */
function endTurn() {
  monstersAct();
  recomputeFov();
}

/** モンスターが移動可能か（床・範囲内・他モンスター不在・プレイヤー以外） */
function canMonsterMove(x, y) {
  if (isWall(x, y)) return false;
  if (x === player.x && y === player.y) return false;
  if (monsterAt(x, y)) return false;
  return true;
}

function monstersAct() {
  // splice 中の添字ズレを避けるためコピーを走査
  for (const m of [...monsters]) {
    if (m.hp <= 0) continue;
    const dx = player.x - m.x;
    const dy = player.y - m.y;
    const manh = Math.abs(dx) + Math.abs(dy);

    if (manh === 1) {
      monsterAttack(m);
      continue;
    }
    if (manh > AGGRO_RANGE) continue; // 未察知: 待機

    // プレイヤーへ貪欲に 1 歩（距離の大きい軸を優先、塞がれたら別軸）
    let stepX = 0;
    let stepY = 0;
    if (Math.abs(dx) >= Math.abs(dy)) stepX = Math.sign(dx);
    else stepY = Math.sign(dy);

    if (canMonsterMove(m.x + stepX, m.y + stepY)) {
      m.x += stepX;
      m.y += stepY;
    } else if (stepX !== 0 && Math.sign(dy) !== 0 && canMonsterMove(m.x, m.y + Math.sign(dy))) {
      m.y += Math.sign(dy);
    } else if (stepY !== 0 && Math.sign(dx) !== 0 && canMonsterMove(m.x + Math.sign(dx), m.y)) {
      m.x += Math.sign(dx);
    }
  }
}

function monsterAttack(m) {
  const def = MONSTERS[m.type];
  player.hp -= def.atk;
  shakeTimer = 6;
  if (player.hp <= 0) {
    player.hp = 0;
    state = "dead";
    msg(`The ${def.name} kills you. You reached depth ${player.depth}.`);
  } else {
    msg(`The ${def.name} hits you for ${def.atk}.`);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ゲーム初期化
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function newGame() {
  player.hp = 20;
  player.maxHp = 20;
  player.atk = 4;
  player.xp = 0;
  player.level = 1;
  player.depth = 1;
  player.gold = 0;
  state = "playing";
  shakeTimer = 0;
  explored.fill(0);
  msg("You enter the dungeon.");
  genDungeon(1);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  更新 (入力)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function tick() {
  if (app.isPaused()) return;

  if (state === "dead") {
    if (keyDown("KeyR") || keyDown("Enter")) newGame();
    return;
  }

  // 1 フレーム 1 アクション
  if (keyDown("ArrowUp") || keyDown("KeyW")) tryPlayerMove(0, -1);
  else if (keyDown("ArrowDown") || keyDown("KeyS")) tryPlayerMove(0, 1);
  else if (keyDown("ArrowLeft") || keyDown("KeyA")) tryPlayerMove(-1, 0);
  else if (keyDown("ArrowRight") || keyDown("KeyD")) tryPlayerMove(1, 0);
  else if (keyDown("Space") || keyDown("Period")) endTurn(); // 待機
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** タイル中央へ 5x5 グリフを描く */
function drawGlyph(mx, my, tx, ty, ch) {
  drawText(mx + tx * TILE + 2, my + ty * TILE + 2, ch, 1);
}

function onDraw(contentRect) {
  tick();

  const cx = contentRect.x;
  const cy = contentRect.y;

  // 背景クリア
  fillRect(cx, cy, W, H, 0);

  // メッセージ行
  drawText(cx + 2, cy + 2, message, 1);

  // マップ領域（ダメージ時のみシェイク。死亡画面は抑制）
  const { sx, sy } = GameUtils.calcShake(shakeTimer, state, ["dead"]);
  if (shakeTimer > 0) shakeTimer--;
  const mx = cx + sx;
  const my = cy + MSG_H + sy;

  // タイル描画
  for (let ty = 0; ty < MAP_ROWS; ty++) {
    for (let tx = 0; tx < MAP_COLS; tx++) {
      const i = idx(tx, ty);
      if (!explored[i]) continue; // 未探索 = 暗闇
      const px = mx + tx * TILE;
      const py = my + ty * TILE;
      const lit = visible[i];

      if (map[i] === WALL) {
        if (lit) fillRect(px + 1, py + 1, TILE - 2, TILE - 2, 1);
        else drawCheckerboard(px + 1, py + 1, TILE - 2, TILE - 2, 1);
      } else if (lit) {
        // 視界内の床 = 中央の点
        pset(px + (TILE >> 1), py + (TILE >> 1), 1);
      }
    }
  }

  // 階段（視界内のみ）
  if (visible[idx(stairs.x, stairs.y)]) {
    drawGlyph(mx, my, stairs.x, stairs.y, ">");
  }

  // アイテム（視界内のみ）
  for (const it of items) {
    if (!visible[idx(it.x, it.y)]) continue;
    drawGlyph(mx, my, it.x, it.y, it.kind === "potion" ? "!" : "$");
  }

  // モンスター（視界内のみ）
  for (const m of monsters) {
    if (!visible[idx(m.x, m.y)]) continue;
    drawGlyph(mx, my, m.x, m.y, m.type);
  }

  // プレイヤー（常時）
  drawGlyph(mx, my, player.x, player.y, "@");

  // マップ外枠
  drawRect(cx, cy + MSG_H, MAP_W, MAP_H, 1);

  // 死亡オーバーレイ
  if (state === "dead") {
    GameUtils.drawOverlay(cx, cy + MSG_H, MAP_W, MAP_H, [
      "YOU DIED",
      "",
      `Depth ${player.depth}   Gold ${player.gold}`,
      "",
      "Press R to descend again",
    ]);
  }
}

function onDrawFooter(footerRect) {
  const fx = footerRect.x;
  const fy = footerRect.y;
  const parts = [
    `HP ${player.hp}/${player.maxHp}`,
    `LV ${player.level}`,
    `DEP ${player.depth}`,
    `G ${player.gold}`,
  ];
  let x = fx;
  for (const p of parts) {
    drawText(x, fy, p, 1);
    x += GameUtils.textWidth(p) + 10;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  入力（マウスは未使用。キーボードは tick() でポーリング）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onInput() {
  // マウス操作は無し（キーボード専用ローグライク）
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  閉じる時のリセット
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onBeforeClose() {
  newGame(); // 次回オープン時に新しいダンジョンで始まるようリセット
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

newGame();

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
