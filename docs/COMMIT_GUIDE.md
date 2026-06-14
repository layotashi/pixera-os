# SYNESTA — コミットメッセージ規約

> このドキュメントは SYNESTA のコミットメッセージの書き方を定める **living document** です。
> ルールは強制ではなくガイドラインであり、`git log` を将来読み返したときに
> 「何が」「なぜ」変わったかが追えることを目的とします。
>
> Conventional Commits をベースに、SYNESTA に必要な要素だけ残した軽量版です。

---

## 1. 基本フォーマット

```
<type>(<scope>): <概要>

<body>

<footer>
```

| 要素 | 言語 | 必須 | 概要 |
| ---- | ---- | ---- | ---- |
| `type` | 英語小文字 | ✅ | 変更の種類 (下表) |
| `scope` | 英語小文字 | ❌ | 影響範囲。明確なときのみ付ける |
| `概要` | 日本語 | ✅ | 50 字目安、句点なし、現在形 |
| `body` | 日本語 | ❌ | WHY 中心。WHAT は diff で読めるので書かない |
| `footer` | 英語 | ❌ | `Co-Authored-By:` 等 |

**設計判断**: `type` / `scope` を英語にしているのは `git log --grep "^fix"` のような
横断検索を効かせるためと、Subject 先頭の視認性を上げるため。概要・本文は日本語の方が
ニュアンスを残せるため日本語にしています。

---

## 2. Type 一覧

| Type | 意味 | 使いどころ |
| ---- | ---- | ---------- |
| `feat` | 新機能 (ユーザーが触れるもの) | アプリ追加・UI 追加・新エフェクト等 |
| `fix` | バグ修正 (意図通りの動作に戻す) | 既存機能の挙動修正 |
| `refactor` | 動作を変えずに構造を変える | モジュール分割・命名整理・責務分離 |
| `perf` | パフォーマンス改善のみ | ホットループ最適化・LUT 導入等 |
| `docs` | ドキュメントのみ | README, BACKLOG, PRODUCT_BRIEF 等の編集 |
| `test` | テスト追加・修正のみ | 既存挙動に対するテスト追加 |
| `style` | コード整形のみ (動作変更なし) | フォーマット統一・コメント整形 |
| `chore` | 雑多 | `.gitignore`, `package.json`, アセット差し替え等 |
| `revert` | リバート | 直前コミットの取り消し |

### 意図的に採用しなかった Type

- `build` / `ci` — SYNESTA はビルドレス・CI 未設定のため不要。将来必要なら `chore` に吸収。
- 独自の `visual` / `aesthetic` — アイコン追加・配色微調整等は `feat` / `chore` で十分。
  Type を増やすほど分類で迷うため、最小数に保つ。

---

## 3. Scope 一覧 (省略可)

レイヤー名 or アプリ名を小文字で記述。複数階層は `/` 区切り。

| 例 | 用途 |
| -- | ---- |
| `(wm)` `(ui)` `(audio)` `(kernel)` `(config)` `(wallpaper)` `(splash)` | レイヤー / 単一ファイル |
| `(core/gpu)` `(core/pixel_grid)` `(core/vfs)` `(core/audio)` | `core/` 内の特定モジュール |
| `(settings)` `(studio)` `(paint)` `(notepad)` `(explorer)` `(capture)` `(genart)` 等 | 特定アプリ |
| `(docs)` `(backlog)` `(brief)` `(humor)` | docs 配下の特定ドキュメント |
| `(test)` | テスト全般 |

### Scope を省略すべきとき

- 影響が複数レイヤーに跨る (例: フォント差し替えで全レイヤーが影響を受ける)
- 特定範囲を名指しできない雑多な変更 (例: `.gitignore` 更新)

```
✅ fix(wm): スナップ復帰時の座標ずれを修正
✅ chore: .gitignore を追加
❌ fix(wm/scrollbar/thumb): ... (細かすぎ — 階層は 2 段まで)
```

---

## 4. 概要 (Subject の本体)

- **50 字目安**。72 字を超えたら body に分割する。
- **句点 (。) は付けない**。
- **現在形・命令形寄り** (`修正する` / `追加する` / `〜を緩和`)。完了形・過去形は避ける。
- **何を変えたか** ではなく **何が起こるか** を書く。
  - ❌ `fix(wm): minH の計算ロジックを変更`
  - ✅ `fix(wm): scrollable ウィンドウの最小高さを緩和`

