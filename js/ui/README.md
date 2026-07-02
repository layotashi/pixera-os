# ui/ — ウィジェットライブラリ層

OS 風デスクトップの GUI ウィジェット。描画・入力などのプラットフォーム機能は
依存注入 (DI) で外部から受け取るため、`core/` を直接 import せず再利用可能。
外部からは `index.js` ファサード経由でアクセスする。

## 依存

```
ports.js            ← 依存ゼロ (ポート定義。initPorts で外部実装を注入)
ui_constants.js     ← 依存ゼロ
scrollbar.js        → ports.js
layout.js           → ui_constants.js
ui_helpers.js       → ports.js
Widget.js           ← 依存ゼロ
FocusableWidget.js  → Widget.js
widgets/*.js        → Widget/FocusableWidget, ports.js, ui_helpers.js, scrollbar.js
WidgetGroup.js      → ports.js, ui_helpers.js, layout.js
index.js            → 全モジュール (re-export) + initPorts オーケストレーション
```

`core/` への直接依存はゼロ。すべて `ports.js` 経由で、ホストが `initPorts()` で実装を注入する。

## コアモジュール

- `Widget.js` — 全ウィジェットの基底クラス
- `FocusableWidget.js` — フォーカス可能ウィジェットの基底 (`handleKey` 追加)
- `WidgetGroup.js` — Widget 配列の描画・入力・フォーカス・ラジオ排他・
  ポップアップを束ねるオーケストレータ
- `layout.js` — 宣言的レイアウト (Box / HBox / VBox)。gap は `MIN_GAP` にクランプ
- `scrollbar.js` — スクロールバー部品 (ListBox/TreeView/TextArea/ウィンドウが共用)
- `ports.js` — DI ポートレジストリ (gpu/font/icon/input/textIcon/dither)
- `ui_helpers.js` — 共有ユーティリティ
  (focus 管理・キーリピート・ポップアップ描画リスト)
- `ui_constants.js` — 共有定数
  (`FOCUS_MARGIN` / `MIN_GAP` / `GAP`。循環回避のため分離)
- `index.js` — ファサード (public API の re-export + `initPorts`)
- `Dialog.js` — 汎用モーダルダイアログ (Confirm / Prompt / Alert、danger variant)
- `FileDialog.js` — ファイル選択モーダル (Save/Open)。VfsBrowser を内包

## ウィジェット (widgets/)

`Widget` → `FocusableWidget` → `ButtonBase` の OOP 階層。`WidgetGroup` は `instanceof` に
頼らずダックタイピング (`isActive` / `hasPopup` 等) で機能を検出する。

- `PushButton` / `ToggleButton` / `RadioButton`
  — クリック / ON-OFF / ラジオ (ButtonBase 派生)
- `Label` / `SectionLabel` — テキストラベル / 反転バンドの大項目見出し
- `HSep` / `VSep` — 水平・垂直セパレータ
- `TabBar` — 下線スタイルのタブ切替
- `Slider` / `NumberBox` — 水平スライダー / 数値入力 (縦ドラッグ・ホイール)
- `DropDown` / `ListBox` / `TreeView` — 選択系 (ListBox/TreeView はスクロール内蔵)
- `VfsBrowser` — TreeView を VFS 特化させたブラウザ
- `BayerPicker` — ベイヤーパターン選択 (4×4 / 8×8)
- `TextBox` / `TextArea` — 1 行 / 複数行テキスト入力 (矩形選択対応)

スクロール内蔵ウィジェット (ListBox/TreeView/TextArea) の items 差し替え後は、
公開メソッド (`setContentLength` / `scrollToTop` / `ensureVisible`) でスクロール状態を更新する
(内部の `_vScroll` に直接触れない)。

## 使い方 (共通パターン)

```js
initPorts({ gpu, font, icon, input, textIcon, dither }); // ブート時 1 回
const btn = new PushButton(0, 0, "Save", onSave);
const root = VBox([HBox([btn, lbl]), slider]);
root.layout(FOCUS_MARGIN, FOCUS_MARGIN);          // 配置
const group = new WidgetGroup(root.leaves());
group.draw(cr);                                    // 毎フレーム描画
group.update(ev);                                  // 毎フレーム入力
const size = root.measure();                        // リサイズ用サイズ計測
```

## 設計原則

- **クラスベース OOP + ポリモーフィズム**:
  `draw()` / `update()` / `handleKey()` のオーバーライドで固有処理。
- **ステートレス描画**: 毎フレーム全描画 (retained mode ではない)。
- **DI で逆依存回避**: プラットフォーム機能は `initPorts()`、
  `wm` 参照は `WidgetGroup.setWmCallbacks()` で注入。
- **純粋レイアウト**: `layout.js` は座標計算のみ副作用なし。
- **ツールチップは 2 階層**: ウィジェット単位 (`w.tooltip`) と、
  ListBox/TreeView のアイテム単位 (`onItemTooltip` コールバック)。
