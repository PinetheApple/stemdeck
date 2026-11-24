import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";

const CLOSE_KEY = "panel.close";

function closeButton() {
  const button = document.createElement("button");
  const label = t(CLOSE_KEY);
  button.className = "dialog-close";
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.dataset.i18nTitle = CLOSE_KEY;
  button.dataset.i18nAriaLabel = CLOSE_KEY;
  button.innerHTML = icon("x");
  return button;
}

export function dialogHead({ titleClass = "", titleKey = "" } = {}) {
  const head = document.createElement("div");
  const title = document.createElement("h2");
  head.className = "dialog-head";
  title.className = "dialog-title";
  if (titleClass) title.classList.add(titleClass);
  if (titleKey) title.dataset.i18n = titleKey;
  head.append(title, closeButton());
  return head;
}
