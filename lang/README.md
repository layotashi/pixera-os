# lang — SYNESTA Generative Art 言語（作業名: 未定 / 仮 `FIELD`）

SYNESTA 内蔵の、generative art のための小さな言語。**既存 ALGO を書き写すための DSL ではなく**、
作家がコードを「読む・書く」体験そのものを目的に、ゼロベースで設計する。

## 北極星
- **low floor, high ceiling** — p5.js の `setup`/`draw` の入りやすさ＋上級者の高い天井。
- **1-bit ネイティブ** — 「インク＝0..1 のディザ値」一個。色が無いぶん API が細く、入口が低い。
- **決定論** — `seed` で完全再現。コードそのものが作品＝レシピ（共有・画像埋め込みに直結）。
- **世界観の所有** — 構文は親しみやすく（JS/Lua 寄り）、標準ライブラリと名前で世界観を持つ
  （PICO-8 の教訓）。生 JS は晒さない。

## 段階（tier）
- **Tier0 — 一行の場**: `f(x,y,t) = …` （tixy 流）。最低の床。← まず実装中。
- **Tier1 — setup/draw**: p5 流の手続き的描画（`clear/dot/line/circle/ink`）。主役。
- **Tier2 — 場ブロック**: フィードバック＋近傍（`lap`）で反応拡散/CA。高い天井。

## アーキテクチャ（隔離開発 → クリーン統合）
SYNESTA の `js/ui/ports.js` と同じ依存注入の流儀に倣う。言語ランタイムは
**抽象「サーフェス」契約**（`surface.js`）に対して描画し、font/theme/GPU は
**コピーせず契約越しに共有**する。

- 開発ハーネス（playground）: サーフェスを canvas2D の薄いシムで実装。
- SYNESTA 統合時: 本物の GPU を同じ契約に注入し、NOTEPAD/GENART をエディタのホストにする。
- 言語本体（core/stdlib）は SYNESTA アプリを import しない＝描画なしで単体テスト可能。

```
/lang
  README.md          ← これ
  surface.js         ← 抽象サーフェス契約（描画/場の境界）
  core/  lexer parser interp     ← 言語コア（依存ゼロ）
  stdlib.js          ← 場のボキャブラリ（math/noise/…、surface を呼ばない純関数）
  runtime.js         ← ソース文字列 → 場関数 へコンパイル
  smoke.mjs          ← node 動作確認
  playground/        ← ブラウザ開発ハーネス（次段）
```

## 現状
Tier0（式 → 場）の最小スライスを実装し node で検証する段階。構文・セマンティクスは
ここで手触りを確かめながら確定する（まだ仮）。
