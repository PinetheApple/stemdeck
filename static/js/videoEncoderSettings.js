import { t } from "./i18n.js";
import { HttpError } from "./libraryControls.js";
import { HTTP_CONFLICT } from "./lyricsTranscribe.js";
import { el, settingsButton, settingsRow } from "./recorderSettings.js";
import { readEncoders, saveVideoEncoder, testEncoders } from "./filmApi.js";
import { POLICY_AUTO, POLICY_CPU, ROW_STATE, encoderChoices, testRows } from "./videoEncoderModel.js";

const SECTION_SELECTOR = ".vid-enc-section";
const SOURCE_ENV = "env";
const SPEED_DECIMALS = 1;
const CHOICE_KEYS = { [POLICY_AUTO]: "settings.export.encoder.auto", [POLICY_CPU]: "settings.export.encoder.cpu" };
const LOG = "[video-encoders]";
const ROW_TEXT = {
  [ROW_STATE.idle]: ["vid-enc-wait", "settings.export.test.notRun"],
  [ROW_STATE.testing]: ["vid-enc-wait", "settings.export.test.testing"],
  [ROW_STATE.works]: ["vid-enc-ok", "settings.export.test.works"],
  [ROW_STATE.failed]: ["vid-enc-bad", "settings.export.test.failed"],
};

function choiceText(choice, names) {
  if (choice.pick) return t("settings.export.encoder.autoWith", { name: names.get(choice.pick) ?? choice.pick });
  const name = CHOICE_KEYS[choice.value] ? t(CHOICE_KEYS[choice.value]) : names.get(choice.value) ?? choice.value;
  return choice.failed ? t("settings.export.encoder.failed", { name }) : name;
}

function encoderSelect(panel) {
  const select = el("select", "settings-select vid-enc-select");
  select.setAttribute("aria-label", t("settings.export.encoder.title"));
  const names = new Map(testRows(panel.status, { testing: false }).map((row) => [row.encoder, row.name]));
  for (const choice of encoderChoices(panel.status)) {
    const option = el("option", "", choiceText(choice, names));
    option.value = choice.value;
    option.disabled = choice.disabled;
    select.append(option);
  }
  select.value = panel.status.policy?.value ?? POLICY_AUTO;
  select.disabled = panel.status.policy?.source === SOURCE_ENV;
  select.addEventListener("change", function onEncoderChoice() {
    saveEncoder(panel, select.value);
  });
  return select;
}

async function saveEncoder(panel, value) {
  try {
    await saveVideoEncoder(value);
    panel.status = await readEncoders();
  } catch (err) {
    console.warn(`${LOG} the video encoder could not be saved:`, err);
  }
  paint(panel);
}

function resultCell(row) {
  const cell = el("td");
  const [className, key] = ROW_TEXT[row.state];
  cell.append(el("span", className, t(key)));
  if (row.reason) cell.append(el("span", "vid-enc-why", t(`settings.export.test.reason.${row.reason}`)));
  return cell;
}

function tableRow(row) {
  const tr = el("tr");
  const name = el("td", "vid-enc-name", row.name);
  if (row.maker) name.append(el("span", "vid-enc-wait", ` · ${row.maker}`));
  const speed = row.speed === null ? "" : t("settings.export.test.speedValue", { x: row.speed.toFixed(SPEED_DECIMALS) });
  tr.append(name, resultCell(row), el("td", "vid-enc-time", speed));
  return tr;
}

function table(panel) {
  const wrap = el("div", "library-editor-table-wrap");
  const grid = el("table", "library-editor-table vid-enc-table");
  const head = el("tr");
  for (const key of ["encoder", "result", "speed"]) head.append(el("th", "", t(`settings.export.test.${key}`)));
  const thead = el("thead");
  thead.append(head);
  const body = el("tbody");
  body.append(...testRows(panel.status, { testing: panel.testing }).map(tableRow));
  grid.append(thead, body);
  wrap.append(grid);
  return wrap;
}

async function runTest(panel) {
  panel.testing = true;
  panel.note = "";
  paint(panel);
  try {
    await testEncoders();
  } catch (err) {
    const busy = err instanceof HttpError && err.status === HTTP_CONFLICT;
    if (!busy) console.warn(`${LOG} the encoder test failed:`, err);
    panel.note = t(busy ? "settings.export.test.busy" : "settings.export.test.error");
  }
  panel.status = await readEncoders().catch(() => panel.status);
  panel.testing = false;
  paint(panel);
}

function paint(panel) {
  if (!panel.section.isConnected) return;
  const tested = Boolean(panel.status.last_test);
  const label = t(tested ? "settings.export.test.again" : "settings.export.test.run");
  const testBtn = settingsButton(label, false, function onTestEncodersClick() {
    runTest(panel);
  });
  testBtn.disabled = panel.testing;
  const locked = panel.status.policy?.source === SOURCE_ENV;
  const desc = t(locked ? "settings.export.encoder.locked" : "settings.export.encoder.desc");
  panel.section.replaceChildren(
    settingsRow(t("settings.export.encoder.title"), desc, [encoderSelect(panel)]),
    settingsRow(t("settings.export.test.title"), panel.note || t("settings.export.test.desc"), [testBtn]),
    ...(tested || panel.testing ? [table(panel)] : []),
  );
}

/** Fill the Video encoder section of the Settings dialog `overlay`; it stays hidden if the server can't say. */
export async function wireVideoEncoderSettings(overlay) {
  const section = overlay.querySelector(SECTION_SELECTOR);
  if (!section) return;
  let status;
  try {
    status = await readEncoders();
  } catch (err) {
    console.warn(`${LOG} could not read the video encoders:`, err);
    return;
  }
  section.hidden = false;
  paint({ section, status, testing: false, note: "" });
}
