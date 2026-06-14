/**
 * @module app/display_tuning
 * display_tuning.js — DISPLAY_TUNING ウィンドウ
 *
 * 表示エフェクト (Vignette, Diagonal scanline) を GUI から調整する設定パネル。
 * 変更は即座に描画パイプラインに反映され、localStorage に永続化される。
 *
 * 構成:
 *   - Vignette: 中心保護の楕円ビネット (周辺減光)
 *   - Diagonal: 流動する CRT 走査線
 *
 * 撤廃済み (BACKLOG 参照): Pixel Grid, Glow, Noise。
 */

import * as Config from "../config.js";
import { wmOpen, wmRegister, wmSetContentSize } from "../wm/index.js";
import {
  Label,
  Slider,
  NumberBox,
  ToggleButton,
  HSep,
  WidgetGroup,
  HBox,
  VBox,
  FOCUS_MARGIN,
} from "../ui/index.js";

const APP_NAME = "DISPLAY_TUNING";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SLIDER_W = 80;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  値フォーマット
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function formatPercent(v) {
  return String(v).padStart(4) + "%";
}

// SPEED は 0–100 の無次元スケール値なので単位なし
function formatPx(v) {
  return String(v).padStart(4);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィジェット生成
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let lblVignette, tglVignette;
let lblVigStrength, sldVigStrength, valVigStrength;
let lblVigRadius, sldVigRadius, valVigRadius;

let lblDiagonal, tglDiagonal;
let lblDiagDarkness, sldDiagDarkness, valDiagDarkness;
let lblDiagSpeed, sldDiagSpeed, valDiagSpeed;
let lblDiagSpacing, nbDiagSpacing;
let lblDiagThickness, nbDiagThickness;

let sep1;
let vigRows, diagRows;
let tuningRoot;
let tuningWidgets;

let maxLabelWidth = 0;
let allLabels = [];

let _ready = false;
function _initWidgets() {
  if (_ready) return;
  _ready = true;

  const ep = Config.getEffectParams();

  // ── Vignette ──
  lblVignette = new Label(0, 0, "Vignette:");
  tglVignette = new ToggleButton(
    0,
    0,
    "ON",
    (v) => {
      Config.setEffectParam("vignetteEnabled", v);
      refreshVisibility();
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

  // ── Diagonal ──
  lblDiagonal = new Label(0, 0, "Diagonal:");
  tglDiagonal = new ToggleButton(
    0,
    0,
    "ON",
    (v) => {
      Config.setEffectParam("diagEnabled", v);
      refreshVisibility();
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
    // thickness の max を spacing - 1 にクランプ
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

  // ── セパレータ ──
  sep1 = new HSep(0, 0, 0);

  // ── ラベル幅統一 ──
  allLabels = [
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

  // ── レイアウト ──
  const vigStrengthRow = HBox([lblVigStrength, sldVigStrength, valVigStrength]);
  const vigRadiusRow = HBox([lblVigRadius, sldVigRadius, valVigRadius]);
  vigRows = [vigStrengthRow, vigRadiusRow];

  const diagDarknessRow = HBox([lblDiagDarkness, sldDiagDarkness, valDiagDarkness]);
  const diagSpeedRow = HBox([lblDiagSpeed, sldDiagSpeed, valDiagSpeed]);
  const diagSpacingRow = HBox([lblDiagSpacing, nbDiagSpacing, new Label(0, 0, "DOT")]);
  const diagThicknessRow = HBox([lblDiagThickness, nbDiagThickness, new Label(0, 0, "DOT")]);
  diagRows = [diagDarknessRow, diagSpeedRow, diagSpacingRow, diagThicknessRow];

  tuningRoot = VBox([
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

  tuningRoot.layout(FOCUS_MARGIN, FOCUS_MARGIN);
  tuningWidgets = new WidgetGroup(tuningRoot.leaves());

  refreshVisibility();
}

/** トグル OFF 時にパラメータ行を非表示にする */
function refreshVisibility() {
  const vigOn = tglVignette.value;
  for (const row of vigRows) row.visible = vigOn;

  const diagOn = tglDiagonal.value;
  for (const row of diagRows) row.visible = diagOn;

  tuningRoot.layout(FOCUS_MARGIN, FOCUS_MARGIN);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ウィンドウ登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wmRegister(APP_NAME, () => {
  _initWidgets();

  // ウィジェットの値を最新の Config から同期
  const ep = Config.getEffectParams();
  tglVignette.value = ep.vignetteEnabled;
  sldVigStrength.value = ep.vignetteStrength;
  valVigStrength.text = formatPercent(ep.vignetteStrength);
  sldVigRadius.value = ep.vignetteRadius;
  valVigRadius.text = formatPercent(ep.vignetteRadius);
  tglDiagonal.value = ep.diagEnabled;
  sldDiagDarkness.value = ep.diagDarkness;
  valDiagDarkness.text = formatPercent(ep.diagDarkness);
  sldDiagSpeed.value = ep.diagSpeed;
  valDiagSpeed.text = formatPx(ep.diagSpeed);
  nbDiagSpacing.value = ep.diagSpacing;
  nbDiagThickness.max = ep.diagSpacing - 1;
  nbDiagThickness.value = ep.diagThickness;
  refreshVisibility();

  const id = wmOpen(
    -1,
    -1,
    0,
    0,
    APP_NAME,
    (contentRect) => {
      const size = tuningRoot.measure();
      wmSetContentSize(id, size.h);
      tuningWidgets.draw(contentRect);
    },
    (ev) => tuningWidgets.update(ev),
    () => tuningRoot.measure(),
    {
      scrollable: true,
      onRelayout: () => {
        tuningWidgets.remeasureAll();
        maxLabelWidth = Math.max(...allLabels.map((l) => l.w));
        for (const l of allLabels) l.w = maxLabelWidth;
        tuningRoot.layout(FOCUS_MARGIN, FOCUS_MARGIN);
      },
    },
  );
  return id;
}, { shortName: "TUNING" });
