/**
 * @module app/tessera
 * tessera.js — TESSERA — ライブコーディング環境（Tessera 言語）
 *
 * lang/（PIXERA OS とは独立した generative-art の小言語 "Tessera"）を PIXERA OS に統合した
 * creative-coding ウィンドウ。左でコードを書き、右でライブプレビュー。拡張子は `.tess`。
 *
 * 名前: tessera = モザイクの一片（タイル）。1-bit のセル/ピクセルを敷き詰めて絵にする
 * この言語の本質。tessellation（平面充填）と同語源。
 *
 * 立ち位置: PIXERA OS 唯一の generative-art アプリ。プリセットやノブは持たず「書いて創る」
 * コード一本。学習用 `/Sketches/Learn` と作例 `/Sketches/Gallery` の `.tess` サンプルを備える。
 *
 * 統合の要: 言語は抽象 surface 契約だけに依存。lang/surface.js の純粋な
 * makeBufferSurface（1-bit FB）に描かせ、その .buf を GPU.blit するだけ。合成・書き出しは
 * 共有モジュール core/art_export.js。
 *
 * 設定はすべてコードの設定ディレクティブで宣言する（recipe 自己完結）:
 *   canvas: WxH / pad: N / fps: N / seed: N / period: 秒 / view: mode(args)
 *   （1 アートドット = 8 出力px 固定＝チャンキー 1bit が核）
 * 画面のコントロールは「書き出し形式 + DL」のみ＝最小（設定はコード側）。
 * プレビューは canvas のアスペクト比を反映。
 *
 * 音（任意）: `sound:` ブロックで「時間の場」a(t) -> -1..1 を書ける（視覚が空間の場なのと
 *   同型・チップチューン割り切り）。1 周期ぶんをオフラインレンダ → ループ AudioBuffer で
 *   period 同期再生（Alt+P でトグル）。無ければ従来どおり無音。`voice <名前>: <式(f)>` で
 *   名前付き音色（＝トラック名）を宣言し、音の場から `名前(freq)` で呼んで `+` で混ぜる。
 *   AV 同期: 視覚の場から `amp`（音の振幅エンベロープ 0..1）や `beat(n)`/`step(n)` を読める
 *   ＝オーディオリアクティブ（決定論＋t/period 共有なので外部アナライザ不要）。
 *
 * 構成:
 *   - トップツールバー(1 行): 形式(PNG/GIF/MP4) + EXPORT/RESEED/SAVE/OPEN/NEW/WALLPAPER。
 *     EXPORT は「いまプレビューに出ている見た目」を書き出す（作品 or コードカード）。
 *   - 左: コードエディタ (TextArea)。編集で即 compile。
 *   - 右: ライブプレビュー（ツールバーの下・size のアスペクト比、surface.buf を整数倍 blit）
 *   - プレビュー直下: カードの見た目トグル CODE / ART INV / CODE INV（CODE ON でコードを
 *     重ねた「コードカード」に。pad を額縁＆コード余白に使う。INV は作品層/コード層 別々）
 *   - footer: エラー (pos 付き) / 状態 (size・seed) / 書き出し進捗
 *
 * VFS / 操作:
 *   - Alt+N 新規 / Ctrl+O 開く / Ctrl+S 保存 / Ctrl+Shift+S 名前を付けて保存
 *   - Ctrl+E / EXPORT で作品を size ちょうどに PNG/GIF/MP4 書き出し。MP4 は sound: があれば
 *     音声入り（1 周期を AAC 化して多重化＝ループ一致。AAC 非対応環境は映像のみ + footer で明示）。
 *     WAV は sound: の 1 周期を音声書き出し。CODE はソースを 1080² の PIXERA OS カードとして
 *     書き出す。Ctrl+R で seed: 振り直し。
 *   - ライブ編集耐性: コンパイル/評価に失敗しても直前の good を流し続ける（映像/音が途切れない）。
 *   - PERFORM（ライブ演奏ビュー）: Alt+Enter / F11 でフルスクリーン化し、画面そのものが
 *     キャンバスになる（1 アートドット = PERFORM_CHUNK(=4) 画面px。canvas:/pad: は無視、Esc / F11 で解除）。
 *     動くアートの上に「暗色バー + 明色 2x コード + カーソル」のオーバーレイエディタが重なり、
 *     通常どおり編集できる（編集モデルは同じ TextArea。編集は即 recompile ＝ライブコーディング）。
 *     エラーは最下端の反転バーに出し、映像/音は直前 good が流れ続ける。
 *   - Alt+W で現在の場をデスクトップ背景に。Alt+P で音の再生/停止。Shift+Alt+F で整形。
 *     未保存変更は破棄確認。サンプルは /Sketches/Learn（番号順・09 で音）と /Sketches/Gallery。
 *   - FILES から .tess をダブルクリックで開く（tesseraOpenFile）。
 */

import * as WM from "../wm/index.js";
import * as UI from "../ui/index.js";
import * as GPU from "../core/gpu.js";
import * as VFS from "../core/vfs.js";
import { drawText, textWidth, getGlyph, GLYPH_W, GLYPH_H } from "../core/font.js";
import { altShiftDown, altDown, ctrlDown, ctrlShiftDown, keyDown } from "../core/input.js";
import * as FieldRender from "../core/field_render.js";
import * as AsciiArt from "../core/ascii_art.js";
import * as ArtExport from "../core/art_export.js";
import {
  MODE_PARAMS,
  VIEW_PARAM,
  PERIOD_CAP_S,
  resolveTessConfig,
  makeFieldSurface,
} from "../core/tess_host.js";
import { initAudio, getAudioContext, getMasterGain, dcBlock } from "../core/audio.js";
import { encodeWav } from "../core/wav.js";
import { compile } from "../../lang/runtime.js";
import { makeBufferSurface } from "../../lang/surface.js";
import { format } from "../../lang/format.js";
import * as Wallpaper from "../wallpaper.js";
import { DEFAULT_CODE, HOME_DIR, EXT, seedSamples } from "./tessera/samples.js";

const APP_NAME = "TESSERA";

// ── レイアウト/プレビュー ──
// レイアウトは**固定**（naturalSize = 規定解像度 360x270 基準で配置。ウィンドウの
// リサイズには追従しない＝リフローしない）。窓を小さくすると WM が窓側の縦横スクロールで
// 巡らせ、maximize / fit-to-content で 360x270 にちょうど収まる。上=全幅ツールバー、
// 左=コードエディタ（135px プレビュー隣の最大幅・縦は全高・長い行はエディタ自身が横スクロール）、
// 右=135px 固定ライブプレビュー＋見た目トグル。
// COLS/ROWS は初期値のみ（実際の表示桁数/行数は fitEditor が px から算出して上書き）。
// COLS=39 は PERFORM の桁基準・桁ガイド（guideCol）としても使う不変値。
const COLS = 39;
const ROWS = 24;
const MAX_LINES = 9999;
// エディタが割り込まれても最低限の可読幅を確保する桁数（プレビューはこの残りに収める）。
const MIN_EDIT_COLS = 24;
// プレビュー枠の長辺px。出力合成（art→額縁→base）をクリーンな倍率(整数 or 1/整数)＋NN で
// 見せる＝pixel の粗さ・pad が WYSIWYG かつ半端比率のモアレ無し。
// 規定解像度 360x270 で最も映える**固定値**（非レスポンシブ）。ウィンドウのリサイズには
// 追従しない。1080² キャンバスならクリーン 1:1 = 135px。previewScale がこの枠へ量子化する。
const PREVIEW_BOX = 135;
const GAP = 8; // エディタ⇄プレビュー間 / 縦の区切り


// ── レンダーモード（場 → 1-bit。共有 core/field_render.js を使う） ──
// 場の blitField を共有レンダラへ通す。方式は view: でコードから宣言する。
const RENDER_MODES = ["dither", "ascii", "hatch", "halftone", "braille"];

// ── ASCII（場 → 文字グリッド → グリフ）。共有コア core/ascii_art.js を使う ──
const ASCII_RAMP_CHARS = " .-:;+=*&%@$#";
let _asciiRamp = null;
function asciiRamp() {
  if (!_asciiRamp) _asciiRamp = AsciiArt.buildToneRamp(ASCII_RAMP_CHARS);
  return _asciiRamp;
}
let asciiActive = false; // onDraw で確定（ascii モードか）
// 方式パラメータの既定 (MODE_PARAMS) と view→パラメータ表 (VIEW_PARAM) は
// tess_host.js に集約 (壁紙と共有)。
const DEFAULT_MODE = "dither";
// 実効モード/パラメータ（onDraw で config.view 優先で確定し、blitField が参照）。
let activeMode = DEFAULT_MODE;
let activeParams = MODE_PARAMS;

