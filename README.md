# SYNESTA

> 1-bit の空想レトロ・クリエイティブ OS — ブラウザ上で動くデスクトップ環境

## 概要

- SYNESTA は、ブラウザ上で動作する **1-bit (2 色) レンダリングの空想レトロマシン**です。
- 歴史的名機のエミュレーションではなく、制約の中でこそ到達できる完璧なデザインを追求した
  **架空のクリエイティブ OS**として、各種機能を同一の 1-bit 美学のもとに統合します。
- Canvas 2D に自作ソフトウェアレンダラで描画し、Web Audio API でチップチューン風の音声合成を行います。

## 起動方法

ビルド不要。ローカルの HTTP サーバーで配信し、ブラウザで `index.html` を開きます。

```bash
python -m http.server 8080   # 例
```

## 技術スタック

- **言語**: Vanilla JavaScript (ES2020+, ES Modules)、ビルドなし
- **レンダリング**: `<canvas>` + `Uint8Array` VRAM (1-bit)
- **音声**: Web Audio API
- **永続化**: `localStorage` (設定 + 仮想ファイルシステム + ユーザーフォント)

## ディレクトリ構成

```
index.html   エントリポイント
js/          全 JavaScript モジュール (アーキテクチャは js/README.md)
assets/      フォント・アイコン・カーソル等のアセット
lang/        Tessera 言語 (生成的アート言語) のコア
docs/        プロダクト・設計ドキュメント
tools/       開発支援スクリプト (visual review harness 等)
```

## ドキュメント

- [docs/PRODUCT_BRIEF.md](docs/PRODUCT_BRIEF.md) — 製品コンセプト・対象ユーザー・設計原則
- [docs/BACKLOG.md](docs/BACKLOG.md) — 今後の機能・アイデア
- [docs/COMMIT_GUIDE.md](docs/COMMIT_GUIDE.md) — コミットメッセージ規約
- [docs/HUMOR_PRINCIPLES.md](docs/HUMOR_PRINCIPLES.md) — ユーモア設計原則
- [js/README.md](js/README.md) — アーキテクチャ (レイヤ構成・依存方向・DI 配線)
- [lang/README.md](lang/README.md) — Tessera 言語
- 各レイヤ (`js/core` `js/ui` `js/wm` `js/app` `js/audio`) の詳細は配下の `README.md`

