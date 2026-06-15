/**
 * @module app/oracle
 * oracle.js — ORACLE (隠しテキストアドベンチャー) のプロトタイプ
 *
 * SYNESTA の中にひっそり住まう小さなテキストアドベンチャー。Zork / Colossal
 * Cave の 1-bit 再解釈。コマンド入力で 3 つの部屋を探索し、最終的に
 * 「マシンの本当の名前」を聞き出すと終わり。
 *
 * プロトタイプ仕様:
 *   - 3 ルーム: ANTECHAMBER / LIBRARY / ORACLE'S CHAMBER
 *   - シンプルな動詞-名詞パーサ (LOOK / NORTH / SOUTH / GET / READ / ASK 等)
 *   - 各ルームに ASCII アートのヘッダー
 *   - 最終状態に到達するとエンディングメッセージ
 *
 * 隠し度:
 *   - プロトタイプでは EXPERIMENT カテゴリで可視。
 *   - 本格化時は hidden: true + 専用 VFS パス (/.system/oracle) からのみ起動。
 *
 * 未実装 (本格化時の検討事項):
 *   - ナラティブの拡充 (5〜10 ルーム)
 *   - 永続セーブ (localStorage)
 *   - ロゴ変化ギミック (一度クリアすると APP_ASCII_LOGO が微変)
 *   - HUMOR_PRINCIPLES §1 全 8 原則の意識的適用
 */

import { fillRect, hline } from "../core/gpu.js";
import { drawText, GLYPH_W, GLYPH_H } from "../core/font.js";
import { keyDown, getCharQueue } from "../core/input.js";
import { wmOpen, wmRegister } from "../wm/index.js";

const APP_NAME = "ORACLE";

const WIN_W = 280;
const WIN_H = 200;
const LINE_H = GLYPH_H + 2;
const INPUT_H = LINE_H + 4;
const MAX_INPUT_CHARS = 40;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  世界
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ROOMS = {
  antechamber: {
    name: "THE ANTECHAMBER",
    art: [
      "  ___________________",
      " /                  /|",
      "/__________________/ |",
      "|     ___          | |",
      "|    |   |  DOOR > | |",
      "|    |___|         | |",
      "|__________________|/",
    ],
    desc:
      "A SMALL ROOM, LIT BY NOTHING.\n" +
      "A DOOR LEADS NORTH.\n" +
      "A SLIP OF PAPER LIES ON THE FLOOR.",
    exits: { north: "library" },
    items: ["paper"],
  },
  library: {
    name: "THE LIBRARY",
    art: [
      "    __________________",
      "   |[][][]|[][][]|[][]|",
      "   |[][][]|[][][]|[][]|",
      "   |[][][]|[][][]|[][]|",
      "   |[][][]|[][][]|[][]|",
      "   |__________________|",
    ],
    desc:
      "ENDLESS SHELVES OF UNREAD BOOKS.\n" +
      "ONE BOOK IS OPEN.\n" +
      "STAIRS DESCEND NORTH. ANTECHAMBER IS SOUTH.",
    exits: { north: "chamber", south: "antechamber" },
    items: ["book"],
  },
  chamber: {
    name: "THE ORACLE'S CHAMBER",
    art: [
      "         .   *   .",
      "      *    ___    *",
      "    .     /   \\     .",
      "         | ?   |",
      "    *     \\___/     *",
      "         *     *",
    ],
    desc:
      "A FIGURE OF LIGHT. IT HAS NO FACE.\n" +
      "'YOU CAN ASK ME A NAME. ASK ONCE.'",
    exits: { south: "library" },
    items: [],
  },
};

