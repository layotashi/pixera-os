/**
 * @module core/user_fonts
 * user_fonts.js — GLYPHER 製ユーザーフォントの永続化
 *
 * GLYPHER でデザインした 5x5 フォントを VFS に保存し、Config の
 * フォントレジストリに登録する。boot 時に保存済みフォントを全て読み込んで
 * 登録することで、リロード後も Settings のドロップダウンから選べる。
 *
 * ── ファイル形式 ──
 *   パス:   /Fonts/<name>.font
 *   内容:   95 文字 × 25 byte (5x5) の生バイト列 = 2375 byte。
 *           ASCII 0x20..0x7E 順。VFS が base64 で localStorage に永続化する。
 */

import * as VFS from "./vfs.js";
import { registerUserFont } from "../config.js";

const FONTS_DIR = "/Fonts";
const GLYPH_LEN = 25; // 5x5

/** ユーザーフォント名 → 一意な font ID */
function _idForName(name) {
  return "user:" + name;
}

/** /Fonts ディレクトリを保証する */
function _ensureDir() {
  if (!VFS.exists(FONTS_DIR)) VFS.mkdir(FONTS_DIR);
}

/** グリフ配列 → ArrayBuffer (95×25 byte) */
export function serializeGlyphs(glyphs) {
  const out = new Uint8Array(glyphs.length * GLYPH_LEN);
  for (let i = 0; i < glyphs.length; i++) out.set(glyphs[i], i * GLYPH_LEN);
  return out.buffer;
}

/** ArrayBuffer → グリフ配列 */
export function deserializeGlyphs(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const n = Math.floor(bytes.length / GLYPH_LEN);
  const glyphs = new Array(n);
  for (let i = 0; i < n; i++) {
    glyphs[i] = bytes.slice(i * GLYPH_LEN, (i + 1) * GLYPH_LEN);
  }
  return glyphs;
}

/**
 * ユーザーフォントを VFS に保存し、レジストリに登録する。
 * @param {string} name        フォント名 (ファイル名 & 表示名)
 * @param {Uint8Array[]} glyphs 5x5 グリフ配列 (95 文字)
 * @returns {string} 登録された font ID
 */
export function saveUserFont(name, glyphs) {
  _ensureDir();
  VFS.writeFileBinary(`${FONTS_DIR}/${name}.font`, serializeGlyphs(glyphs));
  const id = _idForName(name);
  registerUserFont(
    id,
    name,
    glyphs.map((g) => Uint8Array.from(g)),
  );
  return id;
}

/**
 * boot 時に /Fonts 内の全ユーザーフォントを読み込んで登録する。
 */
export function loadUserFonts() {
  if (!VFS.exists(FONTS_DIR)) return;
  const entries = VFS.readDir(FONTS_DIR) || [];
  for (const e of entries) {
    if (e.type !== "file" || !e.name.toLowerCase().endsWith(".font")) continue;
    const buf = VFS.readFileBinary(`${FONTS_DIR}/${e.name}`);
    if (!buf) continue;
    const name = e.name.replace(/\.font$/i, "");
    registerUserFont(_idForName(name), name, deserializeGlyphs(buf));
  }
}
