// In Browse library, a folder's … menu makes a setlist of its songs, and a
// setlist's "Make a folder" makes a folder; each then shows what it made.
import { test, expect } from "@playwright/test";
import { SETLIST_MAX_SONGS, SETLIST_NAME_MAX_CHARS } from "../../static/js/libraryControls.js";
import { copySuffix } from "../../static/js/listNames.js";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  fixtureTrack,
  openBrowse,
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
const SCALES = { id: "f-scales", name: "Scales" };
const EMPTY = { id: "f-empty", name: "Empty" };
const TRASH = { id: "trash", name: "Trash" };
const LONG_NAME = "L".repeat(SETLIST_NAME_MAX_CHARS);
const LONG = { id: "f-long", name: LONG_NAME };
const GIG = "Gig #3";
const GIG_AS_FOLDER = "Gig 3";
const NOTHING_VALID = "#!?";
const RENAMED = "Gig night";
const MORE = "#browseResults .browse-folder-more";
const MENU = ".lib-menu";
const ANNOUNCE = "#libraryAnnounce";
const SETLISTS_PATH = "/api/setlists";
const HTTP_NOT_FOUND = 404;
const NOT_FOUND_DETAIL = "Not Found";
const TAKEN_ID = "f-taken";
// Job-id shaped (12 characters), and apart from the fixture jobs' "e2e0" ids.
const FAKE_SONG_PREFIX = "e2e1";
const FAKE_SONG_DIGITS = 8;
const fakeSongId = (i) => `${FAKE_SONG_PREFIX}${String(i).padStart(FAKE_SONG_DIGITS, "0")}`;

// The e2e server lives for the whole run, so each test leaves no setlist behind.
test.afterEach(async ({ request }) => {
  const res = await request.get(SETLISTS_PATH);
  for (const setlist of await res.json()) await request.delete(`${SETLISTS_PATH}/${setlist.id}`);
});

const serverSetlists = async (request) => (await request.get(SETLISTS_PATH)).json();
const namesAndSongs = async (request) => (await serverSetlists(request)).map(({ name, song_ids }) => [name, song_ids]);
const lastSetlistName = async (request) => (await serverSetlists(request)).at(-1)?.name;
const postSetlist = (request, name, songIds = []) => request.post(SETLISTS_PATH, { data: { name, song_ids: songIds } });

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
  await openBrowse(page);
  await expect(page.locator("#browseNav .browse-nav-folder").first()).toBeVisible();
}

const viewTitle = (page) => page.locator("#browseResults .browse-head h2");
const navNamed = (page, kind, name) => page.locator(`#browseNav .browse-nav-btn[data-view^="${kind}:"]`).filter({
  has: page.locator(".browse-nav-label").getByText(name, { exact: true }),
});

async function openFolderMenu(page, id) {
  await openBrowse(page, `folder:${id}`);
  await page.locator(MORE).click();
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  return menu;
}

async function makeSetlistItem(page, id) {
  const menu = await openFolderMenu(page, id);
  return menu.getByRole("menuitem", { name: await uiText(page, "folder.makeSetlist"), exact: true });
}

/** The setlist's view in Browse library; its Make a folder button. */
async function makeFolderButton(page, setlistName) {
  await navNamed(page, "setlist", setlistName).click();
  await expect(viewTitle(page)).toHaveText(setlistName);
  return page.locator("#browseResults .browse-setlist-folder");
}

async function makeFolderFrom(page, setlistName) {
  await (await makeFolderButton(page, setlistName)).click();
}

/** The folder made is shown: its view's title and its row in the nav. */
async function expectFolderShown(page, name) {
  await expect(viewTitle(page)).toHaveText(name);
  await expect(navNamed(page, "folder", name)).toHaveAttribute("aria-current", "page");
}

async function storedFolders(page) {
  return (await readCatalogState(page)).folders;
}

