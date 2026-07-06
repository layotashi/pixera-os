/**
 * @module app/aquaria
 * aquaria.js — AQUARIA (1-bit 水槽)
 *
 * 1-bit ピクセルアートの魚が群れで泳ぐ「映える画面」専用ウィンドウ。
 * After Dark の水槽スクリーンセーバーの PIXERA OS 的再解釈。
 *
 * 仕様:
 *   - 5 匹のエンゼルフィッシュが boids 風の規則で泳ぐ
 *     (近傍のみの結束/整列 + 個体反発 + 壁反発 + 餌追従 + 個体差・ノイズ・リーダー/
 *     気まぐれ個体による有機的な群れの分裂/再集合)
 *   - 各魚は 2 フレームの尾びれアニメ (assets/fish/ の PNG、個体ごとに
 *     位相をずらして泳ぐ)。スプライトは左向きが基準で、右へ泳ぐ時のみ反転する。
 *   - クリックで餌を落とすと、近くの魚が寄ってきて食べる
 *   - 葉のある水草 + 上昇する気泡で水槽を演出
 *   - NOTEPAD と同じ見た目の縦横スクロールバー + ステッパーボタンをボディ右端/下端に
 *     装飾として表示する (AQUARIA はスクロール不可のため常に 100% 表示・操作不可)
 *   - デスクトップアイコン右クリック → PREFERENCES で、群泳の主要パラメータを
 *     スライダーから live チューニングできる独立ウィンドウを開ける
 *
 * 水槽の縦構成 (ボディ内枠線の内側、上から):
 *   1px 枠線 (BG) → 水上の空間 (BG, AIR_H px) → 水と魚 (FG) → 砂 (BG, 起伏あり, SAND_H px)
 */

import { pset, fillRect, drawRect, vline } from "../core/gpu.js";
import { getFishFrame, FISH_W, FISH_H } from "../core/fish.js";
import {
  wmOpen,
  wmRegister,
  wmOpenOrFocus,
  wmClose,
  wmFocus,
  wmSetContentSize,
} from "../wm/index.js";
import { VRAM_WIDTH, VRAM_HEIGHT } from "../config.js";
import {
  Label,
  SectionLabel,
  HSep,
  PushButton,
  Slider,
  WidgetGroup,
  HBox,
  VBox,
} from "../ui/index.js";

const APP_NAME = "AQUARIA";

const WIN_W = 200;
const WIN_H = 140;

/** デスクトップモードで放つ魚の数 (画面が広いので水槽より多め) */
const DESKTOP_FISH_COUNT = 15;

/** 速度への摩擦係数 (毎フレーム乗算)。個体差は TUNING/trait 側で表現するため固定値。 */
const FRICTION = 0.975;

/**
 * 結束/整列/リーダー追従/中央引力/揺らぎの合成操舵力を、その魚自身の maxSpeed に
 * 対する比率でクランプする係数。TUNING の各値は Speed に関わらず固定なので、
 * この比率が無いと Speed を下げるほど「1 フレームの操舵力」が maxSpeed に対して
 * 相対的に巨大になり、毎フレーム向きが反転する震えとして現れる。
 */
const STEER_ACCEL_RATIO = 1000; // TEMP disabled

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
//  チューニング可能パラメータ (Preferences ウィンドウから編集)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 群泳の見た目を決める主要係数。個体ごとの実効値は「出生時に固定された乱数の種
// (trait, 0..1)」と、この TUNING (随時変更されうる) を毎フレーム掛け合わせて算出
// する (stepSchool 内、_traitValue 参照)。これにより Preferences のスライダーを
// 動かした瞬間に、既に泳いでいる魚の挙動へ途切れなく反映される (魚を作り直さない)。

