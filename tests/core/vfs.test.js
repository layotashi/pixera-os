/**
 * core/vfs.js — 仮想ファイルシステムのテスト
 *
 * storage.js をモックして localStorage 無しで VFS のロジックをテスト。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// storage.js をモック (save/load を no-op に)
vi.mock("@/core/storage.js", () => ({
  save: vi.fn(),
  load: vi.fn(() => null), // 常に null → デフォルトツリーを使う
}));

import {
  initVfs,
  _resetVfs,
  parentPath,
  basename,
  joinPath,
  exists,
  stat,
  readDir,
  readFile,
  writeFile,
  writeFileBinary,
  readFileBinary,
  isBinaryFile,
  mkdir,
  remove,
  rename,
  move,
  flattenTree,
} from "@/core/vfs.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  フィクスチャ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

beforeEach(() => {
  _resetVfs(); // 二重初期化ガードを解除し、毎テストでクリーンな
  initVfs(); // デフォルトツリーに初期化
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  パスユーティリティ (純粋関数)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("parentPath", () => {
  it('ルートの親は "/"', () => {
    expect(parentPath("/")).toBe("/");
  });

  it("トップレベルの親はルート", () => {
    expect(parentPath("/Documents")).toBe("/");
  });

  it("深いパスの親を返す", () => {
    expect(parentPath("/Documents/sub/file.txt")).toBe("/Documents/sub");
  });
});

describe("basename", () => {
  it("ルートは空文字", () => {
    expect(basename("/")).toBe("");
  });

  it("ファイル名を返す", () => {
    expect(basename("/Documents/hello.txt")).toBe("hello.txt");
  });

  it("ディレクトリ名を返す", () => {
    expect(basename("/Documents")).toBe("Documents");
  });
});

describe("joinPath", () => {
  it("ルートとファイル名の結合", () => {
    expect(joinPath("/", "test.txt")).toBe("/test.txt");
  });

  it("ディレクトリとファイル名の結合", () => {
    expect(joinPath("/Documents", "hello.txt")).toBe("/Documents/hello.txt");
  });

  it("末尾スラッシュ付きの base でも正しい", () => {
    expect(joinPath("/Documents/", "hello.txt")).toBe("/Documents/hello.txt");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  デフォルトツリーの確認
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("デフォルトツリー", () => {
  it("ルートが存在する", () => {
    expect(exists("/")).toBe(true);
  });

  it("Desktop, Documents, Pictures, Music が存在する", () => {
    expect(exists("/Desktop")).toBe(true);
    expect(exists("/Documents")).toBe(true);
    expect(exists("/Pictures")).toBe(true);
    expect(exists("/Music")).toBe(true);
  });

  it("Pictures/Wallpapers が存在する", () => {
    expect(exists("/Pictures/Wallpapers")).toBe(true);
    const s = stat("/Pictures/Wallpapers");
    expect(s.type).toBe("dir");
  });

  it("Documents/readme.txt が存在する", () => {
    expect(exists("/Documents/readme.txt")).toBe(true);
  });

  it("存在しないパスは false", () => {
    expect(exists("/nonexistent")).toBe(false);
    expect(exists("/Documents/missing.txt")).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  stat
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("stat", () => {
  it("ディレクトリの stat を返す", () => {
    const s = stat("/Documents");
    expect(s).not.toBeNull();
    expect(s.type).toBe("dir");
    expect(s.name).toBe("Documents");
    expect(s.childCount).toBe(1); // readme.txt
  });

  it("ファイルの stat を返す", () => {
    const s = stat("/Documents/readme.txt");
    expect(s).not.toBeNull();
    expect(s.type).toBe("file");
    expect(s.name).toBe("readme.txt");
    expect(s.size).toBeGreaterThan(0);
  });

  it("存在しないパスは null", () => {
    expect(stat("/missing")).toBeNull();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  readDir
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("readDir", () => {
  it("ルートの子一覧を返す (dir→file 順)", () => {
    const entries = readDir("/");
    expect(entries).not.toBeNull();
    expect(entries.length).toBe(4);
    // 全てディレクトリで名前昇順
    expect(entries.map((e) => e.name)).toEqual([
      "Desktop",
      "Documents",
      "Music",
      "Pictures",
    ]);
    expect(entries.every((e) => e.type === "dir")).toBe(true);
  });

  it("ファイルに対しては null", () => {
    expect(readDir("/Documents/readme.txt")).toBeNull();
  });

  it("存在しないパスは null", () => {
    expect(readDir("/x")).toBeNull();
  });

  it("ディレクトリとファイルが混在する場合、dir が先", () => {
    mkdir("/Desktop/sub");
    writeFile("/Desktop/note.txt", "hello");
    const entries = readDir("/Desktop");
    expect(entries[0].type).toBe("dir");
    expect(entries[1].type).toBe("file");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  readFile / writeFile
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("readFile / writeFile", () => {
  it("既存ファイルの内容を読める", () => {
    const content = readFile("/Documents/readme.txt");
    expect(content).toContain("Welcome to PIXERA!");
  });

  it("新規ファイルを書き込んで読み出す", () => {
    expect(writeFile("/Documents/test.txt", "hello world")).toBe(true);
    expect(readFile("/Documents/test.txt")).toBe("hello world");
  });

  it("既存ファイルを上書きできる", () => {
    writeFile("/Documents/readme.txt", "new content");
    expect(readFile("/Documents/readme.txt")).toBe("new content");
  });

  it("存在しない親ディレクトリには書き込めない", () => {
    expect(writeFile("/missing/test.txt", "data")).toBe(false);
  });

  it("ディレクトリに対しては readFile は null", () => {
    expect(readFile("/Documents")).toBeNull();
  });

  it("ディレクトリに対して writeFile は失敗", () => {
    expect(writeFile("/Documents", "data")).toBe(false);
  });

  it("空文字名では書き込めない", () => {
    expect(writeFile("/", "data")).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  mkdir
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("mkdir", () => {
  it("新規ディレクトリを作成できる", () => {
    expect(mkdir("/Projects")).toBe(true);
    expect(exists("/Projects")).toBe(true);
    expect(stat("/Projects").type).toBe("dir");
  });

  it("既存ディレクトリに対しては true (冪等)", () => {
    expect(mkdir("/Documents")).toBe(true);
  });

  it("存在しない親ディレクトリ下には作れない", () => {
    expect(mkdir("/missing/sub")).toBe(false);
  });

  it("ネストしたディレクトリを順次作成できる", () => {
    mkdir("/Projects");
    expect(mkdir("/Projects/web")).toBe(true);
    expect(exists("/Projects/web")).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  remove
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("remove", () => {
  it("ファイルを削除できる", () => {
    expect(remove("/Documents/readme.txt")).toBe(true);
    expect(exists("/Documents/readme.txt")).toBe(false);
  });

  it("空ディレクトリを削除できる", () => {
    expect(remove("/Desktop")).toBe(true);
    expect(exists("/Desktop")).toBe(false);
  });

  it("中身のあるディレクトリは削除できない", () => {
    expect(remove("/Documents")).toBe(false);
  });

  it("ルートは削除できない", () => {
    expect(remove("/")).toBe(false);
  });

  it("存在しないパスは false", () => {
    expect(remove("/nonexistent")).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  remove({ recursive: true })
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("remove recursive", () => {
  it("中身のあるディレクトリを再帰削除できる", () => {
    expect(remove("/Documents", { recursive: true })).toBe(true);
    expect(exists("/Documents")).toBe(false);
    expect(exists("/Documents/readme.txt")).toBe(false);
  });

  it("ルートは再帰削除できない", () => {
    expect(remove("/", { recursive: true })).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  rename
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("rename", () => {
  it("ファイルをリネームできる", () => {
    expect(rename("/Documents/readme.txt", "notes.txt")).toBe(true);
    expect(exists("/Documents/readme.txt")).toBe(false);
    expect(exists("/Documents/notes.txt")).toBe(true);
    expect(readFile("/Documents/notes.txt")).toContain("Welcome");
  });

  it("ディレクトリをリネームできる", () => {
    expect(rename("/Desktop", "MyDesktop")).toBe(true);
    expect(exists("/Desktop")).toBe(false);
    expect(exists("/MyDesktop")).toBe(true);
  });

  it("同名の兄弟がある場合は失敗", () => {
    writeFile("/Documents/test.txt", "");
    expect(rename("/Documents/test.txt", "readme.txt")).toBe(false);
  });

  it("スラッシュを含む名前は失敗", () => {
    expect(rename("/Documents/readme.txt", "sub/file.txt")).toBe(false);
  });

  it("ルートはリネームできない", () => {
    expect(rename("/", "root")).toBe(false);
  });

  it("存在しないパスは失敗", () => {
    expect(rename("/missing", "new")).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  move
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("move", () => {
  it("ファイルを別のディレクトリに移動", () => {
    expect(move("/Documents/readme.txt", "/Desktop/readme.txt")).toBe(true);
    expect(exists("/Documents/readme.txt")).toBe(false);
    expect(exists("/Desktop/readme.txt")).toBe(true);
    expect(readFile("/Desktop/readme.txt")).toContain("Welcome");
  });

  it("ディレクトリへの移動 (destPath が既存ディレクトリの場合)", () => {
    writeFile("/Desktop/note.txt", "test");
    expect(move("/Desktop/note.txt", "/Documents")).toBe(true);
    expect(exists("/Documents/note.txt")).toBe(true);
  });

  it("ルートは移動できない", () => {
    expect(move("/", "/Desktop")).toBe(false);
  });

  it("同一パスは移動しない", () => {
    expect(move("/Documents/readme.txt", "/Documents/readme.txt")).toBe(false);
  });

  it("自身の子孫への移動は不正", () => {
    mkdir("/Documents/sub");
    expect(move("/Documents", "/Documents/sub")).toBe(false);
  });

  it("移動先に同名ファイルがある場合は失敗", () => {
    writeFile("/Desktop/readme.txt", "other");
    expect(move("/Documents/readme.txt", "/Desktop/readme.txt")).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  flattenTree
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("flattenTree", () => {
  it("デフォルトツリーをフラット化できる", () => {
    const entries = flattenTree({});
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].path).toBe("/");
    expect(entries[0].type).toBe("dir");
  });

  it("展開状態を反映する", () => {
    // Documents を折りたたむ
    const entries = flattenTree({ "/Documents": false });
    const docEntry = entries.find((e) => e.path === "/Documents");
    expect(docEntry.expanded).toBe(false);
    // readme.txt は出現しない
    expect(entries.find((e) => e.name === "readme.txt")).toBeUndefined();
  });

  it("ディレクトリはファイルより先にソートされる", () => {
    mkdir("/Desktop/sub");
    writeFile("/Desktop/aaa.txt", "");
    const entries = flattenTree({});
    const desktopChildren = entries.filter(
      (e) => e.depth === 2 && e.path.startsWith("/Desktop/"),
    );
    if (desktopChildren.length >= 2) {
      // dir が先
      expect(desktopChildren[0].type).toBe("dir");
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  バイナリファイル対応
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ヘルパー: 指定バイト列で ArrayBuffer を生成 */
function makeBuffer(bytes) {
  const buf = new ArrayBuffer(bytes.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) view[i] = bytes[i];
  return buf;
}

