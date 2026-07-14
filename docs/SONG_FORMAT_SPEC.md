# `.song` プロジェクトファイル — 設計スペック

> 楽曲全体を「プロジェクトファイル単位」で管理・編集・再生するための保存形式の**設計合意**。
> `MIDI_EDITOR_SPEC.md` と同じ living document で、**実装前に形式・境界・拡張方針を固定**する。
> 数値・フィールドは提案値。

> **実装状況 (2026-07-14 更新):** 最小レイヤ (トラックごとの音符 + 音色 + 選択トラック) を
> `js/core/song.js` (コーデック) と `app/music/song.js` (`snapshotSong` / `applySong`) で実装し、
> ROLL の Ctrl+S / Ctrl+O が `.song` を扱う。SEQUENCER / 保存 UI は未実装のまま、ROLL が当面の
> 楽曲エディタとして `.song` を読み書きする。`bpm` / `beatsPerBar` / `loop` (トランスポート) と
> `arrangement` (クリップ配置) は §6 のとおり **version を上げて加算的に予約** (未実装)。

決定経緯: 2026-07-14、マルチトラック化 (4 トラック固定) の実装に伴い、ファイル保存の扱い・
保存形式・音色永続化の単位を分析。関連 memory: `music-apps-direction` / `music-app-integration` /
`midi-editor-v1-spec`。関連コード: `core/clip.js` (既存クリップ形式) / `app/music/song.js`
(今回作った共有 4 トラックモデル = 直列化の対象)。

---

## 1. 正体 (一行定義)

**「複数トラック + 各トラックの音色 + クリップ配置 + トランスポートを 1 ファイルに束ねる、
楽曲まるごとのプロジェクトコンテナ」**

ROLL のクリップ (`.roll`) が「音符と時間だけ」の**単一フレーズ**なのに対し、`.song` は
それらを**楽曲として組み上げる上位層**。`MIDI_EDITOR_SPEC.md §13` が将来項目として予約してきた
**SEQUENCER (クリップ配置) / MIXER** の器であり、今回の 4 トラック化で作った共有ソングモデル
(`app/music/song.js`) を**永続化した姿**にあたる。

## 2. 2 層モデル — `.roll` と `.song` の関係

| | `.roll` (既存) | `.song` (本提案) |
|---|---|---|
| 単位 | 単一クリップ (フレーズ) | 楽曲プロジェクト |
| 中身 | 音符と時間だけ | 複数トラック + 音色 + クリップ配置 + テンポ |
| モデル | `core/clip.js` | `core/song.js` (将来) |
| 役割 | 交換 / 再利用の最小グレイン | 制作・再生の単位 |

**`.roll` は変更しない。** 「音符と時間だけ」の最小・MIDI 互換モデルとして維持し、単一フレーズの
交換/再利用グレインであり続ける (`clip.js` ヘッダ / `MIDI_EDITOR_SPEC §4` の非目標を尊重)。
`.song` はその上位のコンテナで、**クリップのノートスキーマ `{pitch,start,len,vel}` を再利用**する
(モデルを二重に作らない)。

## 3. 音色永続化の単位 → **トラック**

今回の 4 トラック化で確立したとおり、音色 (波形 / ADSR / 音量 / ボイス数) は **トラック単位**で
持つ。SYNTH の「単一 patch」概念は廃され、patch はトラックの一属性になった (`app/music/song.js`)。
`.song` はトラック配列を持ち、各トラックが自分の device/patch を内包する。
→ 「どの単位で音色を永続化すべきか」の答えは**トラック**。

## 4. クリップの持ち方 → **インライン埋め込み** (推奨)

`.song` は全ノートを**内包**し自己完結する (1 ファイル = 1 楽曲)。

- ユーザー意図「楽曲をプロジェクトファイル単位で管理」に合致 (ポータブルな単位、参照切れなし)。
- VFS は localStorage の単一 JSON ブロブ (`core/vfs.js`) でファイル間参照が脆く、export 機構も未実装。
- クリップの「楽曲内の時間位置」「クリップ間の参照関係」は song 側のアレンジ属性で、埋め込み前提。
- `.roll` は引き続き単一フレーズの export/交換に使える (相互運用可能。`.song` へ取り込む/書き出す)。

外部 `.roll` 参照方式は「クリップ再利用」に強いが、参照管理・参照切れの解決が要る。**現段階は
自己完結性を優先し埋め込みを採る** (将来クリップライブラリを作るなら参照方式を追加検討)。

## 5. コーデックの型 → `core/clip.js` を踏襲

`core/clip.js` を鏡写しにした **`js/core/song.js`** (将来実装):