// ── 出力サイズモデル（すべてコードの設定ディレクティブから。ウィジェットは廃止）──
// 出力 = base ×PIXEL（PIXEL=8 固定, tess_host.js）。base = 出力 ÷ PIXEL の解像度で
// 描き、整数 ×PIXEL で書き出す。canvas が実質「ドット数（base = canvas/8）」を決める。
// 額縁 pad は出力px。fps スナップ表 / period 既定(TAU) / 上限(PERIOD_CAP_S) も
// すべて tess_host.js に集約（プレビュー・書き出し・壁紙で同一の実効設定）。
// PERFORM は「画面を埋めるライブビュー」なので EXPORT の PIXEL とは別軸。低解像度な画面で
// 8px/ドットだとドット数が少なく粗すぎるため、4px/ドットで細かく描く（既定キャンバス 1080→
// 135 ドットに近い密度になる）。24px の行ピッチ（=6 チャンク）とも整数整合するので美しい。
const PERFORM_CHUNK = 4;
// 音の出力ゲイン。sound: の a(t) は ±1 フルスケールなので、そのまま出すと過大＝AAC で
// 歪む/クリップする。再生（playAudio の GainNode）と書き出し（exportAudioPcm）で同じ値を
// 掛けて音量を一致させる＝WYSIWYG（SSoT。ここだけを変えれば両方に効く）。
const AUDIO_GAIN = 0.3;
const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

/**
 * program.config（生の宣言値）を実効設定へ解決する。
 * 既定値・クランプ・fps スナップ・view 解決の規則は tess_host.js が SSoT。
 * 返り値は { sizeW, sizeH, pixel, pad, fps, seed, period,
 * viewMode, viewParams }（tessera は前 7 つ、壁紙は seed/period/fps/view を使う）。
 */
function resolvedConfig(prog = program) {
  return resolveTessConfig((prog && prog.config) || {});
}

/** 出力寸法を実効設定から導出（base / art / pad[base上] / pixel / fps）。 */
function outputDims() {
  const { sizeW, sizeH, pixel, pad, fps } = resolvedConfig();
  const baseW = Math.round(sizeW / pixel);
  const baseH = Math.round(sizeH / pixel);
  const bpad = Math.round(pad / pixel);
  const artW = Math.max(8, baseW - 2 * bpad);
  const artH = Math.max(8, baseH - 2 * bpad);
  return { baseW, baseH, artW, artH, pixel, fps };
}

const EXPORT_FORMATS = [
  { key: "png", label: "PNG" },
  { key: "gif", label: "GIF" },
  { key: "mp4", label: "MP4" },
  { key: "wav", label: "WAV" }, // 音のみ（sound: の 1 周期を書き出し）
];
let exportFormatIdx = 0; // availableFormats() のインデックス
/** この環境で選べる書き出し形式（MP4 は WebCodecs 対応時のみ）。 */
function availableFormats() {
  return EXPORT_FORMATS.filter((f) => f.key !== "mp4" || ArtExport.isMp4Supported());
}
function currentFormatKey() {
  const a = availableFormats();
  return (a[exportFormatIdx] || a[0]).key;
}
let statusText = ""; // 書き出し進捗（footer 右に表示）

/** プログラムの view: があればそれを、無ければ既定方式（dither）を実効方式とする。 */
function effectiveRender() {
  const v = program && program.config && program.config.view;
  if (v && RENDER_MODES.includes(v.mode)) {
    const params = { ...MODE_PARAMS };
    if (v.args.length && VIEW_PARAM[v.mode]) params[VIEW_PARAM[v.mode]] = v.args[0];
    return { mode: v.mode, params };
  }
  return { mode: DEFAULT_MODE, params: MODE_PARAMS };
}

// ── 音のライブ再生（P1）─────────────────────────────────────────────
// 音は決定論的で period でループするので、1 周期ぶんをオフラインレンダ →
// ループする AudioBuffer で鳴らす（グリッチ皆無・継ぎ目なし・WAV/MP4 書き出しと同じ
// レンダラを共用）。連続音や外部入力への即時反応が要るまで AudioWorklet は持ち込まない。
// P1 は Alt+P でトグル（押すたびに現在のコードを作り直して再生＝Strudel 的な commit）。
let audioSource = null; // 再生中の AudioBufferSourceNode（null=停止）
let audioGain = null;

/** 再生を停止しノードを破棄する。 */
function stopAudio() {
  if (audioSource) {
    try {
      audioSource.stop();
    } catch {
      /* すでに停止済みなら無視 */
    }
    audioSource.disconnect();
    audioSource = null;
  }
  if (audioGain) {
    audioGain.disconnect();
    audioGain = null;
  }
}

/**
 * いま画面に出ている映像の位相（秒）。onDraw の t 計算と同一式。
 * 音の開始オフセットに使い、映像と音を同位相で始める（＝完全同期）。
 */
function currentVisualTime() {
  const { fps, period } = resolvedConfig();
  const frameIdx = Math.floor(((performance.now() - t0) / 1000) * fps);
  return (frameIdx / fps) % period;
}

/** 現在のプログラムの音の場を 1 周期ぶんレンダしてループ再生する。 */
function playAudio() {
  stopAudio();
  if (!program || !program.audio) return; // sound: が無ければ何もしない
  initAudio();
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume();
  const { seed, period } = resolvedConfig();
  const sr = ctx.sampleRate;
  const data = program.audio.renderAudio(sr, period, seed, period); // 決定論・1 周期
  const buf = ctx.createBuffer(1, data.length, sr);
  buf.getChannelData(0).set(data);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true; // period でシームレスループ（視覚のループと同じ長さ）
  const g = ctx.createGain();
  g.gain.value = AUDIO_GAIN; // 書き出しと同じ出力ゲイン（WYSIWYG）
  src.connect(g);
  g.connect(getMasterGain()); // masterGain→dcBlocker(HP20)→limiter（DC 除去＋クリップ防止）
  // 映像と完全同期: いま画面に出ている映像の位相から音を開始する（映像クロックは
  // 触らない＝映像は途切れない）。ループ長は双方 period なので以後ずっと同位相でロックする。
  const bufDur = data.length / sr;
  const offset = ((currentVisualTime() % bufDur) + bufDur) % bufDur;
  src.start(ctx.currentTime, offset);
  audioSource = src;
  audioGain = g;
}

/** Alt+P: 再生/停止トグル。sound: が無いプログラムでは無音。 */
function toggleAudio() {
  if (audioSource) stopAudio();
  else playAudio();
}

/**
 * sound: の 1 周期を書き出し用 PCM にする（WAV/MP4 共通）。
 * 再生（Alt+P）と同じ出力処理を掛けるので、ファイルが再生と同じ音・同じ音量になる
 * ＝WYSIWYG: 生の a(t) → DC ブロック（再生時のマスター HP20 相当） → 出力ゲイン AUDIO_GAIN。
 * DC ブロッカはループ前提で 1 周ぶん暖機してから本番の 1 周を採る（起動過渡＝境界の
 * クリックを消す。周期信号なので 2 周目は暖機済み＝ループ端が滑らかに繋がる）。
 */
function exportAudioPcm(prog, sr, period, seed) {
  const dry = prog.audio.renderAudio(sr, period, seed, period); // 決定論・1 周期
  const two = new Float32Array(dry.length * 2); // 2 周ぶんでフィルタを暖機
  two.set(dry, 0);
  two.set(dry, dry.length);
  const hp = dcBlock(two, sr).subarray(dry.length); // 2 周目（暖機済み）
  const out = new Float32Array(dry.length);
  for (let i = 0; i < out.length; i++) out[i] = hp[i] * AUDIO_GAIN;
  return out;
}

/**
 * Alt+Enter: PERFORM（フルスクリーンのライブ演奏ビュー）トグル。
 * TESSERA では fullscreen ⇔ PERFORM を 1:1 同期する（F11 と等価。onDraw 冒頭で同期）。
 */
function togglePerform() {
  if (winId !== null) WM.wmToggleFullscreen(winId);
}

// ── AV 同期（P3）: 視覚の場が音を読む ─────────────────────────────────
// 決定論＋t/period 共有なので、外部アナライザ無しで「音に反応する画」が作れる。
// renderField が毎フレーム amp（音の振幅エンベロープ）と音クロック(period)を視覚の場へ渡す
// ＝視覚の場で amp / beat(n) / step(n) / decay が使える。プレビューも書き出しも同じ経路。

