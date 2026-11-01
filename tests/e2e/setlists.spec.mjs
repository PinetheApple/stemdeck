// Setlists in the library pane: named lists of songs kept on the server
// (/api/setlists), filled from a song's … menu or from Up Next, and played
// by loading the first song with the rest as Up Next.
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, SIBLING_TITLE, openInspectorTab, openStudio } from "./helpers.mjs";

// The e2e server lives for the whole run, so each test leaves no setlist behind.
test.afterEach(async ({ request }) => {
  const res = await request.get("/api/setlists");
  for (const setlist of await res.json()) await request.delete(`/api/setlists/${setlist.id}`);
});

const serverSetlists = async (request) => (await request.get("/api/setlists")).json();
const serverSongIds = async (request) => (await serverSetlists(request))[0]?.song_ids;

async function openSetlistsTab(page) {
  await page.locator("#libTabSetlists").click();
  await expect(page.locator("#setlistsPanel")).toBeVisible();
}

async function openRowMenu(page, id) {
  const row = page.locator(`#catalogList .cat-item[data-id="${id}"]`).first();
  await row.hover();
  await row.locator(".cat-more").click();
  const menu = page.locator(".lib-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("a setlist is created, filled, reordered, trimmed and deleted", async ({ page, request }) => {
  await openStudio(page);
  await openSetlistsTab(page);
  await expect(page.locator("#catalogList")).toBeHidden();
  await expect(page.locator("#setlistsEmpty")).toBeVisible();

  await page.locator("#setlistNewBtn").click();
  const name = page.locator(".setlist-name-input");
  await expect(name).toBeFocused();
  await name.fill("Sunday");
  await name.press("Enter");
  await expect(page.locator(".setlist-name")).toHaveText("Sunday");
  await expect(page.locator("#setlistsCount")).toHaveText("1");

  await page.locator("#libTabSongs").click();
  for (const id of [JOB_ID, SIBLING_JOB_ID]) {
    const menu = await openRowMenu(page, id);
    await menu.getByRole("menuitem", { name: "Sunday" }).click();
    await expect(menu).toBeHidden();
  }
  await expect.poll(() => serverSongIds(request)).toEqual([JOB_ID, SIBLING_JOB_ID]);
  // A song already in the list is not offered again.
  const again = await openRowMenu(page, JOB_ID);
  await expect(again.getByRole("menuitem", { name: "Sunday" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(again).toBeHidden();

  await openSetlistsTab(page);
  const songs = page.locator(".setlist-song");
  await expect(songs).toHaveCount(2);
  await expect(page.locator(".setlist-count")).toHaveText("2 songs");
  await songs.nth(1).hover();
  await songs.nth(1).locator(".setlist-song-up").click();
  await expect.poll(() => serverSongIds(request)).toEqual([SIBLING_JOB_ID, JOB_ID]);
  await expect(songs.first()).toHaveAttribute("data-id", SIBLING_JOB_ID);

  await songs.nth(1).hover();
  await songs.nth(1).locator(".setlist-song-remove").click();
  await expect.poll(() => serverSongIds(request)).toEqual([SIBLING_JOB_ID]);
  await expect(songs).toHaveCount(1);

  // Deleting takes two clicks: the first only arms the button.
  const head = page.locator(".setlist-head");
  await head.hover();
  await head.locator(".setlist-delete").click();
  await expect(head.locator(".setlist-delete")).toHaveClass(/armed/);
  expect(await serverSetlists(request)).toHaveLength(1);
  await head.locator(".setlist-delete").click();
  await expect(page.locator(".setlist")).toHaveCount(0);
  expect(await serverSetlists(request)).toEqual([]);
  await expect(page.locator("#setlistsEmpty")).toBeVisible();
});

test("a setlist is renamed in place, and Esc keeps the old name", async ({ page, request }) => {
  await request.post("/api/setlists", { data: { name: "Old name", song_ids: [] } });
  await openStudio(page);
  await openSetlistsTab(page);
  const head = page.locator(".setlist-head");

  await head.hover();
  await head.locator(".setlist-rename").click();
  await page.locator(".setlist-name-input").fill("Not this");
  await page.locator(".setlist-name-input").press("Escape");
  await expect(page.locator(".setlist-name")).toHaveText("Old name");

  await head.hover();
  await head.locator(".setlist-rename").click();
  await page.locator(".setlist-name-input").fill("New name");
  await page.locator(".setlist-name-input").press("Enter");
  await expect(page.locator(".setlist-name")).toHaveText("New name");
  await expect.poll(async () => (await serverSetlists(request))[0]?.name).toBe("New name");
});

test("Play opens the first song and puts the rest in Up Next", async ({ page, request }) => {
  await request.post("/api/setlists", { data: { name: "Gig", song_ids: [SIBLING_JOB_ID, JOB_ID] } });
  await openStudio(page);
  await openSetlistsTab(page);

  await page.locator(".setlist-play").click();
  await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: 15000 });
  await openInspectorTab(page, "upnext");
  const queued = page.locator("#upNextList .upnext-row");
  await expect(queued).toHaveCount(1);
  await expect(queued).toHaveAttribute("data-id", JOB_ID);
});

test("Up Next is saved as a setlist, open song first", async ({ page, request }) => {
  await openStudio(page);
  const row = page.locator(`#catalogList .cat-item[data-id="${SIBLING_JOB_ID}"]`).first();
  await row.hover();
  await row.locator(".cat-upnext").click();
  await openInspectorTab(page, "upnext");
  await expect(page.locator("#upNextList .upnext-row")).toHaveCount(1);

  await page.locator("#upNextSave").click();
  const name = page.locator(".setlist-name-input");
  await expect(name).toBeFocused();
  await name.fill("Rehearsal");
  await name.press("Enter");
  await expect(page.locator(".setlist-name")).toHaveText("Rehearsal");
  await expect.poll(async () => (await serverSetlists(request)).map(({ name: n, song_ids }) => [n, song_ids]))
    .toEqual([["Rehearsal", [JOB_ID, SIBLING_JOB_ID]]]);
});

test("adding a song keeps what another window changed, and a deleted setlist is said", async ({ page, request }) => {
  const { id } = await (await request.post("/api/setlists", { data: { name: "Shared", song_ids: [] } })).json();
  await openStudio(page);
  await request.patch(`/api/setlists/${id}`, { data: { song_ids: [SIBLING_JOB_ID] } });
  const menu = await openRowMenu(page, JOB_ID);
  await menu.getByRole("menuitem", { name: "Shared" }).click();
  await expect.poll(() => serverSongIds(request)).toEqual([SIBLING_JOB_ID, JOB_ID]);

  await openSetlistsTab(page);
  await expect(page.locator(".setlist-song")).toHaveCount(2);
  await request.delete(`/api/setlists/${id}`);
  const song = page.locator(".setlist-song").first();
  await song.hover();
  await song.locator(".setlist-song-remove").click();
  await expect(page.locator("#setlistsError")).toHaveText(/no longer exists/);
  await expect(page.locator(".setlist")).toHaveCount(0);
});
