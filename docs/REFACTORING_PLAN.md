# PIXERA OS リファクタリング指示書

> コードベース全体 (js/ 約 36,000 行 + lang/ 約 1,800 行) の通読調査に基づく、
> 優先順位付きのリファクタリング計画。
> 各項目は、そのままコーディングエージェントへのプロンプトとして
> 投入できる粒度で記述する。
>
> 調査日: 2026-07-04 (テスト 699 件全パスの状態を起点とする)

---

## 0. 前提 — 現状の総評

**全体として設計品質は高い。** 以下は既に良好で、壊さないこと:

- レイヤ構造 `app → wm → ui → core` と DI 配線 (kernel.js 集約) は明快。
- ui/ 層は ports.js による DI で core 非依存を保っており、一貫している。
- core/ の純粋モジュール (dither / field_render / gif / mp4 / wav / pbm /
  anim / display_fx) は依存ゼロでテスト可能。手を入れる必要はない。
- lang/ は薄く整理されており、現時点で分割・変更の必要はない。
- ゲーム類 (bricker / graze / dungeon / life) は自己完結の
  1 ファイルアプリとして妥当。game_utils.js への共通化も済んでいる。

問題は主に 3 種類:

1. **少数のレイヤ違反・挙動バグ** (優先度 A)
2. **巨大ファイル** — wm.js 3157 行 / tessera.js 2083 行 / settings.js 788 行
   (優先度 B)
3. **横断的な重複** — ダウンロード処理・ドキュメントアプリ定型・
   Tessera 設定解決など (優先度 B〜C)

### 作業共通ルール

- 各項目の完了条件に **`npm test` (vitest 699+ 件) 全パス** を含める。
- 動作確認は `npm run play` でローカル配信し、ブラウザで該当機能を操作する。
- ファイル分割時は、各レイヤの `README.md` と分割後ファイル先頭の
  JSDoc `@module` を必ず更新する (docs/コメントは SSoT 方針。
  バージョン・寸法などコードから分かる事実は書き写さない)。
- コミットは `docs/COMMIT_GUIDE.md` の規約
  (`<type>(<scope>): <日本語概要>`) に従い、項目ごとに分ける。
- 公開 API (export) の削除・改名は、`js/` `tests/` 全域を grep して
  参照ゼロを確認してから行う。

---

## 優先度 A — 挙動・整合性の修正 (小規模・即時)

### A-1. core/sfx.js のレイヤ違反を解消する

- **対象**: `js/core/sfx.js`, `js/kernel.js`, `js/app/settings.js`,
  `js/core/README.md`, `js/README.md`
- **問題**: sfx.js は core/ に置かれているが、`wm/index.js`・
  `ui/Dialog.js`・`ui/widgets/PushButton.js` 等の上位レイヤを import
  している。README の「依存は上→下の一方向のみ。循環依存はゼロ」に反し、
  実際に wm → core → wm の import 循環が存在する
  (ES Modules なので動くが、アーキテクチャの唯一の違反点)。
- **方針**:
  - sfx.js を 2 つに分ける:
    - `js/core/sfx.js` (残す部分) — SFX_DEFS / SFX_NOTES /
      チャンネル管理 / playSystemSfx / setSystemSfxEnabled。
      audio.js と config.js のみに依存する純粋な「音を鳴らす」層。
    - `js/system_sfx.js` (ルート層・新規) — initSystemSfxHooks() の
      「各サブシステムへフックを配線する」部分。wm / ui への import は
      すべてここへ移す。kernel.js の import を差し替える。
  - もしくは同等の分離であれば配置は任意 (例: 配線部を kernel.js に
    インライン化する案も可)。ポイントは「core/ から wm/ ui/ への
    import を消す」こと。
- **期待される状態**: `grep -rn 'from "../wm\|from "../ui' js/core/`
  が 0 件。システム SFX (窓開閉・クリック音) の挙動は不変。
- **検証**: SETTINGS → SYSTEM タブで SFX ON にし、
  ウィンドウ開閉・ボタンクリックで音が鳴ること。

### A-2. VRAM ダンプの起動を DEV_MODE でゲートする

