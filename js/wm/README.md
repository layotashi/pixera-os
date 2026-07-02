# wm/ — ウィンドウマネージャ層

OS 風のウィンドウシステム。移動・リサイズ・スナップ・タイトルバー・フッター・Z 順・
タスクバー・モーダル・スクロール・階層メニューを担当する。
外部からは `index.js` ファサード経由でアクセスする。

## 依存

```
wm.js      → config.js, core/gpu, core/input, core/cursor, core/icon, core/font,
             ui/ui_constants.js, ui/scrollbar.js
desktop.js → config.js, core/gpu, core/app_icon, core/font, core/input
index.js   → wm.js (re-export のみ)
```

## モジュール

- `wm.js` — ウィンドウシステム本体
  (移動/リサイズ/スナップ/Z順/タスクバー/モーダル/スクロール/階層メニュー)
- `desktop.js` — デスクトップのアイコン管理
  (グリッド配置/選択/ドラッグ/ラッソ/ツールチップ)
- `index.js` — ファサード

ダブルクリック判定・ドラッグ判定の閾値は `core/input.js` のセマンティックイベントログに
一元化されており、wm はそれを消費する。

## アプリへのイベント伝播

ボディ領域のマウス操作は `onInput(ev)` でアプリに伝播する (footer 領域は `onInputFooter`
があればそちらへ、無ければ `onInput` にフォールスルー)。

- 左ボタン: `down` / `held` / `up`
- 中ボタン: `mdown` / `mheld` / `mup`
- 右ボタン: `rdown` / `rheld` / `rup`
- その他: `dblclick` (左ダブルクリック) / `hover` (マウスオーバー) /
  `wheel` (`deltaX/Y`, `ctrl/alt/shift`)

補足:

- 左/中/右系は `ctrl` / `shift` を持つ。全 ev に `localX` / `localY`
  (コンテンツ左上原点) が付く。
- スクロール可能ウィンドウでは `localY` にスクロールオフセットが加算され、
  仮想座標空間が保たれる。
- デスクトップ空白の右クリック → 階層ランチャ
  (`wmRegister` の `opts.category` で構築。`>` で N 階層)。
- ウィンドウヘッダー右クリック → ウィンドウ操作メニュー
  (FIT TO CONTENT / MAXIMIZE / CLOSE / ABOUT)。内部 API
  `openContextMenu(items, x, y)` はアイテム型 `app` / `sub` / `sep` / `action` を扱う。

## ウィンドウオプション (`wmOpen` の opts)

- `modal` — モーダル (他ウィンドウへの入力をブロック)
- `noResize` — リサイズ無効
- `noMaximize` — 最大化無効
- `scrollable` — ウィンドウスクロール有効 (`wmSetContentSize` で仮想高さ設定)。
  最小高さが `MIN_HEIGHT` まで緩和され、初期高さは work area に自動クランプ
- `onBeforeClose` — 閉じる前フック。`false` を返すとキャンセル

## ウィンドウスクロール

仮想コンテンツ高さが物理サイズより大きいとき垂直スクロールバーを自動表示する。

- 通常ホイールは WM が消費、**Ctrl+ホイールはアプリに透過** (ズーム等)。
- `onInput` の `localY` はスクロール加算済み (仮想座標)。
  `contentRect.w` はスクロールバー幅分縮む。
- `scrollable` は「コンテンツ自然サイズ」と「ウィンドウ最小サイズ」を分離する。
  初期は work area の一定比率にクランプ、リサイズ下限は `MIN_HEIGHT` まで緩和
  (幅は水平スクロール非対応のため `onMeasure` 幅で縛る)。
- フォント/パディング変更時は現在の高さを維持 (自然サイズへ勝手に巻き戻さない)。

## 設計原則

- **登録ベース**: アプリは `wmRegister()` で登録し、WM がライフサイクルと座標を
  一元管理する (カスケード配置 + 画面内クランプ)。
- **階層メニュー**: `category` でアプリを分類 (CREATIVE / GAMES / EXPERIMENT / DEMO)。
- **DI で逆依存回避**: `ui` 参照は `wmSetUiCallbacks()` で注入。共有定数
  `FOCUS_MARGIN` は `ui/ui_constants.js` に置き循環を回避。
- **コンテンツ委譲**: 描画・入力は `onDraw` / `onInput` コールバックでアプリに委譲。
- **レイアウトキャッシュ**: `recalcLayout()` は x/y/w/h 変更時のみ。描画時は再計算しない。