/** amp(t) = 音の振幅エンベロープ [0,1]（短い窓の RMS）。sound: が無ければ 0。 */
function ampAt(prog, t, seed, period) {
  if (!prog || !prog.audio) return 0;
  const W = 0.04,
    K = 64; // 約 40ms の窓を 64 点でならす（決定論・軽量）
  let s = 0;
  for (let i = 0; i < K; i++) {
    const v = prog.audio.sampleAudio(t + (i / K) * W, seed, period);
    s += v * v;
  }
  const r = Math.sqrt(s / K);
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

/** 視覚の場を描画する共通ラッパ。AV 同期の uniform（period, amp）を渡す。 */
function renderField(prog, surf, t, seed) {
  const period = resolvedConfig(prog).period;
  prog.render(surf, t, seed, { period, amp: ampAt(prog, t, seed, period) });
}

// ── PERFORM 描画: 画面そのものがキャンバス ─────────────────────────────
// canvas:/pad: は無視し、グリッド = floor(画面/CHUNK) ドット（1 アートドット = CHUNK 画面px）。
// 割り切れない解像度 (480x270 等) は余り (≤CHUNK-1px) を上下左右に折半した暗色レターボックス。
// view: は尊重するが ascii はオーバーレイと噛み合わないため dither 代替 (CODE カードと同じ規則)。
function drawPerform(cr) {
  if (!program) return;
  const eff = effectiveRender();
  activeMode = eff.mode === "ascii" ? "dither" : eff.mode;
  activeParams = eff.params;
  asciiActive = false;
  const { seed, period, fps } = resolvedConfig();
  // 通常プレビューと同じ fps 量子化・period 周回（音同期 currentVisualTime とも一致）。
  const frameIdx = Math.floor(((performance.now() - t0) / 1000) * fps);
  const t = (frameIdx / fps) % period;
  const gw = Math.max(1, Math.floor(cr.w / PERFORM_CHUNK));
  const gh = Math.max(1, Math.floor(cr.h / PERFORM_CHUNK));
  try {
    if (frameIdx !== _pvFrame || _pvCache === null) {
      ensureSurface(gw, gh);
      renderField(program, surface, t, seed);
      if (artInv) {
        const b = surface.buf;
        for (let i = 0; i < b.length; i++) b[i] = b[i] ? 0 : 1;
      }
      // 整数 CHUNK× NN 拡大＝ドット正確（クリーン倍率・モアレ無し）。
      const dw = gw * PERFORM_CHUNK,
        dh = gh * PERFORM_CHUNK;
      _pvCache = { buf: ArtExport.resampleNN(surface.buf, gw, gh, dw, dh), w: dw, h: dh };
      _pvFrame = frameIdx;
    }
  } catch (e) {
    // 描画中の例外でも直前の good フレームを保持（ライブ耐性）。
    errMsg = e.message + (e.pos != null ? ` (pos ${e.pos})` : "");
  }
  const pv = _pvCache;
  if (pv) {
    const ox = cr.x + ((cr.w - pv.w) >> 1);
    const oy = cr.y + ((cr.h - pv.h) >> 1);
    GPU.blit(pv.buf, pv.w, pv.h, ox, oy, 1);
  }
}

// ── PERFORM オーバーレイエディタ ──────────────────────────────────────
// 動くアートの上に「暗色バー + 明色 2x コード + カーソル」を重ねる Strudel 流のライブ
// エディタ。編集モデル (行/カーソル/選択/undo/クリップボード/キー処理) は通常モードと
// 同じ TextArea をそのまま使い、ここは描画とマウス座標変換だけを担う専用ビュー。
//
// メトリクス (画面px。コード層は 2px = 1 単位):
//   縦: バー上 6 / 文字 10 / 間 2 / カーソル(下線) 2 / バー下 2 = バー 22 + 透過行間 6 = 28
//     （ピッチ 28 = 4px チャンク 7 個で整数整合。行間 6px でアートが覗く）
//   横: 透過 4 / バー 3 / 文字 10 (字間 2) …/ バー 3 / 透過 4 — 480px 幅に 39 桁が
//       ぴったり対称に収まる (4+3 + (39*12-2) + 3+4 = 480)。広い画面では中央寄せ。
const OV = {
  adv: 12, // 字送り (文字 10 + 字間 2)
  textH: 10, // 2x グリフ (5x5 → 10x10)
  padTop: 6,
  gapCursor: 2,
  cursorH: 2,
  padBottom: 2,
  lineGap: 6, // バー間の透過行間 (アートが覗く)
  barH: 22, // padTop+textH+gapCursor+cursorH+padBottom
  pitch: 28, // barH + lineGap
  barPadX: 3,
  marginX: 4,
};
let _ovScrollRow = 0; // オーバーレイ独自のスクロール (カーソル追従 + ホイール)
let _ovScrollCol = 0;
let _ovDragging = false;
let _ovDragAnchor = null; // ドラッグ選択の起点 {r, c}
let _ovLastCursor = ""; // カーソル移動検知 (追従スクロールはカーソルが動いたときだけ)

/** オーバーレイのレイアウト (アートのレターボックス原点にアンカー＝ドット整合)。 */
function ovLayout(cr) {
  const artW = Math.floor(cr.w / PERFORM_CHUNK) * PERFORM_CHUNK;
  const artH = Math.floor(cr.h / PERFORM_CHUNK) * PERFORM_CHUNK;
  const ax = cr.x + ((cr.w - artW) >> 1);
  const ay = cr.y + ((cr.h - artH) >> 1);
  // 画面に入る桁数 (対称余白込み・上限 COLS)。480 幅 → ちょうど 39。
  const usable = artW - 2 * (OV.marginX + OV.barPadX);
  const maxCols = Math.max(1, Math.min(COLS, Math.floor((usable + 2) / OV.adv)));
  const gridW = maxCols * OV.adv - 2;
  const x0 = ax + ((artW - gridW) >> 1); // テキスト左端 (中央寄せ＝左右対称)
  const maxRows = Math.max(1, Math.floor(artH / OV.pitch));
  // 縦も横と同じく中央寄せ＝上下対称。バー群の縦幅 (末尾の行間は含めない) を中央に置く。
  // 内容はこのグリッド内で上詰め (タイプしても動かない)。
  const gridH = (maxRows - 1) * OV.pitch + OV.barH;
  const y0 = ay + ((artH - gridH) >> 1);
  return { x0, y0, maxCols, maxRows };
}

/** グリフを 2x で描く (5x5 → 10x10)。PIXERA OS の表示は常に大文字 (drawText と同じ規約)。 */
function drawGlyph2x(ch, x, y, c) {
  const g = getGlyph(ch.toUpperCase());
  if (!g) return;
  for (let gy = 0; gy < GLYPH_H; gy++)
    for (let gx = 0; gx < GLYPH_W; gx++)
      if (g[gy * GLYPH_W + gx]) GPU.fillRect(x + gx * 2, y + gy * 2, 2, 2, c);
}

/** エディタの選択範囲を正規化して返す (無ければ null)。 */
function ovSelection() {
  const ar = editor.selectionAnchorRow;
  if (ar === null) return null;
  const ac = editor.selectionAnchorCol;
  const br = editor.cursorRow;
  const bc = editor.cursorCol;
  if (ar === br && ac === bc) return null;
  return ar < br || (ar === br && ac < bc)
    ? { r0: ar, c0: ac, r1: br, c1: bc }
    : { r0: br, c0: bc, r1: ar, c1: ac };
}

function ovInSelection(s, r, c) {
  if (r < s.r0 || r > s.r1) return false;
  if (r === s.r0 && c < s.c0) return false;
  if (r === s.r1 && c >= s.c1) return false;
  return true;
}

/** オーバーレイ描画 (drawPerform の上に重ねる)。 */
function drawPerformOverlay(cr) {
  const L = ovLayout(cr);
  const lines = editor.lines;

  // カーソルが動いたときだけ追従スクロール (ホイールの自由スクロールを妨げない)
  const curKey = editor.cursorRow + ":" + editor.cursorCol;
  if (curKey !== _ovLastCursor) {
    _ovLastCursor = curKey;
    if (editor.cursorRow < _ovScrollRow) _ovScrollRow = editor.cursorRow;
    if (editor.cursorRow >= _ovScrollRow + L.maxRows)
      _ovScrollRow = editor.cursorRow - L.maxRows + 1;
    if (editor.cursorCol < _ovScrollCol) _ovScrollCol = editor.cursorCol;
    if (editor.cursorCol >= _ovScrollCol + L.maxCols)
      _ovScrollCol = editor.cursorCol - L.maxCols + 1;
  }
  _ovScrollRow = Math.max(0, Math.min(_ovScrollRow, Math.max(0, lines.length - L.maxRows)));
  _ovScrollCol = Math.max(0, _ovScrollCol);

  const sel = ovSelection();
  const focused = WM.wmIsFocused(winId);
  const blink = Math.floor(performance.now() / 500) % 2 === 0;

  for (let r = 0; r < L.maxRows; r++) {
    const li = _ovScrollRow + r;
    if (li >= lines.length) break;
    const y = L.y0 + r * OV.pitch;
    const visText = lines[li].slice(_ovScrollCol, _ovScrollCol + L.maxCols);
    const isCur = li === editor.cursorRow;
    // バーはその行の内容ぶんだけ (空行はバー無し＝アートが覗く)。カーソルセルは含める。
    let cells = visText.length;
    if (isCur) {
      const cc = editor.cursorCol - _ovScrollCol;
      if (cc >= 0) cells = Math.max(cells, Math.min(cc + 1, L.maxCols));
    }
    if (cells <= 0) continue;
    const barW = OV.barPadX * 2 + cells * OV.adv - 2;
    GPU.fillRect(L.x0 - OV.barPadX, y, barW, OV.barH, 0);
    const uw = GLYPH_W * 2; // 下線幅 = グリフ幅（字間を含まない＝TextArea と同規約）
    const uy = y + OV.padTop + OV.textH + OV.gapCursor; // カーソル/選択の下線 Y
    // 文字（明色）＋選択下線（TextArea と同じく下線で表現）。
    for (let c = 0; c < visText.length; c++) {
      const cx = L.x0 + c * OV.adv;
      drawGlyph2x(visText[c], cx, y + OV.padTop, 1);
      if (sel && ovInSelection(sel, li, _ovScrollCol + c))
        GPU.fillRect(cx, uy, uw, OV.cursorH, 1);
    }
    // カーソル下線 (フォーカス時・ブリンク)。選択下線と同じ Y・太さ。
    if (isCur && focused && blink) {
      const cc = editor.cursorCol - _ovScrollCol;
      if (cc >= 0 && cc < L.maxCols) GPU.fillRect(L.x0 + cc * OV.adv, uy, uw, OV.cursorH, 1);
    }
  }

  // エラーバー: 最下グリッド行に重ね、全幅（コードグリッドと同幅）＋極性反転で描く。
  // グリッドに整列するのでコードとズレず、全幅なので左右対称。ライブ耐性で直前 good が
  // 動き続けるため、「いまのコードは反映されていない」ことをここで知らせる。
  if (errMsg) {
    const msg = ("ERR " + errMsg).toUpperCase().slice(0, L.maxCols);
    const y = L.y0 + (L.maxRows - 1) * OV.pitch;
    const barW = OV.barPadX * 2 + L.maxCols * OV.adv - 2; // 全幅（コード行と同じ）
    GPU.fillRect(L.x0 - OV.barPadX, y, barW, OV.barH, 1); // 明色バー = 警告
    for (let c = 0; c < msg.length; c++)
      drawGlyph2x(msg[c], L.x0 + c * OV.adv, y + OV.padTop, 0);
  }
}

/** PERFORM 中のマウス入力: オーバーレイ座標系で editor モデルを直接操作する。 */
function ovHandleMouse(ev) {
  const cr = WM.wmGetContentRect(winId);
  if (!cr) return;
  const L = ovLayout(cr);
  const lines = editor.lines;
  // ev.localX/Y はコンテンツ原点ローカル → 絶対座標へ (PERFORM は非スクロールなので加算なし)
  const ax = ev.localX + cr.x;
  const ay = ev.localY + cr.y;
  const row = Math.max(
    0,
    Math.min(lines.length - 1, _ovScrollRow + Math.floor((ay - L.y0) / OV.pitch)),
  );
  const col = Math.max(
    0,
    Math.min(lines[row].length, _ovScrollCol + Math.round((ax - L.x0) / OV.adv)),
  );

  switch (ev.type) {
    case "down":
      editor.cursorRow = row;
      editor.cursorCol = col;
      editor.selectionAnchorRow = null;
      editor.selectionAnchorCol = null;
      editor.boxSelection = null;
      _ovDragging = true;
      _ovDragAnchor = { r: row, c: col };
      break;
    case "held":
      if (_ovDragging && _ovDragAnchor) {
        if (row !== _ovDragAnchor.r || col !== _ovDragAnchor.c) {
          editor.selectionAnchorRow = _ovDragAnchor.r;
          editor.selectionAnchorCol = _ovDragAnchor.c;
        }
        editor.cursorRow = row;
        editor.cursorCol = col;
      }
      break;
    case "up":
      _ovDragging = false;
      break;
    case "wheel":
      _ovScrollRow += Math.sign(ev.deltaY) * 2; // 2 行/ノッチ (clamp は draw 側)
      break;
  }
}

// ── プレビュー surface（art 評価解像度で確保。解像度が変わるときだけ再確保＝状態場を温存）──
let surface = null,
  pvW = 0,
  pvH = 0;
/** プレビュー surface を必要なら再確保（解像度が変わったときだけ＝状態場を温存）。 */
function ensureSurface(w, h) {
  if (surface && pvW === w && pvH === h) return;
  pvW = w;
  pvH = h;
  surface = makeBufferSurface(w, h);
  // ASCII は文字グリッド解像度で場を評価（1 文字 = 1 セル）。それ以外は w×h。
  surface.width = () => (asciiActive ? Math.max(1, Math.floor(w / AsciiArt.CELL_W)) : w);
  surface.height = () => (asciiActive ? Math.max(1, Math.floor(h / AsciiArt.CELL_H)) : h);
  surface.blitField = (field, fw, fh) => {
    if (asciiActive)
      rasterizeAsciiLinesToBuf(
        AsciiArt.renderAsciiLines(field, fw, fh, asciiRamp()),
        surface.buf,
        w,
        h,
      );
    else FieldRender.renderField(field, fw, fh, surface.buf, activeMode, activeParams);
  };
}

/** 文字グリッド（string[]）を任意サイズの 1-bit バッファへグリフ描画する。 */
function rasterizeAsciiLinesToBuf(lines, buf, w, h) {
  buf.fill(0);
  for (let r = 0; r < lines.length; r++) {
    const oy = r * AsciiArt.CELL_H;
    if (oy >= h) break;
    const line = lines[r];
    for (let c = 0; c < line.length; c++) {
      const g = getGlyph(line[c]);
      if (!g) continue;
      const ox = c * AsciiArt.CELL_W;
      if (ox >= w) break;
      for (let gy = 0; gy < GLYPH_H; gy++) {
        const grow = gy * GLYPH_W;
        const py = oy + gy;
        if (py >= h) break;
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (!g[grow + gx]) continue;
          const px = ox + gx;
          if (px < w) buf[py * w + px] = 1;
        }
      }
    }
  }
}

