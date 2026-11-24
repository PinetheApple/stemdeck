// confirmDialog.js — a yes-or-no question about one named thing, in the app's
// shared confirm card (the reset-confirm-* styles).

import { t } from "./i18n.js";
import { openDialogLayer } from "./dialogLayer.js";
import { dialogHead } from "./dialogHead.js";

let openDialog = null;
let dialogLayer = null;
let settleDialog = null;

// Esc and the dimmed page close through the layer, which answers no.
function onDialogClosed() {
  openDialog?.remove();
  openDialog = null;
  dialogLayer = null;
  const settle = settleDialog;
  settleDialog = null;
  settle?.(false);
}

function finishDialog(confirmed) {
  const settle = settleDialog;
  settleDialog = null;
  dialogLayer?.close();
  settle?.(confirmed);
}

function onDialogCancel() {
  finishDialog(false);
}

function onDialogConfirm() {
  finishDialog(true);
}

function dialogMarkup(body) {
  return `
    <div class="reset-confirm-card" role="dialog" aria-modal="true">
      <p class="reset-confirm-body">
        <strong></strong><br />
        ${body}
      </p>
      <div class="reset-confirm-actions">
        <button class="reset-confirm-cancel" type="button"></button>
        <button type="button"></button>
      </div>
    </div>
  `;
}

const addClass = (el, name) => name && el.classList.add(name);

const DIALOG_DEFAULTS = {
  className: "",
  titleClass: "",
  nameClass: "",
  confirmClass: "reset-confirm-go",
  focusCancel: false,
};

function buildDialog({
  title,
  name,
  body,
  confirmLabel,
  ariaLabel,
  className,
  titleClass,
  nameClass,
  confirmClass,
}) {
  const overlay = document.createElement("div");
  overlay.className = "reset-confirm-backdrop";
  addClass(overlay, className);
  overlay.innerHTML = dialogMarkup(body);
  const card = overlay.querySelector(".reset-confirm-card");
  card.setAttribute("aria-label", ariaLabel);
  card.prepend(dialogHead({ titleClass: "reset-confirm-title" }));
  const titleEl = overlay.querySelector(".reset-confirm-title");
  titleEl.textContent = title;
  addClass(titleEl, titleClass);
  const nameEl = overlay.querySelector("strong");
  nameEl.textContent = name;
  addClass(nameEl, nameClass);
  const cancel = overlay.querySelector(".reset-confirm-cancel");
  cancel.textContent = t("resetConfirm.cancel");
  const confirm = overlay.querySelector(".reset-confirm-actions button:last-child");
  confirm.textContent = confirmLabel;
  confirm.classList.add(confirmClass);
  overlay.querySelector(".dialog-close").addEventListener("click", onDialogCancel);
  return { overlay, cancel, confirm };
}

/** True only for the confirm button. `body` is trusted markup; `name` is set as text.
 *  `focusCancel` is for a question a held key must not answer. */
export function confirmDialog(options) {
  const settings = { ...DIALOG_DEFAULTS, ariaLabel: options.title, ...options };
  finishDialog(false);
  const { overlay, cancel, confirm } = buildDialog(settings);
  cancel.addEventListener("click", onDialogCancel);
  confirm.addEventListener("click", onDialogConfirm);
  const opener = document.activeElement;
  document.body.appendChild(overlay);
  openDialog = overlay;
  dialogLayer = openDialogLayer(overlay, {
    onClose: onDialogClosed,
    opener,
  });
  (settings.focusCancel ? cancel : confirm).focus();
  return new Promise((resolve) => {
    settleDialog = resolve;
  });
}
