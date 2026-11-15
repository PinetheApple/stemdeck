// Settings > Recording, built into the empty pane catalog.js gives it. Opened
// from a track, the latency test measures that track's input.

import { t } from "./i18n.js";
import { closeInput, inputInfo, listInputs, openInput } from "./recorderCapture.js";
import { loadRecorderPrefs, recorderPrefs, setRecorderPref } from "./recorderPrefs.js";
import { saveRoundTrip, savedRoundTrip } from "./latencyStore.js";
import { runLatencyTest } from "./latencyTest.js";
import { LATENCY_CLICKS } from "./latency.js";
import { cameraSelect } from "./filmCamera.js";

const PANE_SELECTOR = '[data-pane="recording"]';
const FAILED_CLASS = "is-failed";

let nextTestInput = null;

/** The input the next Settings > Recording measures, when opened from a track. */
export function setLatencyTestInput(deviceId) {
  nextTestInput = deviceId;
}

export function settingsRow(title, desc, controls) {
  const row = document.createElement("div");
  row.className = "settings-row";
  const text = document.createElement("div");
  text.className = "settings-row-text";
  const head = document.createElement("div");
  head.className = "settings-row-title";
  head.textContent = title;
  text.append(head);
  if (desc) {
    const sub = document.createElement("div");
    sub.className = "settings-row-desc";
    sub.textContent = desc;
    text.append(sub);
  }
  row.append(text, ...controls);
  return row;
}

function section(...children) {
  const el = document.createElement("div");
  el.className = "settings-section";
  el.append(...children);
  return el;
}

export function settingsButton(text, primary, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `settings-btn${primary ? " is-primary" : ""}`;
  el.textContent = text;
  el.addEventListener("click", onClick);
  return el;
}

async function inputSelect() {
  const select = document.createElement("select");
  select.className = "settings-select rec-input-select";
  select.setAttribute("aria-label", t("settings.recording.input"));
  const devices = await listInputs().catch(() => []);
  const options = [{ deviceId: "", label: t("rec.defaultInput") }, ...devices.filter((d) => d.deviceId)];
  options.forEach(function addOption(device, i) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || t("rec.inputN", { n: i });
    select.append(option);
  });
  select.value = recorderPrefs().inputDeviceId;
  if (select.selectedIndex < 0) select.value = "";
  select.addEventListener("change", function onInputDeviceChange() {
    setRecorderPref("inputDeviceId", select.value);
  });
  return select;
}

function monitorSwitch() {
  const label = document.createElement("label");
  label.className = "settings-switch";
  label.innerHTML = '<input type="checkbox" class="rec-monitor-input" />'
    + '<span class="settings-switch-track"><span class="settings-switch-thumb"></span></span>';
  const box = label.querySelector("input");
  box.setAttribute("aria-label", t("settings.recording.monitor"));
  box.checked = recorderPrefs().monitor;
  box.addEventListener("change", function onMonitorChange() {
    setRecorderPref("monitor", box.checked);
  });
  return label;
}

function latencyText(saved) {
  if (!saved) return t("settings.recording.notTested");
  return t("settings.recording.latencyMs", { ms: Math.round(saved.round_trip_ms) });
}

function calibrationBox(className, text, ...buttons) {
  const box = document.createElement("div");
  box.className = `rec-cal${className ? ` ${className}` : ""}`;
  if (className === FAILED_CLASS) box.setAttribute("role", "alert");
  else box.setAttribute("aria-live", "polite");
  const p = document.createElement("p");
  p.textContent = text;
  const actions = document.createElement("div");
  actions.className = "rec-cal-actions";
  actions.append(...buttons);
  box.append(p, actions);
  return box;
}

function clickDots() {
  const dots = document.createElement("div");
  dots.className = "rec-cal-clicks";
  for (let k = 0; k < LATENCY_CLICKS; k++) dots.append(document.createElement("i"));
  return dots;
}

