# wm/ — ウィンドウマネージャ層

OS 風のウィンドウシステムを提供します。  
ウィンドウの移動・リサイズ・スナップ・タイトルバー・フッター・Z 順管理を担当します。

## 依存関係

```
wm.js → config.js, core/gpu, core/input, core/cursor, core/icon,
         core/font, ui/ui_constants.js, ui/scrollbar.js
desktop.js → config.js, core/gpu, core/app_icon, core/font, core/input
index.js → wm.js (re-export のみ)
```

**利用方法**: 外部からは `index.js` ファサードを通じてアクセスしてください。

```js
import { wmRegister, wmOpen, wmCalcWindowSize } from "../wm/index.js";
```

## モジュール一覧

### wm.js — ウィンドウマネージャ本体 (~2100 行)

**ウィンドウシステム機能:**

- ドラッグによる移動・リサイズ
- 画面端スナップ (左半分/右半分/最大化)
- タイトルバー (タイトル + 閉じるボタン)
- フッター (ステータス行 + `onInputFooter` で入力ルーティング)
- Z 順管理 (フォーカスで最前面へ)
- タスクバー (開いているウィンドウの切替)
- モーダルダイアログ (入力ブロック・最前面固定)
- About ダイアログ (モーダルウィンドウとして表示)
- カスケード自動配置 (x=-1 でレトロ OS 風の右下オフセット)
- 画面内クランプ (ウィンドウが画面外に出ないよう補正)
- ウィンドウスクロール (仮想コンテンツ領域のスクロールバー)
- ツールチップ表示
- カーソル切替 (リサイズ方向に応じて)

**input.js 連携 (Phase 2 統合):**

ダブルクリック判定とドラッグ判定を `core/input.js` のセマンティックイベントログに委譲しています。

| 機能               | input.js API                   | wm.js の追加チェック                               |
| ------------------ | ------------------------------ | -------------------------------------------------- |
| ダブルクリック     | `hasInputEvent('dblclick', 0)` | `lastXxxClickWin === target` (同一ウィンドウ判定)  |
| ウィンドウ移動開始 | `isDragging(0)`                | `mode === "move-pending"` (ヘッダークリック後のみ) |

以前は `DOUBLE_CLICK_MS=400` / `MOVE_DEAD_ZONE=3` を独自に持っていましたが、
現在はこれらの閾値は `input.js` で一元管理されています。

**アプリへのイベント伝播:**

ボディ領域でのマウス操作は `onInput(ev)` コールバックでアプリに伝播されます。
footer 領域にマウスがある場合、`onInputFooter` が設定されていれば
footer ローカル座標でそちらに伝播されます (設定がなければ `onInput` にフォールスルー)。

| ev.type    | トリガー         | 追加プロパティ                             |
| ---------- | ---------------- | ------------------------------------------ |
| `down`     | 左ボタン押下     | `ctrl`, `shift`                            |
| `held`     | 左ボタン保持     | `ctrl`, `shift`                            |
| `up`       | 左ボタン開放     | `ctrl`, `shift`                            |
| `dblclick` | 左ダブルクリック | `ctrl`, `shift`                            |
| `mdown`    | 中ボタン押下     | `ctrl`, `shift`                            |
| `mheld`    | 中ボタン保持     | `ctrl`, `shift`                            |
| `mup`      | 中ボタン開放     | `ctrl`, `shift`                            |
| `rdown`    | 右ボタン押下     | `ctrl`, `shift`                            |
| `rheld`    | 右ボタン保持     | `ctrl`, `shift`                            |
| `rup`      | 右ボタン開放     | `ctrl`, `shift`                            |
| `hover`    | マウスオーバー   | —                                          |
| `wheel`    | ホイール         | `deltaX`, `deltaY`, `ctrl`, `alt`, `shift` |

全イベントに共通: `localX`, `localY` (コンテンツ領域左上原点のローカル座標)
スクロール可能ウィンドウでは `localY` にスクロールオフセットが加算され、仮想座標空間が保たれます。

デスクトップ (ウィンドウ外) での右クリックは階層メニュー表示に使用されます。
`wmRegister()` の `opts.category` で指定したカテゴリに基づきサブメニューを構築します
(`">"` 区切りで N 階層対応。省略時はトップレベルに表示)。

ウィンドウヘッダー右クリックでウィンドウコンテキストメニュー (FIT TO CONTENT / MAXIMIZE-RESTORE / CLOSE) が表示されます。
内部 API `openContextMenu(items, x, y)` は将来のアイコン右クリックメニュー (BACKLOG 参照) 等でも再利用可能。
メニューアイテム型は `app` / `sub` / `sep` に加えて `action` (任意コールバック) をサポートします。