test("a folder becomes a setlist: its songs, then its subfolders' at any depth, and the folder stays", async ({ page, request }) => {
  await openLibrary(page, [
    { ...UNSORTED, items: [], color: null },
    { ...REHEARSAL, items: [SIBLING_JOB_ID], color: null },
    { ...WARMUPS, items: [], color: null, parentId: REHEARSAL.id },
    { ...SCALES, items: [JOB_ID], color: null, parentId: WARMUPS.id },
    { ...TRASH, items: [], color: null },
  ]);
  await (await makeSetlistItem(page, REHEARSAL.id)).click();

  await expect.poll(() => namesAndSongs(request)).toEqual([[REHEARSAL.name, [SIBLING_JOB_ID, JOB_ID]]]);
  const [{ id }] = await serverSetlists(request);
  await expect(page.locator(`#browseNav [data-view="setlist:${id}"]`)).toHaveAttribute("aria-current", "page");
  await expect(viewTitle(page)).toHaveText(REHEARSAL.name);
  await expect(page.locator("#browseResults .setlist-song")).toHaveCount(2);

  const folders = await storedFolders(page);
  expect(folders.find((f) => f.id === REHEARSAL.id)?.items).toEqual([SIBLING_JOB_ID]);
  expect(folders.find((f) => f.id === SCALES.id)?.items).toEqual([JOB_ID]);
});

test("a taken setlist name gets a number, trimmed to fit", async ({ page, request }) => {
  await postSetlist(request, REHEARSAL.name);
  await postSetlist(request, `${REHEARSAL.name}${copySuffix(2)}`);
  await postSetlist(request, LONG_NAME);
  await openLibrary(page, [
    { ...UNSORTED, items: [], color: null },
    { ...REHEARSAL, items: [SIBLING_JOB_ID], color: null },
    { ...LONG, items: [JOB_ID], color: null },
    { ...TRASH, items: [], color: null },
  ]);

  await (await makeSetlistItem(page, REHEARSAL.id)).click();
  await expect.poll(() => lastSetlistName(request)).toBe(`${REHEARSAL.name}${copySuffix(3)}`);

  await (await makeSetlistItem(page, LONG.id)).click();
  const suffix = copySuffix(2);
  await expect.poll(() => lastSetlistName(request)).toBe(`${"L".repeat(SETLIST_NAME_MAX_CHARS - suffix.length)}${suffix}`);
  expect(await serverSetlists(request)).toHaveLength(5);
});

test("a name taken in another letter case counts as taken, for setlists and folders", async ({ page, request }) => {
  await postSetlist(request, REHEARSAL.name.toLowerCase());
  await postSetlist(request, RENAMED, [SIBLING_JOB_ID]);
  await openLibrary(page, [
    { ...UNSORTED, items: [], color: null },
    { ...REHEARSAL, items: [JOB_ID], color: null },
    { id: TAKEN_ID, name: RENAMED.toUpperCase(), items: [SIBLING_JOB_ID], color: null },
    { ...TRASH, items: [], color: null },
  ]);

  await (await makeSetlistItem(page, REHEARSAL.id)).click();
  await expect.poll(() => lastSetlistName(request)).toBe(`${REHEARSAL.name}${copySuffix(2)}`);

  await makeFolderFrom(page, RENAMED);
  await expectFolderShown(page, `${RENAMED}${copySuffix(2)}`);
});

test("a failed create says the save failed and makes nothing", async ({ page, request }) => {
  await page.route(`**${SETLISTS_PATH}`, function refuseCreate(route) {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: HTTP_NOT_FOUND, json: { detail: NOT_FOUND_DETAIL } });
  });
  await openLibrary(page, [
    { ...UNSORTED, items: [], color: null },
    { ...REHEARSAL, items: [JOB_ID, SIBLING_JOB_ID], color: null },
    { ...TRASH, items: [], color: null },
  ]);
  await (await makeSetlistItem(page, REHEARSAL.id)).click();

  await expect(page.locator("#setlistsError")).toHaveText(await uiText(page, "setlists.saveFailed"));
  await expect(page.locator('#browseNav [data-view^="setlist:"]')).toHaveCount(0);
  await expect(page.locator("#sidebarSetlists .sidebar-setlist")).toHaveCount(0);
  expect(await serverSetlists(request)).toEqual([]);
});

test("an empty folder or setlist cannot be converted, and Unsorted has no menu", async ({ page, request }) => {
  await postSetlist(request, EMPTY.name);
  await openLibrary(page, [
    { ...UNSORTED, items: [JOB_ID, SIBLING_JOB_ID], color: null },
    { ...EMPTY, items: [], color: null },
    { ...TRASH, items: [], color: null },
  ]);
  await expect(await makeSetlistItem(page, EMPTY.id)).toBeDisabled();
  await expect(page.locator("#browseResults .browse-make-setlist")).toBeDisabled();
  await page.keyboard.press("Escape");
  await openBrowse(page, `folder:${UNSORTED.id}`);
  await expect(page.locator(MORE)).toHaveCount(0);
  await expect(page.locator("#browseResults .browse-make-setlist")).toHaveCount(0);

  await expect(await makeFolderButton(page, EMPTY.name)).toBeDisabled();
  expect(await namesAndSongs(request)).toEqual([[EMPTY.name, []]]);
});

