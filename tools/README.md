# tools/ — 開発支援スクリプト

## capture.mjs — visual review harness

PIXERA OS を headless Chromium で起動し、指定したアプリウィンドウを開いて
`canvas#screen` を PNG に保存するスクリプト。

### 目的

コーディングエージェント (Claude) が UI 実装後に画面確認を行うための閉ループ。
DOM 検査では取れない canvas 描画結果をスクリーンショットで取得し、
エージェントが直接 `Read` ツールで PNG を読んで判断する。

### セットアップ

```bash
npm install
npx playwright install chromium   # 初回のみ (~150MB)
```

### 使い方

```bash
npm run capture <WINDOW_NAME>
# 例:
npm run capture AQUARIA
npm run capture SYNESTA
npm run capture desktop          # ウィンドウを開かず、デスクトップ全体のみ
```

出力: `screenshots/<WINDOW_NAME>.png` (常に上書き、`.gitignore` 済)。

### 仕組み

1. 軽量な静的ファイルサーバーを `http://localhost:8765` で起動
2. Playwright で headless Chromium 起動 (viewport 1280×720)
3. PIXERA OS ロード → `window.__pixera.booted` が `true` になるのを待つ
4. **レビュー精度向上の調整** を適用 (下記)
5. `window.__pixera.wmOpenByName(name)` でアプリを起動
6. 待機してレイアウトが落ち着いた後、canvas#screen を screenshot
7. PNG を `screenshots/` に保存

### レビュー精度向上の調整 (production と見た目が異なる点)

判別精度を上げるため、capture では以下を適用する。**production の見た目とは
異なる**ので注意 (例: 壁紙のディザ模様やカーソルは出ない):

- Diagonal scanline / Vignette を OFF
- カーソルを非表示 (UI に重なって判読を妨げるため)
- 背景を単色 Solid (level 0) にしてディザ模様のノイズを除去

いずれも capture 専用の一時設定で、page を閉じれば消える (production 不変)。

### PIXERA OS 側のテストフック

`js/kernel.js` のブート完了時に以下を露出している (名前空間の追加のみ、
通常運用には影響しない):

```js
window.__pixera = {
  booted: true,
  wmOpenByName, wmGetRegistry, wmGetWindowList,
  wmGetWindowRect, wmGetContentRect, // ウィンドウ矩形取得 (スクリプト操作用)
  wmSetFullscreen, wmIsFullscreen,   // フルスクリーン切替 (検証用)
  setEffect,        // Diagonal / Vignette 等の視覚効果切替
  setCursorHidden,  // カーソル非表示 (レビュー用)
};
```

### 限界

| 項目 | 状況 |
|---|---|
| 静的レイアウト確認 | ◎ できる |
| アニメーション (魚・星・印字) | △ 1 フレームの静止画のみ |
| 音 (OSCILLO の反応) | × headless 環境では音が出ない |
| キーボード/マウス操作 | △ 別途 Playwright API で記述すれば可能 |
| デザイン 4 原則の自動適用 | × エージェントの責任 |

スクリーンショットは「悪い結果を検知する」ための手段であって、
「良いレイアウトを生成する」ための手段ではない。

### screenshot 評価チェックリスト (エージェント用、必須)

PNG を `Read` で見たあと、**1 要素ずつ追跡** して以下を確認する。
「全体的に OK」で済ませない。スキャンではなく批判的精査をする。

#### 1. テキスト個別チェック

各文字列について:
- [ ] 罫線・装飾線と重なっていないか
- [ ] 隣接要素と重なっていないか
- [ ] 右端 / 下端で切れていないか
- [ ] 十分な余白 (最低 GLYPH_H / 2 程度) が周囲にあるか

#### 2. UI 要素 (button / box / 入力欄) 個別チェック

各 UI 要素について:
- [ ] contentRect の境界内に完全に収まっているか
- [ ] **要注意**: `WIN_W / WIN_H` は wmOpen に渡したウィンドウ全体寸法であり、
      contentRect の寸法ではない。位置計算には `cr.x / cr.y / cr.w / cr.h` を使う
- [ ] 角丸・枠線が描画途中で切れていないか

#### 3. デザイン 4 原則の適用確認

「**動くか**」「**読めるか**」だけで OK 判定しない。デザイン 4 原則を
**1 つずつ書き出して** 評価する。頭の中で「全体的に OK」と思っただけだと、
整列・反復違反を見落とす (これは過去に何度か発生した)。
各原則について、現状の判断と理由を 1 文で書き出してから ✓ を付ける。

- [ ] **近接**: 関連要素はグループとして見えるか (空白で区切られているか)
- [ ] **整列**: 要素の左端 / 上端が同一ラインに揃っているか
- [ ] **反復**: 同種要素の余白・サイズ・装飾が一貫しているか
- [ ] **コントラスト**: 重要度の差が視覚的に表現されているか

新規ウィジェット追加 / 移動 / 整列変更を行ったら、commit 前に必ずこの 4 つを
明示的に評価する。不安な場合は「この配置はデザイン 4 原則的に問題ありますか?」と
事前にユーザーに先回りで聞くこと。

#### 4. 「違和感」テスト

PNG 全体を眺めて、**1 つは違和感のある箇所を探す**。
「特に問題なし」は禁止用語。何か見つかるまで観察する。

#### 5. よくあるバグパターン

過去の PIXERA OS 開発で発生したもの (再発防止):
- カスタム描画で `WIN_W / WIN_H` を contentRect 寸法と取り違えてはみ出す
- 罫線などの装飾が text の Y 座標と被って読めない
- `setLabel` などの helper を忘れて Label の幅が古いまま
- Box.layout を呼び忘れて子要素位置が stale
- DropDown.items を差し替えても width が更新されない (setter 化済み)
- `drawText` に小数点座標を渡してグリフが描画されない
  (`Math.floor` で整数化が必要)
- ボタン内テキストの padding が math 上 `(BTN_H - GLYPH_H) / 2` で
  非整数になる組み合わせを選び、上下非対称になる

#### 6. 1 ピクセル単位の対称性 (PIXERA OS 哲学の核)

PRODUCT_BRIEF §5.3「美しさの妥協なし」「1 ピクセルのズレも許容しない」は
文字通りに適用する。「美しい」=「自動的に対称になる構造」であって、
「気をつけて手動配置する」ではない。

矩形内に配置された要素 (ボタン内の文字、ウィンドウ内の box、ラベル横の
アイコン等) について:

- [ ] 上下左右の余白を **pixel 単位で数える** (PNG を拡大して目視。
      `>` のような小さなグリフは 1px 違いが死活問題)
- [ ] 最大値と最小値の差が 1 以下か (math 上 0 になるべきだが、
      整数制約で 0.5 のずれが生じる場合のみ 1 px 許容)
- [ ] math 上 `(コンテナ寸法 - 内部要素寸法)` が **偶数** になる組み合わせを
      選んでいるか (奇数なら必ず 1px 非対称になる)
- [ ] `Math.floor((W - inner) / 2)` 等で対称 padding を **計算で導出** して
      いるか (magic number で `4` 等をハードコードしていないか)

検知能力の限界 (正直に):

- 私の目で見て 1px 非対称を読み取るのは難しいケースがある。
  特に PNG を拡大せずに普通に Read した状態だと見落とすことがある
- 自動 pixel-perfect 検証 (canvas を読んでパディング行を数える) は
  実装可能だが現状未対応 (BACKLOG 候補)

そのため、**設計時に math で対称性を保証する** (段階 2) が最優先。
screenshot による目視は補助的な検知手段。
