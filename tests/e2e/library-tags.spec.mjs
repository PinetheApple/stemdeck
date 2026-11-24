// Browse library's tag chips: the open song's tags, then the library's, under the search
// box. A chip filters by its #tag and a second click clears it; typing # suggests tags.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  TRACK_TITLE,
  SIBLING_TITLE,
  browseRow,
  fixtureTrack,
  openBrowse,
  seedCatalogState,
  stubExportEndpoints,
  stubUpdateCheck,
} from "./helpers.mjs";

const FIRST_TAGS = ["rock", "live", "shared"];
const SIBLING_TAGS = ["jazz", "shared"];
const LIBRARY_TAGS = ["rock", "live", "shared", "jazz"];

const chips = (page) => page.locator("#browseTags .browse-tag");
const chipTags = (page) => chips(page).evaluateAll((els) => els.map((el) => el.dataset.tag));

test.beforeEach(async ({ page }) => {
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: { ...fixtureTrack(JOB_ID, TRACK_TITLE), tags: FIRST_TAGS },
      [SIBLING_JOB_ID]: { ...fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE), tags: SIBLING_TAGS },
    },
  });
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openBrowse(page);
});

test("the chips are the library's tags, each once", async ({ page }) => {
  await expect.poll(() => chipTags(page)).toEqual(LIBRARY_TAGS);
});

test("the open song's tags lead the chips, and one filters by its tag", async ({ page }) => {
  await page.locator("#browseCloseBtn").click();
  await page.locator(`#catalogList .cat-item[data-id="${SIBLING_JOB_ID}"]`).first().click();
  await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: 15000 });
  await openBrowse(page);
  await expect.poll(() => chipTags(page)).toEqual([...SIBLING_TAGS, "rock", "live"]);

  await chips(page).first().click();
  await expect(page.locator("#browseSearch")).toHaveValue("#jazz");
  await expect(browseRow(page, SIBLING_JOB_ID)).toHaveCount(1);
  await expect(browseRow(page, JOB_ID)).toHaveCount(0);
});

test("a chip filters the library by its tag, and a second click clears it", async ({ page }) => {
  const rock = chips(page).filter({ hasText: "#rock" });
  await rock.click();
  await expect(page.locator("#browseSearch")).toHaveValue("#rock");
  await expect(rock).toHaveAttribute("aria-pressed", "true");
  await expect(browseRow(page, JOB_ID)).toHaveCount(1);
  await expect(browseRow(page, SIBLING_JOB_ID)).toHaveCount(0);

  await rock.click();
  await expect(page.locator("#browseSearch")).toHaveValue("");
  await expect(browseRow(page, SIBLING_JOB_ID)).toHaveCount(1);
});

test("typing # suggests tags, and picking one filters by it", async ({ page }) => {
  await page.locator("#browseSearch").fill("#ja");
  const suggestion = page.locator("#tagSuggest .tag-suggest-item");
  await expect(suggestion).toHaveText(["#jazz"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#browseSearch")).toHaveValue("#jazz");
  await expect(browseRow(page, JOB_ID)).toHaveCount(0);
  await expect(browseRow(page, SIBLING_JOB_ID)).toHaveCount(1);
});
