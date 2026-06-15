/**
 * @module app/settings
 * settings.js — SETTINGS ウィンドウ
 *
 * パレット切替・壁紙設定・解像度変更を行う設定パネル。
 * 壁紙は 2 モード: Solid (BayerPicker) / Image (VFS 上の PBM ファイル選択)。
 */

import * as Config from "../config.js";
import * as Wallpaper from "../wallpaper.js";
import { setSystemSfxEnabled } from "../core/sfx.js";
import { basename, readDir, parentPath, joinPath } from "../core/vfs.js";
import { wmOpen, wmRegister, wmSetContentSize } from "../wm/index.js";
import {
  Label,
  DropDown,
  ListBox,
  RadioButton,
  NumberBox,
  BayerPicker,
  PushButton,
  ToggleButton,
  WidgetGroup,
  HBox,
  VBox,
  HSep,
  FOCUS_MARGIN,
  openFileDialog,
} from "../ui/index.js";

const APP_NAME = "SETTINGS";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィジェット生成
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── Palette data ──
const paletteKeys = Object.keys(Config.PALETTES);
const paletteLabels = paletteKeys.map((k) => Config.PALETTES[k].label);
const allPaletteKeys = [...paletteKeys, Config.CUSTOM_PALETTE_NAME];
const allPaletteLabels = [...paletteLabels, Config.CUSTOM_PALETTE_NAME];

// ── Widget instance variables (deferred) ──
let labelResolution, dropDownResolution;
let lblFont, ddFont, lblFontPreview;
let lblHeaderPad, numberBoxHeaderPad;
let lblContentPad, nbContentPad;
let lblInputOverlay, tglInputOverlay;
let lblSystemSfx, tglSystemSfx;
let lblPalette, lbPalette;
let labelBackground, numberBoxBgRed, numberBoxBgGreen, numberBoxBgBlue;
let labelForeground, numberBoxFgRed, numberBoxFgGreen, numberBoxFgBlue;
let lblBackground, ddBackground;
let lblBayer, radioBayer4x4, radioBayer8x8;
let lblLevel, bayerPickerSolid;
let lblImagePath, lblImagePathValue, btnBrowse;
let lblImageFile, ddImageFile;
let lblImageFill, ddImageFill;
let imageDir = "/Images/Wallpapers";

let maxLabelWidth = 0;
/** @type {import("../ui/index.js").Label[]} */
let allLabels = [];
let customWidgets, solidWidgets, imageWidgets;
let settingsRoot;
let bgRow, fgRow, bayerRow, levelRow, imagePathRow, imageFileRow, imageFillRow;
let sep1, sep2, sep3;

/** 指定ディレクトリ内の .pbm ファイル名一覧を返す */
function listPbmFiles(dir) {
  const entries = readDir(dir);
  if (!entries) return [];
  return entries
    .filter((e) => e.type === "file" && e.name.toLowerCase().endsWith(".pbm"))
    .map((e) => e.name);
}

/** Image File ドロップダウンを現在のディレクトリで更新する */
function refreshImageFileList() {
  if (!ddImageFile) return;
  const files = listPbmFiles(imageDir);
  ddImageFile.items = files.length > 0 ? files : ["(none)"]; // setter が w/h を自動再計算
  // 現在の壁紙パスがこのディレクトリ内なら選択
  const curPath = Wallpaper.getImagePath();
  if (curPath && parentPath(curPath) === imageDir) {
    const curFile = basename(curPath);
    const idx = files.indexOf(curFile);
    ddImageFile.selectedIndex = idx >= 0 ? idx : 0;
  } else {
    ddImageFile.selectedIndex = 0;
  }
}

/** Level の Bayer モードを切り替え、値をリマップする */
function switchLevelMode(mode) {
  const oldMode = bayerPickerSolid.mode;
  if (oldMode === mode) return;
  const oldMax = oldMode === "8x8" ? 64 : 16;
  const newMax = mode === "8x8" ? 64 : 16;
  const newVal = Math.round((bayerPickerSolid.value / oldMax) * newMax);
  Wallpaper.setSolidBayerMode(mode);
  bayerPickerSolid.setMode(mode);
  bayerPickerSolid.value = newVal;
  Wallpaper.setSolidLevel(newVal);
}