async function showLatency(panel) {
  panel.value.textContent = latencyText(await savedRoundTrip(panel.inputId));
}

function measureButton(panel, label, primary) {
  return settingsButton(label, primary, function onMeasureClick() {
    measure(panel);
  });
}

function cancelButton(panel) {
  return settingsButton(t("settings.recording.cancel"), false, function onCancelTestClick() {
    resetTest(panel);
  });
}

function showStart(panel) {
  panel.testBtn.hidden = true;
  panel.host.replaceChildren(calibrationBox(
    "",
    t("settings.recording.calStart", { clicks: LATENCY_CLICKS }),
    measureButton(panel, t("settings.recording.start"), true),
    cancelButton(panel),
  ));
}

function resetTest(panel) {
  panel.abort?.abort();
  panel.abort = null;
  panel.testBtn.hidden = false;
  panel.host.replaceChildren();
}

async function saveResult(panel, result) {
  for (const id of new Set([result.deviceId, panel.inputId])) {
    await saveRoundTrip(id, result.roundTripMs, result.sampleRate);
  }
  await showLatency(panel);
  panel.host.replaceChildren(calibrationBox(
    "",
    t("settings.recording.calSaved", { input: result.label }),
    measureButton(panel, t("settings.recording.again"), false),
  ));
}

function showFailed(panel) {
  panel.host.replaceChildren(calibrationBox(
    FAILED_CLASS,
    t("settings.recording.calFailed"),
    measureButton(panel, t("settings.recording.retry"), true),
  ));
}

async function measure(panel) {
  panel.abort = new AbortController();
  const dots = clickDots();
  const box = calibrationBox("", t("settings.recording.listening"), cancelButton(panel));
  box.querySelector("p").after(dots);
  panel.host.replaceChildren(box);
  const result = await runTest(panel.inputId, dots, panel.abort.signal);
  if (!result) return;
  if (result.ok) await saveResult(panel, result);
  else showFailed(panel);
}

/** The latency row and its inline test: start, measuring, result or retry. */
function latencySection(inputId) {
  const panel = { inputId, value: document.createElement("span"), host: document.createElement("div"), abort: null };
  panel.value.className = "rec-latency-value";
  panel.testBtn = settingsButton(t("settings.recording.test"), false, function onTestLatencyClick() {
    showStart(panel);
  });
  showLatency(panel);
  const row = settingsRow(t("settings.recording.latency"), t("settings.recording.latencyDesc"), [
    panel.value,
    panel.testBtn,
  ]);
  return section(row, panel.host);
}

function lightDots(dots, heard) {
  [...dots.children].forEach(function lightDot(dot, k) {
    dot.classList.toggle("is-heard", k < heard);
  });
}

async function runTest(inputId, dots, signal) {
  let stream;
  try {
    stream = await openInput(inputId);
  } catch (err) {
    console.warn("[recorder] latency test could not open the input:", err);
    return { ok: false };
  }
  const info = inputInfo(stream);
  try {
    const verdict = await runLatencyTest(stream, {
      signal,
      onHeard: function onClickHeard(heard) {
        lightDots(dots, heard);
      },
    });
    return verdict && { ...verdict, deviceId: info.deviceId, label: info.label || t("rec.defaultInput") };
  } finally {
    closeInput(stream);
  }
}

/** Fill Settings > Recording in the dialog `overlay`. */
export async function wireRecordingSettings(overlay) {
  const pane = overlay.querySelector(PANE_SELECTOR);
  if (!pane) return;
  await loadRecorderPrefs();
  const inputId = nextTestInput ?? recorderPrefs().inputDeviceId;
  nextTestInput = null;
  pane.replaceChildren(
    section(settingsRow(t("settings.recording.input"), "", [await inputSelect()])),
    section(settingsRow(t("film.camera"), "", [await cameraSelect()])),
    latencySection(inputId),
    section(settingsRow(t("settings.recording.monitor"), t("settings.recording.monitorDesc"), [monitorSwitch()])),
  );
}
