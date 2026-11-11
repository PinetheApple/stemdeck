// Settings reads like the rest of the app and shows only what a user can act on.
//
// The layout checks run at the smallest the dialog gets (a 1024x768 window) in
// the languages with the longest labels, because that is where text gets cut or
// a control slides under its label.

import { test, expect } from "@playwright/test";
import { seedLibrary } from "./helpers.mjs";

const TABS = ["general", "details", "network", "export", "logs", "registry"];
const LONG_LANGUAGES = ["en", "de", "fr", "pt", "es"];
const MIN_VIEWPORT = { width: 1024, height: 768 };
const ACCENT_RGB = "rgb(255, 111, 89)";

async function useLanguage(page, code) {
  await page.addInitScript((lang) => localStorage.setItem("stemdeck.language", JSON.stringify(lang)), code);
}

async function withAddresses(page, addresses) {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const body = await (await route.fetch()).json();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...body, allow_network: true, lan_addresses: addresses }),
    });
  });
}

async function openSettings(page) {
  await seedLibrary(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#settingsBtn").click();
  await expect(page.locator(".library-editor")).toBeVisible();
}

async function showTab(page, name) {
  await page.locator(`.settings-tab[data-tab="${name}"]`).click();
  return page.locator(`.settings-pane[data-pane="${name}"]`);
}

// Gap between one row's text and the next, the arrow a native select draws, and
// the face kept for numbers and paths.
const LIMITS = { minRowGap: 8, selectArrow: 20, codeFace: "IBM Plex Mono" };

/** Tabs or labels cut short, labels in the code face, rows touching or running into their control. */
function rowFaults(dialog, { minRowGap, codeFace }) {
  const cut = (el) => el.scrollWidth > el.clientWidth + 1;
  const faults = [...dialog.querySelectorAll(".settings-tab")].filter(cut).map((t) => `tab cut: ${t.textContent}`);
  let previous = null;
  for (const row of dialog.querySelectorAll(".settings-pane:not(.hidden) .settings-row")) {
    const text = row.querySelector(".settings-row-text");
    if (!text || !row.offsetParent) continue;
    const title = text.querySelector(".settings-row-title");
    const name = title?.textContent;
    const box = text.getBoundingClientRect();
    if (title && cut(title)) faults.push(`label cut: ${name}`);
    if (title && getComputedStyle(title).fontFamily.includes(codeFace)) faults.push(`code face: ${name}`);
    if (previous && box.top - previous.bottom < minRowGap) faults.push(`touching: ${name}`);
    const control = row.classList.contains("settings-row-stack") ? null : text.nextElementSibling;
    if (control && box.right > control.getBoundingClientRect().left) faults.push(`overlap: ${name}`);
    previous = row.getBoundingClientRect();
  }
  return faults;
}

/** Selects too narrow for the option they show. */
function selectFaults(dialog, { selectArrow }) {
  const ctx = document.createElement("canvas").getContext("2d");
  const faults = [];
  for (const select of dialog.querySelectorAll(".settings-pane:not(.hidden) select")) {
    if (!select.offsetParent) continue;
    const style = getComputedStyle(select);
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - selectArrow;
    const shown = select.selectedOptions[0]?.text ?? "";
    if (ctx.measureText(shown).width > room) faults.push(`select cut: ${shown}`);
  }
  return faults;
}

for (const lang of LONG_LANGUAGES) {
  test(`every tab fits the smallest dialog in ${lang}`, async ({ page }) => {
    await page.setViewportSize(MIN_VIEWPORT);
    await useLanguage(page, lang);
    await withAddresses(page, ["http://192.168.1.50:8000"]);
    await openSettings(page);
    const dialog = page.locator(".library-editor");
    const faults = [];
    for (const name of TABS) {
      await showTab(page, name);
      for (const fault of [
        ...(await dialog.evaluate(rowFaults, LIMITS)),
        ...(await dialog.evaluate(selectFaults, LIMITS)),
      ]) {
        faults.push(`${name}: ${fault}`);
      }
    }
    expect(faults).toEqual([]);
  });
}

test("controls of one kind share one width across tabs", async ({ page }) => {
  await openSettings(page);
  const widths = { select: new Set(), number: new Set() };
  for (const name of TABS) {
    const pane = await showTab(page, name);
    for (const w of await pane.locator(".settings-select").evaluateAll((els) => els.map((e) => e.offsetWidth))) {
      widths.select.add(w);
    }
    for (const w of await pane.locator(".settings-num-input").evaluateAll((els) => els.map((e) => e.offsetWidth))) {
      widths.number.add(w);
    }
  }
  expect(widths.select.size).toBe(1);
  expect(widths.number.size).toBe(1);
});

test("tabs report which one is selected", async ({ page }) => {
  await openSettings(page);
  await showTab(page, "export");
  await expect(page.locator('.settings-tab[aria-selected="true"]')).toHaveAttribute("data-tab", "export");
  await expect(page.locator('.settings-tab[aria-selected="true"]')).toHaveCount(1);
});

test("addresses on a Docker bridge get no QR code", async ({ page }) => {
  await withAddresses(page, [
    "http://172.16.4.20:8000",
    "http://172.17.0.1:8000",
    "http://172.31.255.1:8000",
    "http://192.168.1.50:8000",
  ]);
  await openSettings(page);
  await showTab(page, "network");
  await expect(page.locator(".qr-label")).toHaveText([
    "http://172.16.4.20:8000/mobile/",
    "http://192.168.1.50:8000/mobile/",
  ]);
});

test("only Docker bridge addresses reads as no connection", async ({ page }) => {
  await withAddresses(page, ["http://172.17.0.1:8000"]);
  await openSettings(page);
  await showTab(page, "network");
  await expect(page.locator(".qr-card")).toHaveCount(0);
  await expect(page.locator(".settings-net-empty")).toBeVisible();
});

test("a read-only network switch does not look switchable", async ({ page }) => {
  await withAddresses(page, ["http://192.168.1.50:8000"]);
  await openSettings(page);
  await showTab(page, "network");
  const sw = page.locator("label.settings-switch:has(.net-access-input)");
  await expect(sw.locator("input")).toBeDisabled();
  expect(await sw.evaluate((el) => getComputedStyle(el).cursor)).toBe("not-allowed");
  const thumb = sw.locator(".settings-switch-thumb");
  expect(await thumb.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(ACCENT_RGB);
});

test("the library tab shows a song count instead of the raw file", async ({ page }) => {
  await openSettings(page);
  const pane = await showTab(page, "registry");
  await expect(pane.locator(".settings-library-count")).toHaveText("2");
  await expect(pane.locator("textarea")).toHaveCount(0);
  await expect(pane).not.toContainText('"jobs"');
});

test("the raw library file is a download", async ({ page }) => {
  await openSettings(page);
  const pane = await showTab(page, "registry");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    pane.locator(".settings-registry-download").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^stemdeck-library-\d+\.json$/);
});

test("the log folder is shown relative to the home folder", async ({ page }) => {
  await page.route("**/api/logs", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ dir: "/home/someone/.local/share/stemdeck/logs", dir_exists: true, files: [] }),
    }),
  );
  await openSettings(page);
  await showTab(page, "logs");
  await expect(page.locator(".settings-logs-path")).toHaveText("~/.local/share/stemdeck/logs");
});