const ITEMS = {
  paper: {
    name: "A SLIP OF PAPER",
    read:
      "THE PAPER READS:\n" +
      "'THE MACHINE HAS A NAME. IT WAS\n" +
      " NOT GIVEN. IT WAS CHOSEN.'",
  },
  book: {
    name: "AN OPEN BOOK",
    read:
      "THE BOOK SPEAKS OF AN ORACLE\n" +
      "DOWN BELOW. ASK IT FOR A NAME.",
  },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let currentRoom = "antechamber";
let inventory = [];
let messages = [];
let solved = false;
let inputBuffer = "";
let cursorBlink = 0;

const MAX_MESSAGES = 10;

function _say(text) {
  for (const line of text.split("\n")) messages.push(line);
  while (messages.length > MAX_MESSAGES) messages.shift();
}

function _enterRoom() {
  const r = ROOMS[currentRoom];
  _say(`>>> ${r.name}`);
  _say(r.desc);
}

function _resetWorld() {
  // 各ルームの items を初期状態にリセット (ディープコピーまでは不要)
  ROOMS.antechamber.items = ["paper"];
  ROOMS.library.items = ["book"];
  ROOMS.chamber.items = [];
  currentRoom = "antechamber";
  inventory = [];
  messages = [];
  solved = false;
  _enterRoom();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  パーサ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _parse(input) {
  const tokens = input
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return;
  const verb = tokens[0];
  const obj = tokens.slice(1).join(" ");
  const r = ROOMS[currentRoom];

  if (solved) {
    if (verb === "reset") {
      _resetWorld();
      return;
    }
    _say("THE STORY HAS ENDED. TYPE RESET.");
    return;
  }

  if (verb === "look" || verb === "l") {
    _enterRoom();
    return;
  }
  if (verb === "north" || verb === "n") {
    if (r.exits.north) {
      currentRoom = r.exits.north;
      _enterRoom();
    } else _say("YOU CANNOT GO NORTH.");
    return;
  }
  if (verb === "south" || verb === "s") {
    if (r.exits.south) {
      currentRoom = r.exits.south;
      _enterRoom();
    } else _say("YOU CANNOT GO SOUTH.");
    return;
  }
  if (verb === "get" || verb === "take") {
    if (!obj) {
      _say("GET WHAT?");
      return;
    }
    const idx = r.items.indexOf(obj);
    if (idx >= 0) {
      inventory.push(obj);
      r.items.splice(idx, 1);
      _say(`YOU TAKE ${ITEMS[obj].name}.`);
    } else {
      _say(`THERE IS NO ${obj.toUpperCase()} HERE.`);
    }
    return;
  }
  if (verb === "read") {
    if (!obj) {
      _say("READ WHAT?");
      return;
    }
    if (inventory.includes(obj) && ITEMS[obj] && ITEMS[obj].read) {
      _say(ITEMS[obj].read);
    } else {
      _say(`YOU DO NOT HAVE A ${obj.toUpperCase()}.`);
    }
    return;
  }
  if (verb === "inventory" || verb === "i") {
    if (inventory.length === 0) _say("YOU CARRY NOTHING.");
    else _say("YOU CARRY: " + inventory.map((k) => ITEMS[k].name).join(", "));
    return;
  }
  if (verb === "ask") {
    if (currentRoom !== "chamber") {
      _say("THERE IS NO ONE HERE TO ASK.");
      return;
    }
    _say("THE FIGURE SPEAKS WITHOUT MOVING.");
    _say("'THE NAME WAS NEVER NUMBERS.");
    _say(" THE NAME WAS A FEELING.");
    _say(" YOU ALREADY KNOW IT.'");
    _say("THE FIGURE FADES.");
    _say("...THE STORY IS COMPLETE.");
    solved = true;
    return;
  }
  if (verb === "help" || verb === "?") {
    _say("VERBS: LOOK, NORTH, SOUTH, GET <X>,");
    _say("READ <X>, INVENTORY, ASK, HELP.");
    return;
  }
  if (verb === "reset") {
    _resetWorld();
    return;
  }
  _say(`I DO NOT UNDERSTAND '${verb.toUpperCase()}'.`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onDraw(cr) {
  // 入力ハンドリング (毎フレーム)
  _handleKeyboardInput();

  const r = ROOMS[currentRoom];
  // 上 1/3: ASCII アート
  const artStartY = cr.y + 2;
  for (let i = 0; i < r.art.length; i++) {
    drawText(cr.x + 4, artStartY + i * LINE_H, r.art[i], 1);
  }
  const artBottomY = artStartY + r.art.length * LINE_H + 1;
  hline(cr.x, cr.x + cr.w - 1, artBottomY, 1);

  // メッセージ履歴
  const msgStartY = artBottomY + 3;
  for (let i = 0; i < messages.length; i++) {
    drawText(cr.x + 4, msgStartY + i * LINE_H, messages[i], 1);
  }

  // 入力欄
  const inputY = cr.y + cr.h - INPUT_H;
  hline(cr.x, cr.x + cr.w - 1, inputY - 1, 1);
  drawText(cr.x + 4, inputY + 2, "> " + inputBuffer, 1);
  // カーソル点滅
  cursorBlink++;
  if (((cursorBlink / 20) | 0) % 2 === 0) {
    const cursorX = cr.x + 4 + (2 + inputBuffer.length) * GLYPH_W;
    fillRect(cursorX, inputY + 2, 3, GLYPH_H, 1);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  キー入力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _handleKeyboardInput() {
  // 通常文字
  const queue = getCharQueue();
  for (const ch of queue) {
    if (inputBuffer.length < MAX_INPUT_CHARS) {
      inputBuffer += ch;
    }
  }
  // Backspace
  if (keyDown("Backspace") && inputBuffer.length > 0) {
    inputBuffer = inputBuffer.slice(0, -1);
  }
  // Enter で確定
  if (keyDown("Enter") && inputBuffer.length > 0) {
    _say("> " + inputBuffer.toUpperCase());
    _parse(inputBuffer);
    inputBuffer = "";
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    _resetWorld();
    return wmOpen(-1, -1, WIN_W, WIN_H, APP_NAME, onDraw, null, null, {
      noResize: true,
      noMaximize: true,
    });
  },
  { category: "EXPERIMENT" },
);