const TUNING_DEFAULTS = {
  speed: 0.5, // 基準最高速
  separation: 0.25, // 個体間反発 (パーソナルスペース) の強さ
  alignment: 0.1, // 整列 (近傍の平均速度への追従) の重み
  cohesion: 0.011, // 結束 (近傍の重心への追従) の重み
  wallAvoid: 0.6, // 壁 / 画面端の回避力
  centerPull: 0.0015, // 中央への引力 (弱いほど中央への一極集中を防げる)
  wanderSpeed: 0.1, // 低周波ノイズ (遊泳方向) が変化する速さ
  wanderAmp: 0.05, // 低周波ノイズによる揺らぎの強さ
  moodDepth: 0.9, // 結束の呼吸 = 一時的な分裂/再集合の深さ (0=一定 / 1=最大)
  individuality: 2, // 個体差の大きさ (0=全員ほぼ同一 / 2=非常にばらつく)
  maverickChance: 0.18, // 気まぐれ個体が生まれる確率 (出生時に決定)
  leaderFollow: 0.15, // リーダーへの追従力
  startleChance: 0, // 想定外の急な動きが起こる確率 (1 フレームあたり)
};

/** @type {typeof TUNING_DEFAULTS} 現在のチューニング値。Preferences ウィンドウが直接書き換える。 */
let TUNING = { ...TUNING_DEFAULTS };

/**
 * 個体差の種 (trait, 0..1) と中心値・振れ幅から実効値を算出する。
 * 振れ幅は TUNING.individuality で一律にスケールされる (0 でほぼ均一、2 で大きくばらつく)。
 * @param {number} center 振れ幅の中心値
 * @param {number} halfSpread 振れ幅の半分 (individuality=1 のときの値)
 * @param {number} trait 0..1 の固定乱数
 */
