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