describe("writeFileBinary / readFileBinary", () => {
  it("バイナリデータを書き込んで読み出すラウンドトリップ", () => {
    const data = makeBuffer([0x00, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0xff]);
    expect(writeFileBinary("/Documents/test.bin", data)).toBe(true);
    const result = readFileBinary("/Documents/test.bin");
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(result)).toEqual(new Uint8Array(data));
  });

  it("空の ArrayBuffer を書き込んで読み出せる", () => {
    const data = makeBuffer([]);
    expect(writeFileBinary("/Documents/empty.bin", data)).toBe(true);
    const result = readFileBinary("/Documents/empty.bin");
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(0);
  });

  it("大きめのバイナリデータ (256 bytes) をラウンドトリップ", () => {
    const bytes = Array.from({ length: 256 }, (_, i) => i);
    const data = makeBuffer(bytes);
    expect(writeFileBinary("/Documents/all_bytes.bin", data)).toBe(true);
    const result = readFileBinary("/Documents/all_bytes.bin");
    expect(new Uint8Array(result)).toEqual(new Uint8Array(data));
  });

  it("存在しない親ディレクトリへの書き込みは失敗", () => {
    const data = makeBuffer([1, 2, 3]);
    expect(writeFileBinary("/missing/test.bin", data)).toBe(false);
  });

  it("ディレクトリパスへのバイナリ書き込みは失敗", () => {
    const data = makeBuffer([1, 2, 3]);
    expect(writeFileBinary("/Documents", data)).toBe(false);
  });

  it("ルートパスへのバイナリ書き込みは失敗", () => {
    const data = makeBuffer([1]);
    expect(writeFileBinary("/", data)).toBe(false);
  });

  it("ArrayBuffer 以外を渡すと失敗", () => {
    expect(writeFileBinary("/Documents/test.bin", "not a buffer")).toBe(false);
    expect(writeFileBinary("/Documents/test.bin", null)).toBe(false);
    expect(writeFileBinary("/Documents/test.bin", 42)).toBe(false);
    expect(writeFileBinary("/Documents/test.bin", new Uint8Array(4))).toBe(
      false,
    );
  });

  it("既存のテキストファイルをバイナリで上書きできる", () => {
    writeFile("/Documents/convert.txt", "hello text");
    const data = makeBuffer([0xde, 0xad, 0xbe, 0xef]);
    expect(writeFileBinary("/Documents/convert.txt", data)).toBe(true);
    // readFile は null を返す (バイナリファイルなので)
    expect(readFile("/Documents/convert.txt")).toBeNull();
    // readFileBinary で読める
    const result = readFileBinary("/Documents/convert.txt");
    expect(new Uint8Array(result)).toEqual(new Uint8Array(data));
  });

  it("既存のバイナリファイルをテキストで上書きできる", () => {
    writeFileBinary("/Documents/revert.bin", makeBuffer([1, 2, 3]));
    writeFile("/Documents/revert.bin", "back to text");
    // readFile で読める
    expect(readFile("/Documents/revert.bin")).toBe("back to text");
    // readFileBinary は null を返す (テキストファイルなので)
    expect(readFileBinary("/Documents/revert.bin")).toBeNull();
  });
});

