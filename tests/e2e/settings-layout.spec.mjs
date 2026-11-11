// Settings reads like the rest of the app and shows only what a user can act on.
//
// The layout checks run with the dialog at its minimum size, in every language,
// because that is where text gets cut or a control slides under its label.

import { test, expect } from "@playwright/test";
import { seedLibrary } from "./helpers.mjs";

const TABS = ["general", "details", "network", "export", "logs", "registry"];
const LANGUAGES = ["en", "pl", "ja", "ko", "zh-Hans", "de", "fr", "es", "pt", "pt-PT", "id"];
// Short enough that the dialog's height clamps to its minimum.
const MIN_SIZE_VIEWPORT = { width: 1024, height: 600 };
const ACCENT_RGB = "rgb(255, 111, 89)";
// Gap between one row's content and the next, the arrow a native select draws,
// and the face kept for numbers and paths.
const LIMITS = { minRowGap: 8, selectArrow: 20, codeFace: "IBM Plex Mono" };

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

/** Tabs or labels cut short, labels in the code face, rows touching or running into their control. */
function rowFaults(dialog, { minRowGap, codeFace }) {
  const cut = (el) => el.scrollWidth > el.clientWidth + 1;
  const contentBox = (row) => {
    const boxes = [...row.children].filter((c) => c.offsetParent).map((c) => c.getBoundingClientRect());
    return { top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map((b) => b.bottom)) };
  };
  const tabs = dialog.querySelectorAll(".settings-tab, .settings-pane:not(.hidden) .settings-subtab");
  const faults = [...tabs].filter((t) => t.offsetParent && cut(t)).map((t) => `tab cut: ${t.textContent}`);
  let previous = null;
  for (const row of dialog.querySelectorAll(".settings-pane:not(.hidden) .settings-row")) {
    const text = row.querySelector(".settings-row-text");
    if (!text || !row.offsetParent) continue;
    const title = text.querySelector(".settings-row-title");
    const name = title?.textContent;
    const box = contentBox(row);
    if (title && cut(title)) faults.push(`label cut: ${name}`);
    if (title && getComputedStyle(title).fontFamily.includes(codeFace)) faults.push(`code face: ${name}`);
    if (previous && box.top - previous.bottom < minRowGap) faults.push(`touching: ${name}`);
    const control = row.classList.contains("settings-row-stack") ? null : text.nextElementSibling;
    if (control && text.getBoundingClientRect().right > control.getBoundingClientRect().left) {
      faults.push(`overlap: ${name}`);
    }
    previous = box;
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

async function faultsOnEveryTab(page) {
  const dialog = page.locator(".library-editor");
  const faults = [];
  for (const name of TABS) {
    await showTab(page, name);
    const found = [...(await dialog.evaluate(rowFaults, LIMITS)), ...(await dialog.evaluate(selectFaults, LIMITS))];
    faults.push(...found.map((fault) => `${name}: ${fault}`));
  }
  return faults;
}

for (const lang of LANGUAGES) {
  test(`every tab fits the dialog at its minimum size in ${lang}`, async ({ page }) => {
    await page.setViewportSize(MIN_SIZE_VIEWPORT);
    await useLanguage(page, lang);
    await withAddresses(page, ["http://192.168.1.50:8000"]);
    await openSettings(page);
    const dialog = page.locator(".library-editor");
    const { box, min } = await dialog.evaluate((el) => ({
      box: [el.offsetWidth, el.offsetHeight],
      min: [parseFloat(getComputedStyle(el).minWidth), parseFloat(getComputedStyle(el).minHeight)],
    }));
    expect(box).toEqual(min);
    expect(await faultsOnEveryTab(page)).toEqual([]);
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

test.describe("tabs by keyboard", () => {
  const selectedTab = (page) => page.locator('.settings-tab[aria-selected="true"]');

  test("arrows move between tabs and wrap, Home and End jump to the ends", async ({ page }) => {
    await openSettings(page);
    await page.locator('.settings-tab[data-tab="general"]').focus();
    await page.keyboard.press("ArrowRight");
    await expect(selectedTab(page)).toHaveAttribute("data-tab", "details");
    await expect(page.locator('.settings-pane[data-pane="details"]')).toBeVisible();
    await expect(selectedTab(page)).toBeFocused();
    await page.keyboard.press("End");
    await expect(selectedTab(page)).toHaveAttribute("data-tab", "registry");
    await page.keyboard.press("ArrowRight");
    await expect(selectedTab(page)).toHaveAttribute("data-tab", "general");
    await page.keyboard.press("ArrowLeft");
    await expect(selectedTab(page)).toHaveAttribute("data-tab", "registry");
    await page.keyboard.press("Home");
    await expect(selectedTab(page)).toHaveAttribute("data-tab", "general");
  });

  test("only the selected tab is a Tab stop", async ({ page }) => {
    await openSettings(page);
    await showTab(page, "network");
    const stops = await page.locator(".settings-tab").evaluateAll((tabs) => tabs.map((t) => t.tabIndex));
    expect(stops).toEqual([-1, -1, 0, -1, -1, -1]);
  });

  test("the Logs sub-tabs move the same way", async ({ page }) => {
    await openSettings(page);
    await showTab(page, "logs");
    await page.locator('.settings-subtab[data-sub="location"]').focus();
    await page.keyboard.press("ArrowRight");
    const selected = page.locator('.settings-subtab[aria-selected="true"]');
    await expect(selected).toHaveAttribute("data-sub", "application");
    await expect(page.locator('.settings-subpane[data-subpane="application"]')).toBeVisible();
    await page.keyboard.press("End");
    await expect(selected).toHaveAttribute("data-sub", "setup");
  });
});

test("the fade shows at whichever edge has more to scroll, and not on a tab that fits", async ({ page }) => {
  await page.setViewportSize(MIN_SIZE_VIEWPORT);
  await openSettings(page);
  const cueOf = (pane) => () =>
    pane.evaluate((el) => [el.classList.contains("more-above"), el.classList.contains("more-below")]);
  const general = page.locator('.settings-pane[data-pane="general"]');
  await expect.poll(cueOf(general)).toEqual([false, true]);
  await general.evaluate((el) => el.scrollTo(0, (el.scrollHeight - el.clientHeight) / 2));
  await expect.poll(cueOf(general)).toEqual([true, true]);
  await general.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(cueOf(general)).toEqual([true, false]);
  await expect.poll(cueOf(await showTab(page, "export"))).toEqual([false, false]);
});

test("each QR code is captioned with its address on one line", async ({ page }) => {
  await useLanguage(page, "pt");
  await page.setViewportSize(MIN_SIZE_VIEWPORT);
  await withAddresses(page, ["http://100.114.201.106:8000", "http://192.168.1.50:8000"]);
  await openSettings(page);
  await showTab(page, "network");
  const labels = page.locator(".qr-label");
  await expect(labels).toHaveText(["100.114.201.106:8000", "192.168.1.50:8000"]);
  await expect(labels.first()).toHaveAttribute("title", "http://100.114.201.106:8000/mobile/");
  const lines = await labels.evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))),
  );
  expect(lines).toEqual([1, 1]);
});

test("every address the server gives gets a QR code", async ({ page }) => {
  await withAddresses(page, ["http://172.17.0.1:8000", "http://192.168.1.50:8000"]);
  await openSettings(page);
  await showTab(page, "network");
  await expect(page.locator(".qr-card")).toHaveCount(2);
});

test("the server-mode note says what to do without naming config files", async ({ page }) => {
  await openSettings(page);
  await showTab(page, "network");
  const note = page.locator(".settings-server-note");
  await expect(note).toBeVisible();
  await expect(note).not.toContainText(/\.ya?ml|docker/i);
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

test("a library in sync says so once", async ({ page }) => {
  await openSettings(page);
  const pane = await showTab(page, "registry");
  await expect(pane.locator(".library-editor-status")).toHaveText("All tracks in sync");
  await expect(pane.locator(".library-editor-table-wrap")).toBeHidden();
  expect(await pane.innerText()).not.toMatch(/in sync[\s\S]*in sync/i);
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