- **対象**: `js/kernel.js` (mainLoop)
- **問題**: `updateVramDump()` は DEV_MODE に関係なく毎フレーム呼ばれ、
  Ctrl+Shift+D でダンプモードに入る。一方オーバーレイ描画
  (`app.js` の `drawVramDumpOverlay`) は `DEV_MODE` ゲート付き。
  つまり本番 (DEV_MODE=false) では **画面に何も出ないまま
  全入力が乗っ取られる**。Esc を知らなければ操作不能に見える。
- **方針**: kernel.js に `DEV_MODE` を import し、
  `const dumpBusy = DEV_MODE ? updateVramDump() : false;` とする。
- **期待される状態**: DEV_MODE=false で Ctrl+Shift+D を押しても
  何も起きない。DEV_MODE=true では従来どおり。
- **検証**: config.js の DEV_MODE を両値で試す。

### A-3. システム SFX の既定値をコメントと一致させる

- **対象**: `js/config.js` (`_systemSfx` の初期化)
- **問題**: `let _systemSfx = load("systemSfx", false) !== false;` は
  保存値なし (新規アクセス) のとき **false = OFF** になるが、
  直上のコメントは「デフォルト ON」と主張している。
- **方針**: どちらが正か製品判断して統一する。
  - 既定 ON にする場合: `load("systemSfx", true) !== false`
  - 既定 OFF にする場合: コメントを「デフォルト OFF」に直し、
    式を素直に `!!load("systemSfx", false)` へ。
  - 推奨: 初見ユーザーの体験としてシステム SFX は ON が
    「空想のマシン」の没入感に寄与するため **既定 ON** を推奨。
- **検証**: localStorage をクリアして起動し、意図した既定になること。

### A-4. VFS 初期化の副作用 import を除去する

- **対象**: `js/app/files.js` (モジュールトップの `VFS.initVfs()`)
- **問題**: kernel.js が boot() 内で `VFS.initVfs()` を呼ぶ一方、
  files.js もモジュール評価時 (副作用 import) に呼んでいる。
  規約「副作用インポートは wmRegister 登録のみ」に反し、
  初期化順序が import 順に依存する。
- **方針**: files.js の呼び出しを削除する。app/app.js の import は
  kernel の boot() 途中 (initVfs 済み) より前に評価されるため、
  安全のため `initVfs()` 側に「二重呼び出しは no-op」のガード
  (`if (root) return;`) を追加してから削除すること。
- **検証**: 起動 → FILES でツリーが表示される。
  localStorage クリア後の初回起動でも既定ツリーが生成される。

---

## 優先度 B — 構造改善 (大規模分割)

### B-1. wm/wm.js (3157 行) をモジュール分割する

- **対象**: `js/wm/wm.js` → `js/wm/` 配下の複数ファイル
- **問題**: WM が 1 ファイルにメニュー基盤・ヒットテスト・スナップ・
  レイアウト算出・入力ディスパッチ・ツールチップ・ABOUT パネル・
  描画のすべてを持つ。機能追加のたびにこのファイルが伸びる。
- **方針**: 内部セクションは既に明確なので、以下の単位で切り出す。
  共有可変状態 (windows 配列 / activeIndex / mode / \_modalWinId 等) は
  第一段階では wm.js に残し、切り出すモジュールへは
  **関数引数と少数の getter/callback で渡す** (state オブジェクトの
  新設は不要。過剰な抽象化をしない)。
  - `wm/menu.js` — メニュー基盤一式 (~450 行):
    buildMenuTree / calcPanelSize / itemIndexFromLocalY / itemTopY /
    openMenu / openContextMenu / closeMenu / closeSubmenusFrom /
    openSubmenu / drawMenuPanel / drawMenu / hitTestMenuPanels /
    handleMenuInput / handleMenuClick と menuStack 状態。
    依存: GPU / font / icon / config。registry と toggleRegistered、
    SFX コールバックは引数 or 注入で受ける。
  - `wm/win_layout.js` — 純粋なレイアウト算出:
    recalcLayout / calcWindowSize / 各フレーム構成定数
    (BORDER / SEPARATOR*HEIGHT / FOOTER*_ / MIN\__) と
    recalcDerivedConstants。HEADER_HEIGHT 等の live binding は
    この新モジュールから export し直す。
  - `wm/tooltip.js` — wmSetTooltip / wrapTooltip / drawTooltip と
    tooltip 状態一式。
  - `wm/about.js` — ABOUT パネルとディゾルブ遷移:
    \_wrapText / drawAboutPanel / \_startAboutTransition /
    \_snapshotRect / \_renderAboutFace / \_drawAboutTransition。
  - wm.js に残すもの: ウィンドウ配列・レジストリ・ヒットテスト・
    スナップ・入力ディスパッチ (wmUpdate + handle\*)・
    drawWindowFrame・公開 API。これで wm.js は ~1,500 行程度になる。
