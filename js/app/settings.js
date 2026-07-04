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
import { copyDefaultsToClipboard } from "../core/defaults.js";
import {
  basename,
  readDir,
  parentPath,
  joinPath,
  readFile,
} from "../core/vfs.js";
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
  Slider,
  TabBar,
  WidgetGroup,
  HBox,
  VBox,
  HSep,
  FOCUS_MARGIN,
  openFileDialog,
} from "../ui/index.js";

const APP_NAME = "SETTINGS";

// 設定はタブで分類: DISPLAY / EFFECTS / THEME / SYSTEM。
const TAB_LABELS = ["DISPLAY", "EFFECTS", "THEME", "SYSTEM"];
const SLIDER_W = 80; // EFFECTS スライダ幅

function formatPercent(v) {
  return String(v).padStart(4) + "%";
}
function formatPx(v) {
  return String(v).padStart(4);
}

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
let lblFont, ddFont, lblFontPreview, lblFontPreviewIndent, lblFontPreviewSpacer;
let lblHeaderPad, numberBoxHeaderPad;
let lblContentPad, nbContentPad;
let lblInputOverlay, tglInputOverlay;
let lblSystemSfx, tglSystemSfx;
let lblPalette, lbPalette;
let lblInvert, tglInvert;
let labelBackground, numberBoxBgRed, numberBoxBgGreen, numberBoxBgBlue;
let labelForeground, numberBoxFgRed, numberBoxFgGreen, numberBoxFgBlue;
let lblBackground, ddBackground;
let lblBayer, radioBayer4x4, radioBayer8x8;
let lblLevel, bayerPickerSolid;
let lblImagePath, lblImagePathValue, btnBrowse;
let lblImageFile, ddImageFile;
let lblImageFill, ddImageFill;
let imageDir = "/Pictures/Wallpapers";
let lblTessPath, lblTessPathValue, btnTessBrowse;
let tessDir = "/Sketches";

// ── EFFECTS (旧 TUNING) ウィジェット ──
let lblVignette, tglVignette;
let lblVigStrength, sldVigStrength, valVigStrength;
let lblVigRadius, sldVigRadius, valVigRadius;
let lblDiagonal, tglDiagonal;
let lblDiagDarkness, sldDiagDarkness, valDiagDarkness;
let lblDiagSpeed, sldDiagSpeed, valDiagSpeed;
let lblDiagSpacing, nbDiagSpacing;
let lblDiagThickness, nbDiagThickness;
let vigRows, diagRows;

let maxLabelWidth = 0;
/** @type {import("../ui/index.js").Label[]} */
let allLabels = [];
let customWidgets, solidWidgets, imageWidgets, tesseraWidgets;
let bgRow,
  fgRow,
  bayerRow,
  levelRow,
  imagePathRow,
  imageFileRow,
  imageFillRow,
  tessPathRow;
let sep1, sep2, sep3;