---

## 5. Body (任意)

書く基準は **「diff だけでは伝わらない WHY があるとき」**。

書くべき内容:
- 根本原因 (なぜそのバグが起きたか)
- 設計判断の根拠 (なぜ別案を選ばなかったか)
- 副作用や影響範囲のメモ
- 関連するバックログ項目・ドキュメントへの参照

書くべきでない内容:
- diff を見れば分かる WHAT の繰り返し
- 「とても良い修正です」のような感想

### 書式ルール

- Subject から **1 行空けて** 開始。
- 行幅 **72 字目安** (`git log` で改行されずに読める)。
- 箇条書きは `-` (ハイフン) で開始。
- 段落間は 1 行空ける。

---

## 6. Footer (任意)

| Footer | いつ書くか |
| ------ | ---------- |
| `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` | Claude が編集を担った変更 |
| `Refs: docs/BACKLOG.md` | 特定のバックログ項目に紐づくとき |
| `Breaks: <内容>` | 後方互換を壊す変更があるとき (1.0 まではほぼ不要) |

Footer がある場合、Body との間に 1 行空ける。

---

## 7. 例

### 7.1 自明な fix — Subject のみ

```
fix(settings): Custom パレット切替時のレンダリングずれを修正
```

### 7.2 WHY を残したい fix — Body 付き

```
fix(wm): scrollable ウィンドウの最小高さを緩和

onMeasure() の自然サイズが「初期サイズ」と「最小サイズ」の両方に
使われていたため、コンテンツが画面より大きいと最大化でしか
スクロールが効かなかった。scrollable のときは MIN_HEIGHT まで
縮められるよう責務を分離する。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

### 7.3 新機能 — 設計判断を残す

```
feat(display_tuning): Pixel Grid マスタートグルを追加

Pixel Grid OFF 時は Glow / Diagonal / Vignette / Noise も同時に
非表示にする。LCD ジオメトリと積層エフェクトを分離する設計の
第 1 段階。Display Profile 化は BACKLOG に残す。
```

### 7.4 ドキュメントのみ

```
docs(backlog): Display Profile 導入を P1 で追加
```

### 7.5 構造変更 (refactor)

```
refactor(core/pixel_grid): CELL を動的化

flush 経路から CELL=3 ハードコードを排除し、setPixelGridEnabled
で動的切替できるようにする前準備。挙動は変えない。
```

---

## 8. アンチパターン

以下は **避けたい書き方**:

### 8.1 中身を語らない Subject

```
❌ fix: 修正
❌ feat: 機能追加
❌ chore: いろいろ
```
→ Subject 単独で意味が通るようにする。

### 8.2 Body で diff を繰り返す

```
❌ fix(wm): wm.js の 2099 行目の minH = MIN_WIDTH を MIN_HEIGHT に変更

意図的に MIN_HEIGHT に変更しました。
```
→ WHAT は diff で読める。書くなら WHY を書く。書くことが無いなら body は省略。

### 8.3 複数の独立した変更を 1 コミットに混ぜる

```
❌ fix(wm): scrollable 修正と settings の文言修正
```
→ 別コミットに分ける。`git revert` 単位を「1 つの意図」に揃える。

### 8.4 過去形・完了形

```
❌ fix(wm): minH を緩和した
❌ feat(settings): スライダーを追加しました
```
→ 現在形・命令形に統一 (`緩和` / `スライダーを追加`)。

### 8.5 Type の濫用

```
❌ feat(docs): README を更新     ← docs を使う
❌ refactor(wm): バグを修正       ← fix を使う
```
→ Type と内容を合わせる。Type は分類の手がかりなので、ずれると検索が壊れる。

---

## 9. 運用メモ

- **強制ではない**。pre-commit hook 等で機械的に弾かない。判断はコミット作成者に委ねる。
- **既存コミットの書き換えは原則しない**。規約導入前のコミットは時代の境目として残す。
- **迷ったとき** は最小限の Subject だけで commit してよい。完璧な body より、こまめなコミットが優先。
- **Claude にコミット作成を依頼するとき**: このドキュメントが参照される。明示的に「日本語で」「Subject のみで」など指示すれば従う。

---

<!--
  更新履歴:
  - 2026-06-14  初版作成 (Conventional Commits ベースの軽量版を策定)
-->