- **合わせて解消する内部重複**:
  - `Config.onResize` ハンドラ内のスナップ矩形再計算 (maximized /
    snap-left / snap-right の 3 分岐) と `getSnapRect()` が同じ矩形式を
    二重に持つ。`snapRectFor(state)` を作り両方から使う。
  - `wrapTooltip` と `_wrapText` はほぼ同一の単語折返し。
    1 つの `wrapText(text, maxChars)` に統一する
    (tooltip 側の VRAM 幅クランプは呼び出し側で)。
- **期待される状態**: 挙動不変。wm/README.md のモジュール一覧を更新。
- **検証**: `npm test` に加え、手動で
  メニュー (右クリック・サブメニュー・チェック表示)、
  移動/リサイズ/スナップ/最大化/フルスクリーン (F11)、
  scrollable ウィンドウ (SETTINGS)、ツールチップ、
  ヘッダー右クリック → ABOUT のディゾルブ、を一通り確認。
- **テスト追加** (このタイミングで):
  buildMenuTree のツリー構築 (dev/hidden/modal の除外と並び順)、
  calcWindowSize ⇄ recalcLayout の逆演算性、snapRectFor。
  DOM 非依存の純粋部分なので vitest でそのまま書ける。

### B-2. app/tessera.js (2083 行) をサブディレクトリへ分割する

- **対象**: `js/app/tessera.js` → `js/app/tessera/` 配下
- **問題**: エディタ統合・プレビュー・PERFORM オーバーレイ・
  コードカード・音再生・書き出し・**約 640 行のサンプルデータ**が
  1 ファイルに同居している。app/README の構成ルール
  「複数ファイル構成はサブディレクトリに分離」にも沿っていない。
- **方針**: 以下に分割する。モジュール間で共有する状態
  (program / editor / resolvedConfig) は tessera.js (エントリ) が持ち、
  関数引数で渡す。
  - `app/tessera/samples.js` — DEFAULT_CODE / HEADER / LEARN_SAMPLES /
    GALLERY_SAMPLES / SOUND_SAMPLES / seedSamples()。純データ。
  - `app/tessera/perform.js` — PERFORM 描画とオーバーレイエディタ:
    PERFORM_CHUNK / OV / drawPerform / ovLayout / drawGlyph2x /
    ovSelection / ovInSelection / drawPerformOverlay / ovHandleMouse。
  - `app/tessera/card.js` — コードカード合成:
    CARD\_\* 定数 / cardLines / cardBlockSize / resolveCardLayout /
    buildCardMasks / renderCard / renderCardPreview / レイアウトキャッシュ。
  - `app/tessera/sound.js` — 音のライブ再生と PCM 書き出し:
    AUDIO_GAIN / stopAudio / playAudio / toggleAudio /
    currentVisualTime / exportAudioPcm / ampAt。
  - `app/tessera/export.js` — makeExportSurface / exportName /
    exportFrames / exportArt / downloadBlob (→ C-1 で共通化)。
  - `app/tessera/tessera.js` — ウィンドウ登録・エディタ・プレビュー・
    ツールバー・onDraw/onInput/onMeasure・ファイル操作。
  - `app/app.js` の import を `./tessera/tessera.js` に更新。
    `tesseraOpenFile` の export 位置も維持する (files が参照)。
- **期待される状態**: 挙動不変。各ファイル 500 行以下。
- **検証**: TESSERA を開き、編集→即プレビュー、Ctrl+R / Ctrl+E
  (PNG/GIF/MP4/WAV)、CODE カードトグル、Alt+P (音)、
  Alt+Enter (PERFORM で編集・エラーバー)、Alt+W (壁紙化)、
  FILES から .tess ダブルクリック、を確認。

### B-3. Tessera ディレクティブ解決を tessera / wallpaper で共有する

- **対象**: `js/app/tessera.js` (resolvedConfig / VIEW_PARAM /
  MODE_PARAMS / FPS_OPTIONS / effectiveRender / ensureSurface /
  makeExportSurface), `js/wallpaper.js` (resolveTessConfig /
  TESS_VIEW_PARAM / TESS_MODE_PARAMS / TESS_FPS_OPTIONS / surf 構築)