let program = null;
let errMsg = "";
let t0 = performance.now();
let winId = null;

// プレビューを宣言 fps のフレームグリッドに同期（WYSIWYG）。フレームが変わるまで
// 再レンダーせず直近バッファを再ブリット＝低 fps はカクつき。
let _pvCache = null; // 直近に描いた pv（{buf,w,h}）
let _pvFrame = -1; // 直近に描いた fps フレーム番号（-1 = 要再描画）
// カードモードのトグル状態（プレビュー＝書き出しを共通化）。
let codeOn = false; // コードオーバーレイ（OFF=作品のみ / ON=カード）
let artInv = false; // 作品層の明暗反転
let codeInv = false; // バー/文字の極性反転
// PERFORM: フルスクリーン (WM) と 1:1 同期するライブ演奏ビュー。画面そのものがキャンバス
// (1 アートドット = 8 画面px)。Alt+Enter / F11 で入り、Esc / F11 で出る。
let performMode = false;

/** 現在編集中のファイル VFS パス (null = 無題) */
let currentFilePath = null;
let isDirty = false;

// ── ウィジェット (遅延初期化) ──
// パラメータ（seed/方式/出力/dot/pad/fps）はすべてコードの設定ディレクティブで指定する。
// 画面に残すコントロールはツールバー（書き出し形式 + アクション）と、プレビュー下の
// 「カードの見た目」トグル（CODE / ART INV / CODE INV）のみ（最小コントロール）。
// 全ウィジェットを 1 つのフラット WidgetGroup に入れ、fitLayout が毎フレーム座標を与える
// （手動配置＝レスポンシブ）。フォーカス/入力/ツールチップ/ポップアップは group が一括処理。
let editor, ddFormat, btnExport, btnReseed, btnSave, btnOpen, btnNew, btnWallpaper, group;
let toolbarBtns; // ツールバーの均等配分対象（ddFormat + アクション群）
// プレビュー直下の「カードの見た目」トグル群（CODE / ART INV / CODE INV）。
let codeToggle, artInvToggle, codeInvToggle;
// エディタの枠ぶんの余白（px）。widthChars/visibleRows ⇄ px 変換に使う（実測で導出）。
let _editChromeW = 0, _editChromeH = 0;
let _ready = false;

function recompile(src) {
  try {
    const candidate = compile(src);
    // 試し評価: コンパイルは通るが評価時に投げる式（未定義変数など）も弾く。
    // これらが通ったときだけ program を差し替える＝ライブ編集中の typo で映像/音が
    // 途切れず、直前の good を流し続ける（last-good 継続）。
    candidate.sample(0.5, 0.5, 0, 0);
    if (candidate.audio) candidate.audio.sampleAudio(0, 0, Math.PI * 2);
    program = candidate;
    errMsg = "";
    _pvFrame = -1; // 新しい good を即プレビューへ反映
    _cardLayout = null; // ソース/canvas/pad 変更でカードのレイアウト・マスクを作り直す
  } catch (e) {
    // 直前の good（program）はそのまま流し続ける。エラーは footer に出すだけ。
    errMsg = e.message + (e.pos != null ? ` (pos ${e.pos})` : "");
  }
}

/** エディタへコードを流し込み、再コンパイルして時刻リセット（open/new 用。dirty は呼び側） */
function setCode(src) {
  editor.lines = src.split("\n");
  editor.cursorRow = 0;
  editor.cursorCol = 0;
  editor.selectionAnchorRow = null;
  editor.selectionAnchorCol = null;
  editor.boxSelection = null;
  editor.scrollX = 0;
  editor.setContentLength(editor.lines.length);
  editor.scrollToTop();
  editor.clearHistory(); // 別ファイル/新規へ undo で戻れないようにする
  recompile(src);
  t0 = performance.now();
}

