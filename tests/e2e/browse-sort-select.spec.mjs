// Browse library's Sort, Filter, My order and Select: three scratch songs served by
// a stubbed job list, My order served by a stub of /api/library/order.

import { test, expect } from "@playwright/test";
import {
  BROWSE_RESULTS,
  JOB_LIST_URL,
  KEY,
  failureMessages,
  fixtureTrack,
  openBrowse,
  seedCatalogState,
  stubFavorites,
  stubServerTrash,
  stubUpdateCheck,
  uiText,
} from "./helpers.mjs";

const ALPHA = { id: "e2e0sort0001", title: "Alpha Song", bpm: 80, key: "A min", scale: "Minor", createdAt: 1700000300 };
const BRAVO = { id: "e2e0sort0002", title: "Bravo Song", bpm: 140, key: "C maj", scale: "Major", createdAt: 1700000200 };
const CHARLIE = { id: "e2e0sort0003", title: "Charlie Song", bpm: 110, key: "D min", scale: "Minor", createdAt: 1700000100 };
const SONGS = [ALPHA, BRAVO, CHARLIE];
const MY_ORDER_URL = "**/api/library/order";
const SINGLE_JOB_URL = /\/api\/jobs\/e2e0sort\d+$/;
const HTTP_SERVER_ERROR = 500;
const PICKED = /is-picked/;

const rows = (page) => page.locator(`${BROWSE_RESULTS} .cat-item[data-id]`);
const row = (page, song) => page.locator(`${BROWSE_RESULTS} .cat-item[data-id="${song.id}"]`);
const shownIds = (page) => rows(page).evaluateAll((els) => els.map((el) => el.dataset.id));
const idsOf = (...songs) => songs.map((song) => song.id);
const sortButton = (page) => page.locator("#librarySortBtn");
const filterButton = (page) => page.locator("#libraryFilterBtn");
const selectButton = (page) => page.locator("#librarySelectBtn");
const bulkBar = (page) => page.locator("#libraryBulkBar");

function jobFor(base, song, { trashed, favorites }) {
  return {
    ...base,
    job_id: song.id,
    title: song.title,
    user_title: null,
    source_url: `local:${song.title}`,
    created_at: song.createdAt,
    bpm: song.bpm,
    key: song.key,
    scale: song.scale,
    trashed_at: trashed.has(song.id) ? 1 : null,
    favorite: favorites[song.id] ?? null,
  };
}

async function serveSongs(page, server, favorites) {
  let base = null;
  const listed = () => SONGS.map((song) => jobFor(base, song, { trashed: server.trashed, favorites }));
  await page.route(JOB_LIST_URL, async (route) => {
    base ??= (await (await route.fetch()).json())[0];
    await route.fulfill({ json: listed() });
  });
  await page.route(SINGLE_JOB_URL, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    if (!base) return route.fulfill({ status: 404, json: {} });
    return route.fulfill({ json: listed().find((job) => job.job_id === id) });
  });
}

async function stubMyOrder(page, saved = []) {
  const order = { saved, puts: [], failNext: false };
  await page.route(MY_ORDER_URL, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { song_ids: order.saved } });
    const body = JSON.parse(route.request().postData() || "{}");
    order.puts.push(body.song_ids);
    if (order.failNext) {
      order.failNext = false;
      return route.fulfill({ status: HTTP_SERVER_ERROR, json: { detail: "stubbed" } });
    }
    order.saved = body.song_ids;
    return route.fulfill({ json: body });
  });
  return order;
}

async function openSongs(page, { trashed = [], favorite = [], view = "all" } = {}) {
  const ids = idsOf(...SONGS);
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: ids.filter((id) => !trashed.includes(id)), color: null },
      { id: "trash", name: "Trash", items: trashed, color: null },
    ],
    tracks: Object.fromEntries(SONGS.map((song) => [
      song.id,
      { ...fixtureTrack(song.id, song.title), ...song, favorite: favorite.includes(song.id) },
    ])),
    seedOnce: true,
  });
  const favorites = Object.fromEntries(favorite.map((id) => [id, true]));
  const favoriteWrites = await stubFavorites(page, favorites);
  await stubUpdateCheck(page);
  const server = await stubServerTrash(page, { trashed });
  await serveSongs(page, server, favorites);
  const order = await stubMyOrder(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openBrowse(page, view);
  return { server, order, favoriteWrites };
}