**レイアウト定数:**

- `HEADER_H` — ウィンドウヘッダー高さ (ES Module live binding; パディング変更時に自動更新)
- `CONTENT_PAD` — コンテンツ領域のパディング (ES Module live binding; パディング変更時に自動更新)
- `FOOTER_H` — フッター高さ

**ウィンドウオプション:**

`wmOpen()` の第 9 引数でウィンドウの振る舞いを制御できます。

| オプション      | 型              | 説明                                                             |
| --------------- | --------------- | ---------------------------------------------------------------- |
| `modal`         | `boolean`       | モーダルウィンドウ (他ウィンドウへの入力をブロック)              |
| `noResize`      | `boolean`       | リサイズ無効                                                     |
| `noMaximize`    | `boolean`       | 最大化無効 (アイコン非表示)                                      |
| `scrollable`    | `boolean`       | ウィンドウスクロール有効 (`wmSetContentSize` で仮想サイズを設定)。最小高さが `MIN_HEIGHT` まで緩和され、初期高さは work area に自動クランプされる |
| `onBeforeClose` | `() => boolean` | 閉じる前のフック。`false` を返すとキャンセル                     |

**DI:**

- `wmSetUiCallbacks({ flushPopups, hasOpenPopup, hasTextInputFocus })` — UI 層からのポップアップ・フォーカス機能を注入

**主要 API:**

- `wmRegister(name, factory, opts)` — ウィンドウ登録 (`opts.category` で階層メニューに配置。`">"` 区切りで N 階層対応)
- `wmOpen(x, y, w, h, title, ...)` / `wmClose(id)` — 開閉 (x=-1 でカスケード配置、w=0 で自動サイズ)
- `wmCalcWindowSize(cw, ch, footer)` — コンテンツサイズからウィンドウ外寸を算出
- `wmOpenByName(name)` / `wmOpenOrFocus(name)` — 名前指定で開くか最前面に移動
- `wmGetContentRect(id)` — コンテンツ領域の矩形取得 (ID 指定)
- `wmGetWindowList()` — 登録ウィンドウ一覧
- `wmGetWindowRect(id)` — ウィンドウ全体の矩形
- `wmIsFocused(id)` / `wmFocus(id)` — フォーカス管理
- `wmIsModalOpen()` — モーダルダイアログが開いているか判定
- `wmSetContentSize(id, virtualH)` — スクロール可能ウィンドウの仮想コンテンツ高さ設定
- `wmGetScroll(id)` — 現在のスクロール位置取得
- `wmUpdate()` — 全ウィンドウの入力処理
- `wmDraw()` — 全ウィンドウの描画
- `wmDrawSingleWindow(id)` — 単体描画 (スクリーンショット用)
- `wmRequestCursor(name)` — カーソル変更要求
- `wmSetTooltip(text)` — ツールチップ表示
- `wmSetWorkAreaTop(y)` — ワークエリア上端 (タスクバー等の高さ分)

### index.js — ファサード (~55 行)

`wm.js` の全パブリック API を re-export するエントリポイントです。

### desktop.js — デスクトップアイコン管理 (~850 行)

壁紙上にアプリアイコンをグリッド配置し、ダブルクリックでアプリを起動する。
wm.js から呼び出されるサブモジュール。  
全アイコンは app_icon.js の 3-level スプライト (18×18) で描画され、
専用アイコンが無いアプリには "default" アイコンが自動適用される。

**主要機能:**

- **グリッドレイアウト**: CELL_W × CELL_H のグリッドにアイコンを列優先で自動配置
- **選択**: クリック / Ctrl+Click (トグル追加) / Ctrl+A (全選択)
- **ドラッグ移動**: 選択中アイコンを一括ドラッグ (グリッドスナップ、衝突時交換)
- **ラッソ選択**: デスクトップ空白をドラッグすると marching ants 風の選択矩形が表示され、矩形内のアイコンが選択される
- **ツールチップ**: アイコンホバー時にアプリ名ツールチップを表示

**主要 API:**

- `desktopSetIcons(entries)` — 表示するアイコン一覧を設定
- `desktopSetWorkAreaTop(y)` — workArea 上端を設定
- `desktopHandleInput(mx, my, openByName)` — 左クリック時の入力処理
- `desktopHandleHover(mx, my)` — ホバー / ツールチップ処理
- `desktopUpdate(mx, my)` — フレーム更新 (ドラッグ・ラッソ・Ctrl+A)
- `desktopDraw()` — アイコン描画 + ドロップ枠 + マーチングアンツ
- `desktopIsDragging()` — ドラッグ/ラッソ中判定 (wm.js がウィンドウ操作と競合防止)
- `desktopBlur()` — デスクトップフォーカス解除
- `desktopSetTooltipCallback(fn)` — ツールチップコールバック注入

