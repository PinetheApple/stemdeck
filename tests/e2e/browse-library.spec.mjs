// Browse library: every song, folder, setlist, favorite and the Trash, over the
// player with the page dimmed. Opened from the sidebar or with Ctrl/Cmd+K.

import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  JOB_LIST_URL,
  browseRow,
  fixtureTrack,
  openBrowse,
  readCatalogState,
  seedCatalogState,
  stubFavorites,
  stubImportQueue,
  stubServerTrash,
  stubUpdateCheck,
} from "./helpers.mjs";
import { isPlaying, startPlayback } from "./openVsPlaying.mjs";

const SETLISTS_PATH = "/api/setlists";
const IMPORT_ID = "e2e0abc00002";
const GIG = { id: "f-gig", name: "Gig", items: [JOB_ID], color: "#4f9de8", parentId: null };
const ENCORE = { id: "f-encore", name: "Encore", items: [], color: "#64c86f", parentId: "f-gig" };
const LIST_COLUMNS = ["Title", "Artist", "Key", "Tempo", "Length", "Folder", "Added"];
const MIN_SCRIM_ALPHA = 0.4;

const overlay = (page) => page.locator("#browseLibrary");
const navButton = (page, view) => page.locator(`#browseNav .browse-nav-btn[data-view="${view}"]`);
const navCount = (page, view) => navButton(page, view).locator(".browse-nav-count");
const search = (page) => page.locator("#browseSearch");
const serverSetlists = async (request) => (await request.get(SETLISTS_PATH)).json();

test.afterEach(async ({ request }) => {
  for (const setlist of await serverSetlists(request)) await request.delete(`${SETLISTS_PATH}/${setlist.id}`);
});

async function openLibrary(page, { folders = [GIG, ENCORE], trashed = [], tracks = {}, artists = null } = {}) {
  const filed = new Set(folders.flatMap((f) => f.items));
  const loose = [JOB_ID, SIBLING_JOB_ID].filter((id) => !filed.has(id) && !trashed.includes(id));
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: loose, color: null },
      ...folders,
      { id: "trash", name: "Trash", items: trashed, color: null },
    ],
    tracks: {
      [JOB_ID]: { ...fixtureTrack(JOB_ID, TRACK_TITLE), ...tracks[JOB_ID] },
      [SIBLING_JOB_ID]: { ...fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE), ...tracks[SIBLING_JOB_ID] },
    },
    seedOnce: true,
  });
  await stubFavorites(page);
  await stubUpdateCheck(page);
  const server = await stubServerTrash(page, { trashed });
  // The server's names win over seeded ones, so an artist is set where the library reads it.
  if (artists) await page.route(JOB_LIST_URL, async (route) => {
    const jobs = await (await route.fetch()).json();
    await route.fulfill({ json: jobs.map((job) => ({ ...job, user_artist: artists[job.job_id] ?? job.user_artist })) });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#browseBtn")).toBeVisible();
  return server;
}

function alphaOf(color) {
  const parts = color.match(/[\d.]+/g)?.map(Number) ?? [];
  return parts.length === 4 ? parts[3] : parts.length === 3 ? 1 : 0;
}

// A module that throws while loading leaves the page half built; a network error is not the app's.
const NETWORK_ERROR = /^Failed to load resource/;

test("the app boots with no error from its own modules", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !NETWORK_ERROR.test(message.text())) errors.push(`console: ${message.text()}`);
  });
  await openLibrary(page);
  await expect(page.locator("#catalogList .cat-item").first()).toBeVisible();
  await expect(page.locator("#boot-failure")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Browse library and Ctrl+K open it over a dimmed page; Ctrl+K focuses the search", async ({ page }) => {
  await openLibrary(page);
  await page.locator("#browseBtn").click();
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toHaveAttribute("role", "dialog");
  const scrim = await page.locator(".browse-scrim").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(alphaOf(scrim)).toBeGreaterThanOrEqual(MIN_SCRIM_ALPHA);
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toBeHidden();

  await page.keyboard.press("Control+K");
  await expect(overlay(page)).toBeVisible();
  await expect(search(page)).toBeFocused();
  await search(page).fill("Fixture");
  await page.locator("#browseGridBtn").focus();
  await page.keyboard.press("Control+K");
  await expect(overlay(page)).toBeVisible();
  await expect(search(page)).toBeFocused();
  expect(await search(page).evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe("Fixture");
});

