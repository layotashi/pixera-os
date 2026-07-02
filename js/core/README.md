# core/ — インフラストラクチャ層

描画・入力・フォント・音声・ストレージなど、プラットフォーム寄りの基盤機能。
他のどのレイヤーからも参照される最下層。各モジュールの詳細は先頭の JSDoc `@module` を参照。

## 依存

`gpu` / `input` / `font` は `config.js` のみに依存。多くのモジュール
(`anim` / `dither` / `field_render` / `storage` / `gif` / `mp4` / `wav` / `pbm` / `audio`)
は外部依存ゼロの純粋モジュール。

## モジュール

**描画・表示**

- `gpu.js` — 1-bit VRAM + 描画プリミティブ (pset/line/rect/blit 等)、
  autoScale、Canvas 転送
- `display_fx.js` — 表示エフェクト (Vignette + Diagonal scanline)、VRAM → RGBA 展開
- `dither.js` — Bayer ordered dithering (RGBA → 1-bit)
- `field_render.js` — スカラー場 (0..1) → 1-bit の共有レンダラ
  (dither/hatch/halftone/braille)
- `ascii_art.js` — ASCII Art 変換 (文字濃淡ハーフトーニング。場 → 文字グリッドも)
- `anim.js` — イージング関数群 + アニメーションユーティリティ

**入力・フォント・スプライト**

- `input.js` — キーボード・マウス状態管理 + セマンティックイベントログ
  (click/drag/dblclick 等)
- `font.js` — ビットマップフォント読み込み・描画・グリフ差し替え
- `cursor.js` — カーソルスプライト (manifest 駆動)
- `icon.js` — UI アイコンスプライト (manifest 駆動)
- `app_icon.js` — デスクトップ用アプリアイコン (manifest 駆動、default フォールバック)
- `text_icon.js` — テキスト表示用の特殊記号 (中点・改行矢印等)

**ストレージ**

- `storage.js` — localStorage ベースの設定永続化
- `vfs.js` — localStorage ベースの仮想ファイルシステム (テキスト/バイナリ)
- `user_fonts.js` — FONTSMITH 製ユーザーフォントの VFS 永続化・登録
- `defaults.js` — 現在の全設定を「出荷時デフォルト」として書き出す
  (config.js へベイクする運用)

**音声・コーデック・書き出し**

- `audio.js` — Web Audio 基盤
  (AudioContext / SynthChannel / SamplePlayer / SFX / 音楽ユーティリティ)
- `sfx.js` — システム効果音マネージャ (ウィンドウ開閉・クリック等のフック)
- `gif.js` — GIF89a エンコーダ (1-bit 特化、LZW)
- `mp4.js` — MP4 (H.264) エンコーダ (WebCodecs + 自前 ISO BMFF コンテナ)
- `wav.js` — WAV (RIFF) コーデック
- `pbm.js` — PBM P1 コーデック
- `art_export.js` — 1-bit アート出力パイプライン (額縁マット + 整数倍 + PNG/GIF/MP4)

## 設計原則

- **プラットフォーム抽象化**: Canvas / DOM / localStorage / Web Audio への直接アクセスはこの層に閉じ込める
- **ステートレス描画**: 描画関数は副作用 (VRAM 書き込み) のみで、UI ロジックを持たない
- **純粋モジュール優先**: 変換・コーデック・数学系は外部依存ゼロで単体テスト可能
