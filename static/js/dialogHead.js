import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";

const CLOSE_KEY = "panel.close";

/** A dialog's head row: its title on the left, its close button on the right. */
export function dialogHeadHtml({ titleClass = "", titleKey = "" } = {}) {
  const close = t(CLOSE_KEY);
  const i18n = titleKey ? ` data-i18n="${titleKey}"` : "";
  return `<div class="dialog-head"><h2 class="dialog-title ${titleClass}"${i18n}></h2>`
    + `<button class="dialog-close" type="button" title="${close}" aria-label="${close}"`
    + ` data-i18n-title="${CLOSE_KEY}" data-i18n-aria-label="${CLOSE_KEY}">${icon("x")}</button></div>`;
}
