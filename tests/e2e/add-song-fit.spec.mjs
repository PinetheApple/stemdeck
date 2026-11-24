// The Extract chips fit the Add song popover in every language (#238): they
// wrap between chips, never inside one, the Vocals group stays whole, and
// nothing runs past the popover's edge. They used to fold into a "..." button
// in the old bar; the popover has room for them on at most two rows.
import { test, expect } from "@playwright/test";
import { seedLibrary, stubUpdateCheck } from "./helpers.mjs";

const LANGUAGES = ["en", "de", "fr", "pt", "pt-PT", "pl", "es", "id", "ja", "ko", "zh-Hans"];
const SIZES = [{ width: 1366, height: 768 }, { width: 1024, height: 768 }];
const MAX_ROWS = 2;
const HALF_PX = 0.5;
const EVERY_LANGUAGE_MS = 180_000;

/** How the chips sit: rows used, and anything cut, wrapped inside, split or past the edge. */
const chipLayout = (page) => page.evaluate((slack) => {
  const row = document.getElementById("stemChips");
  const edge = row.getBoundingClientRect();
  const items = [...row.children];
  const problems = [];
  for (const item of items) {
    const r = item.getBoundingClientRect();
    const name = item.dataset.stem ?? item.className;
    if (r.left < edge.left - slack || r.right > edge.right + slack) problems.push(`${name} past the edge`);
    const parts = item.matches(".stem-group") ? [...item.querySelectorAll(".stem-choice, .vocal-mode-btn")] : [item];
    const tops = new Set(parts.map((p) => Math.round(p.getBoundingClientRect().top)));
    if (tops.size > 1) problems.push(`${name} split over lines`);
    for (const p of parts) if (p.scrollWidth > p.clientWidth + 1) problems.push(`${p.textContent.trim()} cut`);
  }
  const pop = document.getElementById("composerDrawer");
  if (pop.scrollWidth > pop.clientWidth + 1) problems.push("popover scrolls sideways");
  const rows = new Set(items.map((i) => Math.round(i.getBoundingClientRect().top))).size;
  return { rows, problems };
}, HALF_PX);

test("the Extract chips fit the popover in every language", async ({ page }) => {
  test.setTimeout(EVERY_LANGUAGE_MS);
  const offenders = [];
  await seedLibrary(page);
  await stubUpdateCheck(page);
  for (const lang of LANGUAGES) {
    await page.addInitScript((l) => localStorage.setItem("stemdeck.language", JSON.stringify(l)), lang);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.locator("#addSongBtn").click();
      await expect(page.locator("#stemChips")).toBeVisible();
      const { rows, problems } = await chipLayout(page);
      if (rows > MAX_ROWS || problems.length) offenders.push({ lang, width: size.width, rows, problems });
    }
  }
  expect(offenders).toEqual([]);
});

test("the old overflow button is gone and every chip is in the popover", async ({ page }) => {
  await seedLibrary(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#addSongBtn").click();
  await expect(page.locator("#stemMoreBtn, #stemOverflow")).toHaveCount(0);
  await expect(page.locator("#composerDrawer .stem-choice[data-stem]")).toHaveCount(6);
});
