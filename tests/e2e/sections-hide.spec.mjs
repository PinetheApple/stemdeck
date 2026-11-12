// The sections bar can be put away from its own header, and that header holds
// its controls and save state without spilling, in every language.
import { test, expect } from "@playwright/test";
import { openStudio, JOB_ID, uiText } from "./helpers.mjs";

const ONE_SECTION = [{ id: "s1", name: "Verse", start: 0, end: 2, color: "#4a7fff" }];
const SECTIONS_OFF = /panel-sections-off/;
const LANGUAGE_KEY = "stemdeck.language";
// Sub-pixel layout rounding only.
const EDGE_TOLERANCE_PX = 1;

const hideBtn = (page) => page.locator("#sectionsHideBtn");
const sectionsToggle = (page) => page.locator('.daw-panel-toggle[data-panel="sections"]');

test.afterEach(async ({ page }) => {
  await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections: [] } });
});

async function openWithOneSection(page) {
  const res = await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections: ONE_SECTION } });
  expect(res.ok(), "seeding sections").toBe(true);
  await openStudio(page);
  await expect(page.locator(".section-block")).toHaveCount(ONE_SECTION.length);
}

/** Boxes of the header and the parts that share its row. */
function measureHeader() {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right };
  };
  const header = document.querySelector(".daw-sections-header");
  const padRight = parseFloat(getComputedStyle(header).paddingRight);
  return {
    contentRight: header.getBoundingClientRect().right - padRight,
    title: box(header.querySelector(".daw-label-title")),
    actions: box(header.querySelector(".sections-header-actions")),
    indicator: box(document.getElementById("sectionsSaveIndicator")),
    clippedButtons: [...header.querySelectorAll("button")]
      .filter((b) => b.offsetParent && b.scrollWidth > b.clientWidth)
      .map((b) => b.id),
  };
}

test("Hide puts the bar away, and Collapse > Sections, now focused, brings it back", async ({ page }) => {
  await openStudio(page);
  const app = page.locator(".app");

  await hideBtn(page).click();

  await expect(app).toHaveClass(SECTIONS_OFF);
  await expect(sectionsToggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(sectionsToggle(page)).toBeFocused();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(app).toHaveClass(SECTIONS_OFF);
  await expect(sectionsToggle(page)).toHaveAttribute("aria-pressed", "false");

  await sectionsToggle(page).click();
  await expect(app).not.toHaveClass(SECTIONS_OFF);
  await expect(sectionsToggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(hideBtn(page)).toBeVisible();
});

test("Hide says what it does and how to undo it", async ({ page }) => {
  await openStudio(page);
  await expect(hideBtn(page)).toHaveAttribute("aria-label", await uiText(page, "sections.hideAria"));
  await expect(hideBtn(page)).toHaveAttribute("title", await uiText(page, "sections.hideTitle"));
});

test("Clear shows its word only once armed", async ({ page }) => {
  await openWithOneSection(page);
  const label = page.locator("#sectionsClearBtn .sections-clear-label");
  await expect(page.locator("#sectionsClearBtn")).toBeVisible();
  await expect(label).toBeHidden();

  await page.locator("#sectionsClearBtn").click();

  await expect(label).toBeVisible();
  await expect(label).toHaveText(await uiText(page, "sections.clearConfirm"));
});

test("a long save word in German stays inside its slot", async ({ page }) => {
  await page.addInitScript(
    ([key, code]) => localStorage.setItem(key, JSON.stringify(code)),
    [LANGUAGE_KEY, "de"],
  );
  await openWithOneSection(page);
  await page.route("**/api/jobs/*/sections", () => new Promise(() => {}));

  await page.locator("#sectionsAddBtn").click();
  await expect(page.locator("#sectionsSaveIndicator")).toHaveText(await uiText(page, "sections.saving"));

  const m = await page.evaluate(measureHeader);
  expect(m.title.right).toBeLessThanOrEqual(m.actions.left + EDGE_TOLERANCE_PX);
  expect(m.actions.right).toBeLessThanOrEqual(m.contentRight + EDGE_TOLERANCE_PX);
  expect(m.indicator.left).toBeGreaterThanOrEqual(m.actions.left - EDGE_TOLERANCE_PX);
  expect(m.clippedButtons).toEqual([]);
});
