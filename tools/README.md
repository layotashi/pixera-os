# tools/ — 開発支援スクリプト

## capture.mjs — visual review harness

SYNESTA を headless Chromium で起動し、指定したアプリウィンドウを開いて
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
npm run capture AQUARIUM
npm run capture STUDIO
npm run capture desktop          # ウィンドウを開かず、デスクトップ全体のみ
```

出力: `screenshots/<WINDOW_NAME>.png` (常に上書き、`.gitignore` 済)。

### 仕組み

1. 軽量な静的ファイルサーバーを `http://localhost:8765` で起動
2. Playwright で headless Chromium 起動 (viewport 1280×720)
3. SYNESTA ロード → `window.__synesta.booted` が `true` になるのを待つ
4. `window.__synesta.wmOpenByName(name)` でアプリを起動
5. 800ms 待機してレイアウトが落ち着いた後、canvas#screen を screenshot
6. PNG を `screenshots/` に保存

### SYNESTA 側のテストフック

`js/kernel.js` のブート完了時に以下を露出している:

```js
window.__synesta = {
  booted: true,
  wmOpenByName,
  wmGetRegistry,
  wmGetWindowList,
};
```

通常運用にはまったく影響しない (名前空間の追加のみ)。

### 限界

| 項目 | 状況 |
|---|---|
| 静的レイアウト確認 | ◎ できる |
| アニメーション (魚・星・印字) | △ 1 フレームの静止画のみ |
| 音 (BAND の反応) | × headless 環境では音が出ない |
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

- [ ] **近接**: 関連要素はグループとして見えるか (空白で区切られているか)
- [ ] **整列**: 要素の左端 / 上端が同一ラインに揃っているか
- [ ] **反復**: 同種要素の余白・サイズ・装飾が一貫しているか
- [ ] **コントラスト**: 重要度の差が視覚的に表現されているか

#### 4. 「違和感」テスト

PNG 全体を眺めて、**1 つは違和感のある箇所を探す**。
「特に問題なし」は禁止用語。何か見つかるまで観察する。

#### 5. よくあるバグパターン

過去の SYNESTA 開発で発生したもの (再発防止):
- カスタム描画で `WIN_W / WIN_H` を contentRect 寸法と取り違えてはみ出す
- 罫線などの装飾が text の Y 座標と被って読めない
- `setLabel` などの helper を忘れて Label の幅が古いまま
- Box.layout を呼び忘れて子要素位置が stale
- DropDown.items を差し替えても width が更新されない (setter 化済み)
