# core/ — インフラストラクチャ層

SYNESTA の描画・入力・ストレージなど、プラットフォーム寄りの基盤機能を提供します。  
他のどのレイヤーからも参照される最下層モジュールです。

## 依存関係

```
core/ は config.js のみに依存 (gpu.js, input.js, font.js)
anim.js, dither.js, storage.js, cursor.js, icon.js, audio.js は外部依存ゼロ
```

## モジュール一覧

### gpu.js — 描画エンジン (~665 行)

1-bit VRAM (`Uint8Array`) を管理し、すべての描画プリミティブを提供します。  
2 色パレットは `Uint32Array` LUT で保持し、`putImageData` で Canvas に転送されます。  
`autoScale()` でブラウザウィンドウに収まる最大整数倍を自動算出し、Canvas の CSS サイズを設定します。

**主要 API:**

- `initGpu(canvas)` — Canvas と VRAM を初期化
- `pset(x, y, c)` / `pget(x, y)` — ピクセル単位の読み書き
- `drawRect` / `fillRect` / `drawRoundRect` / `fillRoundRect` — 矩形描画
- `drawLine` / `drawCircle` / `fillCircle` — 線分・円描画
- `drawCheckerboard(x, y, w, h, c, phase)` — 市松模様パターン
- `bayerGradRect(x, y, w, h, d0, d1, dir, matrix)` — Bayerディザグラデーション矩形
- `hline` / `vline` — 水平・垂直ライン (高速)
- `blit(src, sw, sh, dx, dy)` / `blitXor(...)` — ビットマップ転送
- `setClip` / `resetClip` — クリッピング領域 (トップレベル)
- `pushClip` / `popClip` — クリップスタック (ネスト対応)
- `beginCapture` / `endCapture` — スクリーンショット用バッファ切替
- `endCaptureRaw()` — 生 1-bit バッファでキャプチャ終了 (GIF フレーム用・軽量)
- `flush()` — VRAM → Canvas へ最終転送

### input.js — 入力管理 (~700 行)

キーボード・マウスの状態をフレーム単位で追跡し、セマンティックイベントログを生成します。

**ポーリング API (既存):**

- `initInput(canvas)` — イベントリスナー登録
- `keyHeld(key)` / `keyDown(key)` — キー状態
- `mouseX` / `mouseY` / `mouseButtonHeld(n)` / `mouseButtonDown(n)` / `mouseButtonUp(n)` — マウス状態 (n: 0=左, 1=中, 2=右)
- `wheelX` / `wheelY` / `wheelHasCtrl` / `wheelHasAlt` / `wheelHasShift` — ホイール・修飾キー
- `getCharQueue()` — テキスト入力キュー
- `getPasteText()` — クリップボードペースト取得
- `resetInput()` — フレーム末のリセット

**セマンティックイベントログ API (Phase 1 新規):**

- `updateInputLog()` — 毎フレーム呼出。DOM バッファとポーリング状態からイベントログを構築
- `getInputLog()` — そのフレームのイベントログ `InputEvent[]` を返す
- `isDragging(btn)` — 指定ボタンでドラッグ中か
- `getDragStart(btn)` — ドラッグ開始座標 `{x, y}` (ドラッグ中でなければ null)
- `hasInputEvent(type, btn?)` — 指定タイプのイベントがログにあるか

**InputEvent 型:**

| type         | label 例      | 説明                            |
| ------------ | ------------- | ------------------------------- |
| `key-down`   | `CTRL+Z`, `!` | キー押下                        |
| `key-up`     | `A`           | キーリリース                    |
| `key-held`   | `A`           | キーリピート                    |
| `click`      | `L-CLICK`     | マウスクリック                  |
| `dblclick`   | `DBL-CLICK`   | ダブルクリック (400ms 閾値)     |
| `drag-start` | `L-DRAG`      | ドラッグ開始 (3px デッドゾーン) |
| `drag`       | `L-DRAG`      | ドラッグ継続                    |
| `drag-end`   | `L-DRAG`      | ドラッグ終了                    |
| `btn-up`     | `L-CLICK`     | ボタンリリース (非ドラッグ)     |
| `wheel`      | `WHEEL UP`    | ホイール                        |

**キーラベル生成:**

