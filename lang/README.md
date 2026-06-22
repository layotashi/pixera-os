# lang — generative-art の小さな言語（名称未定）

アート / CG / 数学のクリエイターのための、小さなクリエイティブ・コーディング言語。
**SYNESTA とは独立した別プロジェクト**（OSS 公開もあり得る）。SYNESTA は数あるホスト／
サーフェスの一つにすぎず、言語コアは SYNESTA を一切 import しない。

## 北極星
- **low floor, high ceiling** — tixy / p5.js のような入りやすさ＋上級者の高い天井。
- **慣習・正確さ優先の命名** — GLSL / Processing / 数学の伝統に従い、造語を避ける
  （`mix` `clamp` `fract` `smoothstep` `point` `line` `stroke` `dist` `noise` …）。
  世界観・詩情は判断材料にしない。対象読者にとって最小の驚きを最優先。
- **値域非依存** — 関数は素直な値を返す（`sin` は [-1,1]）。0..1 への正規化や 1-bit 化など
  **表示の都合はサーフェスの責務**で、言語コアは持ち込まない。
- **決定論** — `seed` で完全再現。コードそのものが作品＝レシピ。

## 段階（tier）
- **Tier0 — 場(field)**: 裸の式 `f(x,y,t)` を全セルで評価（`f(x,y,t) =` ヘッダは任意）。✅
- **Tier1 — 描画(draw)**: `draw { … }` で手続き的に描く。`repeat` / `point` / `line` /
  `stroke` / `clear`。座標 [0,1]、自動クリアなし。✅
- **Tier2 — 状態を持つ場**: `field { init / step / show }`。`laplacian()` 等の近傍参照で
  反応拡散・CA・成長系。⬜ 次に実装。

形は `draw {}` / `field {}` の有無で自動判別（裸の式＝Tier0）。式コアは全 tier で共有。

## アーキテクチャ（隔離開発 → クリーン統合）
言語ランタイムは抽象「サーフェス」契約（`surface.js`）に対してのみ描画する。
ホスト（playground / SYNESTA / 任意）が契約を実装して注入する。

- 開発ハーネス（playground）: サーフェスを canvas2D の薄いシムで実装。
- SYNESTA 統合時: 本物の GPU を同じ契約に注入（このサーフェスが 0..1 → 1-bit ディザに落とす）。
- 言語本体（core/stdlib/runtime）はホストを import しない＝描画なしで単体テスト可能。

```
/lang
  README.md          ← これ
  surface.js         ← 抽象サーフェス契約（描画/場の境界） + ディザヘルパ
  core/  lexer parser interp     ← 言語コア（依存ゼロ）
  stdlib.js          ← 関数ボキャブラリ（純関数。surface 非依存）
  runtime.js         ← ソース → 場/描画 へコンパイル（形を自動判別）
  smoke.mjs          ← node 動作確認
  playground/        ← ブラウザ開発ハーネス（エディタ + ライブプレビュー）
```

## 現状
Tier0（場）+ Tier1（描画）を実装・コミット済み。命名を GLSL/Processing 慣習へ統一する
監査を実施。次は Tier2（状態を持つ場）。言語名は未定（慣習尊重の精神で別途決める）。
