// A folder's … menu makes a setlist of its songs (its own, then its subfolders'),
// and a setlist's "Make a folder" moves its songs into a new folder. Both keep the
// source, resolve a taken name with "(2)", and focus what they made.
import { test, expect } from "@playwright/test";
import { SETLIST_MAX_SONGS, SETLIST_NAME_MAX_CHARS } from "../../static/js/libraryControls.js";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  fixtureTrack,
  readCatalogState,
  seedCatalogState,
  stubFavorites,
  stubServerTrash,
  stubUpdateCheck,
  uiText,
} from "./helpers.mjs";

const UNSORTED = { id: "f-unsorted", name: "Unsorted" };
const REHEARSAL = { id: "f-rehearsal", name: "Rehearsal" };
const WARMUPS = { id: "f-warmups", name: "Warmups" };
const EMPTY = { id: "f-empty", name: "Empty" };
const TRASH = { id: "trash", name: "Trash" };
const LONG_NAME = "L".repeat(SETLIST_NAME_MAX_CHARS);
const LONG = { id: "f-long", name: LONG_NAME };
const MORE = ".f-more";
const MENU = ".lib-menu";

// The e2e server lives for the whole run, so each test leaves no setlist behind.
test.afterEach(async ({ request }) => {
  const res = await request.get("/api/setlists");
  for (const setlist of await res.json()) await request.delete(`/api/setlists/${setlist.id}`);
});

const serverSetlists = async (request) => (await request.get("/api/setlists")).json();
const namesAndSongs = async (request) => (await serverSetlists(request)).map(({ name, song_ids }) => [name, song_ids]);
const postSetlist = (request, name, songIds = []) => request.post("/api/setlists", { data: { name, song_ids: songIds } });