- 印字可能記号は `e.key` をそのまま使用 (例: `!`, `@`, `:`)
- 英字は `SHIFT+A` 形式
- 修飾キーは `e.ctrlKey` / `e.shiftKey` / `e.altKey` を直接参照

**ブラウザショートカット抑止:**

- Ctrl+key / Alt+key のデフォルト動作を一元的に `preventDefault` で抑止
- F5 (リロード)、F12 / Ctrl+Shift+I/J (DevTools) は常に通過

### font.js — ビットマップフォント

`assets/font/` 以下のフォント PNG シートから固定幅 ASCII フォントを読み込み、テキスト描画を提供します。
`switchFont()` で実行時にフォントを動的に切り替えることができます。

**主要 API:**

- `GLYPH_W` / `GLYPH_H` — 現在のグリフサイズ (`export let`、フォント切替で更新)
- `initFont(url, gw, gh, cols)` — フォント PNG の非同期読み込み (初期化用)
- `switchFont(url, gw, gh, cols, offset)` — フォントの動的切替
- `getGlyph(ch)` — 指定文字のグリフビットマップ取得 (ascii_art.js 等で使用)
- `drawChar(x, y, ch, c)` — 1 文字描画
- `drawText(x, y, str, c)` — 文字列描画
- `textWidth(s)` — 文字列の描画幅を算出

### cursor.js — カーソル管理 (~170 行)

`assets/cursors/manifest.json` に基づき個別 PNG からカーソルを読み込みます。  
マニフェストにホットスポット座標・説明文を含みます。

**主要 API:**

- `initCursor()` — マニフェスト + 個別 PNG の非同期読み込み
- `setCursor(name)` — アクティブカーソル変更
- `getCursor()` — 現在のカーソル名
- `drawCursor(x, y)` — カーソル描画

### app_icon.js — デスクトップ用アプリアイコン管理 (~140 行)

`assets/app-icons/manifest.json` に基づき個別 PNG (18×18) からデスクトップアイコンを
読み込みます。cursor.js と同じ 3-level エンコーディング (白=前景、灰=アウトライン、
黒=透過) を採用し、bg→fg の 2 パス描画でどんな背景でも視認可能です。  
要求されたアイコン名が未登録の場合は `"default"` アイコンにフォールバックします。

**主要 API:**

- `APP_ICON_W` / `APP_ICON_H` — アイコンサイズ定数 (18×18)
- `initAppIcon()` — マニフェスト + 個別 PNG の非同期読み込み
- `drawAppIcon(name, x, y)` — 名前指定でアイコン描画 (2 パス)

### icon.js — アイコン管理 (~120 行)

`assets/icons/manifest.json` に基づき個別 PNG から 7×7 アイコンを読み込みます。  
マニフェストにアイコン名・ファイル名・説明文を含みます。

**主要 API:**

- `ICON_W` / `ICON_H` — アイコンサイズ定数
- `initIcon()` — マニフェスト + 個別 PNG の非同期読み込み
- `drawIcon(name, x, y, c)` — 名前指定でアイコン描画

### text_icon.js — テキスト用アイコン (~110 行)

`assets/icons-text/manifest.json` に基づき個別 PNG から  
スペース中点・改行矢印など、テキスト表示用の特殊記号を描画します。  
フォントと同サイズ (`GLYPH_W × GLYPH_H`) で統一されています。

**主要 API:**

- `TEXT_ICON_W` / `TEXT_ICON_H` — サイズ定数
- `initTextIcon()` — マニフェスト + 個別 PNG の非同期読み込み
- `drawTextIcon(name, x, y, c)` — テキストアイコン描画

### storage.js — 設定永続化 (~120 行)

`localStorage` をラップし、設定値の保存・読み込み API を提供します。  
外部依存ゼロの純粋モジュールです。

**主要 API:**

- `save(key, value)` / `load(key, fallback)` — 汎用 save/load
- `savePalette` / `loadPalette` — パレット設定
- `saveSolidLevel` / `loadSolidLevel` — Solid 階調レベル
- `saveSolidBayerMode` / `loadSolidBayerMode` — Solid Bayer 行列モード ("4x4" | "8x8")
- `saveBgMode` / `loadBgMode` — 背景モード ("solid" | "image")
- `saveBgImagePath` / `loadBgImagePath` — 壁紙画像の VFS パス
- `saveResolution` — 解像度保存
- `saveCustomPalette` / `loadCustomPalette` — カスタムパレット RGB