// ── タブ ──
let tabBar;
let activeTab = 0;
let pages; // [displayPage, effectsPage, themePage, systemPage] (各 VBox)
let mainRoot, mainWidgets; // 現在タブ = VBox([tabRow, pages[activeTab]])

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
  // フォント一覧 / 選択の変化に追従 (FONTSMITH での保存・適用を即時反映)
  const _syncFontSel = () => {
    if (!ddFont) return;
    const idx = Config.FONTS.findIndex(
      (f) => f.id === Config.getSystemFontId(),
    );
    ddFont.selectedIndex = Math.max(0, idx);
  };
  Config.onFontListChange(() => {
    if (ddFont) ddFont.items = Config.FONTS.map((f) => f.label); // setter が幅再計算
    _syncFontSel();
  });
  Config.onFontChange(_syncFontSel);
  // フォントの見た目を即時プレビュー (pangram = 全アルファベット含む英文)。
  // システムフォントで描画されるため、ドロップダウンを切替えると onRelayout
  // → remeasureAll でこの Label が新しいフォントで再計測・再描画される。
  lblFontPreview = new Label(
    0,
    0,
    "THE QUICK BROWN FOX\nJUMPS OVER THE LAZY DOG",
  );
  // Indent: ラベル列に空 Label を置いてコンテンツ列に揃える (整列の原則)
  lblFontPreviewIndent = new Label(0, 0, "");
  // Spacer: パングラム下に余白を入れて FONT グループと HEADER PAD を分離 (近接の原則)
  lblFontPreviewSpacer = new Label(0, 0, "");

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

  // ── Invert (reverse video): 選択中パレットの FG/BG を入れ替える ──
  lblInvert = new Label(0, 0, "Invert:");
  tglInvert = new ToggleButton(
    0,
    0,
    "ON",
    (v) => Config.setInvert(v),
    Config.isInvert(),
  );
  tglInvert.tooltip = "Reverse video: swap FG/BG";

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
  ddBackground = new DropDown(0, 0, ["Solid", "Image", "Tessera"], 0, (i) => {
    const modes = ["solid", "image", "tessera"];
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

  // ── Tessera sketch (.tess を背景に live-render) ──
  lblTessPath = new Label(0, 0, "Sketch:");
  lblTessPathValue = new Label(0, 0, tessDir);
  btnTessBrowse = new PushButton(0, 0, "...", () => {
    openFileDialog("open", {
      title: "SELECT WALLPAPER SKETCH",
      defaultPath: tessDir,
      filter: [".tess"],
      onResult: (path) => {
        if (!path) return;
        const src = readFile(path);
        if (src != null && Wallpaper.setTessSource(src)) {
          tessDir = parentPath(path);
          lblTessPathValue.text = basename(path);
        }
      },
    });
  });
  btnTessBrowse.tooltip = "Browse VFS for a .tess sketch";

  lblImageFill = new Label(0, 0, "Fill:");
  ddImageFill = new DropDown(
    0,
    0,
    ["0", "1"],
    Wallpaper.getImageFillBit(),
    (i) => Wallpaper.setImageFillBit(i),
  );

  refreshImageFileList();

  // ── EFFECTS (旧 TUNING): ビネット / 斜線スキャンライン ──
  const ep = Config.getEffectParams();
  lblVignette = new Label(0, 0, "Vignette:");
  tglVignette = new ToggleButton(
    0,
    0,
    "ON",
    (v) => {
      Config.setEffectParam("vignetteEnabled", v);
      refreshEffectVisibility();
    },
    ep.vignetteEnabled,
  );
  lblVigStrength = new Label(0, 0, "Strength:");
  valVigStrength = new Label(0, 0, formatPercent(ep.vignetteStrength));
  sldVigStrength = new Slider(
    0,
    0,
    SLIDER_W,
    0,
    100,
    ep.vignetteStrength,
    (v) => {
      valVigStrength.text = formatPercent(v);
      Config.setEffectParam("vignetteStrength", v);
    },
  );
  lblVigRadius = new Label(0, 0, "Radius:");
  valVigRadius = new Label(0, 0, formatPercent(ep.vignetteRadius));
  sldVigRadius = new Slider(0, 0, SLIDER_W, 0, 50, ep.vignetteRadius, (v) => {
    valVigRadius.text = formatPercent(v);
    Config.setEffectParam("vignetteRadius", v);
  });
  lblDiagonal = new Label(0, 0, "Diagonal:");
  tglDiagonal = new ToggleButton(
    0,
    0,
    "ON",
    (v) => {
      Config.setEffectParam("diagEnabled", v);
      refreshEffectVisibility();
    },
    ep.diagEnabled,
  );
  lblDiagDarkness = new Label(0, 0, "Darkness:");
  valDiagDarkness = new Label(0, 0, formatPercent(ep.diagDarkness));
  sldDiagDarkness = new Slider(0, 0, SLIDER_W, 0, 100, ep.diagDarkness, (v) => {
    valDiagDarkness.text = formatPercent(v);
    Config.setEffectParam("diagDarkness", v);
  });
  lblDiagSpeed = new Label(0, 0, "Speed:");
  valDiagSpeed = new Label(0, 0, formatPx(ep.diagSpeed));
  sldDiagSpeed = new Slider(0, 0, SLIDER_W, 0, 100, ep.diagSpeed, (v) => {
    valDiagSpeed.text = formatPx(v);
    Config.setEffectParam("diagSpeed", v);
  });
  lblDiagSpacing = new Label(0, 0, "Spacing:");
  nbDiagSpacing = new NumberBox(0, 0, 2, 16, ep.diagSpacing, 1, () => {
    const s = nbDiagSpacing.value;
    Config.setEffectParam("diagSpacing", s);
    if (nbDiagThickness.value >= s) {
      nbDiagThickness.value = s - 1;
      Config.setEffectParam("diagThickness", s - 1);
    }
    nbDiagThickness.max = s - 1;
  });
  lblDiagThickness = new Label(0, 0, "Thickness:");
  nbDiagThickness = new NumberBox(
    0,
    0,
    1,
    ep.diagSpacing - 1,
    ep.diagThickness,
    1,
    () => {
      Config.setEffectParam("diagThickness", nbDiagThickness.value);
    },
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  ラベル幅を全体で統一
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  allLabels = [
    labelResolution,
    lblFont,
    lblFontPreviewIndent,
    lblHeaderPad,
    lblContentPad,
    lblInputOverlay,
    lblSystemSfx,
    lblPalette,
    lblInvert,
    labelBackground,
    labelForeground,
    lblBackground,
    lblBayer,
    lblLevel,
    lblImagePath,
    lblImageFile,
    lblTessPath,
    lblImageFill,
    lblVignette,
    lblVigStrength,
    lblVigRadius,
    lblDiagonal,
    lblDiagDarkness,
    lblDiagSpeed,
    lblDiagSpacing,
    lblDiagThickness,
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
  tessPathRow = HBox([lblTessPath, lblTessPathValue, btnTessBrowse]);
  imageFillRow = HBox([lblImageFill, ddImageFill]);

  // 現在の全設定 (SETTINGS + TUNING) を出荷時デフォルト用にクリップボードへ書き出す。
  // runtime はソースを書けないので、コピーした JSON を config.js のデフォルトへ反映する。
  const lblExportStatus = new Label(0, 0, "");
  const btnExportDefaults = new PushButton(0, 0, "EXPORT DEFAULTS", () => {
    copyDefaultsToClipboard().then((ok) => {
      lblExportStatus.text = ok ? "COPIED" : "SEE CONSOLE";
    });
  });
  btnExportDefaults.tooltip =
    "Copy current settings (SETTINGS+TUNING) as JSON to bake into config defaults";

  // ── タブ別ページ (各 VBox) ──
  const vigStrengthRow = HBox([lblVigStrength, sldVigStrength, valVigStrength]);
  const vigRadiusRow = HBox([lblVigRadius, sldVigRadius, valVigRadius]);
  vigRows = [vigStrengthRow, vigRadiusRow];
  const diagDarknessRow = HBox([
    lblDiagDarkness,
    sldDiagDarkness,
    valDiagDarkness,
  ]);
  const diagSpeedRow = HBox([lblDiagSpeed, sldDiagSpeed, valDiagSpeed]);
  const diagSpacingRow = HBox([
    lblDiagSpacing,
    nbDiagSpacing,
    new Label(0, 0, "DOT"),
  ]);
  const diagThicknessRow = HBox([
    lblDiagThickness,
    nbDiagThickness,
    new Label(0, 0, "DOT"),
  ]);
  diagRows = [diagDarknessRow, diagSpeedRow, diagSpacingRow, diagThicknessRow];

  const displayPage = VBox([
    HBox([labelResolution, dropDownResolution]),
    HBox([lblFont, ddFont]),
    HBox([lblFontPreviewIndent, lblFontPreview]),
    lblFontPreviewSpacer,
    HBox([lblHeaderPad, numberBoxHeaderPad, new Label(0, 0, "DOT")]),
    HBox([lblContentPad, nbContentPad, new Label(0, 0, "DOT")]),
  ]);
  const effectsPage = VBox([
    HBox([lblVignette, tglVignette]),
    vigStrengthRow,
    vigRadiusRow,
    sep1,
    HBox([lblDiagonal, tglDiagonal]),
    diagDarknessRow,
    diagSpeedRow,
    diagSpacingRow,
    diagThicknessRow,
  ]);
  const themePage = VBox([
    HBox([lblPalette, lbPalette]),
    bgRow,
    fgRow,
    HBox([lblInvert, tglInvert]),
    sep2,
    HBox([lblBackground, ddBackground]),
    bayerRow,
    levelRow,
    imagePathRow,
    imageFileRow,
    tessPathRow,
    imageFillRow,
  ]);
  const systemPage = VBox([
    HBox([lblInputOverlay, tglInputOverlay]),
    HBox([lblSystemSfx, tglSystemSfx]),
    sep3,
    HBox([btnExportDefaults, lblExportStatus]),
  ]);
  pages = [displayPage, effectsPage, themePage, systemPage];

  // ── セクション可視制御の対象 ──
  customWidgets = [bgRow, fgRow];
  solidWidgets = [bayerRow, levelRow];
  imageWidgets = [imagePathRow, imageFileRow];
  tesseraWidgets = [tessPathRow];

  // ── タブバー + 現在タブのルートを構築 ──
  tabBar = new TabBar(
    0,
    0,
    TAB_LABELS,
    (i) => {
      activeTab = i;
      buildMainRoot();
    },
    activeTab,
  );
  buildMainRoot();
}

/** 現在タブのレイアウトを (再)構築する。タブバー + ページを縦に並べる。 */
function buildMainRoot() {
  mainRoot = VBox([HBox([tabBar]), new HSep(0, 0, 0), pages[activeTab]]);
  mainWidgets = new WidgetGroup(mainRoot);
}

/** EFFECTS: トグル OFF のパラメータ行を非表示にする */
function refreshEffectVisibility() {
  for (const row of vigRows) row.visible = tglVignette.value;
  for (const row of diagRows) row.visible = tglDiagonal.value;
}

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
  for (const row of tesseraWidgets) row.visible = mode === "tessera";
  // Fill（マット）は image 専用。tessera は常に画面いっぱい (Fill) でマット無し。
  imageFillRow.visible = mode === "image";
}

/** 背景関連ウィジェットを壁紙設定と同期する (initWallpaper 後に 1 回)。 */
let bgSynced = false;
function syncBgWidgets() {
  if (bgSynced) return;
  if (!Wallpaper.isWallpaperReady()) return;
  bgSynced = true;

  // Background ドロップダウン
  const curMode = Wallpaper.getBackgroundMode();
  ddBackground.selectedIndex =
    curMode === "image" ? 1 : curMode === "tessera" ? 2 : 0;
  ddImageFill.selectedIndex = Wallpaper.getImageFillBit();

  // Appearance ウィジェット同期
  numberBoxHeaderPad.value = Config.getHeaderPad();
  nbContentPad.value = Config.getContentPad();
  lbPalette.selectedIndex = Math.max(
    0,
    allPaletteKeys.indexOf(Config.getPaletteName()),
  );
  tglInvert.value = Config.isInvert();
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
        refreshEffectVisibility();
        const size = mainRoot.measure();
        wmSetContentSize(id, size.h);
        mainWidgets.draw(contentRect);
      },
      (ev) => mainWidgets.update(ev),
      () => mainRoot.measure(),
      {
        about:
          "System settings (tabbed): display, effects, theme, system. " +
          "Palette, wallpaper, resolution, fonts, padding, CRT effects, and more.",
        scrollable: true,
        onRelayout: () => {
          mainWidgets.remeasureAll();
          // ラベル幅再統一 (remeasure で自然幅に戻った後に再揃え)
          maxLabelWidth = Math.max(...allLabels.map((l) => l.w));
          for (const l of allLabels) l.w = maxLabelWidth;
          mainRoot.layout(FOCUS_MARGIN, FOCUS_MARGIN);
        },
      },
    );
    return id;
  },
  { shortName: "SETTING" },
);