let _ready = false;
function _initWidgets() {
  if (_ready) return;
  _ready = true;

  // ── Resolution ──
  const resLabels = Config.RESOLUTIONS.map((r) => r.label);
  const curResIdx = Config.RESOLUTIONS.findIndex(
    (r) => r.w === Config.VRAM_WIDTH && r.h === Config.VRAM_HEIGHT,
  );
  labelResolution = new Label(0, 0, "Resolution:");
  dropDownResolution = new DropDown(
    0,
    0,
    resLabels,
    Math.max(0, curResIdx),
    (i) => {
      const r = Config.RESOLUTIONS[i];
      Config.setResolution(r.w, r.h);
    },
  );

  // ── Font ──
  const fontLabels = Config.FONTS.map((f) => f.label);
  const curFontIdx = Config.FONTS.findIndex(
    (f) => f.id === Config.getSystemFontId(),
  );
  lblFont = new Label(0, 0, "Font:");
  ddFont = new DropDown(0, 0, fontLabels, Math.max(0, curFontIdx), (i) =>
    Config.setSystemFont(Config.FONTS[i].id),
  );
  // フォントの見た目を即時プレビュー (pangram = 全アルファベット含む英文)。
  // システムフォントで描画されるため、ドロップダウンを切替えると onRelayout
  // → remeasureAll でこの Label が新しいフォントで再計測・再描画される。
  lblFontPreview = new Label(
    0,
    0,
    "THE QUICK BROWN FOX\nJUMPS OVER THE LAZY DOG",
  );

  // ── Header Pad ──
  lblHeaderPad = new Label(0, 0, "Header pad:");
  numberBoxHeaderPad = new NumberBox(
    0,
    0,
    Config.HEADER_PADDING_MIN,
    Config.HEADER_PADDING_MAX,
    Config.getHeaderPad(),
    1,
    () => Config.setHeaderPad(numberBoxHeaderPad.value),
  );

  // ── Content Pad ──
  lblContentPad = new Label(0, 0, "Content pad:");
  nbContentPad = new NumberBox(
    0,
    0,
    Config.CONTENT_PADDING_MIN,
    Config.CONTENT_PADDING_MAX,
    Config.getContentPad(),
    1,
    () => Config.setContentPad(nbContentPad.value),
  );

  // ── セパレータ ──
  sep1 = new HSep(0, 0, 0);
  sep2 = new HSep(0, 0, 0);
  sep3 = new HSep(0, 0, 0);

  // ── Input overlay ──
  lblInputOverlay = new Label(0, 0, "Input overlay:");
  tglInputOverlay = new ToggleButton(
    0,
    0,
    "ON",
    (v) => Config.setInputOverlay(v),
    Config.isInputOverlayEnabled(),
  );

  // ── System SFX ──
  lblSystemSfx = new Label(0, 0, "System SFX:");
  tglSystemSfx = new ToggleButton(
    0,
    0,
    "ON",
    (v) => {
      Config.setSystemSfx(v);
      setSystemSfxEnabled(v);
    },
    Config.isSystemSfxOn(),
  );

  // ── Palette ──
  const curPalName = Config.getPaletteName();
  const curPalIdx = allPaletteKeys.indexOf(curPalName);

  lblPalette = new Label(0, 0, "Palette:");
  lbPalette = new ListBox(
    0,
    0,
    5,
    allPaletteLabels,
    Math.max(0, curPalIdx),
    (i) => {
      Config.setPalette(allPaletteKeys[i]);
      refreshCustomPalette();
      refreshBackground();
    },
  );

  lbPalette.onItemTooltip = (index) => {
    const key = allPaletteKeys[index];
    const p = Config.PALETTES[key];
    if (!p) return null;
    const parts = [];
    if (p.origin) parts.push(p.origin);
    if (p.note) parts.push(p.note);
    return parts.length > 0 ? parts.join("\n") : null;
  };

  // ── Custom palette: BG / FG numberboxes ──
  const customRgb = Config.getCustomPaletteRgb();

  labelBackground = new Label(0, 0, "BG:");
  numberBoxBgRed = new NumberBox(0, 0, 0, 255, customRgb.bg[0], 1, () =>
    Config.setCustomPaletteRgb(
      "bg",
      numberBoxBgRed.value,
      numberBoxBgGreen.value,
      numberBoxBgBlue.value,
    ),
  );
  numberBoxBgGreen = new NumberBox(0, 0, 0, 255, customRgb.bg[1], 1, () =>
    Config.setCustomPaletteRgb(
      "bg",
      numberBoxBgRed.value,
      numberBoxBgGreen.value,
      numberBoxBgBlue.value,
    ),
  );
  numberBoxBgBlue = new NumberBox(0, 0, 0, 255, customRgb.bg[2], 1, () =>
    Config.setCustomPaletteRgb(
      "bg",
      numberBoxBgRed.value,
      numberBoxBgGreen.value,
      numberBoxBgBlue.value,
    ),
  );

  labelForeground = new Label(0, 0, "FG:");
  numberBoxFgRed = new NumberBox(0, 0, 0, 255, customRgb.fg[0], 1, () =>
    Config.setCustomPaletteRgb(
      "fg",
      numberBoxFgRed.value,
      numberBoxFgGreen.value,
      numberBoxFgBlue.value,
    ),
  );
  numberBoxFgGreen = new NumberBox(0, 0, 0, 255, customRgb.fg[1], 1, () =>
    Config.setCustomPaletteRgb(
      "fg",
      numberBoxFgRed.value,
      numberBoxFgGreen.value,
      numberBoxFgBlue.value,
    ),
  );
  numberBoxFgBlue = new NumberBox(0, 0, 0, 255, customRgb.fg[2], 1, () =>
    Config.setCustomPaletteRgb(
      "fg",
      numberBoxFgRed.value,
      numberBoxFgGreen.value,
      numberBoxFgBlue.value,
    ),
  );

  // ── Background mode ──
  lblBackground = new Label(0, 0, "Background:");
  ddBackground = new DropDown(0, 0, ["Solid", "Image"], 0, (i) => {
    const modes = ["solid", "image"];
    Wallpaper.setBackgroundMode(modes[i]);
    refreshBackground();
  });

  // ── Level ──
  lblBayer = new Label(0, 0, "Bayer:");

  radioBayer4x4 = new RadioButton(
    0,
    0,
    "4x4",
    "levelmode",
    () => switchLevelMode("4x4"),
    true,
  );
  radioBayer8x8 = new RadioButton(
    0,
    0,
    "8x8",
    "levelmode",
    () => switchLevelMode("8x8"),
    false,
  );

  lblLevel = new Label(0, 0, "Level:");

  bayerPickerSolid = new BayerPicker(0, 0, Wallpaper.getSolidLevel(), (v) =>
    Wallpaper.setSolidLevel(v),
  );

  // ── Image path (Image sub-panel) ──
  lblImagePath = new Label(0, 0, "Path:");
  const curPath = Wallpaper.getImagePath();
  if (curPath) imageDir = parentPath(curPath);
  lblImagePathValue = new Label(0, 0, imageDir);
  btnBrowse = new PushButton(0, 0, "...", () => {
    openFileDialog("open", {
      title: "SELECT WALLPAPER",
      defaultPath: imageDir,
      filter: [".pbm"],
      onResult: (path) => {
        if (path) {
          imageDir = parentPath(path);
          lblImagePathValue.text = imageDir;
          Wallpaper.setImagePath(path);
          refreshImageFileList();
        }
      },
    });
  });
  btnBrowse.tooltip = "Browse VFS for PBM image";

  // ── Image file dropdown ──
  lblImageFile = new Label(0, 0, "File:");
  ddImageFile = new DropDown(0, 0, ["(none)"], 0, (i) => {
    const files = listPbmFiles(imageDir);
    if (i >= 0 && i < files.length) {
      const path = joinPath(imageDir, files[i]);
      Wallpaper.setImagePath(path);
    }
  });

  lblImageFill = new Label(0, 0, "Fill:");
  ddImageFill = new DropDown(
    0,
    0,
    ["0", "1"],
    Wallpaper.getImageFillBit(),
    (i) => Wallpaper.setImageFillBit(i),
  );

  refreshImageFileList();

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  ラベル幅を全体で統一
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  allLabels = [
    labelResolution,
    lblFont,
    lblHeaderPad,
    lblContentPad,
    lblInputOverlay,
    lblSystemSfx,
    lblPalette,
    labelBackground,
    labelForeground,
    lblBackground,
    lblBayer,
    lblLevel,
    lblImagePath,
    lblImageFile,
    lblImageFill,
  ];
  maxLabelWidth = Math.max(...allLabels.map((l) => l.w));
  for (const l of allLabels) l.w = maxLabelWidth;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Box レイアウト
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  bgRow = HBox([
    labelBackground,
    numberBoxBgRed,
    numberBoxBgGreen,
    numberBoxBgBlue,
  ]);
  fgRow = HBox([
    labelForeground,
    numberBoxFgRed,
    numberBoxFgGreen,
    numberBoxFgBlue,
  ]);
  bayerRow = HBox([lblBayer, radioBayer4x4, radioBayer8x8]);
  levelRow = HBox([lblLevel, bayerPickerSolid]);
  imagePathRow = HBox([lblImagePath, lblImagePathValue, btnBrowse]);
  imageFileRow = HBox([lblImageFile, ddImageFile]);
  imageFillRow = HBox([lblImageFill, ddImageFill]);

  settingsRoot = VBox([
    // ── DISPLAY ──
    HBox([labelResolution, dropDownResolution]),
    HBox([lblFont, ddFont]),
    lblFontPreview,
    HBox([lblHeaderPad, numberBoxHeaderPad, new Label(0, 0, "DOT")]),
    HBox([lblContentPad, nbContentPad, new Label(0, 0, "DOT")]),
    sep1,
    // ── SYSTEM ──
    HBox([lblInputOverlay, tglInputOverlay]),
    HBox([lblSystemSfx, tglSystemSfx]),
    sep2,
    // ── PALETTE ──
    HBox([lblPalette, lbPalette]),
    bgRow,
    fgRow,
    sep3,
    // ── WALLPAPER ──
    HBox([lblBackground, ddBackground]),
    bayerRow,
    levelRow,
    imagePathRow,
    imageFileRow,
    imageFillRow,
  ]);

  // ── ウィジェットグループ & セクション定義 ──
  customWidgets = [bgRow, fgRow];
  solidWidgets = [bayerRow, levelRow];
  imageWidgets = [imagePathRow, imageFileRow, imageFillRow];

  // WidgetGroup(root) は初期 layout + auto-layout を実行
  appearWidgets = new WidgetGroup(settingsRoot);
}

