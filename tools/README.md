# tools/ — 開発支援スクリプト

## serve.mjs — 依存ゼロのローカル静的サーバー

PIXERA OS / `lang/playground` を ES モジュールとして開くためのローカル
HTTP サーバー。`file://` では ES モジュールの `import` が使えないため、
ブラウザで動作確認する際に使う。

```bash
npm run play              # http://localhost:8777/
# または直接:
node tools/serve.mjs
PORT=9000 node tools/serve.mjs
```

- ルート (`/`) → `index.html` (PIXERA OS 本体)
- `/lang/playground/` → Tessera 言語のプレイグラウンド

見た目の確認はブラウザで各自行う。UI 実装の検証は `npm test` (Vitest) と
静的な整合性チェックで行い、スクリーンショットによる自動確認は行わない。