function _initWidgets() {
  if (_ready) return;
  _ready = true;

  editor = new UI.TextArea(0, 0, COLS, ROWS, MAX_LINES, DEFAULT_CODE, (text) => {
    isDirty = true;
    refreshTitle();
    recompile(text); // 編集で即コンパイル (LangError は footer へ)
  });
  editor.showWhitespace = false; // コード編集では空白/改行マーカーを消す（読みやすさ）
  editor.guideCol = COLS; // 39桁ガイド（点線）＋超過行ティック。TESS の桁制約を可視化（D）
  editor.showLineNumbers = true; // コード編集では行番号ガターを表示
  // 枠ぶんの余白を実測で導出（widthChars/visibleRows ⇄ px 変換に使う）。
  const charW = GLYPH_W + 1;
  const lineH = GLYPH_H + 3; // = Helpers.TEXTAREA_LINE_HEIGHT
  _editChromeW = editor.w - (COLS * charW + GLYPH_W);
  _editChromeH = editor.h - (ROWS * lineH - 1);

  // ── ツールバー（1 行）: 書き出し形式 + アクション群。ショートカットは各ボタンの
  // hover ツールチップに表示する（画面下部の凡例は廃止）。
  ddFormat = new UI.DropDown(0, 0, availableFormats().map((f) => f.label), exportFormatIdx, (i) => {
    exportFormatIdx = i;
  });
  ddFormat.tooltip = "Export format: PNG = still, GIF = loop (any browser), MP4 = loop (SNS).";

  const mkBtn = (label, tip, fn) => {
    const b = new UI.PushButton(0, 0, label, fn);
    b.tooltip = tip;
    return b;
  };
  // DL と EXPORT は同一アクション（コード宣言の size に書き出し）＝1 ボタンに統合。
  btnExport = mkBtn("EXPORT", "Export what the preview shows (artwork, or code card) — Ctrl+E (PNG/GIF/MP4)", exportArt);
  btnReseed = mkBtn("RESEED", "Randomize the seed: directive — Ctrl+R", rerollSeed);
  btnSave = mkBtn("SAVE", "Save — Ctrl+S   (Save As — Ctrl+Shift+S)", saveFile);
  btnOpen = mkBtn("OPEN", "Open a .tess sketch — Ctrl+O", openFile);
  btnNew = mkBtn("NEW", "New sketch — Alt+N", newFile);
  btnWallpaper = mkBtn("WALL", "Set as desktop wallpaper, live-rendered — Alt+W", setWallpaper);
  toolbarBtns = [ddFormat, btnExport, btnReseed, btnSave, btnOpen, btnNew, btnWallpaper];

  // ── プレビュー直下: カードの見た目トグル（fitLayout で preview の下へ配置）──
  const onLook = () => { _pvFrame = -1; }; // 変更を即プレビューへ
  codeToggle = new UI.ToggleButton(0, 0, "CODE", (v) => { codeOn = v; onLook(); }, codeOn);
  codeToggle.tooltip = "Overlay the source code on the preview/export (= code card)";
  artInvToggle = new UI.ToggleButton(0, 0, "ART INV", (v) => { artInv = v; onLook(); }, artInv);
  artInvToggle.tooltip = "Invert the artwork (light/dark swap)";
  codeInvToggle = new UI.ToggleButton(0, 0, "CODE INV", (v) => { codeInv = v; onLook(); }, codeInv);
  codeInvToggle.tooltip = "Invert the code highlight: dark bar+light text  <->  light bar+dark text";

  // 全ウィジェットを 1 つのフラット group に（手動配置。fitLayout が毎フレーム座標を与える）。
  group = new UI.WidgetGroup([
    ...toolbarBtns, editor, codeToggle, artInvToggle, codeInvToggle,
  ]);

  recompile(DEFAULT_CODE);
}

/**
 * エディタを px 矩形 (x,y,w,h) に合わせ、表示桁数/行数を実寸から導出する。
 * TextArea の枠は保ちつつ NotePad 的にフィルする（右下に半端な余白を残さない）。
 */
function fitEditor(x, y, w, h) {
  const charW = GLYPH_W + 1;
  const lineH = GLYPH_H + 3;
  const cols = Math.max(MIN_EDIT_COLS, Math.floor((w - _editChromeW) / charW));
  const rows = Math.max(4, Math.floor((h - _editChromeH + 1) / lineH));
  editor.widthChars = cols;
  editor.visibleRows = rows;
  editor.view.setViewport(cols, rows); // 縦スクロール viewport も同期
  editor.remeasure(); // widthChars/visibleRows から w/h を再算出（cols/rows ちょうど）
  editor.x = x;
  editor.y = y;
}

/** フォント/パディング変更時の再計測（座標は fitLayout が毎フレーム与える）。 */
function relayout() {
  group.remeasureAll();
  // 枠余白を再導出（フォント寸法が変わると charW/lineH が変わりうるため）。
  const charW = GLYPH_W + 1;
  const lineH = GLYPH_H + 3;
  _editChromeW = editor.w - (editor.widthChars * charW + GLYPH_W);
  _editChromeH = editor.h - (editor.visibleRows * lineH - 1);
}

// ── 自然（fit-to-content）サイズ ────────────────────────────────────────
// 規定解像度 360x270 の work area にちょうど収まる**固定**コンテンツ寸法を返す。
// 実画面がどれだけ大きくても（＝解像度に依存せず）この固定サイズで開き、fit-to-content も
// ここへ戻る。窓をこれより小さくすると WM が窓側の縦横スクロールで巡らせる。レイアウト
// （fitLayout）もこの固定サイズに敷くので、ウィンドウのリサイズには追従しない（リフローしない）。
// 標準サイズは WM.wmDefaultContentSize が SSoT（ROLL と共有）。footer 分を差し引いた値。
function naturalSize() {
  const { w, h } = WM.wmDefaultContentSize(true);
  return { w: Math.max(220, w), h: Math.max(160, h) };
}

// ── 固定配置 ────────────────────────────────────────────────────────────
// naturalSize（規定解像度 360x270 基準）から全ウィジェットの座標とプレビュー枠を決める。
// ウィンドウのリサイズには追従しない（リフローしない）: 窓を小さくすると WM が窓側スクロールで
// 巡らせ、長い行はエディタ自身の横スクロールで見る。上=全幅ツールバー、左=エディタ（135px
// プレビュー隣の最大幅・縦は全高）、右=135px 固定プレビュー＋見た目トグル。
let _pvLocal = { x: 0, y: 0, w: 0, h: 0 };
function fitLayout() {
  const nat = naturalSize();
  const FM = UI.FOCUS_MARGIN;
  const uW = nat.w - 2 * FM; // フォーカスブラケットぶんを四辺に確保
  const uH = nat.h - 2 * FM;
  const ox = FM;
  const oy = FM;

  // ── ツールバー（全幅に均等配分）──
  const toolbarH = layoutToolbar(ox, oy, uW);

  // ── ボディ（ツールバーの下）──
  const bodyY = oy + toolbarH + GAP;
  const bodyH = Math.max(1, uH - toolbarH - GAP);

  // ── プレビュー（右・135px 固定、クリーン量子化）──
  const pv = previewScale(asciiActive);
  const pvW = pv.w;
  const pvH = pv.h;
  const rightEdge = ox + uW; // 右コンテンツ端（FM 内側）
  const pvX = rightEdge - pvW;

  // ── エディタ（左・プレビュー隣の残り幅を充填・縦は全高）。長い行はエディタ自身が横スクロール。──
  const minEditW = MIN_EDIT_COLS * (GLYPH_W + 1) + GLYPH_W + _editChromeW;
  const editW = Math.max(minEditW, pvX - GAP - ox);
  fitEditor(ox, bodyY, editW, bodyH);

  // ── 右カラム: プレビュー（上）＋ 見た目トグル（下）──
  // プレビュー枠線は 1px 外側に描くため、エディタ角丸枠の上端と揃うよう +1。
  _pvLocal = { x: pvX, y: bodyY + 1, w: pvW, h: pvH };
  const togY = _pvLocal.y + pvH + GAP;
  const step = codeToggle.h + UI.MIN_GAP;
  codeToggle.x = pvX;    codeToggle.y = togY;
  artInvToggle.x = pvX;  artInvToggle.y = togY + step;
  codeInvToggle.x = pvX; codeInvToggle.y = togY + step * 2;
}

/** ツールバー（ddFormat + アクション群）を [ox, ox+width] に均等配分し、行高を返す。 */
function layoutToolbar(ox, oy, width) {
  const btns = toolbarBtns;
  const sumW = btns.reduce((s, b) => s + b.w, 0);
  const n = btns.length;
  const gap = Math.max(UI.MIN_GAP, Math.floor((width - sumW) / (n - 1)));
  let x = ox;
  for (let i = 0; i < n; i++) {
    btns[i].x = x;
    btns[i].y = oy;
    x += btns[i].w + gap;
  }
  return btns[0].h;
}


// ── タイトル ──
function refreshTitle() {
  if (winId === null) return;
  const name = currentFilePath ? VFS.basename(currentFilePath) : "UNTITLED";
  WM.wmSetTitle(winId, `${isDirty ? "* " : ""}${name} - ${APP_NAME}`);
}

// ── 状態リセット（新規/閉じる時） ──
function resetState() {
  stopAudio(); // 閉じる/新規/リセットで再生も止める
  currentFilePath = null;
  isDirty = false;
  setCode(DEFAULT_CODE);
  refreshTitle();
}

// ── 未保存確認 → コールバック ──
function confirmDiscard(callback) {
  if (!isDirty) {
    callback();
    return;
  }
  UI.openConfirmDialog("DISCARD UNSAVED CHANGES?", {
    variant: "danger",
    onOk: callback,
  });
}

// ── ファイル操作 ──
function newFile() {
  confirmDiscard(() => {
    setCode(DEFAULT_CODE);
    currentFilePath = null;
    isDirty = false;
    refreshTitle();
  });
}

function openFile() {
  confirmDiscard(() => {
    UI.openFileDialog("open", {
      title: "OPEN",
      defaultPath: HOME_DIR,
      filter: [EXT],
      onResult: (path) => {
        if (!path) return;
        const content = VFS.readFile(path);
        if (content === null) return;
        setCode(content);
        currentFilePath = path;
        isDirty = false;
        refreshTitle();
      },
    });
  });
}