- **問題**: 「compile 済み config (不透明データ) → 実効設定」の解決
  ロジックが 2 箇所に別実装で存在する。fps スナップ表・view→パラメータ
  対応表・既定値が二重定義で、クランプ挙動も微妙に異なる
  (SSoT 違反。ディレクティブ追加時に片方だけ直る事故が起きる)。
- **方針**: `js/core/tess_host.js` (新規) に共通化する
  (lang/ コアは「config は不透明データ、解決はホストの責務」方針
  なので、ホスト側 = js/core が置き場所として正しい):
  - `resolveTessConfig(config, overrides?)` — seed / period / fps /
    canvas / pad / view の既定値・クランプ・fps スナップを一元化。
    tessera の厳密版 (canvas 16..4096, pad クランプ等) を正とし、
    wallpaper はその結果から必要な値 (seed/period/fps/aspect/view)
    だけ使う。
  - `makeFieldSurface(w, h, viewMode, viewParams, opts)` —
    makeBufferSurface + blitField 差し替え (field_render / ascii) を
    1 箇所に。tessera の ensureSurface / makeExportSurface、
    wallpaper の renderTessFrame 内のインライン surface が置き換わる。
  - FPS_OPTIONS / VIEW_PARAM / MODE_PARAMS / TAU / PERIOD_CAP_S も
    ここへ移して export。
- **期待される状態**: 同じ .tess がプレビュー・書き出し・壁紙で
  同一の実効設定になる。表の二重定義が消える。
- **検証**: `view: halftone(8)` `fps: 20` `period: tau` を含む作品を
  TESSERA プレビュー → Alt+W 壁紙化して見比べる。
  `tests/core/` に resolveTessConfig の単体テストを追加
  (既定値・クランプ・fps スナップ・view フォールバック)。

### B-4. app/settings.js をタブ単位に分割する

- **対象**: `js/app/settings.js` → `js/app/settings/` 配下
- **問題**: `_initWidgets()` が約 520 行、モジュール変数が約 60 個。
  タブ追加・項目追加のたびに巨大関数と変数宣言列が伸びる。
- **方針**: タブごとにモジュール分割する。各タブは
  `{ build(): Box, sync(): void, widgets }` を返す小さなファクトリに:
  - `app/settings/display_tab.js` — 解像度 / フォント / パディング /
    背景 (Solid・Image・Tessera)。
  - `app/settings/effects_tab.js` — Vignette / Diagonal スライダ群。
  - `app/settings/theme_tab.js` — パレットリスト / カスタム RGB。
  - `app/settings/system_tab.js` — 入力オーバーレイ / SFX / defaults。
  - `app/settings/settings.js` — タブバー・buildMainRoot・
    ウィンドウ登録・wmSetContentSize 連携。
  - ラベル幅揃え (maxLabelWidth) と `formatPercent/formatPx` は
    `app/settings/helpers.js` へ。
- **期待される状態**: 挙動不変。各ファイル 250 行以下。
  設定項目の追加が該当タブ 1 ファイルの変更で済む。
- **検証**: 全タブの全ウィジェットを操作し、リロード後に
  永続化が復元されること (パレット / 壁紙 3 モード / 解像度 /
  パディング / エフェクト / SFX / 入力オーバーレイ)。

### B-5. app/capture.js の三重化を解消する

- **対象**: `js/app/capture.js`, `js/app/app.js`
- **問題**: スクリーンショット / 動画録画 / GIF ループの 3 系統が
  それぞれ「timerEnd + pending + カウントダウン更新 + 中央オーバーレイ
  描画 + <a download> ダウンロード」をコピペで持つ。
  app.js からの連携 export も 3×3 = 9 本あり、呼び忘れリスクがある。
- **方針**:
  - 遅延実行 1 種に統一: `createDelayedAction(onFire, statusLabel)` の
    ような小ヘルパ (timerEnd / pending / countdown テキスト更新) を
    ファイル内に 1 つ作り、3 系統から使う。
  - カウントダウンの中央オーバーレイ描画は 1 関数に統一する
    (3 つの drawXxxOverlay は完全に同一処理)。
  - ダウンロードは C-1 の共通 `triggerDownload` を使う。
  - app.js への export を `updateCapture()` / `drawCaptureOverlay()` /
    `commitCapture()` の 3 本に集約し、app.js 側の呼び出しを差し替える。
