/**
 * @module app/synesta
 * synesta.js — SYNESTA (音楽制作アプリ群の統合入口)
 *
 * SYNTH / ROLL / TRANSPORT / TRACK / OSCILLO を「1 つの音楽制作環境 = SYNESTA」として
 * まとめて起動・終了する統合ランチャ。これはアーカイブ済みの旧 SYNESTA (DAW モノリス) とは
 * 別物で、各機能は従来どおり独立したウィンドウのまま表示する。統合したのは「入口」だけ:
 * デスクトップアイコン / ランチャーメニューには個別アプリではなく SYNESTA だけを見せる
 * (メンバーは hidden + noIcon で登録され、SYNESTA からのみ開かれる)。
 *
 * ── 起動 / 終了のまとまり ──
 *   - 起動: メンバーを一括で開く (既に開いているものは最前面へ)。
 *   - 終了 (アイコン右クリック CLOSE): メンバーを一括で閉じる。各ウィンドウの onBeforeClose
 *     (ROLL の破棄確認等) を尊重する。
 *   - いずれかのメンバーウィンドウが閉じられたら SYNESTA 全体の終了とみなし、残りも閉じる。
 *     これは synestaUpdate() (app.js が毎フレーム呼ぶ) が検出する: セッション中にメンバーの
 *     開いている数が減ったら残りを畳んでセッションを終える。
 *
 * 統合の第一歩 (入口の一本化)。各アプリの中身・連携 (共有ソングモデル app/music/song.js /
 * 共有トランスポート app/music/transport.js) はそのまま。将来ここを本格的な統合 UI へ
 * 発展させる余地を残す。
 *
 * SYNESTA 自身は「窓を持たないメタアプリ」。factory は null を返し (registry の winId は常に
 * null)、開閉状態は isRunning がメンバー窓から導出する。
 */

import {
  wmRegister,
  wmOpenOrFocus,
  wmIsOpenByName,
  wmCloseByName,
} from "../wm/index.js";

const APP_NAME = "SYNESTA";

/**
 * SYNESTA が束ねるメンバーアプリの登録名。配列順 = 起動時に開く順で、後ろほど前面に来る
 * (ROLL を最後に置いて主エディタを最前面にする)。
 */
const MEMBERS = ["OSCILLO", "CHORD", "TRANSPORT", "TRACK", "SYNTH", "ROLL"];

/** セッション (SYNESTA 起動中) か。launch した時点で true、一括終了 or 全窓クローズで false。 */
let _session = false;

/** 一括終了 (closeAll) 実行中フラグ。teardown 中に synestaUpdate の再入判定を止める保険。 */
let _tearingDown = false;

/** メンバーのうち開いているウィンドウ数。 */
function openCount() {
  let n = 0;
  for (const name of MEMBERS) if (wmIsOpenByName(name)) n++;
  return n;
}

/** SYNESTA が起動中か (セッション中 or メンバーが 1 つでも開いている)。
 *  CLOSE 項目の表示・ランチャーのチェック判定に使う。 */
function isRunning() {
  return _session || openCount() > 0;
}

/** SYNESTA を起動する: メンバーを一括で開く (開いているものは最前面へ)。 */
function launch() {
  _session = true;
  for (const name of MEMBERS) wmOpenOrFocus(name);
}

/** SYNESTA を終了する: メンバーを一括で閉じる (各 onBeforeClose を尊重) 。 */
function closeAll() {
  _tearingDown = true;
  for (const name of MEMBERS) wmCloseByName(name);
  _tearingDown = false;
  _session = false;
}

/**
 * 毎フレーム (app.js の update から)。メンバーウィンドウが 1 つでも閉じられたら SYNESTA
 * 全体の終了とみなし、残りも畳む。全窓が閉じ切っていればセッションだけ終える。
 *
 * ポーリングで検出するのは、メンバーの × / CLOSE / タイトルバー操作すべてを 1 か所で拾える
 * ため。ROLL 等が onBeforeClose で破棄確認を出して閉じをキャンセルした場合は winId が残るので
 * 誤発火しない (実際に閉じたときだけ数が減る)。
 */
export function synestaUpdate() {
  if (!_session || _tearingDown) return;
  const n = openCount();
  if (n === 0) {
    _session = false; // 最後の 1 つが閉じられた → セッション終了 (これ以上閉じるものは無い)
    return;
  }
  if (n < MEMBERS.length) closeAll(); // いずれかが閉じられた → 残りも畳む
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// factory は「メンバー一括起動」= launch。ランチャーメニュー (toggleRegistered 経由) は factory を、
// デスクトップアイコン (wmOpenByName 経由) は launch を呼ぶが、どちらも同じ一括起動になる。
// SYNESTA 自身は窓を持たないため factory は null を返す (registry の winId は常に null)。
wmRegister(
  APP_NAME,
  () => {
    launch();
    return null;
  },
  {
    category: "CREATIVE",
    dev: true,
    launch, // アイコン double-click / OPEN / Enter (wmOpenByName) 用
    isRunning, // CLOSE 項目の表示・ランチャーのチェック判定
    onClose: closeAll, // アイコン右クリック CLOSE = メンバー一括終了
  },
);