test("Esc and a click outside close it and return focus", async ({ page }) => {
  await openLibrary(page);
  const opener = page.locator("#browseBtn");
  await opener.click();
  await expect(overlay(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await expect(overlay(page)).toBeVisible();
  await page.mouse.click(4, 400);
  await expect(overlay(page)).toBeHidden();
  await expect(opener).toBeFocused();
});

test("the nav lists views, setlists, nested coloured folders and Trash with counts; Import queue only while importing", async ({ page, request }) => {
  await request.post(SETLISTS_PATH, { data: { name: "Sunday", song_ids: [JOB_ID, SIBLING_JOB_ID] } });
  await openLibrary(page, { trashed: [SIBLING_JOB_ID], tracks: { [JOB_ID]: { favorite: true } } });
  await openBrowse(page);
  await expect(navCount(page, "all")).toHaveText("1");
  await expect(navCount(page, "fav")).toHaveText("1");
  await expect(navButton(page, "recent")).toBeVisible();
  await expect(navButton(page, "queue")).toHaveCount(0);
  const setlist = page.locator('#browseNav .browse-nav-btn[data-view^="setlist:"]');
  await expect(setlist).toContainText("Sunday");
  await expect(setlist.locator(".browse-nav-count")).toHaveText("2");
  await expect(navCount(page, "folder:f-gig")).toHaveText("1");
  const dotX = async (view) => (await navButton(page, view).locator(".folder-dot").boundingBox()).x;
  expect(await dotX("folder:f-encore")).toBeGreaterThan(await dotX("folder:f-gig"));
  const dot = navButton(page, "folder:f-gig").locator(".folder-dot");
  await expect(dot).toHaveCSS("background-color", "rgb(79, 157, 232)");
  await expect(navCount(page, "trash")).toHaveText("1");

  const queue = await stubImportQueue(page, IMPORT_ID, "Incoming song");
  await queue.run();
  await expect(navButton(page, "queue")).toBeVisible();
  await navButton(page, "queue").click();
  await expect(page.locator("#browseImportQueue")).toContainText("Incoming song");
  await queue.settle();
  await expect(navButton(page, "queue")).toHaveCount(0);
});

test("the nav's counts stay the library's while a search narrows the view", async ({ page, request }) => {
  const { id } = await (await request.post(SETLISTS_PATH, { data: { name: "Sunday", song_ids: [JOB_ID, SIBLING_JOB_ID] } })).json();
  await openLibrary(page, { tracks: { [JOB_ID]: { favorite: true }, [SIBLING_JOB_ID]: { favorite: true } } });
  await openBrowse(page);
  const views = ["all", "fav", "folder:f-gig", `setlist:${id}`, "trash"];
  const counts = async () => Promise.all(views.map((view) => navCount(page, view).textContent()));
  const before = await counts();
  expect(before).toEqual(["2", "2", "1", "2", "0"]);

  await search(page).fill(SIBLING_TITLE);
  await expect(browseRow(page, JOB_ID)).toHaveCount(0);
  expect(await counts()).toEqual(before);
  await navButton(page, "fav").click();
  await expect(page.locator("#browseResults .browse-head-count")).toHaveText("1 song");
  expect(await counts()).toEqual(before);
});

test("Esc in the search clears it first, and only the next Esc closes Browse library", async ({ page }) => {
  await openLibrary(page);
  await openBrowse(page);
  await search(page).fill(SIBLING_TITLE);
  await expect(browseRow(page, JOB_ID)).toHaveCount(0);

  await search(page).press("Escape");
  await expect(overlay(page)).toBeVisible();
  await expect(search(page)).toHaveValue("");
  await expect(browseRow(page, JOB_ID)).toHaveCount(1);
  await expect(search(page)).toBeFocused();

  await search(page).press("Escape");
  await expect(overlay(page)).toBeHidden();
});

test("grid and list both show; the list has Title, Artist, Key, Tempo, Length, Folder, Added", async ({ page }) => {
  await openLibrary(page, { tracks: { [JOB_ID]: { bpm: 119.6, key: "B", scale: "Natural Minor", duration: 245, createdAt: Date.now() / 1000 } } });
  await openBrowse(page);
  await page.locator("#browseGridBtn").click();
  await expect(page.locator("#browseGridBtn")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#browseResults .browse-grid .song-card")).toHaveCount(2);

  await page.locator("#browseListBtn").click();
  await expect(page.locator("#browseListBtn")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#browseGridBtn")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#browseResults .browse-thead .cell")).toHaveText([...LIST_COLUMNS, ""]);
  const row = browseRow(page, JOB_ID);
  await expect(row.locator(".c-tempo")).toHaveText("120");
  await expect(row.locator(".c-key")).toHaveText("B minor");
  await expect(row.locator(".c-length")).toHaveText("04:05");
  await expect(row.locator(".c-folder")).toHaveText("Gig");
  await expect(row.locator(".c-added")).toHaveText("Today");

  await page.reload();
  await openBrowse(page);
  await expect(page.locator("#browseListBtn")).toHaveAttribute("aria-pressed", "true");
});

test("search matches title, artist, source and tags; #tag and chips filter by tag", async ({ page }) => {
  await openLibrary(page, {
    tracks: {
      [JOB_ID]: { tags: ["rock"] },
      [SIBLING_JOB_ID]: { sourceUrl: "https://example.com/rock-anthem", tags: ["jazz"] },
    },
    artists: { [JOB_ID]: "Night Owls" },
  });
  await openBrowse(page);
  const shows = async (query, ids) => {
    await search(page).fill(query);
    for (const id of [JOB_ID, SIBLING_JOB_ID]) {
      await expect(browseRow(page, id), `${query} / ${id}`).toHaveCount(ids.includes(id) ? 1 : 0);
    }
  };
  await shows("again", [SIBLING_JOB_ID]);
  await shows("night owls", [JOB_ID]);
  await shows("example.com", [SIBLING_JOB_ID]);
  await shows("rock", [JOB_ID, SIBLING_JOB_ID]);
  await shows("#rock", [JOB_ID]);
  await shows("", [JOB_ID, SIBLING_JOB_ID]);

  const chip = page.locator('.browse-tag[data-tag="jazz"]');
  await chip.click();
  await expect(search(page)).toHaveValue("#jazz");
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(browseRow(page, JOB_ID)).toHaveCount(0);
  await chip.click();
  await expect(search(page)).toHaveValue("");
  await expect(browseRow(page, JOB_ID)).toHaveCount(1);
});

test("a folder view offers Make a setlist and its menu; Delete folder needs a second click", async ({ page, request }) => {
  await openLibrary(page);
  await openBrowse(page, "folder:f-gig");
  const head = page.locator("#browseResults .browse-head");
  await expect(head.locator("h2")).toHaveText("Gig");
  await expect(head).toContainText("1 song");
  await expect(page.locator('#browseResults .browse-subfolder[data-view="folder:f-encore"]')).toBeVisible();

  await head.locator(".browse-make-setlist").click();
  await expect.poll(async () => (await serverSetlists(request)).map((s) => [s.name, s.song_ids])).toEqual([["Gig", [JOB_ID]]]);
  await expect(page.locator("#browseResults .browse-head h2")).toHaveText("Gig");
  await expect(page.locator(".browse-setlist-play")).toBeVisible();

  await openBrowse(page, "folder:f-gig");
  await head.locator(".browse-folder-more").click();
  const menu = page.locator(".lib-menu");
  for (const item of ["Rename…", "New subfolder", "Make a setlist", "Delete folder"]) {
    await expect(menu.getByRole("menuitem", { name: item })).toBeVisible();
  }
  await menu.getByRole("menuitem", { name: "Delete folder" }).click();
  await expect(head.locator(".browse-folder-more")).toContainText("Delete?");
  expect((await readCatalogState(page)).folders.some((f) => f.id === "f-gig")).toBe(true);
  await head.locator(".browse-folder-more").click();
  await expect.poll(async () => (await readCatalogState(page)).folders.some((f) => f.id === "f-gig")).toBe(false);
  await expect(navButton(page, "folder:f-gig")).toHaveCount(0);
});

test("a setlist view plays from the top, renames, makes a folder, deletes on a second click, moves and removes rows", async ({ page, request }) => {
  const { id } = await (await request.post(SETLISTS_PATH, { data: { name: "Sunday", song_ids: [JOB_ID, SIBLING_JOB_ID] } })).json();
  await openLibrary(page);
  await openBrowse(page, `setlist:${id}`);
  const rows = page.locator("#browseResults .cat-item");
  await expect(rows).toHaveCount(2);
  await rows.nth(1).hover();
  await rows.nth(1).locator(".setlist-song-up").click();
  await expect.poll(async () => (await serverSetlists(request))[0].song_ids).toEqual([SIBLING_JOB_ID, JOB_ID]);
  await rows.nth(1).hover();
  await rows.nth(1).locator(".setlist-song-remove").click();
  await expect.poll(async () => (await serverSetlists(request))[0].song_ids).toEqual([SIBLING_JOB_ID]);

  await page.locator(".browse-setlist-rename").click();
  const name = page.locator(".setlist-rename-dialog input");
  await expect(name).toBeFocused();
  await name.fill("Monday");
  await name.press("Enter");
  await expect(page.locator("#browseResults .browse-head h2")).toHaveText("Monday");
  await expect.poll(async () => (await serverSetlists(request))[0].name).toBe("Monday");

  await page.locator(".browse-setlist-folder").click();
  await expect(page.locator("#browseResults .browse-head h2")).toHaveText("Monday");
  await expect.poll(async () => (await readCatalogState(page)).folders.find((f) => f.name === "Monday")?.items).toEqual([SIBLING_JOB_ID]);

  await openBrowse(page, `setlist:${id}`);
  await page.locator(".browse-setlist-delete").click();
  await expect(page.locator(".browse-setlist-delete")).toContainText("Delete?");
  expect(await serverSetlists(request)).toHaveLength(1);
  await page.locator(".browse-setlist-delete").click();
  await expect.poll(() => serverSetlists(request)).toEqual([]);

  await request.post(SETLISTS_PATH, { data: { name: "Gig", song_ids: [SIBLING_JOB_ID] } });
  await page.reload();
  await openBrowse(page, `setlist:${(await serverSetlists(request))[0].id}`);
  await page.locator(".browse-setlist-play").click();
  await expect(overlay(page)).toBeHidden();
  await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: 15000 });
});

test("songs dragged onto a folder, a setlist or Trash land there", async ({ page, request }) => {
  const { id } = await (await request.post(SETLISTS_PATH, { data: { name: "Drop", song_ids: [] } })).json();
  await openLibrary(page);
  await openBrowse(page);
  await browseRow(page, SIBLING_JOB_ID).dragTo(navButton(page, "folder:f-encore"));
  await expect.poll(async () => (await readCatalogState(page)).folders.find((f) => f.id === "f-encore").items).toEqual([SIBLING_JOB_ID]);
  await browseRow(page, JOB_ID).dragTo(navButton(page, `setlist:${id}`));
  await expect.poll(async () => (await serverSetlists(request))[0].song_ids).toEqual([JOB_ID]);
  await browseRow(page, JOB_ID).dragTo(navButton(page, "trash"));
  await expect(navCount(page, "trash")).toHaveText("1");
});

test("a Trash row restores to Unsorted with Restore; Empty trash needs a second click", async ({ page }) => {
  const server = await openLibrary(page, { folders: [], trashed: [JOB_ID, SIBLING_JOB_ID] });
  await openBrowse(page, "trash");
  const row = browseRow(page, JOB_ID);
  await row.hover();
  await expect(row.locator(".cat-restore")).toHaveAttribute("aria-label", `Restore ${TRACK_TITLE}`);
  await row.locator(".cat-restore").click();
  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await readCatalogState(page)).folders.find((f) => f.id === "f-unsorted").items).toContain(JOB_ID);
  expect(server.calls).toContainEqual({ id: JOB_ID, action: "restore" });

  const empty = page.locator("#browseEmptyTrash");
  await page.route(/\/api\/jobs\/[a-f0-9]{12}$/, (route) => (
    route.request().method() === "DELETE" ? route.fulfill({ json: {} }) : route.fallback()
  ));
  await empty.click();
  await expect(empty).toContainText("Delete permanently?");
  await expect(browseRow(page, SIBLING_JOB_ID)).toHaveCount(1);
  await empty.click();
  await expect(browseRow(page, SIBLING_JOB_ID)).toHaveCount(0);
});

