// Renaming a song's title and artist (PATCH /api/jobs/{id}), in the song head
// and in its library row. A saved rename asks the server to look the song up
// again by the new names (POST .../audio-tags).
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, TRACK_TITLE, openStudio, stubAudioTags } from "./helpers.mjs";

// Wide enough for the song head to show the artist beside the title.
test.use({ viewport: { width: 1600, height: 900 } });

// The e2e server lives for the whole run, so each test puts the names back.
test.afterEach(async ({ request }) => {
  for (const id of [JOB_ID, SIBLING_JOB_ID]) {
    await request.patch(`/api/jobs/${id}`, { data: { title: null, artist: null } });
  }
});

const jobState = async (request, id = JOB_ID) => (await request.get(`/api/jobs/${id}`)).json();

function recordRenames(page) {
  const sent = [];
  page.on("request", (req) => {
    if (req.method() === "PATCH" && /\/api\/jobs\/[^/]+$/.test(new URL(req.url()).pathname)) sent.push(req.postDataJSON());
  });
  return sent;
}

test("the song head saves a rename on Enter, and the song is looked up again", async ({ page, request }) => {
  const asked = await stubAudioTags(page, null);
  await openStudio(page);
  // Opening the song asks once already; the rename must ask again.
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  const askedBefore = asked.length;

  await page.locator("#title").click();
  const title = page.locator("#songHead .rename-title");
  await expect(title).toBeFocused();
  await title.fill("Renamed Song");
  await page.locator("#songHead .rename-artist").fill("New Artist");
  await page.locator("#songHead .rename-artist").press("Enter");

  await expect(page.locator("#title")).toHaveText("Renamed Song");
  await expect(page.locator("#np-artist")).toHaveText("New Artist");
  const row = page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`).first();
  await expect(row.locator(".cat-title")).toHaveText("Renamed Song");
  await expect(row.locator(".cat-sub")).toContainText("New Artist");

  const state = await jobState(request);
  expect(state.user_title).toBe("Renamed Song");
  expect(state.user_artist).toBe("New Artist");
  expect(state.display_artist).toBe("New Artist");
  await expect.poll(() => asked.length).toBe(askedBefore + 1);
  expect(asked.at(-1)).toBe(JOB_ID);
});

test("Esc cancels a rename and sends nothing", async ({ page, request }) => {
  await stubAudioTags(page, null);
  const sent = recordRenames(page);
  await openStudio(page);

  await page.locator("#np-rename-btn").click();
  await page.locator("#songHead .rename-title").fill("Not saved");
  await page.locator("#songHead .rename-title").press("Escape");

  await expect(page.locator("#songHead .rename-form")).toHaveCount(0);
  await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
  expect(sent).toEqual([]);
  expect((await jobState(request)).user_title).toBeNull();
});

test("restore goes back to the detected names", async ({ page, request }) => {
  await request.patch(`/api/jobs/${JOB_ID}`, { data: { title: "Given Title", artist: "Given Artist" } });
  await stubAudioTags(page, null);
  const sent = recordRenames(page);
  await openStudio(page);
  await expect(page.locator("#title")).toHaveText("Given Title");
  await expect(page.locator("#np-artist")).toHaveText("Given Artist");

  await page.locator("#np-artist").click();
  await expect(page.locator("#songHead .rename-artist")).toBeFocused();
  await page.locator("#songHead .rename-restore").click();

  await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
  await expect(page.locator("#np-artist")).toBeHidden();
  expect(sent).toEqual([{ title: null, artist: null }]);
  const state = await jobState(request);
  expect(state.user_title).toBeNull();
  expect(state.user_artist).toBeNull();
});

test("a library row renames its song from the … menu", async ({ page, request }) => {
  const asked = await stubAudioTags(page, null);
  await openStudio(page);
  const row = page.locator(`#catalogList .cat-item[data-id="${SIBLING_JOB_ID}"]`).first();
  await row.hover();
  await row.locator(".cat-more").click();
  await page.locator(".lib-menu").getByRole("menuitem", { name: "Rename…" }).click();

  const title = row.locator(".rename-title");
  await expect(title).toBeFocused();
  await title.fill("Row Renamed");
  await title.press("Enter");

  await expect(row.locator(".cat-title")).toHaveText("Row Renamed");
  expect((await jobState(request, SIBLING_JOB_ID)).user_title).toBe("Row Renamed");
  await expect.poll(() => asked.includes(SIBLING_JOB_ID)).toBe(true);
  // The open song is another one, so the song head keeps its name.
  await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
});
