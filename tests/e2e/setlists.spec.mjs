// Setlists: named lists of songs kept on the server (/api/setlists), shown in
// Browse library, filled from a song's … menu or from Up Next, and played from
// the first song as the list Next follows, Up Next left as it was.
import { test, expect } from "@playwright/test";
import { chooseFromSongMenu, JOB_ID, SIBLING_JOB_ID, SIBLING_TITLE, openBrowse, openInspectorTab, openStudio } from "./helpers.mjs";

// The e2e server lives for the whole run, so each test leaves no setlist behind.
test.afterEach(async ({ request }) => {
  const res = await request.get("/api/setlists");
  for (const setlist of await res.json()) await request.delete(`/api/setlists/${setlist.id}`);
});

const serverSetlists = async (request) => (await request.get("/api/setlists")).json();
const serverSongIds = async (request) => (await serverSetlists(request))[0]?.song_ids;
const setlistNav = (page, name) => page.locator('#browseNav .browse-nav-btn[data-view^="setlist:"]', { hasText: name });
const viewTitle = (page) => page.locator("#browseResults .browse-head h2");
const renameInput = (page) => page.locator(".setlist-rename-dialog .folder-editor-name");

async function openSetlist(page, name) {
  await openBrowse(page);
  await setlistNav(page, name).click();
  await expect(viewTitle(page)).toHaveText(name);
}

async function openRowMenu(page, id) {
  await openBrowse(page);
  const row = page.locator(`#browseResults .cat-item[data-id="${id}"]`);
  await row.hover();
  await row.locator(".song-card-more").click();
  const menu = page.locator(".lib-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("a setlist is created, filled, reordered, trimmed and deleted", async ({ page, request }) => {
  await openStudio(page);
  await expect(page.locator("#sidebarSetlists .sidebar-setlist")).toHaveCount(0);

  await page.locator("#sidebarNewSetlist").click();
  await expect(viewTitle(page)).toHaveText("Setlist 1");
  await expect(page.locator("#sidebarSetlists .sidebar-setlist")).toHaveCount(1);
  await expect(page.locator("#browseResults .browse-empty")).toBeVisible();

  for (const id of [JOB_ID, SIBLING_JOB_ID]) {
    const menu = await openRowMenu(page, id);
    await menu.getByRole("menuitem", { name: "Setlist 1" }).click();
    await expect(menu).toBeHidden();
  }
  await expect.poll(() => serverSongIds(request)).toEqual([JOB_ID, SIBLING_JOB_ID]);
  // A song already in the list is not offered again.
  const again = await openRowMenu(page, JOB_ID);
  await expect(again.getByRole("menuitem", { name: "Setlist 1" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(again).toBeHidden();

  await openSetlist(page, "Setlist 1");
  const songs = page.locator("#browseResults .setlist-song");
  await expect(songs).toHaveCount(2);
  await expect(page.locator("#browseResults .browse-head-count")).toHaveText("2 songs");
  await songs.nth(1).hover();
  await songs.nth(1).locator(".setlist-song-up").click();
  await expect.poll(() => serverSongIds(request)).toEqual([SIBLING_JOB_ID, JOB_ID]);
  await expect(songs.first()).toHaveAttribute("data-id", SIBLING_JOB_ID);

  await songs.nth(1).hover();
  await songs.nth(1).locator(".setlist-song-remove").click();
  await expect.poll(() => serverSongIds(request)).toEqual([SIBLING_JOB_ID]);
  await expect(songs).toHaveCount(1);
  await expect(page.locator(".undo-toast")).toContainText("Removed from Setlist 1");

  // Deleting takes two clicks: the first only arms the button.
  const remove = page.locator("#browseResults .browse-setlist-delete");
  await remove.click();
  await expect(remove).toHaveAttribute("data-armed", "1");
  expect(await serverSetlists(request)).toHaveLength(1);
  await remove.click();
  await expect(setlistNav(page, "Setlist 1")).toHaveCount(0);
  await expect.poll(() => serverSetlists(request)).toEqual([]);
  await expect(page.locator("#sidebarSetlists .sidebar-setlist")).toHaveCount(0);
});

test("a setlist is renamed from its dialog, and Esc keeps the old name", async ({ page, request }) => {
  await request.post("/api/setlists", { data: { name: "Old name", song_ids: [] } });
  await openStudio(page);
  await openSetlist(page, "Old name");
  const rename = page.locator("#browseResults .browse-setlist-rename");

  await rename.click();
  await renameInput(page).fill("Not this");
  await renameInput(page).press("Escape");
  await expect(page.locator(".setlist-rename-dialog")).toHaveCount(0);
  await expect(viewTitle(page)).toHaveText("Old name");
  await expect(rename).toBeFocused();

  await rename.click();
  await renameInput(page).fill("New name");
  await renameInput(page).press("Enter");
  await expect(viewTitle(page)).toHaveText("New name");
  await expect(page.locator("#sidebarSetlists .sidebar-setlist")).toContainText("New name");
  await expect.poll(async () => (await serverSetlists(request))[0]?.name).toBe("New name");
});

test("Play from the top opens the first song and leaves Up Next as it was", async ({ page, request }) => {
  await request.post("/api/setlists", { data: { name: "Gig", song_ids: [SIBLING_JOB_ID] } });
  await openStudio(page);
  await openBrowse(page);
  const row = page.locator(`#browseResults .cat-item[data-id="${JOB_ID}"]`);
  await row.hover();
  await row.locator(".cat-upnext").click();
  await openSetlist(page, "Gig");

  await page.locator("#browseResults .browse-setlist-play").click();
  await expect(page.locator("#browseLibrary")).toBeHidden();
  await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: 15000 });
  await openInspectorTab(page, "upnext");
  const queued = page.locator("#upNextList .upnext-row");
  await expect(queued).toHaveCount(1);
  await expect(queued).toHaveAttribute("data-id", JOB_ID);
});

test("the sidebar's Play starts a setlist from the top too", async ({ page, request }) => {
  await request.post("/api/setlists", { data: { name: "Gig", song_ids: [SIBLING_JOB_ID, JOB_ID] } });
  await openStudio(page);
  const row = page.locator("#sidebarSetlists .sidebar-setlist", { hasText: "Gig" });
  await row.hover();
  await row.locator(".sidebar-setlist-play").click();
  await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: 15000 });
});

test("Up Next is saved as a setlist, open song first, with its name asked for", async ({ page, request }) => {
  await openStudio(page);
  await openBrowse(page);
  await chooseFromSongMenu(page, page.locator(`#browseResults .cat-item[data-id="${SIBLING_JOB_ID}"]`), "Add to Up Next");
  await page.locator("#browseCloseBtn").click();
  await openInspectorTab(page, "upnext");
  await expect(page.locator("#upNextList .upnext-row")).toHaveCount(1);

  await page.locator("#upNextSave").click();
  await expect(renameInput(page)).toBeFocused();
  await renameInput(page).fill("Rehearsal");
  await renameInput(page).press("Enter");
  await expect(viewTitle(page)).toHaveText("Rehearsal");
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

  await openSetlist(page, "Shared");
  await expect(page.locator("#browseResults .setlist-song")).toHaveCount(2);
  await request.delete(`/api/setlists/${id}`);
  const song = page.locator("#browseResults .setlist-song").first();
  await song.hover();
  await song.locator(".setlist-song-remove").click();
  await expect(page.locator("#setlistsError")).toHaveText(/no longer exists/);
  await expect(setlistNav(page, "Shared")).toHaveCount(0);
});