describe("readFile とバイナリの互換性", () => {
  it("バイナリファイルに対して readFile は null を返す", () => {
    writeFileBinary(
      "/Documents/data.wav",
      makeBuffer([0x52, 0x49, 0x46, 0x46]),
    );
    expect(readFile("/Documents/data.wav")).toBeNull();
  });

  it("テキストファイルに対して readFileBinary は null を返す", () => {
    writeFile("/Documents/note.txt", "hello");
    expect(readFileBinary("/Documents/note.txt")).toBeNull();
  });

  it("存在しないパスに対して readFileBinary は null を返す", () => {
    expect(readFileBinary("/nonexistent")).toBeNull();
  });

  it("ディレクトリに対して readFileBinary は null を返す", () => {
    expect(readFileBinary("/Documents")).toBeNull();
  });
});

describe("isBinaryFile", () => {
  it("バイナリファイルに対して true を返す", () => {
    writeFileBinary("/Documents/sound.wav", makeBuffer([1, 2, 3]));
    expect(isBinaryFile("/Documents/sound.wav")).toBe(true);
  });

  it("テキストファイルに対して false を返す", () => {
    expect(isBinaryFile("/Documents/readme.txt")).toBe(false);
  });

  it("存在しないパスに対して false を返す", () => {
    expect(isBinaryFile("/nonexistent")).toBe(false);
  });

  it("ディレクトリに対して false を返す", () => {
    expect(isBinaryFile("/Documents")).toBe(false);
  });

  it("バイナリ→テキスト上書き後は false になる", () => {
    writeFileBinary("/Documents/flip.bin", makeBuffer([0xff]));
    expect(isBinaryFile("/Documents/flip.bin")).toBe(true);
    writeFile("/Documents/flip.bin", "text now");
    expect(isBinaryFile("/Documents/flip.bin")).toBe(false);
  });
});

