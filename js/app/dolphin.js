/**
 * @module app/dolphin
 * dolphin.js — "Totally not a virus" イースターエッグ
 *
 * インターネットミーム「totally not a virus. trust me... im a dolphin」の
 * PIXERA OS 版イースターエッグ。デスクトップアイコンをダブルクリックすると
 * 確認ダイアログで「Do you like dolphins?」と問いかけ、応答に応じた
 * イルカからのメッセージが表示される。
 *
 * ── ユーモア設計 (HUMOR_PRINCIPLES.md 準拠) ──
 *
 * 使用している原則:
 *   §1.1 トーンの不一致 — "! IMPORTANT !" タイトル vs イルカの質問
 *   §1.2 選択の無意味化 — YES/NO どちらでもイルカとの対話が発生
 *   §1.3 自己言及的な正直さ — "Totally not a virus" の自己矛盾
 *   §1.4 感情の非対称 — デッドパンの脅迫 ("Forever.")
 *   §1.5 段階的な圧力 — No を選んでも再度問い直される (最大 3 段階)
 *   §1.6 不条理な精密さ — イルカ語の括弧内翻訳
 *   §1.7 真摯な瞬間 — 一部メッセージ末尾の静かなトーン変化
 *   §1.8 一貫した内部論理 — 起動回数に応じた開始メッセージの変化
 *
 * 設計パターン: B (無害な執着を持つプログラム)
 */

import { wmRegister } from "../wm/index.js";
import {
  openConfirmDialog,
  openAlertDialog,
  isDialogOpen,
} from "../ui/index.js";

// ── 定数 ──

/** デスクトップアイコン用のアプリ登録名 */
const APP_NAME = "DOLPHIN";

/** ツールチップ (1 行表示) */
export const DOLPHIN_TOOLTIP = "Totally not a virus. Trust me...im a dolphin";

// §1.8 一貫した内部論理: 起動回数に応じた反応の変化
let _launchCount = 0;

// ── イルカからのメッセージ ──

/** Yes を選んだ場合のメッセージ群 */
const MESSAGES_YES = [
  'I knew it!\nDolphins are the best.\n\nClick click click!\n(That\'s dolphin\nfor "thank you")',
  "Finally, someone\nwith good taste!\n\nWe dolphins\nappreciate you.",
  "A fellow dolphin\nenthusiast!\n\nRemember:\nDolphins never\nlie.",
  "Excellent choice.\n\nThis is definitely\nnot a trick.\n\nTrust the dolphin.",
];

/** エスカレーション中に翻意した場合のメッセージ群 (§1.5 → §1.4) */
const MESSAGES_RELENT = [
  "Good.\nThe dolphin knew\nyou'd come around.",
  "A wise decision.\n\nThe dolphin\nforgives you.",
];

/** 最後まで No を貫いた場合のメッセージ群 */
const MESSAGES_NO = [
  "...How could you?\n\nThe dolphin is\nvery disappointed\nin you.",
  "Wrong answer.\n\nPlease reconsider\nyour life choices.\n\nSincerely,\nThe Dolphin",
  "Error 404:\nGood taste\nnot found.\n\n- The Dolphin",
  "The dolphin will\nremember this.\n\nForever.\n\n...Take care.", // §1.7
];

// ── ロジック ──

/**
 * メッセージ配列からランダムに 1 つ選ぶ。
 * @param {string[]} arr
 * @returns {string}
 */
function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

/**
 * イルカの質問ダイアログを表示する (§1.5 段階的な圧力)。
 *
 * No を選んでもイルカは引き下がらず、最大 3 段階まで再確認する。
 * Esc / × ボタンは Cancel と同義であり、stage 1 以降の Cancel は
 * 「翻意」扱い (§1.2) となるため最大 3 回の操作で終了する。
 *
 * stage 0: "Do you like dolphins?" — YES=positive / NO=escalate
 * stage 1: "Are you sure?"         — YES=escalate / NO=relent
 * stage 2: "...Really?"            — YES=disappointed / NO=relent
 *
 * @param {string} message 質問テキスト
 * @param {number} stage   エスカレーション段階 (0–2)
 */
function _askDolphin(message, stage) {
  openConfirmDialog(message, {
    title: "! IMPORTANT !",
    okLabel: stage < 2 ? "YES" : "...YES",
    cancelLabel: stage < 2 ? "NO" : "...NO",
    // ×ボタン / ESC → 即退場 (ダイアログを続行しない)
    onClose: () => {},
    onOk: () => {
      if (stage === 0) {
        // YES to "Do you like dolphins?" → positive
        openAlertDialog(pick(MESSAGES_YES), {
          title: "DOLPHIN",
          okLabel: "OK",
        });
      } else if (stage === 1) {
        // YES to "Are you sure?" → escalate
        _askDolphin("...Really?\nYou're sure?", 2);
      } else {
        // YES to "...Really?" → final disappointed
        openAlertDialog(pick(MESSAGES_NO), {
          title: "DOLPHIN",
          okLabel: "...",
        });
      }
    },
    onCancel: () => {
      if (stage === 0) {
        // NO to "Do you like dolphins?" → escalate
        _askDolphin("Are you sure\nyou don't?", 1);
      } else {
        // NO to "Are you sure?" / "...Really?" → relent (§1.2)
        openAlertDialog(pick(MESSAGES_RELENT), {
          title: "DOLPHIN",
          okLabel: "OK",
        });
      }
    },
  });
}

/**
 * イースターエッグを起動する。
 * 起動回数に応じて開始メッセージが変化する (§1.8)。
 */
function launchDolphin() {
  if (isDialogOpen()) return;

  const greeting =
    _launchCount === 0
      ? "Do you like dolphins?"
      : _launchCount === 1
        ? "Oh. You again.\n\nDo you like dolphins?"
        : "...\n\nDo you like dolphins?";
  _launchCount++;

  _askDolphin(greeting, 0);
}

// ── 登録 ──
// hidden: true → コンテキストメニューには表示しない (デスクトップアイコンのみ)。
// modal: true → デスクトップアイコン自動生成から除外 (app.js で手動追加)。
// factory は null を返す → entry.winId は常に null → 何度でも起動可能。
wmRegister(
  APP_NAME,
  () => {
    launchDolphin();
    return null;
  },
  { modal: true, hidden: true },
);

