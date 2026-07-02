# assets/ — アセット管理

SYNESTA が使うビジュアルアセット (カーソル・アイコン・フォント) を格納する。

## 構成

```
assets/
  cursors/          カーソル画像 + manifest.json
  icons/            UI アイコン + manifest.json
  icons-text/       テキスト表示用の特殊記号 (中点・改行矢印等) + manifest.json
  app-icons/        デスクトップ用アプリアイコン + manifest.json
  font/             ビットマップフォント PNG (どれを使うかは config.js の FONTS が参照)
  favicon.png       ブラウザタブ用アイコン
```

## manifest 駆動 (SSoT)

各フォルダの `manifest.json` がアセット定義の唯一の出所。JS 側 (`core/cursor.js` /
`icon.js` / `text_icon.js` / `app_icon.js`) はこれを `fetch` し、記載された PNG を動的に読む。

- `format` — そのフォルダ共通の寸法 (`width`/`height`) とエンコーディング。
  **寸法・しきい値の正は manifest**。README には書き写さない。
- 各エントリ — 論理名 → `file` (PNG 名) ＋ `description` (生成 AI 向けの説明文)。
  カーソルは `hotX`/`hotY` (ホットスポット) も持つ。

PNG は明度しきい値で 1-bit 化する。エンコーディングは 2 系統:

- `1bit-white-fg` — 白=前景 / 黒=透過。icons 系。
- `3level` — 白=前景 / 灰=アウトライン / 黒=透過。cursors・app-icons。
  bg→fg の 2 パス描画で任意背景でも視認できる。

正確なしきい値は各 manifest の `format.description` を参照。

## アセット追加手順

1. PNG を該当フォルダに置く (寸法は manifest の `format` に合わせる)
2. `manifest.json` にエントリを追加 (`file` / `description` / カーソルは `hotX`/`hotY`)
3. JS の変更は不要 (manifest 駆動で自動認識される)

## 命名規則

- アイコン名: 描かれるモノ・概念ベース (`arrow-down`, `close`, `note-quarter`)
- カーソル名: 用途ベース・ハイフン区切り (`resize-ew`, `move`)
- ファイル名 = 論理名 + `.png`
