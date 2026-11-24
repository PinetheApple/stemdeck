// No DOM here, so node tests can import it.

export const APPEARANCE_KIND = Object.freeze({ THEME: "theme", FONT: "font", WASH: "wash" });

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
  [APPEARANCE_KIND.THEME]: THEMES[0].id,
  [APPEARANCE_KIND.FONT]: FONTS[0].id,
  [APPEARANCE_KIND.WASH]: WASH_ON,
});

export const APPEARANCE_STORE_KEYS = Object.freeze({
  [APPEARANCE_KIND.THEME]: "stemdeck.theme",
  [APPEARANCE_KIND.FONT]: "stemdeck.font",
  [APPEARANCE_KIND.WASH]: "stemdeck.coverWash",
});

const CHOICES = {
  [APPEARANCE_KIND.THEME]: THEMES.map((theme) => theme.id),
  [APPEARANCE_KIND.FONT]: FONTS.map((font) => font.id),
  [APPEARANCE_KIND.WASH]: [WASH_ON, WASH_OFF],
};

export function resolveChoice(kind, stored) {
  return CHOICES[kind]?.includes(stored) ? stored : DEFAULT_APPEARANCE[kind];
}