let appearWidgets;

/** カスタムパレット行の表示切替 (auto-layout が次フレームで反映)。 */
function refreshCustomPalette() {
  const isCustom = Config.getPaletteName() === Config.CUSTOM_PALETTE_NAME;
  for (const row of customWidgets) row.visible = isCustom;
}

/** 背景モードに応じてサブパネルの表示切替 (auto-layout が次フレームで反映)。 */
function refreshBackground() {
  const mode = Wallpaper.getBackgroundMode();
  for (const row of solidWidgets) row.visible = mode === "solid";
  for (const row of imageWidgets) row.visible = mode === "image";
}

/** 背景関連ウィジェットを壁紙設定と同期する (initWallpaper 後に 1 回)。 */
let bgSynced = false;
function syncBgWidgets() {
  if (bgSynced) return;
  if (!Wallpaper.isWallpaperReady()) return;
  bgSynced = true;

  // Background ドロップダウン
  const curMode = Wallpaper.getBackgroundMode();
  ddBackground.selectedIndex = curMode === "image" ? 1 : 0;
  ddImageFill.selectedIndex = Wallpaper.getImageFillBit();

  // Appearance ウィジェット同期
  numberBoxHeaderPad.value = Config.getHeaderPad();
  nbContentPad.value = Config.getContentPad();
  lbPalette.selectedIndex = Math.max(
    0,
    allPaletteKeys.indexOf(Config.getPaletteName()),
  );
  const cRgb = Config.getCustomPaletteRgb();
  numberBoxBgRed.value = cRgb.bg[0];
  numberBoxBgGreen.value = cRgb.bg[1];
  numberBoxBgBlue.value = cRgb.bg[2];
  numberBoxFgRed.value = cRgb.fg[0];
  numberBoxFgGreen.value = cRgb.fg[1];
  numberBoxFgBlue.value = cRgb.fg[2];

  bayerPickerSolid.value = Wallpaper.getSolidLevel();
  const lm = Wallpaper.getSolidBayerMode();
  radioBayer4x4.value = lm === "4x4";
  radioBayer8x8.value = lm === "8x8";
  if (bayerPickerSolid.mode !== lm) {
    bayerPickerSolid.setMode(lm);
  }

  // 壁紙画像パス同期
  const imgPath = Wallpaper.getImagePath();
  if (imgPath) {
    imageDir = parentPath(imgPath);
    lblImagePathValue.text = imageDir;
  } else {
    lblImagePathValue.text = imageDir;
  }
  refreshImageFileList();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィンドウ登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(
  APP_NAME,
  () => {
    _initWidgets();
    const id = wmOpen(
      -1,
      -1,
      0,
      0,
      APP_NAME,
      (contentRect) => {
        syncBgWidgets();
        refreshCustomPalette();
        refreshBackground();
        const size = settingsRoot.measure();
        wmSetContentSize(id, size.h);
        appearWidgets.draw(contentRect);
      },
      (ev) => appearWidgets.update(ev),
      () => settingsRoot.measure(),
      {
        scrollable: true,
        onRelayout: () => {
          appearWidgets.remeasureAll();
          // ラベル幅再統一 (remeasure で自然幅に戻った後に再揃え)
          maxLabelWidth = Math.max(...allLabels.map((l) => l.w));
          for (const l of allLabels) l.w = maxLabelWidth;
          settingsRoot.layout(FOCUS_MARGIN, FOCUS_MARGIN);
        },
      },
    );
    return id;
  },
  { shortName: "SETTING" },
);

