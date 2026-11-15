// The export menu's "Master" row: ticked means the mix and video exports are
// mastered to the song's loudness target. It is the same switch as Off in
// the EQ tab's Export loudness.

import { getMaster, isMasterOn, setMasterOn } from "../masterEngine.js";
import { onFxChange } from "../mixFx.js";
import { exportMasterLabel } from "./masterPanelModel.js";

const $ = (id) => document.getElementById(id);
const FORMAT_ID_PREFIX = "t-fmt-";

function selectedFormat() {
  const active = document.querySelector('.export-format-toggle [aria-checked="true"]');
  return active?.id.startsWith(FORMAT_ID_PREFIX) ? active.id.slice(FORMAT_ID_PREFIX.length) : "";
}

export function refreshMasterExportRow() {
  const box = $("t-export-master");
  if (!box) return;
  box.checked = isMasterOn();
  $("t-export-master-preset").textContent = exportMasterLabel(getMaster(), selectedFormat());
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
