/**
 * @module app/telex
 * telex.js — TELEX (仮想テレタイプ受信機) のプロトタイプ
 *
 * デスクトップ常駐型のテレタイプ風ウィンドウ。一定間隔で短いメッセージが
 * 「印字」される。PIXERA OS という空想マシンに人格を立ち上げるための装置。
 *
 * プロトタイプ仕様:
 *   - 約 30 秒間隔でメッセージ pool からランダム抽出して 1 行追加
 *   - 過去 N 行が画面内に保持され、古いものから自然消失
 *   - 印字アニメーション: タイプライタ風の 1 文字ずつ表示 (~30ms/字)
 *
 * 今後の検討事項 (本実装時):
 *   - HUMOR_PRINCIPLES.md §5 のチェックリストに沿ったメッセージ拡充
 *   - SE (印字音 / 紙送り音) の追加
 *   - VFS への履歴保存
 *   - 送信者名 (The Machine / The Author / Anonymous) の分類表現
 */

import { fillRect, hline } from "../core/gpu.js";
import { drawText, GLYPH_W, GLYPH_H } from "../core/font.js";
import { wmOpen, wmRegister } from "../wm/index.js";

const APP_NAME = "TELEX";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const WIN_W = 180;
const WIN_H = 130;
const PADDING = 4;
const LINE_H = GLYPH_H + 2;

/** メッセージ間隔 (フレーム数。60fps で 30 秒) */
const MSG_INTERVAL_FRAMES = 60 * 30;
/** タイプライタ速度 (フレーム/字) */
const TYPE_SPEED_FRAMES = 2;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  メッセージ pool (HUMOR_PRINCIPLES の試行段階)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const MESSAGES = [
  "TUESDAY HAS ARRIVED.",
  "ALL SYSTEMS NOMINAL. PROBABLY.",
  "THE MACHINE DREAMS OF NUMBERS.",
  "REMINDER: COFFEE.",
  "CAUTION: TIME PASSING.",
  "QUERY: ARE YOU STILL THERE?",
  "BULLETIN: NOTHING TO REPORT.",
  "...AND SO IT GOES.",
  "STATUS: AWAITING INSTRUCTIONS.",
  "FACT: 3.14159265.",
  "NOTE: 1-BIT IS ENOUGH.",
  "OBSERVATION: WINDOWS ARE OPEN.",
  "MAKE SOMETHING SMALL TODAY.",
  "DISPATCH: A SHIP HAS DEPARTED.",
  "MEMO: PIXELS ARE SACRED.",
  "WARNING: SILENCE IMMINENT.",
  "REPORT: THE DESKTOP IS QUIET.",
  "ADVICE: STOP. LOOK. CONTINUE.",
  "FROM ANONYMOUS: GOOD WORK.",
  "FRAGMENT: ...IT WAS DUSK...",
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 印字済み行 (古いものが先頭) */
let lines = [];
/** いま印字中の行 (まだ lines に積まれていない) */
let typingLine = "";
/** typingLine が表現すべき完成文字列 */
let typingTarget = "";
/** タイプライタ進捗フレームカウンタ */
let typingFrameCount = 0;
/** 次のメッセージまでのフレーム残数 */
let nextMsgIn = MSG_INTERVAL_FRAMES;
/** 受信時刻 (h:mm) を擬似生成するためのオフセット秒 */
let pseudoSecond = 0;

function pseudoTime() {
  // システム時刻ではなく擬似時刻 (アプリ起動からの経過 + ベース 09:00)
  const total = (9 * 3600 + pseudoSecond) % (24 * 3600);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function startTyping() {
  const msg = MESSAGES[(Math.random() * MESSAGES.length) | 0];
  typingTarget = `${pseudoTime()} ${msg}`;
  typingLine = "";
  typingFrameCount = 0;
}

function appendCurrentLine() {
  lines.push(typingTarget);
  typingTarget = "";
  typingLine = "";
  // 表示可能行数を超えたら先頭から落とす
  const maxLines = Math.floor((WIN_H - PADDING * 2 - LINE_H) / LINE_H);
  while (lines.length > maxLines) lines.shift();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画 / 入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDraw(cr) {
  // 完成済み行を描画
  for (let i = 0; i < lines.length; i++) {
    drawText(cr.x + PADDING, cr.y + PADDING + i * LINE_H, lines[i], 1);
  }
  // 現在印字中の行
  if (typingLine) {
    const y = cr.y + PADDING + lines.length * LINE_H;
    drawText(cr.x + PADDING, y, typingLine, 1);
    // カーソル (印字ヘッド)
    const cursorX = cr.x + PADDING + typingLine.length * (GLYPH_W + 1);
    if (((typingFrameCount / 15) | 0) % 2 === 0) {
      fillRect(cursorX, y, 3, GLYPH_H, 1);
    }
  }
}

function onUpdate() {
  pseudoSecond++;

  // タイプライタ進行
  if (typingTarget) {
    typingFrameCount++;
    const wantLen = Math.min(
      typingTarget.length,
      Math.floor(typingFrameCount / TYPE_SPEED_FRAMES),
    );
    typingLine = typingTarget.substring(0, wantLen);
    if (wantLen === typingTarget.length) {
      // 印字完了 → 1 秒の間を置いて確定
      if (typingFrameCount > typingTarget.length * TYPE_SPEED_FRAMES + 60) {
        appendCurrentLine();
      }
    }
  } else {
    // 次のメッセージまでのカウントダウン
    nextMsgIn--;
    if (nextMsgIn <= 0) {
      nextMsgIn = MSG_INTERVAL_FRAMES;
      startTyping();
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィンドウ登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    // 起動直後は最初の 1 行を即印字して、概念をすぐ理解できるようにする
    if (lines.length === 0 && !typingTarget) {
      startTyping();
    }
    return wmOpen(
      -1,
      -1,
      WIN_W,
      WIN_H,
      APP_NAME,
      (cr) => {
        onUpdate();
        onDraw(cr);
      },
      null,
      null,
      {
        about:
          "A teletype that prints short status messages at intervals. " +
          "It runs on its own — no input needed.",
        noResize: false,
        noMaximize: true,
      },
    );
  },
  { category: "EXPERIMENT" },
);
