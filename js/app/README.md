# app/ — アプリケーション層

各ウィンドウの UI・ロジックを実装するアプリケーションモジュール群です。
`wm/` にウィンドウを登録し、`ui/` のウィジェットを使って操作パネルを構成します。

## ディレクトリ構成

```
app/
  app.js              ← ハブ (各ウィンドウの副作用 import + update/draw)
  about.js            ← ABOUT ダイアログ
  breakout.js         ← BREAKOUT ウィンドウ (ブロック崩し)
  capture.js          ← CAPTURE ウィンドウ (スクリーンキャプチャ + 動画撮影 + GIF ループ)
  easing_demo.js      ← EASING_DEMO ウィンドウ (イージングカーブ デモ)
  explorer.js         ← EXPLORER ウィンドウ (ファイルマネージャ)
  game_utils.js       ← ゲームアプリ共通ユーティリティ
  tessera.js          ← TESSERA ウィンドウ (1-bit 生成的アート言語＋出力。旧 GENART を統合)
  gradient_demo.js    ← GRAD_DEMO ウィンドウ (bayerGradRect デモ)
  ascii_art_demo.js   ← AA_DEMO ウィンドウ (ASCII Art 変換デモ)
  graze.js            ← GRAZE ウィンドウ (弾幕サバイバル)
  input_overlay.js    ← 入力可視化オーバーレイ (SNS共有用)
  lifegame.js         ← LIFE_GAME ウィンドウ (Conway's Game of Life)
  notepad.js          ← NOTEPAD ウィンドウ
  paint.js            ← PAINT ウィンドウ (1bit ピクセルペイント)
  settings.js         ← SETTINGS ウィンドウ
  vram_dump.js        ← VRAM ダンプ (開発・デバッグ用)
  studio/             ← STUDIO ウィンドウ (複数ファイル構成)
    studio.js          ← ウィンドウ本体 (Transport + タブ切替)
    synth_panel.js     ← INST タブ (シンセサイザ UI)
    piano_roll.js      ← PIANO_ROLL タブ (シーケンサー)
```

**ルール:**

- `app/` 直下のファイル = 独立アプリ（`wmRegister` で自己登録し、個別ウィンドウを持つ）
- `app/studio/` = STUDIO アプリの内部モジュール（STUDIO ウィンドウ内のタブとして動作）

## 依存関係

```
app.js → config, core/, wm/, wallpaper, capture, input_overlay, vram_dump, audio/transport
         + 副作用 import: settings, notepad, lifegame, paint, gradient_demo, easing_demo,
                          ascii_art_demo, about, breakout, graze, tessera, explorer, studio/studio

studio/studio.js → audio/transport, studio/synth_panel, studio/piano_roll, wm/, ui/

各アプリ → config, core/, wm/, ui/, audio/ (必要に応じて)
```

**副作用インポート**: ウィンドウの登録 (`wmRegister`) は各モジュールのトップレベルで行われるため、`app.js` が副作用インポートで読み込みます。

## モジュール一覧

### app.js — アプリケーションハブ (~73 行)

全アプリウィンドウの副作用インポートと、毎フレームの `update()` / `draw()` を提供します。

**主要 API:**

- `update()` — Transport 更新 + スクリーンショットタイマー + 録画タイマー
- `draw()` — 壁紙 → ウィンドウ → カーソル → オーバーレイ → flush → 録画フレームコピー → スクショの描画順序制御

### studio/studio.js — STUDIO ウィンドウ (~440 行)

音楽制作関連機能を統合した単一ウィンドウです。
Transport (常時表示) + タブ切替 (INST / PIANO_ROLL) + EXPORT WAV で構成されます。

**構成:**

- Transport セクション — 再生/停止/BPM/ループ制御 (audio/transport.js に委譲)
- タブバー — ラジオボタンによる INST / PIANO_ROLL 切替 + EXPORT WAV ボタン
- タブコンテンツ — 選択中タブの描画・入力を委譲

**WAV Export:**

