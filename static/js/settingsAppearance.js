// settingsAppearance.js — Settings > Appearance: theme, font and the cover
// colour wash. Each choice applies at once and is kept on this device (appearance.js).
// Labels are filled in by applyTranslations with the rest of Settings.

import { FONTS, THEMES, WASH_OFF, WASH_ON } from "./appearanceModel.js";
import { chooseAppearance, currentAppearance } from "./appearance.js";

function themeCard({ id, labelKey }) {
  return `<button class="appearance-theme" type="button" data-theme-choice="${id}" aria-pressed="false">`
    + `<span class="appearance-preview" data-theme-preview="${id}" aria-hidden="true"><i></i><i></i><b></b></span>`
    + `<span data-i18n="${labelKey}"></span></button>`;
}

function fontCard({ id, label }) {
  return `<button class="appearance-font" type="button" data-font-choice="${id}" data-font-preview="${id}" aria-pressed="false">`
    + `<b aria-hidden="true">Aa</b><span>${label}</span></button>`;
}

function stackedRow(titleKey, title, descKey, desc, control) {
  return `<div class="appearance-row"><div class="settings-row-title" data-i18n="${titleKey}">${title}</div>`
    + `<div class="settings-row-desc" data-i18n="${descKey}">${desc}</div>${control}</div>`;
}

export function appearancePaneHtml() {
  return stackedRow(
    "settings.appearance.theme.title",
    "Theme",
    "settings.appearance.theme.desc",
    "Colours of the whole app.",
    `<div class="appearance-themes">${THEMES.map(themeCard).join("")}</div>`,
  ) + stackedRow(
    "settings.appearance.font.title",
    "Font",
    "settings.appearance.font.desc",
    "The typeface of every label and lyric.",
    `<div class="appearance-fonts">${FONTS.map(fontCard).join("")}</div>`,
  ) + `<div class="settings-row">
      <div class="settings-row-text">
        <div class="settings-row-title" data-i18n="settings.appearance.wash.title">Cover colour wash</div>
        <div class="settings-row-desc" data-i18n="settings.appearance.wash.desc">Tints the studio with the colours of the song's cover.</div>
      </div>
      <button class="settings-switch appearance-wash" type="button" aria-pressed="false" aria-label="Cover colour wash" data-i18n-aria-label="settings.appearance.wash.title">
        <span class="settings-switch-track"><span class="settings-switch-thumb"></span></span>
      </button>
    </div>`;
}

function paintChoices(pane) {
  for (const card of pane.querySelectorAll("[data-theme-choice]")) {
    card.setAttribute("aria-pressed", String(card.dataset.themeChoice === currentAppearance("theme")));
  }
  for (const card of pane.querySelectorAll("[data-font-choice]")) {
    card.setAttribute("aria-pressed", String(card.dataset.fontChoice === currentAppearance("font")));
  }
  pane.querySelector(".appearance-wash")?.setAttribute("aria-pressed", String(currentAppearance("wash") !== WASH_OFF));
}

function onAppearanceClick(e) {
  const pane = e.currentTarget;
  const theme = e.target.closest("[data-theme-choice]");
  const font = e.target.closest("[data-font-choice]");
  const wash = e.target.closest(".appearance-wash");
  if (theme) chooseAppearance("theme", theme.dataset.themeChoice);
  else if (font) chooseAppearance("font", font.dataset.fontChoice);
  else if (wash) chooseAppearance("wash", currentAppearance("wash") === WASH_OFF ? WASH_ON : WASH_OFF);
  else return;
  paintChoices(pane);
}

export function wireAppearancePane(pane) {
  if (!pane) return;
  paintChoices(pane);
  pane.addEventListener("click", onAppearanceClick);
}
