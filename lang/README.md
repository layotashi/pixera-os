# Tessera — generative-art の小さな言語

アート / CG / 数学のクリエイターのための、小さなクリエイティブ・コーディング言語。
**Tessera** = モザイクの一片（タイル）。1-bit のセルを敷き詰めて絵にする本質を表す。
拡張子 `.tess`、通称テス。tessellation（平面充填）と同語源。

**1-bit・低解像度・ディザが前提**の言語（tixy 寄り）。Processing/oF のような汎用ではなく、
レトロ制約下で最良のヴィジュアルプログラミングをするための言語。**1-bit はホスト差し替え
可能なディテールではなく言語の前提**（媒体非依存＝色/高解像度 は目標ではない）。

**独立性＝デプロイ独立**（媒体非依存ではない）。言語コアは SYNESTA アプリに hard 依存しない
ので、SYNESTA 内の TESSERA アプリでも、スタンドアロンの公開 Web エディタでも、**同じ
SYNESTA 1-bit canvas スタック**で同等の体験を提供できる（OSS 公開もあり得る）。

## 北極星
- **low floor, high ceiling** — tixy / p5.js のような入りやすさ＋上級者の高い天井。
- **慣習・正確さ優先の命名** — GLSL / Processing / 数学の伝統に従い、造語を避ける
  （`mix` `clamp` `fract` `smoothstep` `point` `line` `stroke` `dist` `noise` `fbm`
  `worley`（セルラー＝voronoi/stone 風）…）。
  世界観・詩情は判断材料にしない。対象読者にとって最小の驚きを最優先。
- **場↔描画の層分け** — stdlib は素の値を返す（`sin` は [-1,1]）。0..1 正規化や Bayer ディザ等の
  ラスタライズは**別レイヤ（共有レンダラ `core/field_render.js`）**が担う（内部規律。媒体
  非依存の主張ではない）。表示方式は `view:` でコードから宣言でき、レンダラが解釈する。
- **決定論** — `seed` で完全再現。コードそのものが作品＝レシピ（表示方式も `view:` で含められる）。
- **大小文字を区別しない** — SYNESTA は表示が常に大文字なので `PIXEL` と `pixel` が同じ見た目に
  なる。混乱を避けるため識別子は大小無視で一致させる（lexer が小文字へ畳む。整形は字面を保つ）。
  ホスト側のエディタも入力を大文字化する（入力＝表示＝パースを一致）。

## 段階（tier）
- **Tier0 — 場(field)**: 裸の式 `f(x,y,t)` を全セルで評価（`f(x,y,t) =` ヘッダは任意）。✅
  - **値ブロック**: 最終式の前に `代入` / `repeat { … }` 文を置ける（セル毎に評価）。
    セル内反復・総和で **julia / quasicrystal / metaball** 等の閉形式を書ける
    （例: `m=0` ＋ `repeat 24 { … m=m+… }` ＋ 最終式 `clamp(1-m/200,0,1)`）。
    発散しうる反復は `clamp` で抑える（escape/break は未実装＝予算固定）。
- **Tier1 — 描画(draw)**: `draw { … }` で手続き的に描く。`repeat` / `point` / `line` /
  `stroke` / `clear`。座標 [0,1]、自動クリアなし。✅
- **Tier2 — 状態を持つ場**: `field { … }`。セル毎にチャンネルごとのスカラー状態を持ち、毎
  フレーム step で更新（ping-pong・同期更新）。近傍は `lap()`（離散ラプラシアン）/ `nbr(dx,dy)` /
  `sum8()`（8 近傍和）で wrap（トーラス）参照＝**現チャンネル**に作用。✅
  - 単一: `field { init: … step: … show: … }`（暗黙チャンネル s）。拡散・CA・成長系。
  - 多チャンネル: `Du = …`（定数）＋ `u: { init: … step: … }` 複数 ＋ `show: …`。他チャンネルは
    名前で現在値参照。**真の反応拡散（Gray-Scott / Gierer / FitzHugh-Nagumo 等）**。
    近傍 `lap()/nbr()/sum8()` は常に**現チャンネル**に作用する（高階微分のためのクロス
    チャンネル近傍は、出力画が 1-bit アート的に面白くないため廃止＝言語をシンプルに保つ）。

形は `draw {}` / `field {}` の有無で自動判別（裸の式＝Tier0）。式コアは全 tier で共有。

**設定ディレクティブ** — トップレベルの軽量宣言（順不同・任意・省略時は既定）で、表示方式・
出力サイズ・乱数まで**コードに含められる**（recipe 自己完結・p5 的）。`field{}` の channel
構文（`u: {…}`）はブレース内なので衝突しない。