- **期待される状態**: capture.js が ~650 行以下になり、
  録画系の状態遷移が 1 箇所で読める。挙動不変。
- **検証**: Delay 0 と 3 秒でスクショ / 録画 / GIF を各実行。
  録画・GIF の同時開始が引き続き禁止されること。
  ウィンドウ単体録画中の対象クローズ / リサイズで自動停止すること。

---

## 優先度 C — 横断的な重複の統合 (中規模)

### C-1. ファイルダウンロードヘルパを 1 本化する

- **対象**: `js/core/art_export.js` (triggerDownload),
  `js/app/capture.js` (3 箇所), `js/app/tessera.js` (downloadBlob)
- **問題**: 「Blob → <a download> クリック」が 5 実装ある。
  appendChild の有無など細部が揺れている。
- **方針**: art_export.js の `triggerDownload(blob, filename)` を
  export に昇格し (機能はそのまま)、他 4 箇所をこれで置き換える。
  capture.js のようにファイル名生成が絡む箇所は名前生成だけ残す。
- **期待される状態**: `URL.createObjectURL` の出現が
  js/ 全体で 1 箇所になる。

### C-2. ドキュメントアプリ定型 (dirty / 保存 / タイトル) を共通化する

- **対象**: `js/app/notepad.js`, `js/app/paint.js`,
  `js/app/tessera.js` (B-2 後は app/tessera/tessera.js)
- **問題**: currentFilePath / isDirty / refreshTitle (`* NAME - APP`) /
  confirmDiscard / saveFileAs / saveFile / onBeforeClose の一式が
  3 アプリにコピペされている。文言・挙動は事実上同一。
- **方針**: `js/app/doc_host.js` (新規) に共通ファクトリを作る:
  ```js
  createDocHost({
    appName,
    ext,
    defaultDir,
    defaultName,
    getContent,
    setContent, // アプリ固有のシリアライズ
    getWinId, // タイトル更新用
  });
  // 返り値: { open, save, saveAs, newDoc, confirmDiscard,
  //           markDirty, isDirty, currentPath, refreshTitle,
  //           onBeforeClose }
  ```
  ダイアログ文言 ("DISCARD UNSAVED CHANGES?" 等) もここに集約。
  各アプリは getContent/setContent と保存後フック
  (paint の resetPaintState 等) だけを渡す。
- **期待される状態**: 3 アプリから同型コードが消え、
  「ファイルを扱うアプリ」の追加が doc_host 利用で完結する。
- **検証**: 各アプリで new / open / save / save as / dirty 表示 /
  閉じる時の破棄確認 / FILES からのダブルクリックオープン。

### C-3. ファイル関連付けを自己登録レジストリにする

- **対象**: `js/app/files.js` (FILE_ASSOC / FILE_HANDLERS),
  `js/app/notepad.js`, `js/app/paint.js`, `js/app/tessera.js`
- **問題**: files が拡張子表とハンドラ表をハードコードし、
  notepad / paint / tessera を直接 import している (アプリ間の横結合)。
  ファイルを開けるアプリを増やすたびに files の修正が要る。
- **方針**: `js/app/file_assoc.js` (新規) に
  `registerFileHandler(exts, openFn)` / `openWithAssociatedApp(path)` を
  作る。各アプリが wmRegister と同じ場所で自己登録し、
  files は `openWithAssociatedApp` を呼ぶだけにする。
  wallpaper の SETTINGS 連携等は対象外 (拡張子起動のみ)。
- **期待される状態**: files.js からアプリ import が消える。
- **検証**: FILES で .txt / .pbm / .tess をダブルクリックし
  各アプリで開くこと。未知拡張子は従来どおり何もしない。

### C-4. desktop.js の gridRowSpan 機構を除去する

- **対象**: `js/wm/desktop.js`
- **問題**: ラベルは常に 1 行 (`splitLabel` は切り捨てのみ、
  `calcRowSpan` は常に 1) なのに、複数行時代の span 対応コード
  (`gridRowSpan || 1` 分岐、clampAnchor / dropIcons / hitTestIcon /
  updateLassoSelection の span ループ、freeSources の行単位管理) が
  残っている。読み手が「span は可変」と誤解する。