test("a folder with too many songs says so under its title, makes nothing, and the message goes once the folder changes", async ({ page, request }) => {
  const ids = Array.from({ length: SETLIST_MAX_SONGS + 1 }, (_, i) => fakeSongId(i));
  const tracks = { ...BOTH_TRACKS };
  for (const id of ids) tracks[id] = fixtureTrack(id, `Song ${id}`);
  await openLibrary(page, [
    { ...UNSORTED, items: [JOB_ID, SIBLING_JOB_ID], color: null },
    { ...REHEARSAL, items: ids, color: null },
    { ...TRASH, items: [], color: null },
  ], { tracks });

  await (await makeSetlistItem(page, REHEARSAL.id)).click();
  const error = page.locator("#browseResults .folder-error");
  const message = await uiText(page, "folder.tooManyForSetlist", { max: SETLIST_MAX_SONGS });
  await expect(error).toHaveText(message);
  await expect(page.locator(ANNOUNCE)).toHaveText(message);
  await expect(viewTitle(page)).toHaveText(REHEARSAL.name);
  expect(await serverSetlists(request)).toEqual([]);

  await navNamed(page, "folder", REHEARSAL.name).dblclick();
  await page.locator(".folder-editor-name").fill(RENAMED);
  await page.keyboard.press("Enter");
  await expect(viewTitle(page)).toHaveText(RENAMED);
  await expect(error).toHaveCount(0);
  await expect(page.locator(ANNOUNCE)).toHaveText("");
});

test("a setlist becomes a folder: its songs move in setlist order, and the setlist stays", async ({ page, request }) => {
  await postSetlist(request, GIG, [SIBLING_JOB_ID, JOB_ID]);
  await openLibrary(page, [
    { ...UNSORTED, items: [JOB_ID], color: null },
    { ...REHEARSAL, items: [SIBLING_JOB_ID], color: null },
    { ...TRASH, items: [], color: null },
  ]);
  await makeFolderFrom(page, GIG);

  await expectFolderShown(page, GIG_AS_FOLDER);
  const folders = await storedFolders(page);
  const made = folders.find((f) => f.name === GIG_AS_FOLDER);
  expect(made.items).toEqual([SIBLING_JOB_ID, JOB_ID]);
  expect(folders.find((f) => f.id === UNSORTED.id)?.items).toEqual([]);
  expect(folders.find((f) => f.id === REHEARSAL.id)?.items).toEqual([]);
  await expect(page.locator("#browseResults .cat-item")).toHaveCount(2);
  expect(await namesAndSongs(request)).toEqual([[GIG, [SIBLING_JOB_ID, JOB_ID]]]);
});

test("a trashed song stays in the Trash, a taken folder name gets a number, and a name with nothing left is New Folder", async ({ page, request }) => {
  await postSetlist(request, REHEARSAL.name, [JOB_ID, SIBLING_JOB_ID]);
  await postSetlist(request, NOTHING_VALID, [SIBLING_JOB_ID]);
  await openLibrary(page, [
    { ...UNSORTED, items: [SIBLING_JOB_ID], color: null },
    { ...REHEARSAL, items: [], color: null },
    { ...TRASH, items: [JOB_ID], color: null },
  ], { trashed: [JOB_ID] });
  const makeFolder = await makeFolderButton(page, REHEARSAL.name);
  await expect(page.locator(`#browseResults .setlist-song[data-id="${JOB_ID}"]`)).toHaveClass(/in-trash/);
  await makeFolder.click();

  const renamed = `${REHEARSAL.name}${copySuffix(2)}`;
  await expectFolderShown(page, renamed);
  let folders = await storedFolders(page);
  expect(folders.find((f) => f.name === renamed)?.items).toEqual([SIBLING_JOB_ID]);
  expect(folders.find((f) => f.id === TRASH.id)?.items).toEqual([JOB_ID]);

  await makeFolderFrom(page, NOTHING_VALID);
  const fallback = await uiText(page, "library.newFolder");
  await expectFolderShown(page, fallback);
  folders = await storedFolders(page);
  expect(folders.find((f) => f.name === fallback)?.items).toEqual([SIBLING_JOB_ID]);
});