- EXPORT WAV ボタン → FileDialog (Save) でパス選択
- `renderToBuffer()` でループ範囲をオフラインレンダリング (PCM)
- `encodeWav()` で WAV エンコード → `writeFileBinary()` で VFS に保存
- デフォルト保存先: /Music、デフォルトファイル名: export.wav

**閉じる/リセット:**

- 閉じるとき再生中なら即停止
- 未保存データ (ノートあり) があれば確認モーダルダイアログを表示
- 閉じた場合は全サブシステムの状態をリセット (再度開くと新規状態)

### studio/piano_roll.js — ピアノロールエディタ (~1100 行)

STUDIO ウィンドウ内の PIANO_ROLL タブとして動作するシーケンサーエディタです。

**機能:**

- グリッド描画 (小節/拍/ステップ)
- ノートの追加・削除・ドラッグ移動・リサイズ
- 範囲選択 (矩形ラバーバンド)
- クリップボード (Cut/Copy/Paste)
- Undo/Redo (履歴スタック)
- 再生ヘッド表示
- トラック切替 + チャンネル管理

**主要 API:**

- `tracks` — トラックデータ配列 (playback_engine に DI 注入される)
- `setPlayheadPos(step)` — 再生ヘッド位置更新 (playback_engine に DI 注入される)
- `drawPianoRoll(cr)` — 描画 (studio.js から呼ばれる)
- `onPianoRollInput(ev)` — 入力処理 (studio.js から呼ばれる)
- `resetPianoRoll()` — 全状態リセット (ノート・選択・スクロール等)

### studio/synth_panel.js — シンセサイザ UI (~560 行)

STUDIO ウィンドウ内の INST タブとして動作する波形選択・ADSR・音量コントロール UI です。
現在は synth デバイスのみ実装。将来 sampler 等のデバイスが追加され、トラックごとにデバイスを選択する構成となる予定。

**機能:**

