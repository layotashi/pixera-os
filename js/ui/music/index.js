/**
 * @module ui/music
 * index.js — 音楽制作系ウィジェットのファサード
 *
 * ハードウェア音楽機材の操作子を 1-bit で再現したウィジェット群。
 * OS 標準ウィジェット (js/ui/widgets/, ui/index.js) とは別カテゴリで、
 * SYNTH / MIXER / SAMPLER / DAW など音を扱うアプリでのみ使う。
 *
 * 描画・入力ポートは OS 標準ウィジェットと共通 (ui/ports.js)。
 * ホストは ui/index.js の initPorts() を 1 度呼べば、こちらも動作する。
 *
 * 利用側:
 *   import { Fader } from "../../ui/music/index.js";
 */

export { Fader, FADER_W, FADER_DEFAULT_H, FADER_GAP } from "./Fader.js";
