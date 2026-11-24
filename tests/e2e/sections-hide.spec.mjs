// The sections bar can be put away from the Sections menu and brought back from
// it or from View, and its header holds the save state without spilling.
import { test, expect } from "@playwright/test";
import { openStudio, openSectionsMenu, JOB_ID, uiText } from "./helpers.mjs";

const ONE_SECTION = [{ id: "s1", name: "Verse", start: 0, end: 2, color: "#4a7fff" }];
// seed.py writes a 6 second fixture; these two sections cover all of it.
const FULL_TRACK = [
  { id: "s1", name: "Verse", start: 0, end: 3, color: "#4a7fff" },
  { id: "s2", name: "Chorus", start: 3, end: 6, color: "#ff7a59" },
];
const SECTIONS_OFF = /panel-sections-off/;
const LANGUAGE_KEY = "stemdeck.language";
// Sub-pixel layout rounding only.
const EDGE_TOLERANCE_PX = 1;

const hideBtn = (page) => page.locator("#sectionsHideBtn");
const showBtn = (page) => page.locator("#sectionsShowBtn");
const viewToggle = (page) => page.locator("#viewSectionsBtn");

test.afterEach(async ({ page }) => {
  await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections: [] } });
});

async function openWithSections(page, sections = ONE_SECTION) {
  const res = await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections } });
  expect(res.ok(), "seeding sections").toBe(true);
  await openStudio(page);
  await expect(page.locator(".section-block")).toHaveCount(sections.length);
}

function inGerman(page) {
  return page.addInitScript(
    ([key, code]) => localStorage.setItem(key, JSON.stringify(code)),
    [LANGUAGE_KEY, "de"],
  );
}

/** Whether the notice's whole text is drawn inside the header. */
function measureNotice() {
  const el = document.getElementById("sectionsSaveIndicator");
  const header = el.closest(".daw-sections-header").getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return {
    cutAcross: el.scrollWidth > el.clientWidth,
    cutDown: el.scrollHeight > el.clientHeight,
    insideHeader: r.left >= header.left && r.right <= header.right
      && r.top >= header.top && r.bottom <= header.bottom,
  };
}

test("Hide puts the bar away, and Show the sections bar, now focused, brings it back", async ({ page }) => {
  await openStudio(page);
  const app = page.locator(".app");
  await openSectionsMenu(page);

  await hideBtn(page).click();

  await expect(app).toHaveClass(SECTIONS_OFF);
  await expect(viewToggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(showBtn(page)).toBeFocused();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(app).toHaveClass(SECTIONS_OFF);
  await expect(viewToggle(page)).toHaveAttribute("aria-pressed", "false");

  await openStudio(page);
  await openSectionsMenu(page);
  await showBtn(page).click();
  await expect(app).not.toHaveClass(SECTIONS_OFF);
  await expect(viewToggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(hideBtn(page)).toBeVisible();
});

test("Hide says what it does and how to undo it", async ({ page }) => {
  await openStudio(page);
  await openSectionsMenu(page);
  await expect(hideBtn(page)).toHaveAccessibleName(await uiText(page, "sections.hideAria"));
  await expect(hideBtn(page)).toHaveAttribute("title", await uiText(page, "studio.sections.hideTitle"));
});

test("Clear says Clear, then asks to confirm once armed", async ({ page }) => {
  await openWithSections(page);
  await openSectionsMenu(page);
  const clear = page.locator("#sectionsClearBtn");
  const label = clear.locator(".sections-clear-label");
  await expect(label).toHaveText(await uiText(page, "sections.clear"));

  await clear.click();

  await expect(label).toHaveText(await uiText(page, "sections.clearConfirm"));
  await expect(clear).toHaveAttribute("aria-label", await uiText(page, "sections.clearConfirm"));
});

test("Hide disarms Clear, so the bar comes back without a pending clear", async ({ page }) => {
  await openWithSections(page);
  await openSectionsMenu(page);
  const clear = page.locator("#sectionsClearBtn");
  await clear.click();
  await expect(clear).toHaveAttribute("data-armed", "1");

  await hideBtn(page).click();
  await showBtn(page).click();

  await expect(clear).not.toHaveAttribute("data-armed", "1");
  await expect(clear).toHaveAttribute("aria-label", await uiText(page, "sections.clearAria"));
});

test("a German notice is shown in full", async ({ page }) => {
  await inGerman(page);
  await openWithSections(page, FULL_TRACK);

  await openSectionsMenu(page);
  await page.locator("#sectionsAddBtn").click();
  const notice = page.locator("#sectionsSaveIndicator.notice");
  await expect(notice).toHaveText(await uiText(page, "sections.noRoom"));

  expect(await page.evaluate(measureNotice)).toEqual({ cutAcross: false, cutDown: false, insideHeader: true });
});

test("a long save word in German stays inside its slot", async ({ page }) => {
  await inGerman(page);
  await openWithSections(page);
  await page.route("**/api/jobs/*/sections", () => new Promise(() => {}));

  await openSectionsMenu(page);
  await page.locator("#sectionsAddBtn").click();
  await expect(page.locator("#sectionsSaveIndicator")).toHaveText(await uiText(page, "sections.saving"));

  expect(await page.evaluate(measureNotice)).toEqual({ cutAcross: false, cutDown: false, insideHeader: true });
});