- 波形切替 (SAW/TRI/SQ/SINE/NOISE)
- ADSR スライダー
- 音量スライダー
- PC キーボードマッピング (Z=C4, S=C#4, X=D4...)
- 波形サンプル表示

**主要 API:**

- `drawSynth(cr)` — 描画 (studio.js から呼ばれる)
- `onSynthInput(ev)` — 入力処理 (studio.js から呼ばれる)
- `measureSynth()` — コンテンツサイズ測定 (studio.js から呼ばれる)
- `resetSynth()` — 全状態リセット (波形・ADSR・音量等のデフォルト復元)

### explorer.js — ファイルエクスプローラ (~400 行)

仮想ファイルシステム (VFS) の内容をツリー表示し、ファイル/フォルダの基本操作を提供するファイルマネージャです。

**構成:**

- ツールバー — New File / New Folder / Rename / Delete ボタン
- TreeView — フォルダ構造をツリー表示 (展開/折りたたみ対応)
- Rename モーダル — 名前変更時に独立モーダルウィンドウを表示 (NAME ラベル + TextBox + OK/CANCEL)
- footer — 選択中アイテムのパス・サイズ情報

**キーボードショートカット:**

| キー   | 動作                                 |
| ------ | ------------------------------------ |
| ↑↓     | 選択移動                             |
| ←→     | 折りたたみ / 展開                    |
| Enter  | フォルダ展開 / ファイル起動 (未実装) |
| Delete | 選択アイテム削除                     |
| F2     | リネーム (モーダルダイアログ)        |

**主要コールバック:**

- `onDraw(cr)` — ツールバー + ツリー描画
- `onInput(ev)` — ウィジェット更新 + キーボードショートカット
- `onMeasure()` — コンテンツサイズ計測
- `onDrawFooter(fr)` — フッター描画 (パス情報 + サイズ)

### lifegame.js — ライフゲームウィンドウ (~320 行)

Conway's Game of Life のシミュレーションウィンドウです。
可変サイズのグリッド上でセルを編集・実行できます。
ツールバーはアイコンボタン (play/pause, dice, trash) で構成されています。

**機能:**

- 再生/一時停止トグル (play ↔ pause, 6 フレーム/ステップ)
- ランダム配置 (dice アイコン, 25% 密度)
- グリッド全消去 (trash アイコン)
- グリッドサイズ変更 (W: 8–128, H: 8–96)
- セルサイズ変更 (4–32 px)
- セルのクリック/ドラッグ編集
- トーラス境界 + ダブルバッファリング
- ステータスバー (世代数・生存セル数・グリッドサイズ)

**主要コールバック:**

- `onDraw(cr)` — ツールバー + グリッド + ステータスバー描画
- `onInput(ev)` — ウィジェット更新 + セル編集
- `onMeasure()` — コンテンツサイズ計測
- `onBeforeClose()` — シミュレーション停止 + 全状態リセット (再度開くと初期状態)

### settings.js — 設定ウィンドウ (~400 行)

パレット・壁紙・解像度・入力オーバーレイの設定 UI です。

**機能:**

- パレット切替・カスタムパレット RGB 編集
- 壁紙切替 (Solid / VFS 画像)
- Solid 背景: Bayer 行列モード 4×4/8×8切替 + 階調ピッカー
- Image 背景: FileDialog で VFS から PBM ファイルを選択
- 解像度変更
- 入力オーバーレイ ON/OFF トグル

### capture.js — スクリーンキャプチャ + 動画撮影 + GIF ループ (~900 行)

即時撮影・タイマー撮影・個別ウィンドウ撮影に対応。スクリーンショット・動画録画・ GIF ループすべてが TARGET ドロップダウンで選択したウィンドウを対象にできます。

**スクリーンショット機能:**

- フルスクリーン / 個別ウィンドウ対象
- スケール X1/X2/X4/X8
- ディレイ 0〜10秒
- PNG ダウンロード

**動画撮影機能:**

- 対象: Full screen / 個別ウィンドウ (TARGET 選択)
- 形式: MP4 (H.264) 優先、WebM (VP9) フォールバック
- 音声: core/audio.js の limiter 出力を MediaStreamDestination 経由で取得
- スケール X1/X2/X4/X8 (Nearest-neighbor)
- ディレイ設定共有 (スクリーンショットと同じ Delay 値を使用)
- 経過時間表示 + 自動ダウンロード

**GIF ループ撮影機能:**

- VRAM フレームを指定 FPS (10/12/15) で蓄積し、自前 GIF89a エンコーダで出力
- 対象: Full screen / 個別ウィンドウ (TARGET 選択)
- 撮影時間: 1〜10 秒 (デフォルト 3 秒)
- 2 色パレット固定でピクセルパーフェクトな GIF を生成 (圧縮アーティファクトなし)
- スケール / ディレイ設定をスクリーンショット・動画と共有
- 無限ループ (Netscape Application Extension)
- 時間経過で自動停止 + エンコード + ダウンロード

**安全機構:**

- 動画録画と GIF ループは排他的に動作 (GPU キャプチャバッファ共有のため)
- ウィンドウ単体録画中にリサイズを検出した場合は自動停止 (収録済みデータは保存)
- `_isContinuousRecordingBusy()` で動画/GIF の全録画状態を一元判定

**主要 API:**

- `updateScreenshotTimer()` — スクリーンショットタイマーカウントダウン更新
- `drawScreenshotOverlay()` — スクリーンショットタイマーオーバーレイ描画
- `executePendingScreenshot()` — スクリーンショット撮影実行
- `updateRecordingTimer()` — 録画カウントダウン + 経過時間更新
- `drawRecordingOverlay()` — 録画カウントダウンオーバーレイ描画
- `commitRecording()` — 録画開始 + 毎フレームのオフスクリーン canvas コピー
- `updateGifTimer()` — GIF カウントダウン + 撮影時間監視
- `drawGifOverlay()` — GIF カウントダウンオーバーレイ描画
- `commitGifRecording()` — GIF 録画開始 + FPS 間隔で VRAM スナップショット蓄積

### notepad.js — メモ帳ウィンドウ (~145 行)

`TextArea` ベースのシンプルなテキスト編集パネルです。
将来的な live coding 機能の基盤として配置されています。

### paint.js — ペイントウィンドウ (~1050 行)

1bit (2色) ピクセルペイントツールです。
独自のキャンバスバッファ (128×96) を保持し、各種描画ツールで編集します。

**ツール:**

| 略語 | ツール      | 説明                                                   |
| ---- | ----------- | ------------------------------------------------------ |
| PEN  | Pencil      | フリーハンド描画 (前景色)                              |
| ERS  | Eraser      | フリーハンド消去 (背景色)                              |
| LIN  | Line        | ドラッグで直線 (リアルタイムプレビュー付き)            |
| RCT  | Rectangle   | 矩形 (枚/塗り切替, プレビュー付き)                     |
| CIR  | Circle      | 円 (枚/塗り切替, プレビュー付き)                       |
| FIL  | Flood Fill  | 4方向フラッドフィル                                    |
| INV  | Invert Rect | 矩形範囲反転 (プレビュー付き)                          |
| SPT  | Color Pick  | スポイト (色取得 → PEN/ERS 自動切替)                   |
| SEL  | Select      | 矩形選択 → ドラッグ移動 / Ctrl+ドラッグ複製 / Del 削除 |

**その他機能:**

- Undo/Redo (Ctrl+Z / Ctrl+Y, 最大20ステップ)
- Ctrl+A 全選択
- ブラシサイズ 1–7px
- 枚線/塗りつぶしトグル (OL/FL)
- マーチングアンツ (選択範囲アニメーション)
- フッター: カーソル座標 / キャンバスサイズ / 現在ツール

**主要コールバック:**

- `onDraw(cr)` — サイドバー + キャンバス + プレビュー + 選択オーバーレイ描画
- `onInput(ev)` — ウィジェット更新 + ツール別入力処理
- `onMeasure()` — コンテンツサイズ計測
- `onBeforeClose()` — 全状態リセット

### gradient_demo.js — グラデーションデモウィンドウ (~95 行)

`bayerGradRect` 描画プリミティブの動作検証用デモパネルです。
水平・垂直グラデーションを4×4 / 8×8 Bayer行列で並べて表示します。
開発確認後に削除予定。

### game_utils.js — ゲームアプリ共通ユーティリティ (~256 行)

ゲームアプリで繰り返し実装されるパターンを一元化し、コード重複を排除するユーティリティ集です。

**提供する機能:**

- `textWidth(str)` — テキストのピクセル幅計算
- `centerTextX(ox, areaW, str)` — テキスト中央揃え X 座標計算
- `drawOverlay(ox, oy, w, h, lines)` — ダイアログ風オーバーレイ描画
- `drawPauseOverlay(ox, oy, w, h)` — ポーズオーバーレイ描画
- `calcShake(shakeT, state, suppress)` — 画面シェイク計算 (結果画面では抑制)
- `createSfxChannels(defs)` — SFX チャンネル一括初期化
- `playSfx(ch, midiNote)` — ワンショット SFX 再生
- `tickParticles(parts, gravity, friction)` — パーティクル更新ループ
- `registerGameApp(config)` — WM 統合パターン (登録・描画・入力・フッター・クローズを定型化)

### breakout.js — BREAKOUT ウィンドウ (~1140 行)

Catch & Aim・スマッシュ・パワーアップ・コンボチェイン・ブロック降下を備えた拡張ブロック崩しです。
`game_utils.js` の `registerGameApp` で WM 統合。

**特徴的なメカニクス:**

- CATCH & AIM — 長押しでボールをキャッチ、照準線で狙って発射
- SMASH — パドルバウンス直前 5F にクリックで貫通ファイアボール化
- POWER-UPS — M (マルチボール), W (ワイド), F (ファイア), S (スロー), + (1UP)
- COMBO CHAIN — パドル非接触の連続破壊でコンボ加算
- ADVANCING BLOCKS — 一定間隔でブロック群が降下

### graze.js — GRAZE ウィンドウ (~840 行)

マウス操作の弾幕サバイバルです。
弾をギリギリで避ける「グレイズ」でスコア倍率が跳ね上がるリスク＝リターン設計。
`game_utils.js` の `registerGameApp` で WM 統合。

**特徴的なメカニクス:**

- グレイズ — 弾とのニアミスでスコア倍率上昇
- ボム — 左クリックで全弾消去 (限定 3 発)
- ウェーブ制 — 段階的に難易度上昇
- フォーカスモード — 弾が近いと当たり判定 (1×1) を可視化
- 残像・シェイク・反転エフェクト

### tessera.js — TESSERA ウィンドウ

SYNESTA 唯一の generative-art アプリ。1-bit 前提の小言語 **Tessera**（`lang/`、拡張子 `.tess`）で
コードを書き、右でライブプレビューしながら作品を作る。旧 GENART（プリセット＋ノブのノーコード）は
廃止し、その算法を `.tess` サンプル（学習用 `/Sketches/Learn` ＋ 作例 `/Sketches/Gallery`）へ、
出力パイプラインを本アプリへ移設・一本化した。

**できること:**

- Tier0 場 `f(x,y,t)` / 値ブロック、Tier1 `draw{}`、Tier2 状態場 `field{}`（反応拡散・CA）。
- **設定はすべてコードの設定ディレクティブ**で宣言: `canvas:` `pad:` `fps:` `seed:` `period:` `view:`（pixel は 8 固定＝廃止）。
  表示方式（dither/ascii/hatch/halftone/braille ＝ 1-bit で映える「面」系）は `view:` で指定。画面のコントロールは
  「書き出し形式 + DL」のみ＝最小。プレビューは `canvas:` のアスペクト比を反映。
- 出力: コード宣言の `size` ちょうどに PNG・GIF・MP4 を書き出し（Ctrl+E / DL）。合成・符号化は共有
  `core/art_export.js`、場 → 1-bit は `core/field_render.js` / `core/ascii_art.js`。
- ショートカット: Ctrl+E 書き出し / Ctrl+R シード振り直し（`seed:` をコード内で更新）/ Shift+Alt+F 整形 /
  Ctrl+S 保存。VFS 連携（`.tess` 保存/読込、EXPLORER から開く）。

### easing_demo.js — イージングデモウィンドウ (~290 行)

`core/anim.js` のイージング関数群の動作確認用デモパネルです。
全 25 種のイージングカーブをミニグラフで一覧表示し、選択したカーブの
拡大グラフとリアルタイムアニメーションプレビューを表示します。
開発確認後に削除予定。

**機能:**

- ミニグラフ一覧 (5×5 グリッド) — クリックで選択
- ドロップダウンによるカーブ選択
- 拡大グラフ (80×80 px) — 対角線ガイド (linear 参照線) 付き
- ボールアニメーション — 選択カーブで往復運動
- 進行度バー + t/v 値のリアルタイム表示
- REPLAY ボタンでアニメーション再開

### ascii_art_demo.js — AA_DEMO ウィンドウ (~340 行)

`core/ascii_art.js` の動作確認用デモパネルです。
合成テストパターンを ASCII Art に変換し、文字濃淡の結果をリアルタイムプレビューします。
開発確認後に削除予定。

**構成:**

- ツールバー: パターン選択 DropDown, INV (反転) トグル, GAMMA スライダー,
  W/H サイズ指定 NumberBox
- 中央: ASCII Art プレビューエリア (枠線付き)
- 下部: Tone Ramp 表示 (複数行折り返し)
- Footer: 現在の ASCII Art サイズ (cols×rows CHARS)

**テストパターン:**

- H-GRAD — 水平グラデーション (左:黒 → 右:白)
- V-GRAD — 垂直グラデーション (上:黒 → 下:白)
- RADIAL — 放射グラデーション (中心:白 → 外:黒)
- CHECKER — チェッカーパターン (24×24 セル)
- SPHERE — 擬似 3D 球体 (ランバート反射モデル)

### vram_dump.js — VRAM ダンプ (開発・デバッグ用) (~400 行)

VRAM の表示内容をテキスト (BIN: 0/1 行列 / HEX: 16進数 / RLE: Run-Length Encoding) として
ホスト OS のクリップボードにコピーする開発者向けデバッグ機能です。
ウィンドウを持たないシステムオーバーレイとして動作します。

**操作フロー:**

| 操作               | 動作                           |
| ------------------ | ------------------------------ |
| Ctrl+Shift+D       | ダンプモード (BIN) 開始        |
| H (モード中)       | HEX モードに切替               |
| B (モード中)       | BIN モードに切替               |
| R (モード中)       | RLE モードに切替               |
| ウィンドウクリック | ウィンドウ領域をダンプ・コピー |
| Enter              | 全画面をダンプ・コピー         |
| Esc                | キャンセル                     |

**出力フォーマット:**

- BIN: 0/1 の行列 (1行 = VRAM 1行)
- HEX: 4px = 1 nibble (16進数), MSB が左端
- RLE: 同一値の連続を `N*V` 形式で圧縮 (カンマ区切り, 1行 = VRAM 1行)
- ヘッダ行に解像度・ウィンドウ位置・フォーマットを記載

**主要 API:**

- `updateVramDump()` — ダンプモード入力処理 (kernel.js から呼ばれる)
- `isVramDumpActive()` — ダンプモード中かのフラグ
- `drawVramDumpOverlay()` — モード表示バー / コピー完了フラッシュの描画

### input_overlay.js — 入力可視化オーバーレイ (~290 行)

SNS 共有用に、ユーザーのキーボード・マウス操作をテキストとして
VRAM 画面の右下に表示するオーバーレイです。
ウィンドウ等のアプリではなく、メインループに直接統合されるシステムオーバーレイです。

**表示対象:**

| カテゴリ       | 表示例                                     |
| -------------- | ------------------------------------------ |
| キーボード     | `A`, `SPACE`, `ENTER`, `CTRL+Z`, `SHIFT+A` |
| 印字記号       | `!`, `@`, `:` (Shift+キーは文字を直接表示) |
| 左クリック     | `L-CLICK`, `CTRL+L-CLICK`                  |
| 右クリック     | `R-CLICK`                                  |
| 中クリック     | `M-CLICK`                                  |
| ダブルクリック | `DBL-CLICK`                                |
| ドラッグ       | `L-DRAG`, `R-DRAG`, `M-DRAG`               |
| ホイール       | `WHEEL UP`, `WHEEL DN`, `CTRL+WHEEL UP`    |

**仕様:**

- 表記: 大文字, `+` 区切り
- 位置: 右下 (MARGIN 4px), 左揃え
- 余白: テキスト周囲 4px, 行間 2px
- 持続: リリース後 120 フレーム (≈2秒 @60fps)
- 最大 4 行同時表示
- 背景色で塗りつぶし + 前景色テキスト
- ドラッグ開始時に先行クリックエントリを自動除去
- ブラウザショートカット抑止は input.js に一元化済み

**アーキテクチャ:**

- input.js の `getInputLog()` を毎フレーム消費する薄いログビューア
- キーラベル生成・ドラッグ判定・ダブルクリック判定は全て input.js 側で実行
- 本モジュール自体は DOM イベントリスナを持たない

**主要 API:**

- `updateInputOverlay()` — 毎フレームの入力ログ消費・エントリ更新
- `drawInputOverlay()` — VRAM へのオーバーレイ描画

## 設計原則

- **登録パターン**: 各ウィンドウは `wmRegister()` でトップレベルに自己登録 (`opts.category` でメニューカテゴリを指定可能)
- **副作用インポート集約**: `app.js` が全ウィンドウモジュールを import (登録トリガー)
- **WM お任せ配置**: 各ウィンドウは `wmOpen(-1, -1, ...)` で座標指定せず WM のカスケード配置に委譲
- **統合ウィンドウ**: 音楽制作機能は `studio/` に統合し、タブで切替
- **ウィジェット合成**: `ui/` のファクトリ関数でウィジェットを生成し、`onUpdate` / `onDraw` で制御
- **DI データ提供**: `studio/piano_roll.js` の `tracks` / `setPlayheadPos` は `kernel.js` から再生エンジンへ注入
- **構成ルール**: 単一ファイルのアプリは `app/` 直下に配置、複数ファイル構成のアプリはサブディレクトリに分離