const BOTH_TRACKS = {
  [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
  [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
};

async function openLibrary(page, folders, { tracks = BOTH_TRACKS, trashed = [] } = {}) {
  await seedCatalogState(page, { folders, tracks, seedOnce: true });
  await stubFavorites(page);
  await stubUpdateCheck(page);
  // Last, so its job list wins over the favorites stub's.
  await stubServerTrash(page, { trashed });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#catalogList .folder").first()).toBeVisible();
}

const headOf = (page, id) => page.locator(`#catalogList .folder[data-id="${id}"] > .folder-head`);
const headNamed = (page, name) => page.locator("#catalogList .folder-head").filter({
  has: page.locator(".f-name").getByText(name, { exact: true }),
});

async function openFolderMenu(page, id) {
  await headOf(page, id).hover();
  await headOf(page, id).locator(MORE).click();
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  return menu;
}

async function makeSetlistItem(page, id) {
  const menu = await openFolderMenu(page, id);
  return menu.getByRole("menuitem", { name: await uiText(page, "folder.makeSetlist"), exact: true });
}

async function expectKeyboardFocus(locator) {
  await expect(locator).toBeFocused();
  expect(await locator.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
}

async function storedFolders(page) {
  return (await readCatalogState(page)).folders;
}

test("a folder becomes a setlist: its songs, then its subfolders', and the folder stays", async ({ page, request }) => {
  await openLibrary(page, [
    { ...UNSORTED, items: [], color: null },
    { ...REHEARSAL, items: [SIBLING_JOB_ID], color: null },
    { ...WARMUPS, items: [JOB_ID], color: null, parentId: REHEARSAL.id },
    { ...TRASH, items: [], color: null },
  ]);
  await (await makeSetlistItem(page, REHEARSAL.id)).click();

  await expect.poll(() => namesAndSongs(request)).toEqual([[REHEARSAL.name, [SIBLING_JOB_ID, JOB_ID]]]);
  const [{ id }] = await serverSetlists(request);
  await expect(page.locator("#libTabSetlists")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(`.setlist[data-id="${id}"] .setlist-song`)).toHaveCount(2);
  await expectKeyboardFocus(page.locator(`.setlist[data-id="${id}"] > .setlist-head`));

  const folders = await storedFolders(page);
  expect(folders.find((f) => f.id === REHEARSAL.id)?.items).toEqual([SIBLING_JOB_ID]);
  expect(folders.find((f) => f.id === WARMUPS.id)?.items).toEqual([JOB_ID]);
});

test("a taken setlist name gets a number, trimmed to fit", async ({ page, request }) => {
  await postSetlist(request, REHEARSAL.name);
  await postSetlist(request, `${REHEARSAL.name} (2)`);
  await postSetlist(request, LONG_NAME);
  await openLibrary(page, [
    { ...UNSORTED, items: [], color: null },
    { ...REHEARSAL, items: [SIBLING_JOB_ID], color: null },
    { ...LONG, items: [JOB_ID], color: null },
    { ...TRASH, items: [], color: null },
  ]);

  await (await makeSetlistItem(page, REHEARSAL.id)).click();
  await expect.poll(async () => (await serverSetlists(request)).at(-1)?.name).toBe(`${REHEARSAL.name} (3)`);

  await page.locator("#libTabSongs").click();
  await (await makeSetlistItem(page, LONG.id)).click();
  const trimmed = `${"L".repeat(SETLIST_NAME_MAX_CHARS - " (2)".length)} (2)`;
  await expect.poll(async () => (await serverSetlists(request)).at(-1)?.name).toBe(trimmed);
  expect(await serverSetlists(request)).toHaveLength(5);
});

test("an empty folder cannot be made a setlist, and Unsorted has no menu", async ({ page, request }) => {
  await openLibrary(page, [
    { ...UNSORTED, items: [JOB_ID, SIBLING_JOB_ID], color: null },
    { ...EMPTY, items: [], color: null },
    { ...TRASH, items: [], color: null },
  ]);
  await expect(await makeSetlistItem(page, EMPTY.id)).toBeDisabled();
  await expect(headOf(page, UNSORTED.id).locator(MORE)).toHaveCount(0);
  expect(await serverSetlists(request)).toEqual([]);
});

test("a folder with too many songs says so under its row and makes nothing", async ({ page, request }) => {
  const ids = Array.from({ length: SETLIST_MAX_SONGS + 1 }, (_, i) => `e2e1${String(i).padStart(8, "0")}`);
  const tracks = { ...BOTH_TRACKS };
  for (const id of ids) tracks[id] = fixtureTrack(id, `Song ${id}`);
  await openLibrary(page, [
    { ...UNSORTED, items: [JOB_ID, SIBLING_JOB_ID], color: null },
    { ...REHEARSAL, items: ids, color: null, collapsed: true },
    { ...TRASH, items: [], color: null },
  ], { tracks });

  await (await makeSetlistItem(page, REHEARSAL.id)).click();
  const error = page.locator(`#catalogList .folder[data-id="${REHEARSAL.id}"] > .folder-error`);
  await expect(error).toHaveText(await uiText(page, "folder.tooManyForSetlist", { max: SETLIST_MAX_SONGS }));
  await expect(headOf(page, REHEARSAL.id)).toBeFocused();
  await expect(page.locator("#libTabSongs")).toHaveAttribute("aria-selected", "true");
  expect(await serverSetlists(request)).toEqual([]);
});

test("a setlist becomes a folder: its songs move in setlist order, and the setlist stays", async ({ page, request }) => {
  await postSetlist(request, "Gig #3", [SIBLING_JOB_ID, JOB_ID]);
  await openLibrary(page, [
    { ...UNSORTED, items: [JOB_ID], color: null },
    { ...REHEARSAL, items: [SIBLING_JOB_ID], color: null },
    { ...TRASH, items: [], color: null },
  ]);
  await page.locator("#libTabSetlists").click();
  await page.locator(".setlist-head .setlist-make-folder").click();

  const head = headNamed(page, "Gig 3");
  await expect(page.locator("#libTabSongs")).toHaveAttribute("aria-selected", "true");
  await expectKeyboardFocus(head);
  const folders = await storedFolders(page);
  const made = folders.find((f) => f.name === "Gig 3");
  expect(made.items).toEqual([SIBLING_JOB_ID, JOB_ID]);
  expect(made.collapsed).toBe(false);
  expect(folders.find((f) => f.id === UNSORTED.id)?.items).toEqual([]);
  expect(folders.find((f) => f.id === REHEARSAL.id)?.items).toEqual([]);
  await expect(page.locator(`#catalogList .folder[data-id="${made.id}"] .cat-item`)).toHaveCount(2);
  expect(await namesAndSongs(request)).toEqual([["Gig #3", [SIBLING_JOB_ID, JOB_ID]]]);
});

test("a trashed song stays in the Trash, a taken folder name gets a number, and a name with nothing left is New Folder", async ({ page, request }) => {
  await postSetlist(request, REHEARSAL.name, [JOB_ID, SIBLING_JOB_ID]);
  await postSetlist(request, "#!?");
  await openLibrary(page, [
    { ...UNSORTED, items: [SIBLING_JOB_ID], color: null },
    { ...REHEARSAL, items: [], color: null },
    { ...TRASH, items: [JOB_ID], color: null },
  ], { trashed: [JOB_ID] });
  await page.locator("#libTabSetlists").click();
  await expect(page.locator(`.setlist-song[data-id="${JOB_ID}"]`)).toHaveClass(/in-trash/);
  await page.locator(".setlist-make-folder").first().click();

  const renamed = `${REHEARSAL.name} (2)`;
  await expectKeyboardFocus(headNamed(page, renamed));
  let folders = await storedFolders(page);
  expect(folders.find((f) => f.name === renamed)?.items).toEqual([SIBLING_JOB_ID]);
  expect(folders.find((f) => f.id === TRASH.id)?.items).toEqual([JOB_ID]);

  await page.locator("#libTabSetlists").click();
  await page.locator(".setlist-make-folder").nth(1).click();
  const fallback = await uiText(page, "library.newFolder");
  await expectKeyboardFocus(headNamed(page, fallback));
  folders = await storedFolders(page);
  expect(folders.find((f) => f.name === fallback)?.items).toEqual([]);
});