- 自己記述メタ: `SONG_FORMAT = "pixera-song"` / `SONG_VERSION = 1` / `SONG_EXT = ".song"`。
- `serializeSong(song)` / `parseSong(text)` — **防御的パース** (壊れた JSON → null、format タグ検証、
  各フィールドを clamp/正規化、`version` は前方互換の足場)。JSON テキストを VFS `writeFile`/`readFile`。
- アプリ連携: `files.js` の `FILE_ASSOC` に `".song": "SONG"` を追加 + `FILE_HANDLERS` + `wmRegister`
  で SONG/SEQUENCER アプリを登録 (新アプリ実装時)。ROLL の `.roll` save/load と同じ三角形を複製する。

## 6. スキーマ (最小を今・残りは加算的に予約)

大規模構想 (エフェクト / PAN / Mute-Solo / オートメーション / クリップ参照…) を**加算的**に
受け入れる形にし、まず 4 トラックチップチューンに必要な最小フィールドだけ実体化する
(`clip.js` が MIDI 互換のため velocity 枠を残しつつ v1 では固定運用にした、あの「枠は先に、
実装は後から」規律と同じ)。

```jsonc
song = {
  format: "pixera-song", version: 1,
  bpm, beatsPerBar, loop: { start, end, on },        // トランスポート (transport.getClock 由来)
  tracks: [ track... ],                              // 今は 4、将来可変
  // ── 将来 (加算) ──
  //   arrangement: [...]   // クリップ配置 (楽曲時間軸)
  //   automation:  [...]   // パラメータ自動化
  //   trackOrder:  [...]   // トラックの並び順
}

track = {
  name, type: "instrument",                          // 将来: "audio" | "automation"
  device: { kind: "synth",
            patch: { waveform, a, d, s, r, volume, maxVoices } },  // 将来: kind:"sampler"
  clips: [ clip... ],                                // 今は 1 トラック 1 クリップ
  // ── 将来 (加算) ──
  //   volume, pan, mute, solo
  //   effects: [ { kind: "delay"|"reverb"|"chorus"|"saturation", ...params } ]
}

clip = { notes: [ { pitch, start, len, vel } ], steps, stepsPerBeat }
  // ── 将来 (加算) ──
  //   position     // 楽曲全体における時間位置
  //   loopRange    // クリップ内ループ範囲 / 再生開始・終了
  //   ref          // クリップ間の参照関係 (参照コピー / 値コピー)
```

**現段階で出力するのは**: `format`/`version`, `bpm`/`beatsPerBar`/`loop`, `tracks[4]`
(各 `name` + `type:"instrument"` + `device.patch` + `clips[1]`)。
`effects` / `pan` / `mute` / `solo` / `automation` / `arrangement` / `type:"audio|automation"` は
**スキーマ枠のみ予約**し出力しない。Audio (サンプル再生 = Sampler デバイス) / Automation は現状
土台コードが皆無なので、別タスクで設計する。

## 7. 現状 (Part A: 4 トラック実装) との対応

今回の実装で `app/music/song.js` が保持する in-memory モデルが、そのまま `.song` の直列化対象:

| in-memory (`song.js`) | `.song` フィールド |
|---|---|
| `track.name` | `track.name` |
| `track.patch {waveform,a,d,s,r,volume,maxVoices}` | `track.device.patch` |
| `track.clip {notes,steps,stepsPerBeat}` | `track.clips[0]` |
| 共有 `transport` (bpm/loop/beatsPerBar) | song 直下 `bpm`/`loop`/`beatsPerBar` |

`serializeSong` は各トラックの patch と clip、共有トランスポート状態を集めるだけで組み上がる
(clip 部は `core/clip.js` の正規化を再利用)。読み込み時は patch を `song.updatePatch`、
clip を `song.setClipNotes` へ流し込み、`transport.setTempo`/`setLoop` を呼ぶ。

## 8. 保存の扱い (段階)

- **今回 (Part A)**: 4 トラックは **in-memory のみ** (音楽スタック全体が非永続な現状と整合)。
  ROLL の `.roll` save/load は**選択トラックのクリップ**に対して従来どおり動く。リロードで既定へ戻る。
- **将来 (本提案の実装)**: `.song` で楽曲まるごと (4 クリップ + 4 音色 + テンポ/ループ) を保存。
  SONG/SEQUENCER アプリが save/load UI (`openFileDialog` + VFS) を持つ。`.roll` は単一クリップの
  取り込み/書き出しとして併存。

## 9. 非目標 (本形式 v1 の外)

- Audio トラック (サンプル再生) / Automation の実体 (スキーマ枠のみ予約)。
- エフェクト / MIXER (PAN / Mute / Solo / センド) の実体。
- 可変トラック数 (今は 4 固定)、トラック名/用途の UI 編集。
- `.mid` 入出力 (クリップは互換形状。コーデックは別途)。
- クラウド同期 / ファイル間参照 (自己完結の埋め込みを優先)。