function saveFileAs() {
  UI.openFileDialog("save", {
    title: "SAVE AS",
    defaultPath: currentFilePath ? VFS.parentPath(currentFilePath) : HOME_DIR,
    defaultName: currentFilePath ? VFS.basename(currentFilePath) : "untitled" + EXT,
    filter: [EXT],
    onResult: (path) => {
      if (!path) return;
      currentFilePath = path;
      VFS.writeFile(path, editor.getText());
      isDirty = false;
      refreshTitle();
    },
  });
}

function saveFile() {
  if (!currentFilePath) {
    saveFileAs();
    return;
  }
  VFS.writeFile(currentFilePath, editor.getText());
  isDirty = false;
  refreshTitle();
}

/** Shift+Alt+F: エディタを整形（意味は変えないので再コンパイル不要） */
function formatEditor() {
  const formatted = format(editor.getText());
  if (formatted === editor.getText()) return;
  editor.snapshotForUndo(); // 整形を 1 ステップで undo 可能に
  const row = editor.cursorRow,
    col = editor.cursorCol; // カーソル位置を保持（0,0 にリセットしない）
  editor.lines = formatted.split("\n");
  editor.setContentLength(editor.lines.length);
  // 整形で行数・空白が変わりうるので、おおむね同じ位置へクランプする。
  editor.cursorRow = Math.max(0, Math.min(editor.lines.length - 1, row));
  editor.cursorCol = Math.max(0, Math.min(editor.lines[editor.cursorRow].length, col));
  editor.selectionAnchorRow = null;
  editor.selectionAnchorCol = null;
  editor.boxSelection = null;
  editor._ensureCursorVisible(); // カーソルが見える位置までスクロール調整
  isDirty = true; // 整形は内容（空白）を変える → dirty
  refreshTitle();
}

/**
 * Ctrl+R: エディタ内の `seed:` 行を新しい乱数に書き換える（無ければ先頭に挿入）。
 * 「コードが唯一の真実」を保ったまま、キー一発でシードを探索する（案A）。整形と同質。
 */
function rerollSeed() {
  const n = (Math.random() * 10000) | 0;
  editor.snapshotForUndo(); // シード振り直しを 1 ステップで undo 可能に
  const lines = editor.lines;
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*seed\s*:/.test(lines[i])) {
      found = i;
      break;
    }
  }
  if (found >= 0) {
    lines[found] = lines[found].replace(/^(\s*seed\s*:\s*).*$/, `$1${n}`);
  } else {
    lines.unshift(`seed: ${n}`);
    editor.cursorRow = Math.min(lines.length - 1, editor.cursorRow + 1); // 行ズレ追従
  }
  editor.setContentLength(lines.length);
  isDirty = true;
  refreshTitle();
  recompile(editor.getText()); // 新シードで即再コンパイル（状態場も再 init）
}

/**
 * プレビューの評価解像度(renderDenom)・表示倍率(displayScale)・最終寸法(w,h)を求める
 * （描画はしない）。**クリーンな倍率のみ**: base ≤ 枠 PV_BOX なら整数倍 NN 拡大、超える
 * なら 1/整数 に評価解像度を落とす（半端比率のモアレを避ける）。onMeasure とも共有し、
 * ウィンドウは実プレビュー寸法ちょうどに収める（PV_BOX 予約による右下の余白を作らない）。
 */
function previewScale(ascii) {
  const { baseW, baseH } = outputDims();
  const maxBase = Math.max(baseW, baseH);
  let renderDenom = 1,
    displayScale = 1;
  if (maxBase <= PREVIEW_BOX) displayScale = Math.max(1, Math.floor(PREVIEW_BOX / maxBase));
  else renderDenom = Math.ceil(maxBase / PREVIEW_BOX);
  // ASCII はグリフを拡大すると汚いので等倍表示。
  if (ascii && displayScale > 1) displayScale = 1;
  const rbW = Math.max(1, Math.round(baseW / renderDenom));
  const rbH = Math.max(1, Math.round(baseH / renderDenom));
  return { renderDenom, displayScale, rbW, rbH, w: rbW * displayScale, h: rbH * displayScale };
}

/**
 * プレビュー 1-bit バッファを作る。previewScale の倍率で場を評価解像度で直接描く
 * （合成後の再標本化はしない）ので常に綺麗。
 * @returns {{ buf:Uint8Array, w:number, h:number }} 画面に出す 1-bit バッファと寸法
 */
function renderPreview(t, seed, mode, params, ascii) {
  const { baseW, artW } = outputDims();
  const padBase = (baseW - artW) / 2; // 額縁（base 上、上下左右一定）
  const { renderDenom, displayScale, rbW, rbH } = previewScale(ascii);
  const rpad = Math.round(padBase / renderDenom);
  const raW = Math.max(1, rbW - 2 * rpad);
  const raH = Math.max(1, rbH - 2 * rpad);

  ensureSurface(raW, raH);
  renderField(program, surface, t, seed); // surface.buf = raW×raH の art（AV 同期つき）
  const base = ArtExport.composeMatte(surface.buf, raW, raH, rbW, rbH);

  if (displayScale === 1) return { buf: base, w: rbW, h: rbH };
  // 整数 NN 拡大（チャンキー・モアレ無し）。
  const dw = rbW * displayScale,
    dh = rbH * displayScale;
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < rbH; y++) {
    for (let x = 0; x < rbW; x++) {
      if (!base[y * rbW + x]) continue;
      const ox = x * displayScale,
        oy = y * displayScale;
      for (let j = 0; j < displayScale; j++) {
        const r = (oy + j) * dw + ox;
        for (let i = 0; i < displayScale; i++) out[r + i] = 1;
      }
    }
  }
  return { buf: out, w: dw, h: dh };
}

// ── 書き出し（PNG / GIF / MP4）──
// プレビューと独立した surface・プログラム実体でオフスクリーン描画する（書き出し時は
// ソースを別途 compile する）。場を art 解像度で直接描く。合成・符号化は core/art_export.js。

/** 任意サイズの 1-bit バッファへ「場 → 1-bit」を描くオフスクリーン surface。 */
function makeExportSurface(w, h, asciiOn, mode, params) {
  // field_render 方式は tess_host の共通サーフェスを使う（壁紙と同一経路）。
  if (!asciiOn) return makeFieldSurface(w, h, mode, params);
  // ASCII は文字グリッド解像度で場を評価し、グリフを 1-bit へラスタライズする
  // (font 依存の tessera 固有処理なので共通化しない)。
  const surf = makeBufferSurface(w, h);
  const cols = Math.max(1, Math.floor(w / AsciiArt.CELL_W));
  const rows = Math.max(1, Math.floor(h / AsciiArt.CELL_H));
  surf.width = () => cols; // 場は文字グリッド解像度で評価（1 文字 = 1 セル）
  surf.height = () => rows;
  surf.blitField = (field, fw, fh) =>
    rasterizeAsciiLinesToBuf(
      AsciiArt.renderAsciiLines(field, fw, fh, asciiRamp()),
      surf.buf,
      w,
      h,
    );
  return surf;
}

/** 書き出しファイル名 tessera_<name>_<seed>_<ts>.<ext>。 */
function exportName(ext) {
  const base = currentFilePath
    ? VFS.basename(currentFilePath).replace(/\.tess$/i, "")
    : "untitled";
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `tessera_${base}_${resolvedConfig().seed}_${ts}.${ext}`;
}

/** PNG=1枚 / GIF・MP4=period ループ を frameAt(t) から書き出す共通ヘルパ。 */
function exportFrames(key, frameAt, w, h, scale, invert, fps, period, tag, audio = null) {
  const name = (ext) =>
    tag ? exportName(ext).replace(/\.(\w+)$/, `_${tag}.$1`) : exportName(ext);
  try {
    if (key === "png") {
      // 画面に出ている量子化フレームと同じ t を捕らえる（WYSIWYG）。
      const t = (Math.floor(((performance.now() - t0) / 1000) * fps) / fps) % period;
      ArtExport.downloadPng(frameAt(t), w, h, scale, invert, name("png"));
    } else {
      // GIF/MP4: t∈[0,period) を等間隔サンプル＝シームレスループ（末尾の次が t=0）。
      const loopFrames = clampI(period * fps, 2, PERIOD_CAP_S * fps);
      const frames = [];
      for (let i = 0; i < loopFrames; i++) frames.push(frameAt((i / loopFrames) * period));
      statusText = `ENCODING ${key.toUpperCase()}...`;
      ArtExport.exportVideo(
        frames, w, h, scale, invert, fps, key, name(key),
        (s) => {
          statusText = s;
        },
        audio,
      );
    }
  } catch (e) {
    errMsg = e.message + (e.pos != null ? ` (pos ${e.pos})` : "");
    statusText = "";
  }
}

/**
 * DOWNLOAD / Ctrl+E: いまプレビューに出ている見た目を選択フォーマットで書き出す。
 * CODE OFF=作品 / CODE ON=コードカード。ART INV / CODE INV は層別に反映。
 */