describe("stat とバイナリファイル", () => {
  it("バイナリファイルの size は実バイト数を返す", () => {
    const data = makeBuffer([10, 20, 30, 40, 50]);
    writeFileBinary("/Documents/five.bin", data);
    const s = stat("/Documents/five.bin");
    expect(s).not.toBeNull();
    expect(s.size).toBe(5);
    expect(s.encoding).toBe("base64");
  });

  it("テキストファイルの stat には encoding がない", () => {
    const s = stat("/Documents/readme.txt");
    expect(s).not.toBeNull();
    expect(s.encoding).toBeUndefined();
  });

  it("空のバイナリファイルの size は 0", () => {
    writeFileBinary("/Documents/empty.bin", makeBuffer([]));
    const s = stat("/Documents/empty.bin");
    expect(s.size).toBe(0);
    expect(s.encoding).toBe("base64");
  });

  it("256 バイトのバイナリファイルの size は 256", () => {
    const bytes = Array.from({ length: 256 }, (_, i) => i);
    writeFileBinary("/Documents/full.bin", makeBuffer(bytes));
    const s = stat("/Documents/full.bin");
    expect(s.size).toBe(256);
  });
});

describe("バイナリとテキストの共存", () => {
  it("同じディレクトリにテキストとバイナリを作成できる", () => {
    writeFile("/Documents/note.txt", "hello");
    writeFileBinary(
      "/Documents/clip.wav",
      makeBuffer([0x52, 0x49, 0x46, 0x46]),
    );
    // 両方存在する
    expect(exists("/Documents/note.txt")).toBe(true);
    expect(exists("/Documents/clip.wav")).toBe(true);
    // readDir に両方出る
    const entries = readDir("/Documents");
    const names = entries.map((e) => e.name);
    expect(names).toContain("note.txt");
    expect(names).toContain("clip.wav");
  });

  it("バイナリファイルを remove で削除できる", () => {
    writeFileBinary("/Documents/temp.bin", makeBuffer([1]));
    expect(remove("/Documents/temp.bin")).toBe(true);
    expect(exists("/Documents/temp.bin")).toBe(false);
  });

  it("バイナリファイルを rename できる", () => {
    writeFileBinary("/Documents/old.bin", makeBuffer([0xab, 0xcd]));
    expect(rename("/Documents/old.bin", "new.bin")).toBe(true);
    expect(exists("/Documents/old.bin")).toBe(false);
    const result = readFileBinary("/Documents/new.bin");
    expect(new Uint8Array(result)).toEqual(new Uint8Array([0xab, 0xcd]));
  });

  it("バイナリファイルを move できる", () => {
    writeFileBinary("/Documents/moveme.bin", makeBuffer([0x01, 0x02]));
    expect(move("/Documents/moveme.bin", "/Desktop/moveme.bin")).toBe(true);
    expect(exists("/Documents/moveme.bin")).toBe(false);
    const result = readFileBinary("/Desktop/moveme.bin");
    expect(new Uint8Array(result)).toEqual(new Uint8Array([0x01, 0x02]));
  });
});

