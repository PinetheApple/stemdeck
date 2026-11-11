// A song re-imported from the library keeps its Lead + Backing choice, so the
// new copy is split when it opens, as the old one was.
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, SIBLING_TITLE, fixtureTrack, openStudio } from "./helpers.mjs";

const GONE_ID = "e2e0f00dface";
const GONE_URL = "https://example.invalid/gone-song";
const RESTORED_ID = "e2e0feedf00d";
const OLD_SPLIT_VIEW = Object.freeze({ state: "done", choice: "split", error: null });

const CATALOG = {
  folders: [
    { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID, GONE_ID], color: null },
    { id: "trash", name: "Trash", items: [], color: null },
  ],
  tracks: {
    [JOB_ID]: fixtureTrack(JOB_ID, "E2E Fixture Track"),
    [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    [GONE_ID]: { ...fixtureTrack(GONE_ID, SIBLING_TITLE), status: "unavailable", sourceUrl: GONE_URL },
  },
};

/** The gone song split on the server; its re-import answers with the sibling's files. */
async function stubReimport(page) {
  const storedChoices = [];
  await page.route(`**/api/jobs/${GONE_ID}/vocal-split`, (route) => route.fulfill({ json: OLD_SPLIT_VIEW }));
  await page.route("**/api/jobs", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { job_id: RESTORED_ID } });
  });
  await page.route(`**/api/jobs/${RESTORED_ID}/vocal-split/choice`, (route) => {
    storedChoices.push(route.request().postDataJSON().choice);
    return route.fulfill({ json: { job_id: RESTORED_ID } });
  });
  await page.route(new RegExp(`/api/jobs/${RESTORED_ID}(/(?!vocal-split/choice).*)?$`), (route) => {
    const url = route.request().url();
    return route.fallback({ url: url.replace(RESTORED_ID, SIBLING_JOB_ID) });
  });
  return storedChoices;
}

test("a song re-imported from the library keeps its Lead + Backing choice", async ({ page }) => {
  await openStudio(page, { catalog: CATALOG });
  // After openStudio: its own /api/jobs route would otherwise answer the POST first.
  const storedChoices = await stubReimport(page);

  await page.evaluate(async (id) => (await import("/js/catalog.js")).loadTrackIntoStudio(id), GONE_ID);

  await expect.poll(() => storedChoices).toEqual(["split"]);
});