### anim.js — イージング関数群・アニメーションユーティリティ (~300 行)

UI アニメーション全般で使えるイージング関数と補助ユーティリティを提供します。
Robert Penner のイージング方程式をベースに、正規化シグネチャ `(t) → t'` で統一。
外部依存ゼロの純粋数学モジュールです。

**イージング関数 (10 ファミリー × In/Out/InOut = 25 種 + linear):**

| ファミリー | In              | Out              | InOut              | 特徴                 |
| ---------- | --------------- | ---------------- | ------------------ | -------------------- |
| Quad       | `easeInQuad`    | `easeOutQuad`    | `easeInOutQuad`    | t² — 汎用            |
| Cubic      | `easeInCubic`   | `easeOutCubic`   | `easeInOutCubic`   | t³ — やや強い加速    |
| Quart      | `easeInQuart`   | `easeOutQuart`   | `easeInOutQuart`   | t⁴ — 強い加速        |
| Sine       | `easeInSine`    | `easeOutSine`    | `easeInOutSine`    | 正弦波 — 自然な動き  |
| Expo       | `easeInExpo`    | `easeOutExpo`    | `easeInOutExpo`    | 指数 — 急激な変化    |
| Back       | `easeInBack`    | `easeOutBack`    | `easeInOutBack`    | オーバーシュート付き |
| Elastic    | `easeInElastic` | `easeOutElastic` | `easeInOutElastic` | 弾性振動             |
| Bounce     | `easeInBounce`  | `easeOutBounce`  | `easeInOutBounce`  | バウンド             |

**ユーティリティ:**

- `clamp01(t)` — 0–1 クランプ
- `lerp(a, b, t)` — 線形補間
- `normalizeTime(elapsed, duration)` — 経過時間 → 0–1 進行度
- `stepped(easeFn, steps)` — イージングを N 段階に離散化 (レトロ演出用)

**辞書:**

- `easings` — 全イージング関数を名前で引ける `Record<string, Function>`
- `easingNames` — イージング関数名の配列

### dither.js — ディザリングエンジン (~200 行)

Bayer ordered dithering アルゴリズムで RGBA 画像データを 1-bit 配列に変換します。  
外部依存ゼロの純粋モジュールです。

**主要 API:**

- `BAYER_4x4` — 4×4 ベイヤー行列定数 (整数 0–15)
- `BAYER_8x8` — 8×8 ベイヤー行列定数 (整数 0–63)
- `ditherRGBA(rgba, w, h, out)` — RGBA → 1-bit 変換
- `setDitherMode(m)` / `getDitherMode()` — ディザモード設定
- `setPreprocessParams(p)` / `getPreprocessParams()` — 前処理パラメータ

### ascii_art.js — ASCII Art 変換エンジン (~270 行)

文字グリフの塗り面積率 (density) に基づき、RGBA 画像データを文字の濃淡で表現する ASCII Art に変換します。  
`dither.js` と対をなす、もう一つの 1-bit 画像表現手法です。  
Tone-based ASCII Art — ラインプリンタ時代 (1960s–) から続く古典的アルゴリズム。  
`font.js` の `getGlyph()` に依存し、グリフデータから density を自動算出します。

**主要 API:**

- `calcDensity(glyph)` — グリフビットマップの density 算出
- `buildToneRamp(chars?)` — 指定文字(または全ASCII)から density ランプを構築
- `getDefaultRamp()` — デフォルト tone ramp 取得 (キャッシュ付き)
- `clearRampCache()` — キャッシュクリア (フォント切替時用)
- `getRampString(ramp)` — ランプを文字列として取得 (表示・デバッグ用)
- `calcAsciiSize(srcW, srcH, maxCols, maxRows)` — アスペクト比維持のサイズ算出
- `findNearest(ramp, density)` — 二分探索で最近傍文字を取得
- `asciiRGBA(rgba, srcW, srcH, cols, rows, opts?)` — RGBA → ASCII Art 文字グリッド変換
- `drawAsciiArt(lines, x, y, c)` — 文字グリッドを VRAM に描画
- `CELL_W` / `CELL_H` — 文字セルピッチ定数 (6×8 px)

### gif.js — GIF89a エンコーダ (1-bit 特化) (~260 行)

