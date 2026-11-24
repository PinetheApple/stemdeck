// settingsNav.js — Settings' tabs, in order, and the vertical list they show in.
// Lucide icons (ISC). Each tab keeps the data-tab its pane is found by.

const ICONS = {
  palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z"/>',
  settings: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  wifi: '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.86a10 10 0 0 1 14 0"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  mic: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};

export const SETTINGS_TAB = Object.freeze({
  APPEARANCE: "appearance",
  GENERAL: "general",
  DETAILS: "details",
  NETWORK: "network",
  EXPORT: "export",
  RECORDING: "recording",
  LOGS: "logs",
  LIBRARY: "registry",
  ABOUT: "about",
});

const TABS = [
  { id: SETTINGS_TAB.APPEARANCE, key: "settings.tab.appearance", label: "Appearance", icon: ICONS.palette },
  { id: SETTINGS_TAB.GENERAL, key: "settings.tab.general", label: "General", icon: ICONS.settings },
  { id: SETTINGS_TAB.DETAILS, key: "settings.tab.songDetails", label: "Song details", icon: ICONS.music },
  { id: SETTINGS_TAB.NETWORK, key: "settings.tab.network", label: "Network", icon: ICONS.wifi },
  { id: SETTINGS_TAB.EXPORT, key: "settings.tab.export", label: "Export", icon: ICONS.upload },
  { id: SETTINGS_TAB.RECORDING, key: "settings.tab.recording", label: "Recording", icon: ICONS.mic },
  { id: SETTINGS_TAB.LOGS, key: "settings.tab.logs", label: "Logs", icon: ICONS.file },
  { id: SETTINGS_TAB.LIBRARY, key: "settings.tab.library", label: "Library", icon: ICONS.library },
  { id: SETTINGS_TAB.ABOUT, key: "settings.tab.about", label: "About", icon: ICONS.info },
];

export const DEFAULT_SETTINGS_TAB = SETTINGS_TAB.APPEARANCE;

export function isSettingsTab(name) {
  return TABS.some((tab) => tab.id === name);
}

function tabHtml({ id, key, label, icon }) {
  return `<button class="settings-tab" type="button" role="tab" data-tab="${id}" aria-selected="false" tabindex="-1">`
    + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`
    + `<span data-i18n="${key}">${label}</span></button>`;
}

/** The tab list; labels are English here and translated with the rest of the dialog. */
export function settingsNavHtml() {
  return `<nav class="settings-nav" role="tablist" aria-orientation="vertical">${TABS.map(tabHtml).join("")}</nav>`;
}