| ディレクティブ | 例 | 意味 |
|---|---|---|
| `view:` | `view: halftone(8)` | 表示方式と数値パラメータ（dither/hatch/halftone/braille/ascii ＝ 1-bit で映える「面」系） |
| `canvas:` | `canvas: 1920x1080` | 出力解像度（外寸px。`1920 1080` でも可）。base(ドット数)=canvas/8。プレビューもこのアスペクト比 |
| `pad:` | `pad: 64` | 額縁マット（出力px） |
| `fps:` | `fps: 20` | アニメ/書き出しのフレームレート（ホストは 100 の約数へスナップ） |
| `period:` | `period: tau` | ループ周期秒（定数式可。プレビュー周回・GIF/MP4 のシームレスループ長） |
| `seed:` | `seed: 42` | 乱数シード（rnd/noise/fbm・状態場の初期化） |

> **pixel は廃止**。TESSERA は **8 固定**（1 アートドット = 8 出力px のチャンキー 1bit が核）。
> 互換のため言語は `pixel:` を受理するが TESSERA は無視する。

コアはこれらを**不透明データ**として持つだけで**ラスタライズ・適用しない**。既定値・範囲クランプ・
実際の出力はホスト（TESSERA / `art_export`）の責務。未指定は各ホストの既定（TESSERA は
`dither(2)` / `1080x1080` / `pixel=8固定` / `pad:80` / `fps:20` / `seed:0` / `period:tau`）。

## アーキテクチャ（薄いコア → 複数デプロイ）
言語ランタイムは抽象「サーフェス」契約（`surface.js`）に対してのみ描画する。デプロイ先
（SYNESTA アプリ / 公開 Web エディタ）が契約を実装する。両デプロイとも**同じ 1-bit canvas
スタック**を使う想定（媒体差し替えではなく配布形態の差）。

- 言語本体（core/stdlib/runtime）はデプロイ先を import しない＝描画なしで単体テスト可能・
  スタンドアロン配布可能。これが「独立」の実体。
- ラスタライズ（0..1 → 1-bit、dither/hatch/…）は共有レンダラ `js/core/field_render.js` が担い、
  GENART と TESSERA で共有する。
- `playground/`（canvas2D + HTML の薄いシム）は当面の**開発ハーネス**。公開 Web エディタの
  本命は「SYNESTA スタックをそのまま canvas 内 UI で出すスタンドアロン版」（将来）。

```
/lang
  README.md          ← これ
  surface.js         ← 抽象サーフェス契約 + ディザ + makeBufferSurface（1-bit FB）
  core/  lexer parser interp     ← 言語コア（依存ゼロ）
  stdlib.js          ← 関数ボキャブラリ（純関数。surface 非依存）
  runtime.js         ← ソース → 場/描画/状態場 へコンパイル（形を自動判別）
  format.js          ← 整形（トークン再出力。意味不変・コメント保持・折返しなし）
  smoke.mjs          ← node 動作確認
  playground/        ← ブラウザ開発ハーネス（エディタ + ライブプレビュー）
```

SYNESTA 統合: `js/app/tessera.js`（TESSERA）が唯一の creative-coding ウィンドウ。場(field/cells)
は **共有レンダラ**で 1-bit 化：ピクセル方式は `js/core/field_render.js`、ASCII は
`js/core/ascii_art.js` の `renderAsciiLines`（場→文字グリッド）。表示方式・出力は**すべてコードの
設定ディレクティブ**で指定し、画面のコントロールは「形式 + DL」のみ＝最小。プレビューは `canvas:` の
アスペクト比を反映。`.buf` を GPU.blit。draw は point/line を直接描く。書き出し（合成→PNG/GIF/MP4）は
共有 `js/core/art_export.js`。VFS 連携（`.tess` 保存/読込、サンプルは `/TESSERA/LEARN`（番号順チュートリアル）と `/TESSERA/GALLERY`（作例））。
Ctrl+E 書き出し / Ctrl+R シード振り直し / Shift+Alt+F 整形。エディタの指針は 40桁。

## 現状
Tier0（場・**値ブロック**）+ Tier1（描画）+ Tier2（状態を持つ場・単一/多チャンネル反応拡散）
を実装。SYNESTA との **場レンダラ共有（北極星 B）** はピクセル方式（`core/field_render.js`）＋
ASCII（`core/ascii_art.js` の `renderAsciiLines`）まで完了。

**統合（GENART → TESSERA 一本化）** 完了：
- 言語拡張（`worley` ＋ Tier0 値ブロック）で julia / metaball / 細胞模様 等を表現可能に。
- GENART の算法を `.tess` サンプルへ移植（学習用 `/TESSERA/LEARN` ＋ 作例 `/TESSERA/GALLERY`）。出力パイプライン
  （compose/pixel/size/PNG·GIF·MP4）を TESSERA ＋ 共有 `core/art_export.js` へ移設し、GENART を削除。

**シンプル化（言語を美しく保つ）**：1-bit アート的に映えない・教材化しにくい機能を削除。
- クロスチャンネル近傍（Swift-Hohenberg / Cahn-Hilliard 用）＝数学は高度だが出力画が退屈、を廃止。
- 線ベースの表示方式 `contour` / `scanline` ＝ 1-bit で映えない、を廃止（面系のみ残す）。