async function chooseSort(page, name) {
  await sortButton(page).click();
  await page.locator(".lib-menu").getByRole("menuitemradio", { name, exact: true }).click();
}

async function chooseFilter(page, name, role = "menuitemradio") {
  if (!(await page.locator(".lib-menu").isVisible())) await filterButton(page).click();
  await page.locator(".lib-menu").getByRole(role, { name, exact: true }).click();
}

async function pick(page, song, modifiers = []) {
  await row(page, song).locator(".cat-title").click({ modifiers });
}

test("the Sort menu orders the songs, and the choice comes back after a reload", async ({ page }) => {
  await openSongs(page);
  await expect.poll(() => shownIds(page)).toEqual(idsOf(ALPHA, BRAVO, CHARLIE));
  await chooseSort(page, await uiText(page, "libSort.title"));
  await expect.poll(() => shownIds(page)).toEqual(idsOf(CHARLIE, BRAVO, ALPHA));
  await chooseSort(page, await uiText(page, "libSort.ascending"));
  await expect.poll(() => shownIds(page)).toEqual(idsOf(ALPHA, BRAVO, CHARLIE));
  await expect(sortButton(page)).toHaveText(await uiText(page, "libSort.title"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await openBrowse(page, "all");
  await expect(sortButton(page)).toHaveText(await uiText(page, "libSort.title"));
  await expect.poll(() => shownIds(page)).toEqual(idsOf(ALPHA, BRAVO, CHARLIE));
  await chooseSort(page, await uiText(page, "inspector.tempo"));
  await expect.poll(() => shownIds(page)).toEqual(idsOf(ALPHA, CHARLIE, BRAVO));
});

test("Favorites sorts its songs too", async ({ page }) => {
  await openSongs(page, { favorite: idsOf(ALPHA, CHARLIE), view: "fav" });
  await chooseSort(page, await uiText(page, "libSort.title"));
  await expect.poll(() => shownIds(page)).toEqual(idsOf(CHARLIE, ALPHA));
});

test("a column head sorts by its column, and a second click flips the direction", async ({ page }) => {
  await openSongs(page);
  await page.locator("#browseListBtn").click();
  const tempo = page.locator(".browse-thead button.c-tempo");
  await expect(tempo).toHaveAttribute("title", await uiText(page, "libSort.sortByColumn", { column: await uiText(page, "lib.colTempo") }));
  await expect(page.locator(".browse-thead button.c-folder")).toHaveCount(0);
  await tempo.click();
  await expect(page.locator(".browse-thead button.c-tempo")).toHaveClass(/is-on/);
  await expect.poll(() => shownIds(page)).toEqual(idsOf(ALPHA, CHARLIE, BRAVO));
  await page.locator(".browse-thead button.c-tempo").click();
  await expect.poll(() => shownIds(page)).toEqual(idsOf(BRAVO, CHARLIE, ALPHA));
});

test("filters count on the button, keep the menu open, and Clear filters brings every song back", async ({ page }) => {
  await openSongs(page);
  await chooseFilter(page, await uiText(page, "libSort.tempoFast", { min: 130 }));
  await expect(page.locator(".lib-menu")).toBeVisible();
  await expect.poll(() => shownIds(page)).toEqual(idsOf(BRAVO));
  await expect(filterButton(page)).toHaveText(await uiText(page, "libSort.filterCount", { count: 1 }));
  await expect(filterButton(page)).toHaveAttribute("aria-pressed", "true");
  await chooseFilter(page, await uiText(page, "libSort.minorKeys"));
  await expect(rows(page)).toHaveCount(0);
  await page.keyboard.press(KEY.ESCAPE);
  await expect(page.locator("#browseLibrary")).toBeVisible();
  await page.locator(".library-clear-filters").click();
  await expect.poll(() => shownIds(page)).toEqual(idsOf(ALPHA, BRAVO, CHARLIE));
  await expect(filterButton(page)).toHaveText(await uiText(page, "libSort.filter"));
  await expect(filterButton(page)).toHaveAttribute("aria-pressed", "false");
});

test("the slow band keeps only songs under its tempo", async ({ page }) => {
  await openSongs(page);
  await chooseFilter(page, await uiText(page, "libSort.tempoSlow", { max: 90 }));
  await expect.poll(() => shownIds(page)).toEqual(idsOf(ALPHA));
});

test("Select picks a Shift range, then Favorite and Trash change every pick", async ({ page }) => {
  const { server, favoriteWrites } = await openSongs(page);
  await selectButton(page).click();
  await expect(selectButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(bulkBar(page)).toBeVisible();
  await pick(page, ALPHA);
  await pick(page, CHARLIE, ["Shift"]);
  await expect(bulkBar(page)).toContainText(await uiText(page, "libSort.selected.other", { count: 3 }));
  await expect(row(page, BRAVO)).toHaveClass(PICKED);
  await bulkBar(page).getByRole("button", { name: await uiText(page, "libSort.favorite") }).click();
  await expect.poll(() => favoriteWrites.map((write) => write.id).sort()).toEqual(idsOf(ALPHA, BRAVO, CHARLIE));
  await expect(bulkBar(page)).toBeHidden();
  await expect(selectButton(page)).toHaveAttribute("aria-pressed", "false");
  await selectButton(page).click();
  await pick(page, ALPHA);
  await pick(page, BRAVO, ["ControlOrMeta"]);
  await bulkBar(page).getByRole("button", { name: await uiText(page, "libSort.trash") }).click();
  await expect.poll(() => shownIds(page)).toEqual(idsOf(CHARLIE));
  expect(server.calls.filter((call) => call.action === "trash").map((call) => call.id)).toEqual(idsOf(ALPHA, BRAVO));
});

test("in the Trash, Select all and Restore bring every song back", async ({ page }) => {
  const { server } = await openSongs(page, { trashed: idsOf(ALPHA, BRAVO), view: "trash" });
  await selectButton(page).click();
  await bulkBar(page).getByRole("button", { name: await uiText(page, "libSort.selectAll") }).click();
  await expect(bulkBar(page).locator("button[data-bulk]")).toHaveText([
    await uiText(page, "libSort.selectAll"),
    await uiText(page, "libSort.restore"),
    await uiText(page, "settings.done"),
  ]);
  await bulkBar(page).getByRole("button", { name: await uiText(page, "libSort.restore") }).click();
  await expect(rows(page)).toHaveCount(0);
  expect(server.calls.filter((call) => call.action === "restore").map((call) => call.id).sort()).toEqual(idsOf(ALPHA, BRAVO));
  await expect(sortButton(page)).toBeHidden();
});

test("Esc leaves Select without closing Browse library; a Ctrl click starts picking", async ({ page }) => {
  await openSongs(page);
  await pick(page, BRAVO, ["ControlOrMeta"]);
  await expect(bulkBar(page)).toBeVisible();
  await expect(row(page, BRAVO)).toHaveClass(PICKED);
  await page.keyboard.press(KEY.ESCAPE);
  await expect(bulkBar(page)).toBeHidden();
  await expect(page.locator("#browseLibrary")).toBeVisible();
  await expect(row(page, BRAVO)).not.toHaveClass(PICKED);
  await page.keyboard.press(KEY.ESCAPE);
  await expect(page.locator("#browseLibrary")).toBeHidden();
});

test("My order: a drop saves the whole order, and a failed save puts the order back", async ({ page }) => {
  const { order } = await openSongs(page);
  await chooseSort(page, await uiText(page, "libSort.myOrder"));
  await expect(page.locator(".library-hint")).toHaveText(await uiText(page, "libSort.myOrderHint"));
  await row(page, CHARLIE).dragTo(row(page, ALPHA));
  await expect.poll(() => order.puts.at(-1)).toEqual(idsOf(CHARLIE, ALPHA, BRAVO));
  await expect.poll(() => shownIds(page)).toEqual(idsOf(CHARLIE, ALPHA, BRAVO));
  order.failNext = true;
  await row(page, BRAVO).dragTo(row(page, CHARLIE));
  await expect.poll(() => order.puts.length).toBe(2);
  await expect.poll(() => shownIds(page)).toEqual(idsOf(CHARLIE, ALPHA, BRAVO));
  await expect.poll(() => failureMessages(page)).toContain(await uiText(page, "libSort.myOrderSaveFailed"));
});
