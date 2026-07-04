/**
 * @module core/sfx
 * sfx.js — システム効果音 (SFX) の再生層
 *
 * OS のシステム操作（ウィンドウ開閉・ボタンクリック・ダイアログ表示等）に
 * 紐づく効果音を「鳴らす」責務だけを持つ純粋な core レイヤ。
 * どのイベントで鳴らすか (wm / ui へのフック配線) は上位の
 * `js/system_sfx.js` が担い、この層は playSystemSfx(name) を提供する。
 * これにより core/ → wm/ ui/ の逆方向 import を持たない。
 *
 * ── 設計方針 ──
 *   - 既存の createSfxChannels / playSfx インフラ (core/audio.js) を再利用
 *   - 遅延初期化: 最初の playSystemSfx() 呼び出し時にチャンネルを作成
 *   - 有効/無効切替: setSystemSfxEnabled(bool) で全 SFX を ON/OFF
 *
 * ── SFX イベント一覧 ──
 *   winOpen      ウィンドウオープン
 *   winClose     ウィンドウクローズ
 *   maximize     最大化 / 復帰
 *   dialogOpen   ダイアログ表示 (default variant)
 *   dialogDanger ダイアログ表示 (danger variant)
 *   btnClick     プッシュボタンクリック
 *   toggle       トグルボタン状態変更
 *   menuOpen     メニュー表示
 *   menuSelect   メニュー項目選択
 */

import { createSfxChannels, playSfx } from "./audio.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SFX プリセット定義
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * システム SFX チャンネル定義。
 * 各エントリは createSfxChannels() に渡す形式。
 */
const SFX_DEFS = {
  winOpen: { wave: "tri", adsr: [0, 20, 0, 0], vol: 10 },
  winClose: { wave: "tri", adsr: [0, 20, 0, 0], vol: 10 },
  maximize: { wave: "tri", adsr: [0, 20, 0, 0], vol: 10 },
  dialogOpen: { wave: "tri", adsr: [0, 20, 0, 0], vol: 10 },
  dialogDanger: { wave: "tri", adsr: [0, 20, 0, 0], vol: 10 },
  btnClick: { wave: "tri", adsr: [0, 20, 0, 0], vol: 10 },
  toggle: { wave: "tri", adsr: [0, 20, 0, 0], vol: 10 },
  menuOpen: { wave: "tri", adsr: [0, 20, 0, 0], vol: 10 },
  menuSelect: { wave: "tri", adsr: [0, 20, 0, 0], vol: 10 },
  listSelect: { wave: "tri", adsr: [0, 20, 0, 0], vol: 10 },
};

/**
 * 各 SFX イベントに対応する MIDI ノート番号。
 * 音の高さでイベントの「性格」を表現する。
 */
const SFX_NOTES = {
  winOpen: 72, // C5 — 明るい上昇感
  winClose: 60, // C4 — 落ち着いた下降感
  maximize: 67, // G4
  dialogOpen: 65, // F4
  dialogDanger: 55, // G3 — 低く警告的
  btnClick: 76, // E5 — 軽いクリック
  toggle: 74, // D5
  menuOpen: 69, // A4
  menuSelect: 72, // C5
  listSelect: 72, // C5 — リスト/ドロップダウン選択
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態管理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** SFX チャンネルマップ (遅延初期化) */
let _channels = null;

/** SFX 持続時間マップ (秒単位、_channels と同時に初期化) */
let _durations = null;

/** SFX 有効フラグ */
let _enabled = true;

/**
 * システム SFX の有効/無効を切り替える。
 * @param {boolean} enabled
 */
export function setSystemSfxEnabled(enabled) {
  _enabled = enabled;
}

/**
 * システム SFX が有効かどうかを返す。
 * @returns {boolean}
 */
export function isSystemSfxEnabled() {
  return _enabled;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SFX 再生 (後勝ち debounce)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * SFX チャンネルを遅延初期化する。
 * AudioContext はユーザージェスチャ後に initAudio() で自動作成される。
 */
function _ensureChannels() {
  if (!_channels) {
    _channels = createSfxChannels(SFX_DEFS);
    _durations = {};
    for (const [name, def] of Object.entries(SFX_DEFS)) {
      _durations[name] = (def.dur || 30) / 1000; // ms → 秒
    }
  }
}

/**
 * 同一フレーム内に複数 SFX がトリガーされた場合、最後のものだけを
 * 実際に再生する (後勝ち debounce)。
 * 例: ボタンクリック→ダイアログ表示 で btnClick + winOpen + dialogOpen が
 * 同一フレームで発火するが、実際に鳴るのは dialogOpen だけ。
 */
let _pendingSfx = null;
let _debounceScheduled = false;

function _flushPendingSfx() {
  _debounceScheduled = false;
  if (!_pendingSfx) return;
  const name = _pendingSfx;
  _pendingSfx = null;
  _ensureChannels();
  if (!_channels) return;
  const ch = _channels[name];
  const note = SFX_NOTES[name];
  if (ch && note !== undefined) {
    playSfx(ch, note, _durations[name]);
  }
}

/**
 * 指定されたシステム SFX を再生する。
 * 同一フレーム内で複数回呼ばれた場合、最後の呼び出しのみ再生される。
 *
 * @param {string} name  SFX 名 (SFX_DEFS のキー)
 */
export function playSystemSfx(name) {
  if (!_enabled) return;
  _pendingSfx = name;
  if (!_debounceScheduled) {
    _debounceScheduled = true;
    queueMicrotask(_flushPendingSfx);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  テスト用エクスポート
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @internal テスト用: チャンネルをリセット */
export function _resetSfx() {
  _channels = null;
  _durations = null;
  _enabled = true;
  _pendingSfx = null;
  _debounceScheduled = false;
}

/** @internal テスト用: pending SFX を即座にフラッシュ */
export { _flushPendingSfx };

