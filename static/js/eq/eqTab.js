import { onLanguageChange } from "../i18n.js";
import { $ } from "../utils.js";
import { STEM_COLORS, STEM_DISPLAY } from "../constants.js";
import { MASTER_LANE } from "../eqEngine.js";
import { INSPECTOR_TABS, openInspectorTab, shownInspectorTab } from "../inspector.js";
import { PLAYBACK_READY_EVENT } from "../player.js";
import { laneHasPanel } from "./eqPanelKinds.js";
import { EqLaneView } from "./eqLaneView.js";
import { EqMasterView } from "./eqMasterView.js";
import { EqSpectrum } from "./eqSpectrum.js";
import { OPEN_LANE_EQ_EVENT, refreshLaneMarks } from "./eqLaneMark.js";
import { initMasterExportRow, refreshMasterExportRow } from "./masterExportRow.js";

const SCOPE = Object.freeze({ lane: "lane", master: "master" });
const EDITING_CLASS = "eq-editing";
const SCOPE_KEY_STEPS = Object.freeze({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 });
const SCOPE_ORDER = Object.freeze([SCOPE.lane, SCOPE.master]);
const scopeButton = (scope) => $(scope === SCOPE.lane ? "eqScopeLane" : "eqScopeMaster");
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

const isShown = () => shownInspectorTab() === INSPECTOR_TABS.EQ;

function renderScope() {
  const lane = tab.lane;
  $("eqScopeName").textContent = lane ? STEM_DISPLAY[lane] || lane : "";
  $("eqScopeDot").style.color = STEM_COLORS[lane] || "";
  for (const scope of SCOPE_ORDER) {
    const checked = scope === tab.scope;
    scopeButton(scope).setAttribute("aria-checked", String(checked));
    scopeButton(scope).tabIndex = checked ? 0 : -1;
  }
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

function onScopeKeydown(e) {
  const step = SCOPE_KEY_STEPS[e.key];
  if (!step) return;
  e.preventDefault();
  const at = SCOPE_ORDER.indexOf(tab.scope);
  const next = SCOPE_ORDER[(at + step + SCOPE_ORDER.length) % SCOPE_ORDER.length];
  chooseScope(next);
  scopeButton(next).focus();
}

function onOpenLaneEq(e) {
  tab.lane = e.detail.lane;
  tab.scope = SCOPE.lane;
  openInspectorTab(INSPECTOR_TABS.EQ);
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
  $("eqScopeLane").parentElement.addEventListener("keydown", onScopeKeydown);
  document.addEventListener(OPEN_LANE_EQ_EVENT, onOpenLaneEq);
  document.addEventListener(PLAYBACK_READY_EVENT, onPlaybackReady);
  onLanguageChange(onLanguageSwitch);
  const observer = new MutationObserver(sync);
  observer.observe(pane, { attributes: true, attributeFilter: ["hidden"] });
  if (app) observer.observe(app, { attributes: true, attributeFilter: ["class"] });
  initMasterExportRow();
  sync();
}

initEqTab();