function _traitValue(center, halfSpread, trait) {
  const span = halfSpread * TUNING.individuality;
  return center - span + trait * 2 * span;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  魚 / 餌
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @typedef {ReturnType<typeof _makeFish>} Fish */
/** @type {Fish[]} */
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

/**
 * 個体差を持った 1 匹を生成する。水槽/デスクトップ両モードで共有するファクトリ。
 *
 * ここでは「出生時に固定される乱数の種 (trait)」と役割 (リーダー/気まぐれ/通常) の
 * みを決める。実際の速度・結束の強さ等は TUNING と合わせて stepSchool が毎フレーム
 * 算出するため、Preferences でのチューニングは既存の個体にも即座に反映される。
 *
 * - 先頭 (i===0) は「リーダー」: 結束/整列は弱いが視野が広く、独自に気ままに泳ぐ。
 *   他個体は近くにいる時だけ、個体ごとの追従度に応じてリーダーへ引き寄せられる
 *   (追従しない個体もいる = リーダーに全員が付いていくわけではない)。
 * - 一定確率 (TUNING.maverickChance) で「気まぐれ個体」: 結束/整列がさらに弱く、
 *   ふらつきが大きい。群れから離れがちになり、想定外の動きの起点になる。
 * - それ以外は「通常個体」だが、速度・反応距離・視野角・結束の強さ等が個体ごとに
 *   ランダムに散らばる (全員が同じ動きになるのを防ぐ)。
 */
function _makeFish(x, y, i) {
  const isLeader = i === 0;
  const isMaverick = !isLeader && Math.random() < TUNING.maverickChance;
  return {
    x,
    y,
    vx: (Math.random() - 0.5) * 1.5,
    vy: (Math.random() - 0.5) * 0.5,
    phase: (Math.random() * 8) | 0, // 尾びれアニメの位相 (群れを desync)
    isLeader,
    isMaverick,
    // ── 個体差の種 (0..1、固定)。実効値は毎フレーム _traitValue + TUNING で算出 ──
    tSpeed: Math.random(),
    tPersonalSpace: Math.random(),
    tPerception: Math.random(),
    tRear: Math.random(),
    tCohesion: Math.random(),
    tAlign: Math.random(),
    tCenterPull: Math.random(),
    tWanderSpeed: Math.random(),
    // ── 状態 (フレームごとに更新される) ──
    wanderAngle: Math.random() * Math.PI * 2, // 低周波ノイズによる遊泳方向の揺らぎ
    moodPhase: Math.random() * Math.PI * 2, // 結束の強さが緩やかに呼吸する位相
    moodFreq: 0.004 + Math.random() * 0.006,
    leaderFollow: Math.random(), // リーダーへの追従度 (0 = 追従しない)
  };
}

function _initFish() {
  fish = [];
  food = [];
  const waterBottom = _sandBaseTop();
  for (let i = 0; i < 5; i++) {
    const x = Math.random() * (_crW - FISH_W - BORDER * 2 - 2) + BORDER + 1;
    const y =
      Math.random() * (waterBottom - WATER_TOP_LOCAL - FISH_H - 2) +
      WATER_TOP_LOCAL +
      1;
    fish.push(_makeFish(x, y, i));
  }
}

function _tickFood() {
  // 餌は沈み、砂に達したら消える
  for (const p of food) p.y += 0.4;
  const sandTop = _sandBaseTop();
  food = food.filter((p) => p.y < sandTop);
}

/**
 * Boids 風の 1 ステップ。水槽モードとデスクトップモードで共有する。
 * 群れの挙動 (近傍結束/整列 + 個体反発 + 壁反発 + 餌追従 + 個体差/ノイズ/リーダー追従)
 * は同一で、境界 (bounds) と中央引力の中心 (cx, cy)、餌の有無だけがモードで異なる。
 *
 * 整然とした一塊にならないよう、中央引力は個体ごとに弱く可変にし、代わりに「近傍の
 * 仲間だけ」を見て結束/整列する古典的 boids 則を使う。これにより群れが自然に複数の
 * サブグループへ分かれたり、ゆっくり再合流したりする。さらに結束の強さ自体が個体
 * ごとにゆっくり呼吸するように上下し (mood)、視野角相当の rearAwareness で後方の
 * 仲間の感知度を弱め、低周波ノイズ (wanderAngle のランダムウォーク) で遊泳方向が
 * 緩やかに迷い、まれな驚き挙動 (startle) が想定外の動きを生む。
 *
 * @param {Fish[]} arr  魚配列
 * @param {{left:number,right:number,top:number,bottom:number}} bounds  壁反発の作用境界 (魚座標系)
 * @param {number} cx  中央引力の中心 X
 * @param {number} cy  中央引力の中心 Y
 * @param {{x:number,y:number,_eaten?:boolean}[]|null} foodArr  餌配列 (null = 餌なし)
 * @param {number} t  経過フレーム (mood 振動の時間軸。水槽/デスクトップで独立カウント)
 */
function stepSchool(arr, bounds, cx, cy, foodArr, t) {
  const { left, right, top, bottom } = bounds;

  let leader = null;
  for (const g of arr) {
    if (g.isLeader) {
      leader = g;
      break;
    }
  }

  for (let i = 0; i < arr.length; i++) {
    const f = arr[i];
    const fcx = f.x + FISH_W / 2;
    const fcy = f.y + FISH_H / 2;

    // ── この瞬間の実効パラメータを算出 (種 trait は固定、TUNING は随時変化しうる) ──
    // Individuality を高く設定すると振れ幅が中心値を超えうるため、0 未満 (負の速度・
    // 重み) にならないよう下限を設ける。
    let maxSpeed = Math.max(0.05, _traitValue(TUNING.speed, 0.35, f.tSpeed));
    let personalSpace = _traitValue(14, 3, f.tPersonalSpace);
    let perception = _traitValue(38, 10, f.tPerception);
    let rearAwareness = Math.max(0, Math.min(1, _traitValue(0.4, 0.2, f.tRear)));
    let cohesionBase = Math.max(
      0,
      _traitValue(TUNING.cohesion, TUNING.cohesion * 0.45, f.tCohesion),
    );
    let alignWeight = Math.max(
      0,
      _traitValue(TUNING.alignment, TUNING.alignment * 0.5, f.tAlign),
    );
    let centerPull = Math.max(
      0,
      _traitValue(TUNING.centerPull, TUNING.centerPull * 0.6, f.tCenterPull),
    );
    let wanderSpeed = Math.max(
      0,
      _traitValue(TUNING.wanderSpeed, TUNING.wanderSpeed * 0.4, f.tWanderSpeed),
    );
    let wanderAmp = TUNING.wanderAmp;

    if (f.isLeader) {
      perception *= 1.45;
      cohesionBase *= 0.4;
      alignWeight *= 0.4;
      wanderAmp *= 1.75;
    } else if (f.isMaverick) {
      cohesionBase *= 0.2;
      alignWeight *= 0.25;
      centerPull *= 0.15;
      wanderSpeed *= 2.5;
      wanderAmp *= 2.5;
    }

    // 結束の強さは個体ごとにゆっくり呼吸する → 一時的に群れへくっついたり、
    // 離れがちになったりする揺らぎが生まれる (TUNING.moodDepth=0 で呼吸を止められる)。
    const mood = 0.5 + 0.5 * Math.sin(t * f.moodFreq + f.moodPhase);
    const moodMul = 1 + (mood - 0.5) * 2 * TUNING.moodDepth;
    cohesionBase *= Math.max(0, moodMul);

    // 進行方向 (視野角の重み付けに使用。ほぼ静止中は無指向とみなす)
    const spd0 = Math.hypot(f.vx, f.vy);
    const heading = spd0 > 0.05 ? { x: f.vx / spd0, y: f.vy / spd0 } : null;

    const pr2 = personalSpace * personalSpace;
    const per2 = perception * perception;
    let neighborWeight = 0;
    let sumX = 0, sumY = 0, sumVx = 0, sumVy = 0;

    for (let j = 0; j < arr.length; j++) {
      if (i === j) continue;
      const g = arr[j];
      const dxAway = f.x - g.x;
      const dyAway = f.y - g.y;
      const d2 = dxAway * dxAway + dyAway * dyAway;
      if (d2 === 0) continue;

      // 個体間反発 (パーソナルスペース、全方位に効く)
      if (d2 < pr2) {
        const inv = 1 / Math.sqrt(d2);
        f.vx += dxAway * inv * TUNING.separation;
        f.vy += dyAway * inv * TUNING.separation;
      }

      // 結束/整列は近傍のみ。視野角の狭い個体は後方の仲間の重みを rearAwareness まで
      // 落とす (完全な遮断ではなく滑らかな重み付けでジッターを避ける)。
      if (d2 < per2) {
        let w = 1;
        if (heading) {
          const dist = Math.sqrt(d2);
          const dot = (-dxAway / dist) * heading.x + (-dyAway / dist) * heading.y;
          w = rearAwareness + (1 - rearAwareness) * Math.max(0, dot);
        }
        neighborWeight += w;
        sumX += g.x * w;
        sumY += g.y * w;
        sumVx += g.vx * w;
        sumVy += g.vy * w;
      }
    }

    // ── 「周囲を見て泳ぐ」操舵力 (結束/整列/リーダー追従/中央引力/揺らぎ) は、
    // ここに accumulate してから maxSpeed に比例した上限でまとめてクランプする。
    // これらは元々 TUNING の固定値であり、Speed が低いとその魚自身の最高速に
    // 対して相対的に過大になり、毎フレーム向きが反転する激しい震えの原因になって
    // いた (壁回避・驚き・餌追従は「意図的に強い反応」なのでここでは対象外)。
    let steerX = 0;
    let steerY = 0;

    if (neighborWeight > 0) {
      const avgX = sumX / neighborWeight;
      const avgY = sumY / neighborWeight;
      steerX += (avgX - f.x) * cohesionBase;
      steerY += (avgY - f.y) * cohesionBase;
      const avgVx = sumVx / neighborWeight;
      const avgVy = sumVy / neighborWeight;
      steerX += (avgVx - f.vx) * alignWeight;
      steerY += (avgVy - f.vy) * alignWeight;
    }

    // リーダー追従: 気ままに泳ぐリーダーが近くにいる時だけ、個体ごとの追従度に
    // 応じて引き寄せられる (追従度が低い個体はほぼ反応しない)。
    if (leader && f !== leader) {
      const dx = leader.x - f.x;
      const dy = leader.y - f.y;
      const d2 = dx * dx + dy * dy;
      const noticeR = perception * 1.8;
      if (d2 > 0 && d2 < noticeR * noticeR) {
        const d = Math.sqrt(d2);
        steerX += (dx / d) * f.leaderFollow * TUNING.leaderFollow;
        steerY += (dy / d) * f.leaderFollow * TUNING.leaderFollow;
      }
    }

    // 中央への引力 (弱め・個体差あり。壁際に延々と張り付くのを防ぐ程度に留める)
    steerX += (cx - f.x) * centerPull;
    steerY += (cy - f.y) * centerPull;

    // 低周波ノイズによる遊泳方向の揺らぎ (向きがランダムウォークでゆっくり迷う)
    f.wanderAngle += (Math.random() - 0.5) * wanderSpeed;
    steerX += Math.cos(f.wanderAngle) * wanderAmp;
    steerY += Math.sin(f.wanderAngle) * wanderAmp;

    const steerMag = Math.hypot(steerX, steerY);
    const maxSteer = maxSpeed * STEER_ACCEL_RATIO;
    if (steerMag > maxSteer && steerMag > 0) {
      const s = maxSteer / steerMag;
      steerX *= s;
      steerY *= s;
    }
    f.vx += steerX;
    f.vy += steerY;

    // まれに驚いたような急な動きをする → 周囲がつられて反応し、思わぬ動きが波及する
    // (意図的な突発行動なので、上の操舵力クランプとは別に直接加える)
    if (Math.random() < TUNING.startleChance) {
      f.vx += (Math.random() - 0.5) * 1.4;
      f.vy += (Math.random() - 0.5) * 0.7;
    }

    // 餌追従: 一番近い餌へ向かう。十分近ければ食べる。
    if (foodArr) {
      let best = null;
      let bestD2 = 70 * 70; // 探知範囲
      for (const p of foodArr) {
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
    }

    // 壁反発
    if (f.x < left) f.vx += TUNING.wallAvoid;
    if (f.x > right) f.vx -= TUNING.wallAvoid;
    if (f.y < top) f.vy += TUNING.wallAvoid;
    if (f.y > bottom) f.vy -= TUNING.wallAvoid;

    // 速度上限 (個体ごとの最高速) + 摩擦
    const sp = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
    if (sp > maxSpeed) {
      f.vx *= maxSpeed / sp;
      f.vy *= maxSpeed / sp;
    }
    f.vx *= FRICTION;
    f.vy *= FRICTION;
    f.x += f.vx;
    f.y += f.vy;
  }
}

function _tickFish() {
  // 水槽モード: 境界は水面〜砂の手前、餌あり。
  stepSchool(
    fish,
    {
      left: BORDER + 1,
      right: _crW - FISH_W - BORDER - 1,
      top: WATER_TOP_LOCAL + 1,
      bottom: _sandBaseTop() - FISH_H, // 砂の手前で反転
    },
    _crW / 2,
    _crH / 2,
    food,
    frame,
  );
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
//  デスクトップモード
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 魚だけを画面全体 (VRAM_WIDTH × VRAM_HEIGHT) に最前面で泳がせるモード。
// 砂・水草・気泡・水面などの水槽要素は描かず、魚は画面端で反転する。
// ウィンドウを持たないため、放流中はウィンドウを閉じても泳ぎ続ける
// (状態はこのモジュールに常駐する)。入力は一切奪わず描画のみ行うので、
// 魚の下にあるアイコン/ウィンドウ/メニューは通常どおり操作できる。
//
// モードは「起動モード」を表す永続選択で、アイコン右クリックメニューの
// WINDOW MODE / DESKTOP MODE ラジオで切り替える。Run (= ダブルクリック) すると
// 選択中のモードで起動し、Exit で停止する。動作中のモード間 live 切替は行わない。

/** 起動モード: "window" (水槽ウィンドウ) | "desktop" (最前面で放流) */
let launchMode = "window";

/** デスクトップに放流中の魚 (放流中のみ非空) */
/** @type {{x:number,y:number,vx:number,vy:number,phase:number}[]} */
let deskFish = [];

/** デスクトップモードが起動中か */
let deskRunning = false;

/** デスクトップ魚の尾びれアニメ用フレームカウンタ (ウィンドウと独立に進む) */
let deskFrame = 0;

/** デスクトップ魚を画面全体にランダム配置で生成する。 */
function _initDesktopFish() {
  deskFish = [];
  for (let i = 0; i < DESKTOP_FISH_COUNT; i++) {
    const x = Math.random() * (VRAM_WIDTH - FISH_W);
    const y = Math.random() * (VRAM_HEIGHT - FISH_H);
    deskFish.push(_makeFish(x, y, i));
  }
}

/**
 * デスクトップ魚の物理更新。kernel の update() から毎フレーム呼ばれる。
 * 画面解像度は毎フレーム参照するため、解像度変更にも追従する。
 */
export function updateDesktopFish() {
  if (!deskRunning) return;
  deskFrame++;
  stepSchool(
    deskFish,
    {
      left: 1,
      right: VRAM_WIDTH - FISH_W - 1,
      top: 1,
      bottom: VRAM_HEIGHT - FISH_H - 1,
    },
    VRAM_WIDTH / 2,
    VRAM_HEIGHT / 2,
    null, // デスクトップモードでは餌なし
    deskFrame,
  );
}

/**
 * デスクトップ魚の描画。app.js の draw() で wmDraw() の後・カーソルの前に呼ばれ、
 * すべての UI の上・カーソルの下に描かれる。スプライトはカーソルと同じ自己完結型
 * (本体 + アウトライン) なので任意の背景の上でそのまま視認できる。
 */
export function drawDesktopFish() {
  if (!deskRunning) return;
  for (const f of deskFish) {
    const wf = ((deskFrame + f.phase * 4) >> 3) & 1;
    drawFishSprite(wf, f.x | 0, f.y | 0, f.vx >= 0);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Preferences ウィンドウ (群泳チューニング)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// TUNING の各値をスライダーで即時編集できる独立ウィンドウ。モーダルではないため、
// 水槽/デスクトップの魚を眺めながら調整できる。値は _traitValue 経由で毎フレーム
// 再解決されるため、ドラッグ中も途切れなく反映される。

/**
 * Preferences のスライダー定義。表示順・ラベル・値域・表示桁数・ホイール刻み幅・説明 (tooltip)。
 * 値域は「既定値がおおむね中央付近に来る」ことと「min/max が切りの良い数値であること」を
 * 優先して決めている (0 は常に「その挙動を完全に無効化する」意味を持つ、意味のある下限)。
 */
const TUNING_SLIDER_SPECS = [
  {
    key: "speed",
    label: "Speed",
    min: 0,
    max: 1.0,
    decimals: 2,
    wheelStep: 0.05,
    tooltip: "Average top swimming speed.\nLower = lazier drifting, higher = darting around.",
  },
  {
    key: "wallAvoid",
    label: "Wall avoid",
    min: 0,
    max: 1.0,
    decimals: 2,
    wheelStep: 0.05,
    tooltip:
      "How hard fish push back when they reach the tank/screen edge.\n" +
      "Too low lets them hug walls; too high makes bouncing visible.",
  },
  {
    key: "separation",
    label: "Separation",
    min: 0,
    max: 0.5,
    decimals: 2,
    wheelStep: 0.02,
    tooltip:
      "Personal-space repulsion between nearby fish.\n" +
      "Higher keeps individuals from overlapping/crowding each other.",
  },
  {
    key: "alignment",
    label: "Alignment",
    min: 0,
    max: 0.2,
    decimals: 2,
    wheelStep: 0.01,
    tooltip:
      "How strongly a fish matches its neighbors' heading and speed.\n" +
      "Higher = more synchronized, parallel swimming.",
  },
  {
    key: "cohesion",
    label: "Cohesion",
    min: 0,
    max: 0.02,
    decimals: 3,
    wheelStep: 0.001,
    tooltip:
      "How strongly a fish is pulled toward the center of its nearby\n" +
      "neighbors. Higher = tighter, denser clusters.",
  },
  {
    key: "centerPull",
    label: "Center pull",
    min: 0,
    max: 0.003,
    decimals: 4,
    wheelStep: 0.0001,
    tooltip:
      "Constant pull toward the tank/screen center.\n" +
      "Too weak lets the whole school drift out to the edges; too strong\n" +
      "makes fish orbit tightly around the middle, fighting other behaviors.",
  },
  {
    key: "wanderSpeed",
    label: "Wander speed",
    min: 0,
    max: 0.2,
    decimals: 2,
    wheelStep: 0.01,
    tooltip:
      "How quickly each fish's own wandering direction drifts over time.\n" +
      "Higher = more erratic, fast-changing meandering.",
  },
  {
    key: "wanderAmp",
    label: "Wander amount",
    min: 0,
    max: 0.1,
    decimals: 2,
    wheelStep: 0.005,
    tooltip:
      "Strength of the random wandering push.\n" +
      "Higher = more visible drifting/idling independent of the group.",
  },
  {
    key: "moodDepth",
    label: "Split / regroup",
    min: 0,
    max: 2.0,
    decimals: 2,
    wheelStep: 0.05,
    tooltip:
      "How much each fish's cohesion strength breathes over time.\n" +
      "0 = constant grouping. Higher = the school visibly splits into\n" +
      "sub-groups and regroups again in slow cycles.",
  },
  {
    key: "individuality",
    label: "Individuality",
    min: 0,
    max: 4,
    decimals: 2,
    wheelStep: 0.1,
    tooltip:
      "Scales how much fish differ from each other (speed, perception,\n" +
      "cohesion, etc). 0 = a uniform school, higher = very varied individuals.",
  },
  {
    key: "maverickChance",
    label: "Maverick chance",
    min: 0,
    max: 0.5,
    decimals: 2,
    wheelStep: 0.02,
    tooltip:
      "Probability a newly spawned fish becomes a maverick (weak\n" +
      "flocking, wanders off alone). Use RESPAWN SCHOOL to re-roll roles.",
  },
  {
    key: "leaderFollow",
    label: "Leader follow",
    min: 0,
    max: 0.3,
    decimals: 2,
    wheelStep: 0.01,
    tooltip:
      "How strongly other fish are pulled toward the leader when nearby.\n" +
      "0 = nobody follows; higher = the school trails the leader closely.",
  },
  {
    key: "startleChance",
    label: "Startle chance",
    min: 0,
    max: 0.02,
    decimals: 4,
    wheelStep: 0.0005,
    tooltip: "Probability, per frame, that a fish makes a sudden unexpected burst of speed.",
  },
];

/** Preferences ウィンドウの WM ID (未オープン時は null)。 */
let prefsWinId = null;
/** @type {{root: import("../ui/index.js").Box, group: WidgetGroup}|null} */
let prefsUi = null;

function _fmtTuning(v, decimals) {
  return v.toFixed(decimals);
}

/** Preferences のウィジェットツリーを構築する。 */
function _buildPreferencesUI() {
  const rows = [];
  const sliderRefs = [];

  const labels = TUNING_SLIDER_SPECS.map((spec) => new Label(0, 0, spec.label + ":"));
  const maxLabelW = Math.max(...labels.map((l) => l.w));
  for (const l of labels) l.w = maxLabelW;

  for (let i = 0; i < TUNING_SLIDER_SPECS.length; i++) {
    const spec = TUNING_SLIDER_SPECS[i];
    const valLbl = new Label(0, 0, _fmtTuning(TUNING[spec.key], spec.decimals));
    const slider = new Slider(0, 0, 90, spec.min, spec.max, TUNING[spec.key], (v) => {
      TUNING[spec.key] = v;
      valLbl.text = _fmtTuning(v, spec.decimals);
    });
    slider.defaultValue = TUNING_DEFAULTS[spec.key];
    slider.wheelStep = spec.wheelStep;
    slider.tooltip = spec.tooltip;
    rows.push(HBox([labels[i], slider, valLbl]));
    sliderRefs.push({ spec, slider, valLbl });
  }

  const btnReset = new PushButton(0, 0, "RESET TO DEFAULTS", () => {
    TUNING = { ...TUNING_DEFAULTS };
    for (const { spec, slider, valLbl } of sliderRefs) {
      slider.value = TUNING[spec.key];
      valLbl.text = _fmtTuning(TUNING[spec.key], spec.decimals);
    }
  });
  btnReset.tooltip = "Restore all sliders to their shipped defaults";

  const btnRespawn = new PushButton(0, 0, "RESPAWN SCHOOL", () => {
    // Maverick/Leader の役割は出生時に決まるため、現在泳いでいる群れだけを
    // 同じ場所で作り直す (実行中のモードのみ、停止中の側には触れない)。
    if (fish.length > 0) _initFish();
    if (deskFish.length > 0) _initDesktopFish();
  });
  btnRespawn.tooltip = "Re-roll the currently swimming school (leader/maverick roles, traits)";

  const root = VBox([
    new SectionLabel(0, 0, "SCHOOLING"),
    ...rows,
    new HSep(0, 0, 0),
    HBox([btnReset, btnRespawn]),
  ]);
  const group = new WidgetGroup(root);
  return { root, group };
}

/** Preferences ウィンドウを開く。既に開いていれば最前面へ。 */
function openPreferences() {
  if (prefsWinId !== null) {
    wmFocus(prefsWinId);
    return;
  }
  prefsUi = _buildPreferencesUI();
  const ui = prefsUi;
  prefsWinId = wmOpen(
    -1,
    -1,
    0,
    0,
    "AQUARIA PREFERENCES",
    (contentRect) => {
      // スライダー本数が画面高を超えうるため scrollable にしている。仮想コンテンツ高
      // (縦スクロールの基準) は毎フレーム最新の自然サイズで更新する (SETTINGS と同じ)。
      wmSetContentSize(prefsWinId, ui.root.measure().h);
      ui.group.draw(contentRect);
    },
    (ev) => ui.group.update(ev),
    () => ui.root.measure(),
    {
      noMaximize: true,
      scrollable: true,
      about:
        "Live-tune AQUARIA's schooling: speed, separation/alignment/cohesion, " +
        "wall avoidance, wander noise, mood-driven splitting/regrouping, and " +
        "individual variation (mavericks/leader). Changes apply instantly.",
      onBeforeClose: () => {
        prefsWinId = null;
        prefsUi = null;
        return true;
      },
    },
  );
}

// TEMP DEBUG (visual verification only, removed before commit)
export function _debugGetVelocities() {
  return fish.map((f) => ({ vx: f.vx, vy: f.vy }));
}

// ── コントローラ (アイコン右クリックメニューから駆動) ──

/** AQUARIA が (いずれかのモードで) 起動中か。 */
function _isRunning(entry) {
  return (entry && entry.winId !== null) || deskRunning;
}

/**
 * 選択中の launchMode で起動する。Run / ダブルクリックの実体。
 * 既に起動中なら (window モードのみ) 最前面へ、それ以外は何もしない
 * (モード間の live 切替はしない = 一度 Exit してから Run する)。
 */
function runAquaria(entry) {
  if (_isRunning(entry)) {
    if (entry && entry.winId !== null) wmOpenOrFocus(APP_NAME);
    return;
  }
  if (launchMode === "desktop") {
    _initDesktopFish();
    deskRunning = true;
  } else {
    wmOpenOrFocus(APP_NAME); // 水槽ウィンドウを開く (factory 経由で winId 追跡)
  }
}

/** 起動中のインスタンスを停止する。Exit の実体。 */
function exitAquaria(entry) {
  if (entry && entry.winId !== null) wmClose(entry.winId);
  if (deskRunning) {
    deskRunning = false;
    deskFish = [];
  }
}

/**
 * アイコン右クリックのコンテキストメニュー項目を返す。
 * 右クリックのたびに現在状態で再構築される (1-bit のため無効項目は
 * グレーアウトせず、Exit は起動中のみ出す = 表示/非表示で状態を伝える)。
 */
function buildIconMenu(entry) {
  const items = [
    { type: "action", label: "RUN", action: () => runAquaria(entry) },
    { type: "sep" },
    {
      type: "action",
      label: "WINDOW MODE",
      checked: launchMode === "window",
      action: () => {
        launchMode = "window";
      },
    },
    {
      type: "action",
      label: "DESKTOP MODE",
      checked: launchMode === "desktop",
      action: () => {
        launchMode = "desktop";
      },
    },
    { type: "sep" },
    { type: "action", label: "PREFERENCES", action: () => openPreferences() },
  ];
  if (_isRunning(entry)) {
    items.push({ type: "sep" });
    items.push({ type: "action", label: "EXIT", action: () => exitAquaria(entry) });
  }
  return items;
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
        "Click in the tank to drop food, and the fish will come to eat it. " +
        "Right-click the desktop icon to release the school onto the desktop.",
      noResize: true,
      noMaximize: true,
      padding: "none", // 水面・水草を枠端まで描く（ボディ内側の余白を消す）
    });
  },
  // iconMenu: アイコン右クリックで Window/Desktop モードを切り替え・起動・終了。
  // launch: ダブルクリック起動を launchMode 尊重にする (factory の代わりに呼ばれる)。
  { category: "EXPERIMENT", iconMenu: buildIconMenu, launch: runAquaria },
);
