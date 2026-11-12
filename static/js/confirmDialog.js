// confirmDialog.js — a yes-or-no question about one named thing, in the app's
// shared confirm card (the reset-confirm-* styles).

import { t } from "./i18n.js";

let openDialog = null;
let dialogOpener = null;
let settleDialog = null;

function closeDialog() {
  openDialog?.remove();
  openDialog = null;
  document.removeEventListener("keydown", onDialogKeydown);
  if (dialogOpener?.isConnected) dialogOpener.focus();
  dialogOpener = null;
}

function finishDialog(confirmed) {
  const settle = settleDialog;
  settleDialog = null;
  closeDialog();
  settle?.(confirmed);
}

function onDialogKeydown(e) {
  if (e.code === "Escape") finishDialog(false);
}

function onDialogCancel() {
  finishDialog(false);
}

function onDialogConfirm() {
  finishDialog(true);
}

function onDialogBackdrop(e) {
  if (e.target === openDialog) finishDialog(false);
}

function dialogMarkup(body) {
  return `
    <div class="reset-confirm-card" role="dialog" aria-modal="true">
      <div class="reset-confirm-title"></div>
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
  overlay.querySelector(".reset-confirm-card").setAttribute("aria-label", ariaLabel);
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
  return { overlay, cancel, confirm };
}

/**
 * Resolves true only for the confirm button; Cancel, Esc, a click outside or a
 * newer dialog all say no. `body` is trusted markup; `name` may come from
 * anywhere and is set as text. `focusCancel` is for a question a held key
 * must not answer.
 */
export function confirmDialog(options) {
  const settings = { ...DIALOG_DEFAULTS, ariaLabel: options.title, ...options };
  finishDialog(false);
  const { overlay, cancel, confirm } = buildDialog(settings);
  cancel.addEventListener("click", onDialogCancel);
  confirm.addEventListener("click", onDialogConfirm);
  overlay.addEventListener("mousedown", onDialogBackdrop);
  document.addEventListener("keydown", onDialogKeydown);

  dialogOpener = document.activeElement;
  document.body.appendChild(overlay);
  openDialog = overlay;
  (settings.focusCancel ? cancel : confirm).focus();
  return new Promise((resolve) => {
    settleDialog = resolve;
  });
}
