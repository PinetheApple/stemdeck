// appearanceModel.js — the theme, font and cover wash a device can choose, and
// what a stored choice resolves to. No DOM, so node tests can import it.

export const THEMES = Object.freeze([
  { id: "ink-coral", labelKey: "settings.appearance.theme.inkCoral" },
  { id: "ink-ice", labelKey: "settings.appearance.theme.inkIce" },
  { id: "dusk-coral", labelKey: "settings.appearance.theme.duskCoral" },
]);

// Font names are proper nouns: shown as they are in every language.
export const FONTS = Object.freeze([
  { id: "manrope", label: "Manrope" },
  { id: "inter", label: "Inter" },
  { id: "geist", label: "Geist" },
  { id: "figtree", label: "Figtree" },
  { id: "dm-sans", label: "DM Sans" },
  { id: "plus-jakarta-sans", label: "Plus Jakarta Sans" },
  { id: "bricolage-grotesque", label: "Bricolage Grotesque" },
]);

export const WASH_ON = "on";
export const WASH_OFF = "off";

export const DEFAULT_APPEARANCE = Object.freeze({
  theme: THEMES[0].id,
  font: FONTS[0].id,
  wash: WASH_ON,
});

export const APPEARANCE_STORE_KEYS = Object.freeze({
  theme: "stemdeck.theme",
  font: "stemdeck.font",
  wash: "stemdeck.coverWash",
});

const CHOICES = {
  theme: THEMES.map((theme) => theme.id),
  font: FONTS.map((font) => font.id),
  wash: [WASH_ON, WASH_OFF],
};

/** The stored value when it is still on offer, otherwise the default. */
export function resolveChoice(kind, stored) {
  return CHOICES[kind]?.includes(stored) ? stored : DEFAULT_APPEARANCE[kind];
}