function exportArt() {
  if (!program || statusText) return; // 未コンパイル or 書き出し中は無視
  let prog;
  try {
    prog = compile(editor.getText()); // プレビューと独立した実体
  } catch {
    return;
  }
  const key = currentFormatKey();
  const { seed, period } = resolvedConfig();
  const fps = outputDims().fps;
  if (key === "wav") {
    // 音のみ: sound: の 1 周期を決定論レンダして WAV 書き出し（シームレスループ）。
    if (!prog.audio) {
      errMsg = "no sound: block to export as WAV";
      return;
    }
    const sr = 44100;
    const data = exportAudioPcm(prog, sr, period, seed); // 再生と同じ音・音量（WYSIWYG）
    ArtExport.triggerDownload(
      new Blob([encodeWav(data, sr)], { type: "audio/wav" }),
      exportName("wav"),
    );
    return;
  }
  // MP4 は sound: があれば音声入り（1 周期を決定論レンダ → AAC 多重化 = ループ一致）。
  let audio = null;
  if (key === "mp4" && prog.audio) {
    const sr = 44100;
    audio = { samples: exportAudioPcm(prog, sr, period, seed), sampleRate: sr };
  }
  if (codeOn) {
    // コードカード: 作品(額縁=pad) + バー + 文字。art/code の INV は frame に焼き込む。
    const eff = effectiveRender();
    const mode = eff.mode === "ascii" ? "dither" : eff.mode; // 背景は面系ディザ
    const lay = getCardLayout();
    const frameAt = (t) => renderCard(prog, t, seed, mode, eff.params, lay, artInv, codeInv);
    exportFrames(key, frameAt, lay.cbW, lay.cbH, lay.scale, false, fps, period, "code", audio);
  } else {
    // 作品のみ: base ×pixel で効率出力。ART INV は palette 反転で。
    const { baseW, baseH, artW, artH, pixel } = outputDims();
    const eff = effectiveRender();
    const asciiOn = eff.mode === "ascii";
    const frameAt = (t) => {
      const surf = makeExportSurface(artW, artH, asciiOn, eff.mode, eff.params);
      renderField(prog, surf, t, seed);
      return ArtExport.composeMatte(surf.buf, artW, artH, baseW, baseH);
    };
    exportFrames(key, frameAt, baseW, baseH, pixel, artInv, fps, period, "", audio);
  }
}

// ── コードカード（CODE ON）: 作品＋行ごとの黒バー＋大文字コードの 3 段重ね ──
// canvas/pad を尊重: 作品の額縁＝pad、コードの余白＝pad。base=canvas/scale(4 or 2) で
// encode 効率化（8px チャンキー維持: art@canvas/8 → ×(8/scale) → cardBase → ×scale → canvas）。
// ART INV=作品層を反転 / CODE INV=バー(0↔1)と文字(1↔0)を反転。テーマ配色は art_export 任せ。
const CARD_BAR_PADX = 3; // バー内の左右パディング（glyph-px）
const CARD_BAR_PADY = 2; // バー内の上下パディング（glyph-px）
const CARD_LINE_GAP = 3; // バー間の隙間＝作品が覗く（glyph-px）

/** 現在ソースの行配列（各行 rstrip・末尾の空行は除去）。 */
function cardLines() {
  return editor.getText().replace(/\s+$/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
}

/** ソース行の素のブロック寸法（glyph-px, G=1）と行送り・字送り。 */
function cardBlockSize(lines) {
  const adv = GLYPH_W + 1;
  const pitch = GLYPH_H + 2 * CARD_BAR_PADY + CARD_LINE_GAP;
  let maxBar = 0;
  for (const ln of lines) {
    if (ln.length === 0) continue;
    maxBar = Math.max(maxBar, ln.length * adv + 2 * CARD_BAR_PADX);
  }
  return {
    w: Math.max(adv, maxBar),
    h: Math.max(pitch, lines.length * pitch - CARD_LINE_GAP),
    pitch,
    adv,
  };
}

/** カードのレイアウト（cardBase・scale・マスク）を解決。pad を余白に使い中央寄せ。 */
function resolveCardLayout() {
  const lines = cardLines();
  const { sizeW, sizeH, pad } = resolvedConfig();
  const { w: bw, h: bh } = cardBlockSize(lines);
  let scale = 2,
    cbW = Math.round(sizeW / 2),
    cbH = Math.round(sizeH / 2),
    pb = Math.round(pad / 2),
    g = 1;
  for (const s of [4, 2]) {
    const w = Math.round(sizeW / s),
      h = Math.round(sizeH / s),
      p = Math.round(pad / s);
    const gg = Math.min(Math.floor((w - 2 * p) / bw), Math.floor((h - 2 * p) / bh));
    if (gg >= 1) {
      scale = s;
      cbW = w;
      cbH = h;
      pb = p;
      g = gg;
      break;
    }
  }
  return { scale, cbW, cbH, ...buildCardMasks(lines, cbW, cbH, pb, g) };
}

/** レイアウト（masks 含む）はソース/canvas/pad に依存＝重いのでキャッシュ（recompile で破棄）。 */
let _cardLayout = null;
function getCardLayout() {
  if (!_cardLayout) _cardLayout = resolveCardLayout();
  return _cardLayout;
}

/** バー/インクのマスク（cbW×cbH の 0/1）。コードは padBase 余白の内側に中央寄せ。 */
function buildCardMasks(lines, cbW, cbH, pb, g) {
  const { w: bw, h: bh, pitch, adv } = cardBlockSize(lines);
  const ox = pb + Math.floor((cbW - 2 * pb - bw * g) / 2);
  const oy = pb + Math.floor((cbH - 2 * pb - bh * g) / 2);
  const barMask = new Uint8Array(cbW * cbH);
  const inkMask = new Uint8Array(cbW * cbH);
  const set = (m, x, y) => {
    if (x >= 0 && x < cbW && y >= 0 && y < cbH) m[y * cbW + x] = 1;
  };
  const barH = (GLYPH_H + 2 * CARD_BAR_PADY) * g;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.length === 0) continue; // 空行はバー無し＝作品が覗く
    const barTop = oy + i * pitch * g;
    const barW = (ln.length * adv + 2 * CARD_BAR_PADX) * g;
    for (let y = 0; y < barH; y++)
      for (let x = 0; x < barW; x++) set(barMask, ox + x, barTop + y);
    const tx = ox + CARD_BAR_PADX * g;
    const ty = barTop + CARD_BAR_PADY * g;
    for (let j = 0; j < ln.length; j++) {
      const gl = getGlyph(ln[j].toUpperCase());
      if (!gl) continue;
      const gx0 = tx + j * adv * g;
      for (let gy = 0; gy < GLYPH_H; gy++)
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (!gl[gy * GLYPH_W + gx]) continue;
          for (let sy = 0; sy < g; sy++)
            for (let sx = 0; sx < g; sx++)
              set(inkMask, gx0 + gx * g + sx, ty + gy * g + sy);
        }
    }
  }
  return { barMask, inkMask };
}

/** 1 フレーム合成: 作品(t, 額縁=pad) → バー → 文字。aInv=作品層反転 / cInv=バー/文字反転。 */
function renderCard(prog, t, seed, mode, params, lay, aInv, cInv) {
  const { baseW, baseH, artW, artH } = outputDims();
  const surf = makeExportSurface(artW, artH, false, mode, params);
  renderField(prog, surf, t, seed);
  const baseArt = ArtExport.composeMatte(surf.buf, artW, artH, baseW, baseH);
  const art = ArtExport.resampleNN(baseArt, baseW, baseH, lay.cbW, lay.cbH);
  const { barMask, inkMask } = lay;
  const barVal = cInv ? 1 : 0;
  const textVal = cInv ? 0 : 1;
  const out = new Uint8Array(lay.cbW * lay.cbH);
  for (let i = 0; i < out.length; i++)
    out[i] = inkMask[i]
      ? textVal
      : barMask[i]
        ? barVal
        : aInv
          ? art[i] ? 0 : 1
          : art[i];
  return out;
}

/** プレビュー用: カード 1 フレームをプレビュー枠 (pvW×pvH) へ NN 縮小（文字は小さくなる）。 */
function renderCardPreview(t, seed, mode, params, pvW, pvH) {
  const lay = getCardLayout();
  const card = renderCard(program, t, seed, mode, params, lay, artInv, codeInv);
  return { buf: ArtExport.resampleNN(card, lay.cbW, lay.cbH, pvW, pvH), w: pvW, h: pvH };
}

/** ALT+W: 現在の場をデスクトップ背景に設定（ソースをスナップショット保存 → live-render）。 */
function setWallpaper() {
  if (!program) return; // コンパイル不能なソースは無視
  const ok = Wallpaper.setTessSource(editor.getText());
  statusText = ok ? "WALLPAPER SET" : "WALLPAPER: ERROR";
  setTimeout(() => {
    if (statusText === "WALLPAPER SET" || statusText === "WALLPAPER: ERROR") {
      statusText = "";
    }
  }, 1500);
}

