/**
 * @module app/music/chord
 * chord.js — 発音中ノート群からの簡易コード推定 (純ロジック)
 *
 * CHORD アプリ (発音中の和音名を表示) が使う純関数。MVP: 代表的な和音をルート位置のインターバル
 * 集合として持ち、発音音のピッチクラス集合に「完全一致」で当てるだけ。存在する各ピッチクラスを
 * ルート候補に見立てて照合するので、転回 (ボイシング) は自然に無視される。
 *
 * 非対応 (将来): 相対度数 (I / VIm7)、分数コード (C/G、D7 on F#)、文脈依存 (ナポリ N6、増六 等)、
 * テンション (9th/11th/13th)、異名同音の使い分け (常にシャープ表記)。まずは単純に。
 */

/** 音名 (シャープ表記)。 */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/**
 * 和音テンプレート (ルートからの半音インターバル → 表記接尾辞)。音数 (集合サイズ) で先に絞るので
 * 順序は本質的でないが、読みやすさのため 4 音 → 3 音 → 2 音の順に並べる。
 */
const CHORD_TEMPLATES = [
  { iv: [0, 4, 7, 10], sfx: "7" }, // ドミナント 7th
  { iv: [0, 4, 7, 11], sfx: "maj7" },
  { iv: [0, 3, 7, 10], sfx: "m7" },
  { iv: [0, 3, 6, 10], sfx: "m7-5" }, // ハーフディミニッシュ
  { iv: [0, 3, 6, 9], sfx: "dim7" },
  { iv: [0, 4, 7, 9], sfx: "6" },
  { iv: [0, 3, 7, 9], sfx: "m6" },
  { iv: [0, 4, 7], sfx: "" }, // メジャー (接尾辞なし)
  { iv: [0, 3, 7], sfx: "m" }, // マイナー
  { iv: [0, 3, 6], sfx: "dim" },
  { iv: [0, 4, 8], sfx: "aug" },
  { iv: [0, 2, 7], sfx: "sus2" },
  { iv: [0, 5, 7], sfx: "sus4" },
  { iv: [0, 7], sfx: "5" }, // パワーコード
];

/** ソート済み半音配列が等しいか。 */
function sameIntervals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 発音中の MIDI ノート群から和音名を推定する (純関数)。
 *   空          → ""
 *   単一ピッチクラス → 音名 (例 "C")
 *   既知テンプレート一致 → ルート音名 + 接尾辞 (例 "Cm7")、転回は無視
 *   どれにも一致しない → 最低音の音名 (ベースの当て推量)
 * @param {number[]} midis MIDI ノート番号
 * @returns {string}
 */
export function estimateChord(midis) {
  if (!midis || !midis.length) return "";
  const pcs = [...new Set(midis.map((m) => ((m % 12) + 12) % 12))].sort((a, b) => a - b);
  const bassPc = ((Math.min(...midis) % 12) + 12) % 12;
  if (pcs.length === 1) return NOTE_NAMES[bassPc]; // 単音 (オクターブ違いの重ねも同じ)

  // 最低音 (ベース) をルートに見立てて一致するテンプレートを最優先で採る。C6 と Am7 のように
  // 同じピッチクラス集合になる和音は、鳴っている最低音でどちらかへ寄せる (分数表記はしない)。
  for (const t of CHORD_TEMPLATES) {
    if (t.iv.length !== pcs.length) continue;
    const iv = pcs.map((pc) => (pc - bassPc + 12) % 12).sort((a, b) => a - b);
    if (sameIntervals(iv, t.iv)) return NOTE_NAMES[bassPc] + t.sfx;
  }
  // ベースがルートでない (転回) 場合は、存在する各ピッチクラスをルート候補に照合して根音を探す。
  for (const t of CHORD_TEMPLATES) {
    if (t.iv.length !== pcs.length) continue;
    for (const root of pcs) {
      const iv = pcs.map((pc) => (pc - root + 12) % 12).sort((a, b) => a - b);
      if (sameIntervals(iv, t.iv)) return NOTE_NAMES[root] + t.sfx;
    }
  }
  return NOTE_NAMES[bassPc]; // 未知の和音は最低音を当て推量として表示
}
