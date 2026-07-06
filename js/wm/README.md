# wm/ — ウィンドウマネージャ層

OS 風のウィンドウシステム。移動・リサイズ・スナップ・タイトルバー・フッター・Z 順・
タスクバー・モーダル・スクロール・階層メニューを担当する。
外部からは `index.js` ファサード経由でアクセスする。

## 依存

依存は一方向: `wm.js → {win_layout, menu, tooltip, about, text_wrap} → core/`。
分割モジュールは wm.js を import し返さない (循環なし)。wm 固有の可変状態
(windows / activeIndex / mode / registry / _modalWinId 等) は wm.js が保持し、
分割モジュールへは関数引数と `menuSetDeps` / `aboutSetDeps` 等で注入する。

```
wm.js         → config.js, core/gpu, core/input, core/cursor, core/icon, core/font,
                ui/ui_constants.js, ui/scrollbar.js,
                win_layout.js, menu.js, tooltip.js, about.js
win_layout.js → config.js, core/font, core/icon, ui/scrollbar.js
menu.js       → config.js, core/gpu, core/font, core/icon
tooltip.js    → config.js, core/gpu, core/input, core/font, text_wrap.js
about.js      → core/gpu, core/font, core/dither, text_wrap.js
desktop.js    → config.js, core/gpu, core/app_icon, core/font, core/input
index.js      → wm.js, desktop.js (re-export のみ)
```

## モジュール

- `wm.js` — ウィンドウシステム本体
  (移動/リサイズ/スナップ/Z順/タスクバー/モーダル/スクロール/ヒットテスト/
  入力ディスパッチ/ウィンドウ枠描画/公開 API)
- `win_layout.js` — 枠寸法定数と外寸 ⇄ 内部矩形の算出
  (`recalcLayout` / `calcWindowSize`。HEADER_HEIGHT 等の live binding を供給)
- `menu.js` — 階層メニュー基盤
  (ツリー構築/パネル寸法/描画/ヒットテスト/サブメニュー。deps は `menuSetDeps`)
- `tooltip.js` — ホバーツールチップ (遅延表示 + カーソル追従)
- `about.js` — ウィンドウ ABOUT パネルと ⇄ ボディの dither ディゾルブ遷移
- `text_wrap.js` — 単語折返し (tooltip / about 共用)
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

## フルスクリーン (F11)

スナップ最大化とは別軸の OS 機能。chrome（枠/ヘッダー/footer）ごと消して
全 VRAM をコンテンツにする（背面の窓・デスクトップは描画も入力も停止）。

- `F11` — 最前面ウィンドウをトグル（モーダル表示中は無効）。解除も F11。
- ヘッダー右クリックメニューの FULLSCREEN からも入れる。
- API: `wmSetFullscreen(id, on)` / `wmToggleFullscreen(id)` / `wmIsFullscreen(id)`。
  アプリが独自ショートカット（Esc 等）で解除してもよい。
- snapState は温存されるので、解除すると元の状態（通常 / maximized）に戻る。

## ウィンドウオプション (`wmOpen` の opts)

- `modal` — モーダル (他ウィンドウへの入力をブロック)。標準 chrome は既定 OFF。
- `noResize` — リサイズ無効
- `noMaximize` — 最大化無効
- `chrome` — 標準スクロールバー chrome (縦横バー + ステッパー + コーナー) の明示指定。
  省略時はモーダル以外 ON。→ 「標準スクロールバー chrome」節を参照
- `scrollable` — WM 管理の縦スクロール有効 (`wmSetContentSize` で仮想高さ設定)。
  最小高さが `MIN_HEIGHT` まで緩和され、初期高さは work area に自動クランプ。
  chrome の縦バーが「機能」になる (横は飾りのまま)
- `onBeforeClose` — 閉じる前フック。`false` を返すとキャンセル

## 標準スクロールバー chrome

Pixera 標準 UI: 通常のアプリウィンドウ (モーダル以外) は、スクロール可否に**よらず**
ボディ端に縦スクロールバー・横スクロールバー・ステッパーボタン・交差コーナーを**常時**
表示する。1bit 表現で「ここはウィンドウ」という手掛かりを一貫して与えるのが狙い。

- 実体は `ui/scrollbar.js` の slot API (`drawVScrollbarSlot` / `drawHScrollbarSlot` /
  `drawScrollCorner`)。レイアウトは `win_layout.js` が `scrollbarRect` /
  `hScrollbarRect` / `scrollCornerRect` として算出し、wm.js が描画・入力を一元処理する。
- **飾り / 機能の 2 モード**: 各軸のスクロール状態 (`win._vScroll` / `win._hScroll`) が
  `scrollNeeded=false` なら「飾り」(100% 表示・非操作・ドラッグカーソル無し)、
  `true` なら「機能」(サム・ドラッグ・ステッパー・オートリピート)。既定は飾り
  (`createScrollState(1,1)`)。`scrollable` (WM 管理縦) や `wmAttachScroll` で機能化する。
- **コンテンツ領域は縮まない**: chrome の分だけウィンドウ外寸を SLOT 広げる
  (`calcWindowSize` / `wmOpen`)。既存アプリは `contentRect` に描くだけで自動対応する。
- ステッパー 1 クリックの量は `wmAttachScroll` の `vStep` / `hStep` (既定 px、行/桁
  単位のアプリは 1)。

### WM 管理の縦スクロール (`scrollable`)

仮想コンテンツ高さが物理サイズより大きいとき、縦バーが機能化してスクロールする。

- 通常ホイールは WM が消費、**Ctrl+ホイールはアプリに透過** (ズーム等)。
- `onInput` の `localY` はスクロール加算済み (仮想座標)。
- `scrollable` は「コンテンツ自然サイズ」と「ウィンドウ最小サイズ」を分離する。
  初期は work area の一定比率にクランプ、リサイズ下限は `MIN_HEIGHT` まで緩和
  (幅は水平スクロール非対応のため `onMeasure` 幅で縛る)。
- フォント/パディング変更時は現在の高さを維持 (自然サイズへ勝手に巻き戻さない)。

### アプリ管理のスクロール (`wmAttachScroll`)

自前のスクロール (行・桁単位など) を持つアプリ (例: NOTEPAD) は、その `ScrollState` を
`wmAttachScroll(id, { v, h, vStep, hStep })` で chrome の縦横バーへ接続する。WM は表示・
ドラッグ・ステッパーのみを担い、viewport / content 同期・ホイール・座標変換はアプリ側
(`_scrollable=false` のため WM が触れない) が担う。

## 設計原則

- **登録ベース**: アプリは `wmRegister()` で登録し、WM がライフサイクルと座標を
  一元管理する (カスケード配置 + 画面内クランプ)。
- **階層メニュー**: `category` でアプリを分類 (CREATIVE / GAMES / EXPERIMENT / DEMO)。
- **DI で逆依存回避**: `ui` 参照は `wmSetUiCallbacks()` で注入。共有定数
  `FOCUS_MARGIN` は `ui/ui_constants.js` に置き循環を回避。
- **コンテンツ委譲**: 描画・入力は `onDraw` / `onInput` コールバックでアプリに委譲。
- **レイアウトキャッシュ**: `recalcLayout()` は x/y/w/h 変更時のみ。描画時は再計算しない。