- **方針**: gridRowSpan / calcRowSpan / span ループを削除し、
  1 アイコン = 1 セル前提に単純化する。splitLabel は
  truncateLabel にリネーム。desktop.test.js の期待値も追従。
  (将来複数行ラベルを復活させる場合は git 履歴から戻せる。)
- **期待される状態**: desktop.js が ~100 行減。挙動不変
  (ドラッグ交換・ラッソ・Ctrl 選択すべて従来どおり)。
- **検証**: `tests/wm/desktop.test.js` パス + 手動でアイコン D&D。

### C-5. gpu.js のキャプチャ復元と未使用プリミティブを整理する

- **対象**: `js/core/gpu.js`
- **問題**:
  - endCapture / endCaptureRaw / endCaptureIndexed が同じ
    「activeBuffer/W/H 復元 + resetClip」4 行を三重に持つ。
  - `copyRect` と `scroll` は js/ 全域で参照ゼロ (デッドコード)。
- **方針**:
  - private `_restoreRenderTarget()` を作り 3 関数から呼ぶ。
  - copyRect / scroll は削除する。将来必要になれば git から戻す
    (「使われていない描画プリミティブを予約として持たない」)。
    ヘッダーコメントの命名規則一覧からも除く。
- **検証**: `npm test` + CAPTURE でウィンドウ単体スクショ / GIF。

### C-6. splash.js のディザワイプを 1 関数に統一する

- **対象**: `js/splash.js`
- **問題**: `ditherWipe` (単色へ) と `fadeInDesktop` 内ループ
  (スナップショットへ) が同じ Bayer 4×4 閾値ループの二重実装。
- **方針**: `ditherReveal(t, getPixel)` のような 1 関数にし、
  単色は `() => 0`、デスクトップは `(i) => snapshot[i]` を渡す。
  wm/about.js のディゾルブ (B-1) と共通化できるなら
  `core/dither.js` へ `ditherMix(dst, from, to, t, w, h)` として
  移す案も可 (判断はエージェントに委ねる。無理な統合はしない)。
- **検証**: 起動演出が従来どおり (フェードアウト → デスクトップ
  フェードイン) であること。

---

## 優先度 D — 小さな設計判断 (要判断のため指示書に記載)

### D-1. app.js のキーボードカーソル移動を削除する

- **対象**: `js/app/app.js` (cursorX / cursorY と矢印キー処理)
- **問題**: 「サンプル用の状態」とコメントされた初期実装の名残。
  マウスが canvas 外のとき矢印キーでカーソル表示位置が動くが、
  矢印キーはアプリ操作 (テキスト編集・ゲーム) で多用されるため
  隠れた副作用になっている。実用機能ではない。
- **方針**: 削除を推奨。カーソルは
  「マウスが領域内なら表示、外なら最後の位置 or 非表示」へ単純化する
  (`drawCursor` を `isMouseInside()` のときだけ呼ぶのが最小変更)。
  意図的な機能として残す判断をした場合は、コメントを
  「サンプル」ではなく仕様として書き直すこと。
- **検証**: マウスを canvas 外に出したときの見た目を確認。

### D-2. vfs.js の remove / removeRecursive を統合する

- **対象**: `js/core/vfs.js`, 呼び出し側 (files 等), `tests/core/vfs.test.js`
- **問題**: 両関数は「空チェックの有無」以外同一。
- **方針**: `remove(path, { recursive = false } = {})` に統合し、
  removeRecursive は削除。呼び出し側とテストを更新する。
- **検証**: FILES でファイル削除・空/非空フォルダ削除。

### D-3. package.json のメタデータを実態に合わせる

- **対象**: `package.json`
- **問題**: `version: 1.0.0` (正は config.js APP_VERSION = SSoT 違反)、
  `description` が旧ポジショニング「1-bit Desktop DAW」のまま。
- **方針**: private パッケージなので version は "0.0.0" 固定にして
  「バージョンは config.js が正」とコメント不要で運用するか、
  いっそ version を削除。description は README の一行説明
  (1-bit の空想レトロ・クリエイティブ OS) に合わせる。

---

## 優先度 E — パフォーマンス (計測してから着手)

### E-1. 動画書き出しの全フレーム先行生成をやめる

- **対象**: `js/app/tessera.js` の exportFrames,
  `js/core/art_export.js` の exportVideo, `js/core/mp4.js`, `js/core/gif.js`
