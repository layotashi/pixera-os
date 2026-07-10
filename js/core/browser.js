/**
 * @module core/browser
 * browser.js — ホスト (ブラウザ) 機能の薄いラッパ
 *
 * PIXERA は仮想マシンだが、外部リンクだけは実ブラウザに委譲する。
 * 別タブで開くことで PIXERA のセッション (このタブ) は生かしたままにし、
 * 「マシンから出た」感を最小化する。
 */

/**
 * URL を新しいタブで開く。http/https のみ許可する (それ以外は無視)。
 * @param {string} url
 */
export function openUrl(url) {
  if (typeof url !== "string") return;
  if (!/^https?:\/\//i.test(url)) return;
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    /* ポップアップブロック等は無視 */
  }
}