test("the Trash lists plain rows with Restore in the grid layout too", async ({ page }) => {
  await openLibrary(page, { folders: [], trashed: [JOB_ID, SIBLING_JOB_ID] });
  await openBrowse(page);
  await page.locator("#browseGridBtn").click();
  await openBrowse(page, "trash");
  await expect(page.locator("#browseResults .browse-grid")).toHaveCount(0);
  await expect(page.locator("#browseResults .song-card")).toHaveCount(0);
  const rows = page.locator("#browseResults .browse-list .cat-item.in-trash");
  await expect(rows).toHaveCount(2);
  await expect(rows.locator(".cat-restore")).toHaveCount(2);
});

test("an empty Recently added shows its title and nothing more", async ({ page }) => {
  await openLibrary(page, { folders: [], trashed: [JOB_ID, SIBLING_JOB_ID] });
  await openBrowse(page, "recent");
  await expect(page.locator("#browseResults .browse-head h2")).toHaveText("Recently added");
  await expect(page.locator("#browseResults .browse-head-count")).toHaveText("0 songs");
  await expect(page.locator("#browseResults .browse-empty")).toHaveCount(0);
  await expect(page.locator("#browseResults .cat-item")).toHaveCount(0);
});

test("click shows, double-click / Enter / cover Play plays and closes; Delete trashes only a keyboard-reached row", async ({ page }) => {
  await openLibrary(page);
  await openBrowse(page);
  await browseRow(page, JOB_ID).locator(".cat-title").click();
  await expect(page.locator("#title")).toHaveText(TRACK_TITLE, { timeout: 15000 });
  await expect(overlay(page)).toBeVisible();
  expect(await isPlaying(page)).toBe(false);
  await page.keyboard.press("Delete");
  await expect(browseRow(page, JOB_ID)).toHaveCount(1);

  await browseRow(page, SIBLING_JOB_ID).locator(".cat-title").dblclick();
  await expect(overlay(page)).toBeHidden();
  await expect.poll(() => isPlaying(page), { timeout: 15000 }).toBe(true);

  await openBrowse(page);
  await browseRow(page, JOB_ID).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(overlay(page)).toBeHidden();
  await expect(page.locator("#title")).toHaveText(TRACK_TITLE, { timeout: 15000 });

  await openBrowse(page);
  await browseRow(page, SIBLING_JOB_ID).hover();
  await browseRow(page, SIBLING_JOB_ID).locator(".row-play").click();
  await expect(overlay(page)).toBeHidden();
  await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: 15000 });

  await openBrowse(page);
  await browseRow(page, JOB_ID).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Delete");
  await expect(browseRow(page, SIBLING_JOB_ID)).toHaveCount(0);
});

test("the playing row shows moving bars while playing and Resume when paused", async ({ page }) => {
  await openLibrary(page);
  await page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`).first().click();
  await expect(page.locator("#title")).toHaveText(TRACK_TITLE, { timeout: 15000 });
  await startPlayback(page);
  await openBrowse(page);
  const row = browseRow(page, JOB_ID);
  await expect(row.locator(".eqbars")).toBeVisible();
  await expect(row.locator(".cat-resume")).toHaveCount(0);
  // The transport sits under Browse library's scrim, so its button is pressed directly.
  await page.locator("#t-play").dispatchEvent("click");
  await expect(row.locator(".eqbars")).toHaveCount(0);
  await expect(row.locator(".cat-resume")).toHaveAttribute("aria-label", `Resume ${TRACK_TITLE}`);
  await row.locator(".cat-resume").click({ force: true });
  await expect.poll(() => isPlaying(page)).toBe(true);
  await expect(row.locator(".eqbars")).toBeVisible();
});