SYNESTA の 1-bit VRAM データから GIF89a アニメーションを生成します。  
2 色固定パレットに特化しており、LZW 圧縮を含む全工程をゼロ依存で実装しています。  
外部依存ゼロの純粋モジュールです。

**主要 API:**

- `lzwEncode(pixels, minCodeSize)` — LZW 圧縮 (サブブロック形式で出力)
- `encodeGif(frames, width, height, bgRgb, fgRgb, fps, scale)` — 複数フレームから GIF89a Blob を生成

**特徴:**

- 2 色パレット固定 (ピクセルパーフェクト、圧縮アーティファクトなし)
- Netscape Application Extension による無限ループ
- 整数倍ニアレストネイバー拡大対応

### art_export.js — 1-bit アート出力パイプライン (~130 行)

「art 解像度の 1-bit バッファ → 額縁マット付き base 合成 → 整数 ×scale 拡大 → PNG/GIF/MP4 保存」を
アプリ非依存に集約します（旧 GENART のインライン compose/encode を抽出・一般化）。サイズモデルと
フレーム捕捉はアプリ（TESSERA）側、合成・符号化・ダウンロードはここ。`field_render.js`（場 → 1-bit）の
出力段にあたる共有モジュールです。

**主要 API:**

- `composeMatte(artBuf, artW, artH, baseW, baseH)` — art を base 中央へ配置（周囲 0＝額縁）
- `resampleNN(src, sw, sh, dw, dh)` — NN 再標本化（cells のキャップ格子 → art 解像度）
- `downloadPng(baseBuf, baseW, baseH, scale, invert, filename)` — PNG 書き出し
- `exportVideo(frames, baseW, baseH, scale, invert, fps, format, filename, onStatus)` — GIF/MP4 書き出し
- `isMp4Supported()` — WebCodecs 対応判定（mp4.js を再 export）

### audio.js — オーディオ基盤 (~900 行)

Web Audio API の AudioContext・マスター信号チェーン・録画用ストリームを一元管理し、  
`SynthChannel` クラスで per-channel 音声合成、`SamplePlayer` クラスで PCM サンプル再生を提供します。  
`gpu.js` が描画基盤であるように、`audio.js` は音声基盤です。

**初期化・コンテキスト:**

- `initAudio()` — AudioContext 生成 + マスター信号チェーン構築
- `getAudioContext()` — AudioContext 取得
- `getMasterGain()` — マスターゲインノード取得
- `getAudioStream()` — 録画用音声 MediaStream 取得 (limiter 出力)

**SynthChannel クラス:**

- `SynthChannel` — モノフォニック・シンセチャンネル (波形・ADSR・音量・位相を保持)
- `noteOn(freq, time, vel)` / `noteOff(time)` — ノートオン/オフ
- `scheduleVoice(freq, onTime, offTime)` — タイムドボイススケジュール
- `stopAllScheduled()` — スケジュール済み全ボイス停止
- `setWaveform(type)` / `cycleWaveform()` — 波形切替
- `setADSR(a, d, s, r)` — エンベロープ設定
- `setVolume(v)` — 音量設定
- `getWaveformSamples(n)` — 波形サンプル取得 (表示用)

**チャンネル管理:**

- `getDefaultChannel()` / `createChannel()` — チャンネル取得/生成
- `resetDefaultChannel()` — デフォルトチャンネルのリセット

**SFX ヘルパー (シンセ):**

- `createSfxChannels(defs)` — 定義辞書から SFX チャンネルマップを一括生成
- `playSfx(ch, midiNote)` — ワンショット SFX 再生

**SamplePlayer クラス (PCM サンプル再生):**

- `SamplePlayer(buffer?, volume?)` — AudioBuffer ワンショット再生プレイヤー
- `play(playbackRate?, time?)` — サンプル再生 (ポリフォニック、同時発音数制限付き)
- `stop()` — 全アクティブボイスを停止
- `setBuffer(buf)` / `getBuffer()` / `hasBuffer()` — バッファ管理
- `setVolume(v)` / `getVolume()` — 音量設定
- `setMaxVoices(n)` — 最大同時発音数設定
- `activeVoiceCount` — 現在のアクティブボイス数 (getter)

**サンプル再生ヘルパー:**