function onDraw(cr) {
  // ── PERFORM ⇔ フルスクリーンを 1:1 同期（Alt+Enter / F11 / Esc すべて同じ経路）──
  const fs = winId !== null && WM.wmIsFullscreen(winId);
  if (fs !== performMode) {
    performMode = fs;
    _pvFrame = -1; // プレビュー解像度が変わるため次フレームで作り直す
  }

  // ── キーボードショートカット (フォーカス時のみ) ──
  if (WM.wmIsFocused(winId)) {
    if (ctrlShiftDown("KeyS")) saveFileAs();
    else if (ctrlDown("KeyS")) saveFile();
    else if (ctrlDown("KeyO")) openFile();
    else if (ctrlDown("KeyE")) exportArt(); // 書き出し（コード宣言の size）
    else if (ctrlDown("KeyR")) rerollSeed(); // seed: をコード内で振り直す
    else if (altDown("KeyW")) setWallpaper(); // 現在の場をデスクトップ背景に
    else if (altDown("KeyN")) newFile();
    else if (altDown("KeyP")) toggleAudio(); // sound: の再生/停止トグル
    else if (altDown("Enter")) togglePerform(); // PERFORM（フルスクリーン演奏ビュー）
    else if (altShiftDown("KeyF")) formatEditor();
    else if (performMode && keyDown("Escape")) {
      // Esc: 選択があれば選択解除だけ、なければ PERFORM 解除 (段階的な脱出)
      if (editor.selectionAnchorRow !== null || editor.boxSelection) {
        editor.selectionAnchorRow = null;
        editor.selectionAnchorCol = null;
        editor.boxSelection = null;
      } else {
        WM.wmSetFullscreen(winId, false);
      }
    }
  }

  GPU.fillRect(cr.x, cr.y, cr.w, cr.h, 0); // 背景クリア

  // ── PERFORM: 画面そのものがキャンバス + コードのオーバーレイエディタ ──
  if (performMode) {
    // キーボード編集はフォーカス管理を迂回して TextArea を直接駆動する
    // (handleKey が文字入力/ナビ/undo/クリップボードまで自己完結。編集は onChange
    //  経由で即 recompile = ライブコーディング)。
    if (WM.wmIsFocused(winId)) editor.handleKey();
    drawPerform(cr);
    drawPerformOverlay(cr);
    return;
  }

  // ── 実効方式を先に確定（プレビュー枠の ascii 判定に使う）──
  const eff = effectiveRender();
  activeMode = eff.mode;
  activeParams = eff.params;
  asciiActive = activeMode === "ascii" && !codeOn; // CODE ON の背景は面系ディザ

  // ── 固定配置（naturalSize から全ウィジェット座標 + プレビュー枠を決める。窓が
  //     自然サイズより小さければ WM が窓側スクロールで巡らせる）──
  codeInvToggle.visible = codeOn; // CODE OFF 時は CODE INV を隠す
  fitLayout();
  group.draw(cr);

  // ── 右: ライブプレビュー（ツールバーの下・右カラム上）──
  const pvX = cr.x + _pvLocal.x;
  const pvY = cr.y + _pvLocal.y;
  const pvBoxW = _pvLocal.w;
  const pvBoxH = _pvLocal.h;

  if (program) {
    const { seed, period, fps } = resolvedConfig();
    // WYSIWYG: プレビューを宣言 fps のフレームグリッドへ量子化（書き出しと同じ間引き・速度）。
    // フレーム番号が変わったときだけ再レンダー。
    const frameIdx = Math.floor(((performance.now() - t0) / 1000) * fps);
    // t を [0,period) で周回＝プレビューが実際にループ（見た目＝書き出し）。
    const t = (frameIdx / fps) % period;
    try {
      if (frameIdx !== _pvFrame || _pvCache === null) {
        if (codeOn) {
          const cm = activeMode === "ascii" ? "dither" : activeMode;
          _pvCache = renderCardPreview(t, seed, cm, activeParams, pvBoxW, pvBoxH);
        } else {
          _pvCache = renderPreview(t, seed, activeMode, activeParams, asciiActive);
          if (artInv && _pvCache) {
            const b = _pvCache.buf; // 作品層の反転＝表示バッファ反転（palette swap 相当）
            for (let i = 0; i < b.length; i++) b[i] = b[i] ? 0 : 1;
          }
        }
        _pvFrame = frameIdx;
      }
    } catch (e) {
      // 描画中の例外でも直前の good フレーム（_pvCache）は保持し、映像を途切れさせない。
      errMsg = e.message + (e.pos != null ? ` (pos ${e.pos})` : "");
    }
    const pv = _pvCache;
    if (pv) {
      GPU.fillRect(pvX, pvY, pv.w, pv.h, 0); // 背景 (未描画セルの下地)
      GPU.drawRect(pvX - 1, pvY - 1, pv.w + 1, pv.h + 1, 1); // 枠線
      GPU.blit(pv.buf, pv.w, pv.h, pvX, pvY, 1);
    }
  }
}

function onDrawFooter(fr) {
  if (errMsg) {
    drawText(fr.x, fr.y, "ERR " + errMsg, 1);
    return;
  }
  const rc = resolvedConfig();
  // 書き出し中は進捗、平常は seed。出力外寸・実効 fps を左に併記（fps→100の約数への
  // スナップを可視化）。pixel は 8 固定なので表示しない。
  const right = statusText || `seed ${rc.seed}`;
  const left = `${rc.sizeW}x${rc.sizeH}  ${rc.fps}fps`;
  drawText(fr.x, fr.y, left, 1);
  drawText(fr.x + fr.w - textWidth(right), fr.y, right, 1);
}

function onInput(ev) {
  // PERFORM 中は隠れたウィジェットへ配信せず（誤クリック・tooltip・Esc による
  // フォーカス解除を回避）、オーバーレイ座標系で editor モデルを直接操作する。
  if (performMode) {
    ovHandleMouse(ev);
    return;
  }
  // ヒットテストが描画と同じ座標を使うよう、入力前にも配置を確定する。
  codeInvToggle.visible = codeOn;
  fitLayout();
  group.update(ev);
}

function onMeasure() {
  return naturalSize();
}

function onBeforeClose() {
  if (isDirty) {
    UI.openConfirmDialog("DISCARD UNSAVED CHANGES?", {
      variant: "danger",
      onOk: () => {
        resetState();
        WM.wmClose(winId);
      },
    });
    return false;
  }
  resetState();
  return true;
}

// ── 登録 ──
WM.wmRegister(
  APP_NAME,
  () => {
    _initWidgets();
    seedSamples();
    winId = WM.wmOpen(-1, -1, 0, 0, APP_NAME, onDraw, onInput, onMeasure, {
      footer: true,
      onDrawFooter,
      onBeforeClose,
      about:
        "Tessera: a tiny language for 1-bit generative art. Write code on " +
        "the left, watch it render on the right. A sketch is a field " +
        "f(x,y,t) -> 0..1 (one expression; value blocks with let/repeat too). " +
        "All settings live in code as directives: " +
        "canvas: WxH, pad: N, fps: N, seed: N, period: sec, view: mode(args) " +
        "(pixel is fixed at 8 = chunky 1-bit). " +
        "Learn from /Sketches/Learn (numbered tutorial), browse /Sketches/Gallery. " +
        "Shortcuts: Alt+N new, Ctrl+O " +
        "open, Ctrl+S save, Ctrl+Shift+S save as, Ctrl+E / EXPORT exports what " +
        "the preview shows (PNG/GIF/MP4). Below the preview: CODE overlays the " +
        "source (= code card, pad becomes the frame/margin); ART INV / CODE INV " +
        "flip the artwork and the code-highlight separately. Ctrl+R reseed, " +
        "Alt+W set as desktop wallpaper (live-rendered), Shift+Alt+F format. " +
        "Add a sound: block for chiptune audio — a field over time a(t) -> -1..1 " +
        "(pulse/tri/saw/nz, hz, beat/step/seq, decay). Alt+P plays / stops; " +
        "it loops over 'period' in sync with the view. Declare named timbres with " +
        "voice <name>: <expr with f>, then play them by name and mix with +. " +
        "The visual field can read the sound: amp (audio level 0..1) and beat(n)/" +
        "step(n) share the loop clock, so visuals react to the audio. MP4 export " +
        "includes the sound; pick WAV to export the sound alone (one loop). " +
        "Typos never blank the output — the last " +
        "working version keeps running until the new code is valid. Alt+Enter (or " +
        "F11) is PERFORM: the screen itself becomes the canvas (one dot = 8 px, " +
        "fullscreen) with your code overlaid on the animating art — cursor, " +
        "selection and shortcuts all work, so you can live-code the piece. Esc exits.",
      onRelayout: relayout,
    });
    // デスクトップ/ランチャーからの新規起動は必ず初期状態で表示する (factory は閉じた状態から
    // 開くときだけ呼ばれるので再フォーカスでは走らない)。ファイルを開く経路はこの後に内容を
    // 上書きするので競合しない。
    resetState();
    refreshTitle();
    return winId;
  },
  { category: "CREATIVE" },
);

// ── 公開 API: FILES 等から .tess を開く ──

/**
 * 指定パスの Tessera ソースを TESSERA で開く。
 * ウィンドウが閉じていれば開き、最前面へ。
 * @param {string} path  VFS パス
 * @returns {boolean} 読み込み成功なら true
 */
export function tesseraOpenFile(path) {
  _initWidgets();
  const content = VFS.readFile(path);
  if (content === null) return false;
  WM.wmOpenOrFocus(APP_NAME); // 未オープンなら登録 cb が winId を確定
  setCode(content);
  currentFilePath = path;
  isDirty = false;
  refreshTitle();
  return true;
}
