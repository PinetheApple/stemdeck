import { t } from "../i18n.js";
import { $ } from "../utils.js";
import { getMaster, isMasterOn, setExportFormat, setMasterOn } from "../masterEngine.js";
import { onFxChange } from "../eqEngine.js";
import { exportMasterLabel } from "./masterPanelModel.js";

const FORMAT_ID_PREFIX = "t-fmt-";

function selectedFormat() {
  const active = document.querySelector('.export-format-toggle [aria-checked="true"]');
  return active?.id.startsWith(FORMAT_ID_PREFIX) ? active.id.slice(FORMAT_ID_PREFIX.length) : "";
}

export function refreshMasterExportRow() {
  const box = $("t-export-master");
  if (!box) return;
  const format = selectedFormat();
  setExportFormat(format);
  box.checked = isMasterOn();
  const units = { lufs: t("meta.lufs"), dbtp: t("eq.unitDbtp") };
  $("t-export-master-preset").textContent = exportMasterLabel(getMaster(), format, units);
}

function onMasterBoxChange(e) {
  setMasterOn(e.currentTarget.checked);
}

// The format buttons stop their clicks, so the row follows their checked state instead.
function watchFormat() {
  const toggle = document.querySelector(".export-format-toggle");
  if (!toggle) return;
  new MutationObserver(refreshMasterExportRow).observe(toggle, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-checked"],
  });
}

export function initMasterExportRow() {
  $("t-export-master")?.addEventListener("change", onMasterBoxChange);
  watchFormat();
  $("t-export-btn")?.addEventListener("click", refreshMasterExportRow);
  onFxChange(refreshMasterExportRow);
  refreshMasterExportRow();
}
