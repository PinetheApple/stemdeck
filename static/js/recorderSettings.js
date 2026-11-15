// Settings > Recording: the input new tracks use, the latency test (run inline
// under its row), and hear yourself. catalog.js builds the empty pane and calls
// wireRecordingSettings with the dialog.

import { t } from "./i18n.js";
import { closeInput, inputInfo, listInputs, openInput } from "./recorderCapture.js";
import { loadRecorderPrefs, recorderPrefs, setRecorderPref } from "./recorderPrefs.js";
import { saveRoundTrip, savedRoundTrip } from "./latencyStore.js";
import { runLatencyTest } from "./latencyTest.js";
import { LATENCY_CLICKS } from "./latency.js";

const PANE_SELECTOR = '[data-pane="recording"]';

function settingsRow(title, desc, controls) {
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

function btn(text, primary, onClick) {
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
  return saved ? t("settings.recording.latencyMs", { ms: Math.round(saved.round_trip_ms) }) : t("settings.recording.notTested");
}

function calibrationBox(className, text, ...buttons) {
  const box = document.createElement("div");
  box.className = `rec-cal${className ? ` ${className}` : ""}`;
  box.setAttribute(className === "is-failed" ? "role" : "aria-live", className === "is-failed" ? "alert" : "polite");
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
  panel.value.textContent = latencyText(await savedRoundTrip(recorderPrefs().inputDeviceId));
}

function showStart(panel) {
  panel.testBtn.hidden = true;
  panel.host.replaceChildren(calibrationBox("", t("settings.recording.calStart"),
    btn(t("settings.recording.start"), true, function onMeasureClick() { measure(panel); }),
    btn(t("settings.recording.cancel"), false, function onCancelTestClick() { resetTest(panel); })));
}

function resetTest(panel) {
  panel.abort?.abort();
  panel.abort = null;
  panel.testBtn.hidden = false;
  panel.host.replaceChildren();
}

async function saveResult(panel, result) {
  for (const id of new Set([result.deviceId, recorderPrefs().inputDeviceId])) {
    await saveRoundTrip(id, result.roundTripMs, result.sampleRate);
  }
  await showLatency(panel);
  panel.host.replaceChildren(calibrationBox("", t("settings.recording.calSaved", { input: result.label }),
    btn(t("settings.recording.again"), false, function onMeasureClick() { measure(panel); })));
}

async function measure(panel) {
  panel.abort = new AbortController();
  const dots = clickDots();
  const box = calibrationBox("", t("settings.recording.listening"),
    btn(t("settings.recording.cancel"), false, function onCancelTestClick() { resetTest(panel); }));
  box.querySelector("p").after(dots);
  panel.host.replaceChildren(box);
  const result = await runTest(dots, panel.abort.signal);
  if (!result) return;
  if (result.ok) {
    await saveResult(panel, result);
    return;
  }
  panel.host.replaceChildren(calibrationBox("is-failed", t("settings.recording.calFailed"),
    btn(t("settings.recording.retry"), true, function onMeasureClick() { measure(panel); })));
}

/** The latency row and its inline test: start, measuring, result or retry. */
function latencySection() {
  const panel = { value: document.createElement("span"), host: document.createElement("div"), abort: null };
  panel.value.className = "rec-latency-value";
  panel.testBtn = btn(t("settings.recording.test"), false, function onTestLatencyClick() { showStart(panel); });
  showLatency(panel);
  const row = settingsRow(t("settings.recording.latency"), t("settings.recording.latencyDesc"), [
    panel.value,
    panel.testBtn,
  ]);
  return section(row, panel.host);
}

async function runTest(dots, signal) {
  let stream;
  try {
    stream = await openInput(recorderPrefs().inputDeviceId);
  } catch (err) {
    console.warn("[recorder] latency test could not open the input:", err);
    return { ok: false };
  }
  const info = inputInfo(stream);
  try {
    const verdict = await runLatencyTest(stream, {
      signal,
      onHeard: (n) => [...dots.children].forEach((dot, k) => dot.classList.toggle("is-heard", k < n)),
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
  pane.replaceChildren(
    section(settingsRow(t("settings.recording.input"), "", [await inputSelect()])),
    latencySection(),
    section(settingsRow(t("settings.recording.monitor"), t("settings.recording.monitorDesc"), [monitorSwitch()])),
  );
}
