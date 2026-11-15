// The EQ inspector tab: a Lane | Master switch over the two views. Nothing
// runs (spectrum, warm master) while the tab is out of sight.

import { onLanguageChange } from "../i18n.js";
import { STEM_COLORS, STEM_DISPLAY } from "../constants.js";
import { MASTER_LANE } from "../mixFx.js";
import { openInspectorTab } from "../inspector.js";
import { laneHasPanel } from "./eqPanelKinds.js";
import { EqLaneView } from "./eqLaneView.js";
import { EqMasterView } from "./eqMasterView.js";
import { EqSpectrum } from "./eqSpectrum.js";
import { OPEN_LANE_EQ_EVENT, refreshLaneMarks } from "./eqLaneMark.js";
import { initMasterExportRow, refreshMasterExportRow } from "./masterExportRow.js";

const $ = (id) => document.getElementById(id);
const SCOPE = Object.freeze({ lane: "lane", master: "master" });
const EQ_TAB = "eq";
const EDITING_CLASS = "eq-editing";
const INSPECTOR_HIDDEN_CLASS = "inspector-hidden";
const LANE_ROWS = ".mixer-column .lane-header[data-stem]:not(.hidden):not(.unavailable)";

const pane = $("inspectorPaneEq");
const app = document.querySelector(".app");
const laneView = new EqLaneView();
const masterView = new EqMasterView();
const laneSpectrum = new EqSpectrum(laneView.graph, $("eqGraphLane"));
const masterSpectrum = new EqSpectrum(masterView.graph, $("eqGraphMaster"));
const tab = { scope: SCOPE.lane, lane: null, running: "", frame: 0 };

function availableLanes() {
  return [...document.querySelectorAll(LANE_ROWS)]
    .sort((a, b) => Number(a.style.order || 0) - Number(b.style.order || 0))
    .map((row) => row.dataset.stem)
    .filter(laneHasPanel);
}

function pickLane() {
  const lanes = availableLanes();
  if (!lanes.includes(tab.lane)) tab.lane = lanes[0] ?? null;
}

const isShown = () => !pane.hidden && !app?.classList.contains(INSPECTOR_HIDDEN_CLASS);

function renderScope() {
  const lane = tab.lane;
  $("eqScopeName").textContent = lane ? STEM_DISPLAY[lane] || lane : "";
  $("eqScopeDot").style.color = STEM_COLORS[lane] || "";
  $("eqScopeLane").setAttribute("aria-checked", String(tab.scope === SCOPE.lane));
  $("eqScopeMaster").setAttribute("aria-checked", String(tab.scope === SCOPE.master));
  $("eqLaneView").hidden = tab.scope !== SCOPE.lane || !lane;
  $("eqMasterView").hidden = tab.scope !== SCOPE.master;
}

function frameEditedRow() {
  for (const row of document.querySelectorAll(`.${EDITING_CLASS}`)) row.classList.remove(EDITING_CLASS);
  if (!tab.running || tab.scope !== SCOPE.lane || !tab.lane) return;
  document.querySelector(`.mixer-column .lane-header[data-stem="${tab.lane}"]`)?.classList.add(EDITING_CLASS);
}

function tick() {
  tab.frame = requestAnimationFrame(tick);
  laneSpectrum.frame();
  masterSpectrum.frame();
  if (tab.scope === SCOPE.master) masterView.tick();
}

function stopRunning() {
  cancelAnimationFrame(tab.frame);
  tab.frame = 0;
  laneSpectrum.follow(null);
  masterSpectrum.follow(null);
  laneView.leave();
  masterView.leave();
}

function startRunning() {
  const onLane = tab.scope === SCOPE.lane;
  if (onLane) {
    masterView.leave();
    laneView.show(tab.lane);
  } else {
    laneView.leave();
    masterView.show();
  }
  laneSpectrum.follow(onLane ? tab.lane : null);
  masterSpectrum.follow(onLane ? null : MASTER_LANE);
  if (!tab.frame) tab.frame = requestAnimationFrame(tick);
}

/** Bring the tab in line with what is on screen and which lane is picked. */
function sync() {
  pickLane();
  const wanted = isShown() ? `${tab.scope}|${tab.lane}` : "";
  if (wanted !== tab.running) {
    if (wanted) startRunning();
    else stopRunning();
    tab.running = wanted;
  }
  renderScope();
  frameEditedRow();
}

function chooseScope(scope) {
  if (scope === tab.scope) return;
  tab.scope = scope;
  sync();
}

function onScopeLaneClick() {
  chooseScope(SCOPE.lane);
}

function onScopeMasterClick() {
  chooseScope(SCOPE.master);
}

function onOpenLaneEq(e) {
  tab.lane = e.detail.lane;
  tab.scope = SCOPE.lane;
  openInspectorTab(EQ_TAB);
  sync();
}

function onPlaybackReady() {
  stopRunning();
  tab.running = "";
  sync();
}

function onLanguageSwitch() {
  refreshLaneMarks();
  refreshMasterExportRow();
  if (tab.running) {
    laneView.render();
    masterView.render();
  }
}

function initEqTab() {
  if (!pane) return;
  $("eqScopeLane").addEventListener("click", onScopeLaneClick);
  $("eqScopeMaster").addEventListener("click", onScopeMasterClick);
  document.addEventListener(OPEN_LANE_EQ_EVENT, onOpenLaneEq);
  document.addEventListener("playbackready", onPlaybackReady);
  onLanguageChange(onLanguageSwitch);
  const observer = new MutationObserver(sync);
  observer.observe(pane, { attributes: true, attributeFilter: ["hidden"] });
  if (app) observer.observe(app, { attributes: true, attributeFilter: ["class"] });
  initMasterExportRow();
  sync();
}

initEqTab();