- **問題**: GIF/MP4 書き出しで全フレームの 1-bit バッファを
  配列に貯めてからエンコードする。最悪ケース
  (canvas 4096 → base 512², period 30s × fps 100 = 3000 frames) で
  約 780MB をピークで保持し、タブクラッシュしうる。
- **方針**: フレーム供給をコールバック化する
  (`frameAt(i)` をエンコーダへ渡し、エンコーダが順に要求する)。
  MP4 (WebCodecs) は逐次エンコードと相性が良い。GIF の自前
  エンコーダも 1 フレームずつ LZW 圧縮できる構造なら対応する。
  対応が重い場合の代替: `フレーム数 × baseW × baseH` に上限を設け、
  超過時は footer にエラーを出して書き出しを拒否する (安全弁のみ)。
- **検証**: 1080² / period tau / fps 20 の通常ケースが従来どおり
  書き出せること。大型ケースでメモリが平坦なこと
  (DevTools Performance monitor)。

### E-2. display_fx.applyVramRgba の per-pixel 剰余を増分化する

- **対象**: `js/core/display_fx.js` (applyVramRgba / applyVramIndexed)
- **問題**: 毎フレーム全ピクセル (480×270 ≈ 130k) で
  `(((x + y - doff) % S) + S) % S` の二重剰余を計算している。
  現状 60fps は出ているはずなので **必須ではない** が、
  flush はシステム最大のホットループ。
- **方針**: 行頭で base を 1 回計算し、x++ ごとに
  `base = base + 1 === S ? 0 : base + 1` と増分更新する。
  変更前後で出力バッファの一致テスト (既存 display_fx.test.js に
  ゴールデン比較を追加) を書いてから最適化する。
- **検証**: テスト一致 + 目視で斜線スキャンラインが従来どおり
  流れること。

---

## 優先度 F — ドキュメント / テスト補強

### F-1. アーキテクチャ README の依存図を実態に合わせる

- **対象**: `js/README.md`
- **問題**: 依存図に `lang/` が現れないが、実際は
  `wallpaper.js → lang/runtime.js`、`app/tessera → lang/*` の依存がある。
  また A-1 完了後の sfx 配線位置も反映が必要。
- **方針**: 依存図に lang/ を追加し (`app/ と ルート → lang/`)、
  「lang/ は js/ に依存しない (逆方向禁止)」を明記する。

### F-2. WM と Tessera ホスト解決のユニットテストを追加する

- **対象**: `tests/wm/`, `tests/core/`
- **問題**: wm.js の純粋ロジック (メニューツリー構築・
  ウィンドウサイズ算出・スナップ矩形) と Tessera 設定解決に
  テストがなく、B-1 / B-3 の分割リファクタの安全網が薄い。
- **方針**: B-1 / B-3 の各項目に含めたテストを、
  **分割前に現挙動へ対して先に書く** (characterization test)。
  分割後も同じテストが通ることをもって挙動不変の根拠とする。

---

## 実施順序の推奨

1. **A-1 〜 A-4** (半日) — 独立・小規模。すぐ効く。
2. **F-2 の characterization test → B-1 (wm 分割)** — 最大の構造改善。
3. **B-3 (tess_host 共通化) → B-2 (tessera 分割)** — B-3 を先にやると
   B-2 の分割境界が綺麗になる。
4. **B-5 / C-1** (capture 整理とダウンロード統一はセットで)。
5. **C-2 / C-3** (doc_host と file_assoc はセットで)。
6. **B-4 / C-4 / C-5 / C-6 / D 系** — 順不同。
7. **E 系** — 必要になったとき (計測を先に)。

各ステップの完了条件: `npm test` 全パス +
該当機能の手動確認 + README/@module の更新。

## やらないこと (over-engineering 防止)

- ui/ 層・lang/ コア・純粋コーデック群 (gif/mp4/wav/pbm) の再設計。
  現状で十分整理されている。
- field_render.js の Bayer 行列と core/dither.js の重複解消。
  field_render は「依存ゼロの純粋モジュール」方針の意図的重複。
- storage.js の save/load 薄ラッパ群の削減。キー名の
  タイポ防止として機能しており、害がない。
- ゲーム 4 本の相互共通化の深掘り。game_utils.js で十分。
- TextBox / TextArea の編集ロジック統合。1 行 / 複数行で
  データモデルが異なり、統合コストが利得を上回る。

