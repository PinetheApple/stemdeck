// Opening Settings on one of its tabs, the way a user does: the button, then the tab.

import { expect } from "@playwright/test";

export const SETTINGS_TABS = [
  "appearance",
  "general",
  "details",
  "network",
  "export",
  "recording",
  "logs",
  "registry",
  "about",
];

/** Settings, open on `tab` (General unless asked), once its dialog is up. */
export async function openSettings(page, tab = "general") {
  await page.locator("#settingsBtn").click();
  await expect(page.locator(".library-editor")).toBeVisible();
  await page.locator(`.settings-tab[data-tab="${tab}"]`).click();
  return page.locator(`.settings-pane[data-pane="${tab}"]`);
}
