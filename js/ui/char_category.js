/**
 * @module ui/char_category
 * char_category.js — 文字カテゴリ判定 (単語境界ナビゲーション用の純関数)。
 *
 * word / space / punctuation の 3 分類。TextBox / TextArea / TextEditModel の
 * Ctrl+←→ 等の単語ジャンプが共有する。Ports/GPU 非依存＝純粋なので、純モデル
 * (text_edit_model) からも安全に import できる (ui_helpers は Ports を引くため
 * 直接 import すると純度が崩れる。ここへ切り出して ui_helpers は再 export する)。
 */

export const CAT_WORD = 0;
export const CAT_SPACE = 1;
export const CAT_PUNCT = 2;

/** 文字のカテゴリを返す (word / space / punctuation) */
export function charCat(ch) {
  if (ch === " " || ch === "\t") return CAT_SPACE;
  if (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_"
  )
    return CAT_WORD;
  return CAT_PUNCT;
}
