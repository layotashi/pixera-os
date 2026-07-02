# app/ — アプリケーション層

各ウィンドウの UI・ロジックを実装するモジュール群。`wm/` にウィンドウを登録し、
`ui/` のウィジェットで操作パネルを構成する。各アプリの詳細は先頭の JSDoc `@module` を参照。

## 構成ルール

- `app/` 直下のファイル = 独立アプリ (`wmRegister` で自己登録し、個別ウィンドウを持つ)。
- `app/studio/` = STUDIO アプリの内部モジュール (ウィンドウ内タブとして動作)。
- 単一ファイルのアプリは直下、複数ファイル構成はサブディレクトリに分離。

## 登録とカテゴリ (SSoT = コード)

各アプリはトップレベルで `wmRegister(name, factory, opts)` を呼んで自己登録する。
`app.js` が全アプリを**副作用インポート**することで、この登録がまとめて走る。
どのアプリが存在し何カテゴリかは、各モジュールの `wmRegister` 呼び出しが唯一の出所
(下のロスターは目安。増減したらコードが正)。

`opts` の主なフラグ:

- `category` — 右クリックランチャの分類。省略時はトップレベル (OS ユーティリティ扱い)。
- `dev: true` — `config.js` の `DEV_MODE` が真のときだけ表示 (未完成・デモ)。
- `hidden: true` — ランチャに出さない (イースターエッグ)。
- `about` — ヘッダ右クリック → ABOUT パネルの説明文 (宣言したアプリのみ)。

- **CREATIVE**
  - `studio/` — 音楽 DAW (dev)
  - `tessera` — 生成的アート言語 Tessera のエディタ + 出力
  - `paint` — 1-bit ピクセルペイント
- **トップレベル** (カテゴリ無し = OS ユーティリティ)
  - `notepad` — テキスト編集
  - `explorer` — VFS マネージャ
  - `capture` — スクショ/動画/GIF 撮影
  - `settings` — パレット/壁紙/解像度/エフェクト
  - `about` — バージョン情報
- **GAMES**
  - `lifegame` — ライフゲーム / `breakout` — ブロック崩し
  - `graze` — 弾幕サバイバル / `delve` — 1-bit ローグライク
- **EXPERIMENT**
  - `band` — 音声反応ビジュアル / `fontsmith` — フォントエディタ
  - `aquarium` / `observatory` — 「映える画面」
  - `telex` — テレタイプ演出 / `oracle` — 隠しテキストアドベンチャー
- **DEMO** (dev) — `easing_demo` / `ascii_art_demo` / `gradient_demo`
  (プリミティブ動作確認)
- **hidden** — `dolphin` (イースターエッグ)

## 非ウィンドウ・システムモジュール

- `app.js` — アプリ層ハブ。全アプリを副作用 import し、
  毎フレームの `update()` / `draw()` を提供
- `game_utils.js` — ゲーム共通ユーティリティ
  (オーバーレイ・シェイク・パーティクル・`registerGameApp` の WM 統合)
- `input_overlay.js` — 入力可視化オーバーレイ (SNS 共有用)。
  `input.js` のイベントログを消費する薄いビューア
- `vram_dump.js` — VRAM ダンプ (開発デバッグ用。BIN/HEX/RLE でクリップボードへ)

## 設計原則

- **登録パターン**: 各ウィンドウは `wmRegister()` で自己登録し、
  `app.js` が副作用 import で読み込む。
- **WM お任せ配置**: `wmOpen(-1, -1, ...)` で座標を指定せず、WM のカスケード配置に委譲する。
- **統合ウィンドウ**: 音楽制作機能は `studio/` に統合し、タブ (INST / PIANO_ROLL) で切替。
- **DI データ提供**: `studio/piano_roll.js` の `tracks` / `setPlayheadPos` は
  `kernel.js` から再生エンジンへ注入される。