- `decodeAudioBuffer(arrayBuffer)` — ArrayBuffer (WAV 等) → AudioBuffer に非同期デコード
- `playSample(player, playbackRate?)` — SamplePlayer でワンショット再生 (null 安全)

\*\*音楽ユーティリティ:

- `NOTE_NAMES` — 音名配列 (`["C", "C#", "D", ...]`)
- `midiToFreq(midiNote)` — MIDI ノート番号 → 周波数 (Hz)
- `midiToNoteName(midiNote)` — MIDI ノート番号 → 音名文字列

**波形:**

- `WAVEFORM_LIST` — 波形名リスト (`["saw", "tri", "sq50", ...]`)
- `sampleWaveformFn(wf, t)` — 波形の 1 サンプル計算 (プレビュー/バッファ共用)

### pbm.js — PBM P1 コーデック (~70 行)

Netpbm PBM P1 (ASCII) 形式のエンコード・デコードを提供します。  
Paint アプリのファイル保存や壁紙画像の読み込みで共有されるビットマップ交換形式です。  
外部依存ゼロの純粋モジュールです。

**主要 API:**

- `encodePBM(buf, w, h)` — Uint8Array (1px=1byte) → PBM P1 文字列
- `decodePBM(text)` — PBM P1 文字列 → `{ w, h, buf }` (失敗時 null)

### wav.js — WAV (RIFF) コーデック (~260 行)

PCM 音声データの WAV エンコード・デコードをゼロ依存で提供します。  
`gif.js` が 1-bit 画像の GIF エンコードを担うように、`wav.js` は音声データの WAV 入出力を担います。  
STUDIO の WAV エクスポート、VFS 上の WAV ファイル読み込み、システム SFX のカスタムサウンド等で使用されます。  
外部依存ゼロの純粋モジュールです。

**主要 API:**

- `encodeWav(samples, sampleRate, bitDepth?)` — Float32Array (or [L, R]) → WAV ArrayBuffer
- `decodeWav(arrayBuffer)` — WAV ArrayBuffer → `{ samples, sampleRate, channels, bitDepth, duration }`

**対応フォーマット:**

- モノラル / ステレオ
- 8-bit unsigned PCM / 16-bit signed PCM

### vfs.js — 仮想ファイルシステム (~600 行)

`localStorage` をバッキングストアとするツリー構造のファイルシステムです。  
Explorer・FileDialog・Notepad・Paint 等のアプリが VFS を介してデータを永続化します。  
テキストファイルに加え、バイナリファイル (Base64 エンコード) もサポートします。

**主要 API:**

- `initVfs()` — 初回起動時にデフォルトツリー (/Desktop, /Documents, /Pictures/Wallpapers, /Music) を生成。旧構成(/Images・/TESSERA)からは move で移行
- `readFile(path)` / `writeFile(path, content)` — テキストファイル読み書き (バイナリファイルには null を返す)
- `readFileBinary(path)` / `writeFileBinary(path, arrayBuffer)` — バイナリファイル読み書き (ArrayBuffer ↔ Base64)
- `isBinaryFile(path)` — バイナリファイル判定
- `stat(path)` — ノード情報取得 (バイナリは実バイトサイズ + `encoding: "base64"`)
- `readDir(path)` — ディレクトリ内容一覧
- `mkdir(path)` — ディレクトリ作成
- `remove(path)` / `removeRecursive(path)` — ノード削除
- `rename(path, newName)` — リネーム
- `move(srcPath, destPath)` — ノード移動
- `flattenTree(expandedMap)` — ツリーのフラット化 (TreeView 向け)
- `parentPath(p)` / `basename(p)` / `joinPath(base, name)` — パスユーティリティ

**ノード構造:**

- テキスト: `{ type: "file", name, content: "...", createdAt, modifiedAt }`
- バイナリ: `{ type: "file", name, content: "<base64>", encoding: "base64", createdAt, modifiedAt }`
- ディレクトリ: `{ type: "dir", name, children: [], createdAt, modifiedAt }`

## 設計原則

- **プラットフォーム抽象化**: Canvas / DOM / localStorage / Web Audio API への直接アクセスはこの層に閉じ込める
- **ステートレス API**: 描画関数は副作用 (VRAM 書き込み) のみで、UI ロジックは持たない
- **外部依存ゼロ**: `dither.js`, `storage.js`, `audio.js` は他の core モジュールにも依存しない

