# js/ — アーキテクチャ

PIXERA OS (1-bit の空想レトロ・クリエイティブ OS) を構成する全 JavaScript モジュール。
ビルドツールなしの ES Modules で、`index.html` が `js/kernel.js` を読み込む。

## ドキュメント方針 (SSoT)

このディレクトリ以下のドキュメント・コメントは **概念・アーキテクチャ・設計理由・非自明な
契約** を書く場所。バージョン・寸法・プリセット・パレット・音楽定数・API シグネチャなど
「コードや manifest を見れば分かる可変な事実」は **そちらが唯一の出所** とし、docs には
書き写さない (再掲は必ず陳腐化する)。例: 製品バージョンは `config.js` の `APP_VERSION`、
アセット寸法は各 `manifest.json` の `format`。

## レイヤ構成と依存方向

依存は **上→下** の一方向のみ。循環依存はゼロ。

```
app/  →  wm/  →  ui/  →  core/  →  lang/
  │        │       │        ↑         ↑
  └────────┴───────┴── config.js      │
   │                    audio/ → core/ (UI なし)
   └──────────────── ルート ──────────┘
```

- `core/` — 描画・入力・フォント・音声・ストレージ等のプラットフォーム基盤
- `audio/` — SYNESTA 専用の再生エンジンとトランスポート UI
- `ui/` — OS 風ウィジェットライブラリ (DI で `core` から切り離し、再利用可能)
- `wm/` — OS 風ウィンドウマネージャ・デスクトップ
- `app/` — 各アプリケーションウィンドウ
- ルート — `kernel` (配線) / `config` (定数) / `splash` / `wallpaper` /
  `system_sfx` (システム SFX のフック配線)
- `lang/` — Tessera 生成アート言語 (compile / runtime / surface / format)。
  `app/tessera` `wallpaper` `core/tess_host` が利用する。
  **`lang/` は js/ に依存しない (逆方向 import は禁止)** — 媒体非依存の
  純粋な言語コアとして独立させ、ホスト側 (js/) が解決・描画を担う。

各レイヤのファイル一覧・規約は配下の `README.md` を参照。

## DI (依存注入) — 逆方向参照の解決

レイヤ間の逆方向参照はすべてコールバック注入で解決し、配線は `kernel.js` の `boot()` に集約。
各項目は `注入関数 (方向) — 渡すもの`。

- `initPorts(...)` (core → ui)
  — gpu / font / icon / input / textIcon / dither (ui/ports.js)
- `wmSetUiCallbacks(...)` (ui → wm)
  — flushPopups / hasOpenPopup / hasTextInputFocus / dispatchPopupInput
- `WidgetGroup.setWmCallbacks(...)` (wm → ui)
  — setTooltip / requestCursor
- `transportSetPianoRollCallbacks(...)` (app → audio)
  — getTracks / setPlayheadPos
- `transportSetIsHostFocused(...)` (wm → audio)
  — SYNESTA フォーカス判定 (Space キー制御用)
- `configSetSaveCallback(...)` (core → config)
  — 設定保存ディスパッチャ (storage へ)
- `configSetFontSwitchCallback(...)` (core → config)
  — フォント切替時のグリフ差し替え (font へ)

## 技術スタック

- **言語**: ES Modules (ES2020+)、ビルドツールなし
- **描画**: `Uint8Array` VRAM (1-bit) → `display_fx` で RGBA 展開 → `Canvas putImageData`
- **音声**: Web Audio API (`OscillatorNode` + `GainNode`)
- **書き出し**: GIF89a / WAV / PBM は自前コーデック、MP4 は WebCodecs、動画録画は MediaRecorder
- **永続化**: `localStorage` (設定 + VFS + ユーザーフォント)
- **エントリ**: `index.html` → `<script type="module" src="./js/kernel.js">`

## 規約

- `ui/` と `wm/` は `index.js` ファサード経由でアクセスする。
- 副作用インポート (`import "./xxx.js"`) は `app/app.js` でのウィンドウ登録のみ。
- モジュール先頭の JSDoc `@module` ヘッダーが、その 1 ファイルの役割の SSoT。