## ウィンドウスクロール

ウィンドウの仮想コンテンツ領域が物理サイズより大きい場合に、垂直スクロールバーを自動表示します。
`scrollbar.js` の高レベル API (`drawVScrollbarSlot` / `vScrollbarSlotThumbArea`) を使用し、
スロットの描画仕様 (sep + dark margin + thumb) は `scrollbar.js` にカプセル化されています。

**使い方:**

```js
// 1. scrollable オプションを指定してウィンドウを開く
const id = wmOpen(-1, 0, 200, 150, "My App", onDraw, onInput, null, {
  scrollable: true,
});

// 2. 仮想コンテンツ高さを設定 (contentRect.h より大きいとスクロール可能になる)
wmSetContentSize(id, 500); // 仮想高さ 500px

// 3. onDraw で contentRect.y を使って描画 (スクロール分は WM が自動オフセット)
function onDraw(cr) {
  // cr.y はスクロール分ずらされている → cr.y + widgetY で自然に描画
  group.draw(cr);
}
```

**動作:**

- 通常のホイール操作は WM が消費し、ウィンドウスクロールに使用
- **Ctrl+ホイールはアプリに透過** (ズーム等の用途)
- スクロールバーのクリック・ドラッグも WM が処理
- `onInput` の `localY` にはスクロールオフセットが加算済み (仮想座標)
- `contentRect.w` はスクロールバー幅分だけ縮小される

**サイズ制御:**

`scrollable` ウィンドウは「コンテンツの自然サイズ」と「ウィンドウの最小サイズ」を分離して扱います。

- **初期高さ**: `wmOpen` で `h=0` 指定時、自然サイズが work area を超える場合は work area の 85% (`SCROLL_INIT_RATIO`) に自動クランプされ、上下対称な中央に配置されます (画面圧迫の緩和 + 開いた瞬間にスクロールバーが出る)。同じ計算はヘッダー右クリック → FIT TO CONTENT でも適用されます。
- **リサイズ下限**: 縦方向の最小高さは `MIN_HEIGHT` (枠 + ヘッダー + 区切り + ボディ最小 4px) まで緩和されます。コンテンツより小さくしてもスクロールで吸収できるため。幅は水平スクロール非対応のため引き続き `onMeasure` の幅で縛られます。
- **フォント/パディング変更時**: `scrollable` ウィンドウは現在の `h` を維持します (自然サイズに自動復元すると、ユーザーが選んだサイズが勝手に巻き戻る違和感が出るため)。幅は広がった分だけ追従します。

## フッター入力ルーティング

`onInputFooter` コールバックが設定されているウィンドウでは、footer 領域 (区切り線以下)
でのマウスイベントが `onInputFooter` に footer ローカル座標で伝播されます。
`onInputFooter` が未設定の場合は従来どおり `onInput` にフォールスルーします。

```js
wmOpen(-1, -1, 0, 0, "App", onDraw, onInput, onMeasure, {
  footer: true,
  onDrawFooter,
  onInputFooter: (ev) => {
    /* footer ローカル座標でのイベント */
  },
});
```

## レイアウト計算ヘルパー

`wmCalcWindowSize(cw, ch, footer)` でコンテンツサイズからウィンドウ外寸を算出できます。
ウィンドウ配置やダイアログのセンタリングに使用してください。

```js
import { wmCalcWindowSize } from "../wm/index.js";
const { w, h } = wmCalcWindowSize(contentW, contentH);
```

## 設計原則

- **登録ベース**: アプリは `wmRegister()` でウィンドウを登録、wm がライフサイクル管理
- **階層メニュー**: `category` オプションでアプリをカテゴリ分類 (CREATIVE / GAMES / DEMO 等)
- **WM 主導の配置**: ウィンドウ座標は WM が一元管理 (カスケード自動配置 + 画面内クランプ)
- **DI で逆依存回避**: `ui` への参照は `wmSetUiCallbacks()` で注入
- **共有定数の分離**: `FOCUS_MARGIN` は `ui/ui_constants.js` に配置し循環を回避
- **コンテンツ委譲**: `onDraw` / `onUpdate` コールバックでアプリに描画・入力を委譲
- **レイアウトキャッシュ**: `recalcLayout()` は x/y/w/h 変更時のみ呼び出し、描画時は再計算しない
- **スナップ保護**: パディング変更時の `recalcAllWindows` はスナップ中ウィンドウのサイズを維持

