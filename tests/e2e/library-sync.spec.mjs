// Trash and re-imports across syncs. A reload stands in for the next focus or
// launch, since each of these only went wrong on the sync after the action.

import { test, expect } from "@playwright/test";

import {
  JOB_ID,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  SOURCE_URL,
  TRACK_TITLE,
  fixtureTrack,
  openStudio,
  readCatalogState,
  seedCatalogState,
  stubImportQueue,
  stubServerTrash,
  stubUpdateCheck,
} from "./helpers.mjs";

const ROCK = "f-rock";
const UNSORTED = "f-unsorted";
const TRASH = "trash";
const LIST_PATH = "/api/jobs";
const TRASH_PUSHED_KEY = "stemdeck.trash_pushed";
// What follows a list read is the reconcile and its render; a negative
// assertion made before them would pass on a page that never got the chance.
const SETTLE_MS = 500;
const SIBLING_URL = new RegExp(`/api/jobs/${SIBLING_JOB_ID}$`);
const HTTP_UNPROCESSABLE = 422;
const HTTP_CONFLICT = 409;
const GONE = "gone";
const OTHER_COPY_ID = "e2e0feedface";

const unavailable = (id, title) => ({ ...fixtureTrack(id, title), status: "unavailable" });

async function seed(page, { rock = [], unsorted = [], trash = [], tracks, trashPushed = true }) {
  await seedCatalogState(page, {
    folders: [
      { id: UNSORTED, name: "Unsorted", items: unsorted, color: null },
      { id: ROCK, name: "Rock", items: rock, color: null },
      { id: TRASH, name: "Trash", items: trash, color: null },
    ],
    tracks,
    trashPushed,
    seedOnce: true,
  });
  await stubUpdateCheck(page);
}

const folderItems = async (page, id) =>
  (await readCatalogState(page))?.folders?.find((f) => f.id === id)?.items ?? [];
const storedTrack = async (page, id) => (await readCatalogState(page))?.tracks?.[id];

/** Load or reload, and return once the startup sync has read the list and settled. */
async function synced(page, load) {
  const listRead = page.waitForResponse(
    (r) => new URL(r.url()).pathname === LIST_PATH && r.request().method() === "GET",
  );
  await load();
  await listRead;
  await page.waitForTimeout(SETTLE_MS);
}

const open = (page) => synced(page, () => page.goto("/", { waitUntil: "domcontentloaded" }));
const reopen = (page) => synced(page, () => page.reload({ waitUntil: "domcontentloaded" }));

const bothTracks = () => ({
  [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
  [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
});

async function trashRow(page, id) {
  const row = page.locator(`#catalogList .cat-item[data-id="${id}"]`).first();
  await row.hover();
  await row.locator(".cat-del").click();
}

/** Add an import to the library the way job.js does when one starts. */
async function startImport(page, fields) {
  await page.evaluate(async (track) => {
    const { addTrackToLibrary } = await import("/js/catalog.js");
    addTrackToLibrary({ status: "processing", stems: [], audioStems: [], ...track });
  }, fields);
}

test.describe("the Trash follows the server", () => {
  test("a song trashed on the phone moves into the Trash and stays there", async ({ page }) => {
    await seed(page, { unsorted: [JOB_ID, SIBLING_JOB_ID], tracks: bothTracks() });
    const server = await stubServerTrash(page, { trashed: [SIBLING_JOB_ID] });
    await open(page);
    await expect.poll(() => folderItems(page, TRASH)).toEqual([SIBLING_JOB_ID]);

    await reopen(page);
    expect(await folderItems(page, TRASH)).toEqual([SIBLING_JOB_ID]);
    expect(server.calls).toEqual([]);
  });

  test("a song restored elsewhere leaves the Trash", async ({ page }) => {
    await seed(page, { unsorted: [JOB_ID], trash: [SIBLING_JOB_ID], tracks: bothTracks() });
    const server = await stubServerTrash(page);
    await open(page);
    await expect.poll(() => folderItems(page, TRASH)).toEqual([]);
    expect(await folderItems(page, UNSORTED)).toContain(SIBLING_JOB_ID);
    expect(server.calls).toEqual([]);
  });

  test("an install from before the server kept a Trash pushes it up once", async ({ page }) => {
    await seed(page, { unsorted: [JOB_ID], trash: [SIBLING_JOB_ID], tracks: bothTracks(), trashPushed: false });
    const server = await stubServerTrash(page);
    await open(page);
    await expect.poll(() => server.calls).toEqual([{ id: SIBLING_JOB_ID, action: "trash" }]);
    expect(await page.evaluate((key) => localStorage.getItem(key), TRASH_PUSHED_KEY)).toBe("true");

    await reopen(page);
    expect(await folderItems(page, TRASH)).toEqual([SIBLING_JOB_ID]);
    expect(server.calls).toHaveLength(1);
  });

  test("a song trashed while offline stays trashed and reaches the server later", async ({ page }) => {
    await seed(page, { unsorted: [JOB_ID, SIBLING_JOB_ID], tracks: bothTracks() });
    const server = await stubServerTrash(page);
    server.offline = true;
    await open(page);
    await trashRow(page, SIBLING_JOB_ID);
    await expect.poll(() => folderItems(page, TRASH)).toEqual([SIBLING_JOB_ID]);
    await reopen(page);
    expect(await folderItems(page, TRASH)).toEqual([SIBLING_JOB_ID]);

    server.offline = false;
    await reopen(page);
    expect(await folderItems(page, TRASH)).toEqual([SIBLING_JOB_ID]);
    await expect.poll(() => server.calls).toEqual([{ id: SIBLING_JOB_ID, action: "trash" }]);

    await reopen(page);
    expect(await folderItems(page, TRASH)).toEqual([SIBLING_JOB_ID]);
  });

  test("a trash the server refuses gives way to the server's answer", async ({ page }) => {
    await seed(page, { unsorted: [JOB_ID, SIBLING_JOB_ID], tracks: bothTracks() });
    const server = await stubServerTrash(page);
    server.refuseWith = HTTP_UNPROCESSABLE;
    await open(page);
    await trashRow(page, SIBLING_JOB_ID);
    await expect.poll(() => folderItems(page, TRASH)).toEqual([SIBLING_JOB_ID]);

    await reopen(page);
    expect(await folderItems(page, TRASH)).toEqual([]);
    expect(await folderItems(page, UNSORTED)).toContain(SIBLING_JOB_ID);
  });
});

test.describe("two copies of one source", () => {
  test("stay two rows across syncs, each where it was", async ({ page }) => {
    await seed(page, { rock: [JOB_ID], tracks: { [JOB_ID]: unavailable(JOB_ID, TRACK_TITLE) } });
    const server = await stubServerTrash(page, { unavailable: [JOB_ID] });
    await open(page);
    await expect.poll(() => folderItems(page, UNSORTED)).toEqual([SIBLING_JOB_ID]);

    for (let sync = 0; sync < 2; sync++) {
      await reopen(page);
      expect(await folderItems(page, ROCK)).toEqual([JOB_ID]);
      expect(await folderItems(page, UNSORTED)).toEqual([SIBLING_JOB_ID]);
    }
    expect(server.calls).toEqual([]);
  });

  test("an import of the same link without `replaces` leaves the song alone", async ({ page }) => {
    await seed(page, { rock: [JOB_ID], tracks: { [JOB_ID]: unavailable(JOB_ID, TRACK_TITLE) } });
    await stubServerTrash(page, { unavailable: [JOB_ID], hidden: [SIBLING_JOB_ID] });
    await open(page);
    await startImport(page, { id: SIBLING_JOB_ID, title: TRACK_TITLE, sourceUrl: SOURCE_URL });
    await expect.poll(() => folderItems(page, UNSORTED)).toEqual([SIBLING_JOB_ID]);
    expect(await folderItems(page, ROCK)).toEqual([JOB_ID]);
  });

  test("a copy the phone re-imported takes the old one's place", async ({ page }) => {
    await seed(page, { rock: [JOB_ID], tracks: { [JOB_ID]: unavailable(JOB_ID, TRACK_TITLE) } });
    await stubServerTrash(page, { hidden: [JOB_ID], replaces: { [SIBLING_JOB_ID]: JOB_ID } });
    await open(page);
    await expect.poll(() => folderItems(page, ROCK)).toEqual([SIBLING_JOB_ID]);
    expect(await folderItems(page, UNSORTED)).toEqual([]);
  });
});

test.describe("a re-import in progress", () => {
  /**
   * JOB_ID is the unavailable song in Rock; SIBLING_JOB_ID is its re-import,
   * started in the page and reported by the server as `job.status`.
   */
  async function startReimport(page) {
    await seed(page, { rock: [JOB_ID], tracks: { [JOB_ID]: unavailable(JOB_ID, TRACK_TITLE) } });
    const server = await stubServerTrash(page, { unavailable: [JOB_ID], hidden: [SIBLING_JOB_ID] });
    const job = { status: "separating" };
    await page.route(SIBLING_URL, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      if (job.status === GONE) return route.fulfill({ status: 404, json: { detail: "job not found" } });
      const real = await (await route.fetch()).json();
      await route.fulfill({ json: job.status === "done" ? real : { ...real, status: job.status } });
    });
    await open(page);
    await startImport(page, { id: SIBLING_JOB_ID, title: TRACK_TITLE, sourceUrl: SOURCE_URL, replaces: JOB_ID });
    await expect.poll(() => folderItems(page, ROCK)).toEqual([SIBLING_JOB_ID]);
    return { server, job };
  }

  /** The new job finishes; `retire` is what the server did with the old one. */
  async function finish(page, { server, job }, retire) {
    job.status = "done";
    server.hidden.delete(SIBLING_JOB_ID);
    retire(server);
    await reopen(page);
  }

  test("keeps its place through a sync, then the old copy the server deleted is gone", async ({ page }) => {
    const reimport = await startReimport(page);
    await reopen(page);
    expect(await folderItems(page, ROCK)).toEqual([SIBLING_JOB_ID]);
    expect(await folderItems(page, TRASH)).toEqual([]);
    expect(await folderItems(page, UNSORTED)).toEqual([]);

    await finish(page, reimport, (server) => server.hidden.add(JOB_ID));
    expect(await folderItems(page, ROCK)).toEqual([SIBLING_JOB_ID]);
    expect(await folderItems(page, TRASH)).toEqual([]);
    expect((await storedTrack(page, SIBLING_JOB_ID)).replaced).toBeUndefined();
    expect(reimport.server.calls).toEqual([]);

    await reopen(page);
    expect(await folderItems(page, ROCK)).toEqual([SIBLING_JOB_ID]);
  });

  test("done, the old copy the server trashed shows in the Trash", async ({ page }) => {
    const reimport = await startReimport(page);
    await finish(page, reimport, (server) => server.trashed.add(JOB_ID));
    await expect.poll(() => folderItems(page, TRASH)).toEqual([JOB_ID]);
    expect(await folderItems(page, ROCK)).toEqual([SIBLING_JOB_ID]);
    expect(reimport.server.calls).toEqual([]);
  });

  test("failed, it puts the song back beside the failed row", async ({ page }) => {
    const { job } = await startReimport(page);
    job.status = "error";
    await reopen(page);
    await expect.poll(() => folderItems(page, ROCK)).toEqual([JOB_ID, SIBLING_JOB_ID]);
  });

  test("cancelled, it puts the song back where it was", async ({ page }) => {
    const queue = await stubImportQueue(page, SIBLING_JOB_ID);
    const { job } = await startReimport(page);
    await queue.run();
    job.status = "cancelled";
    await queue.settle();
    await expect.poll(() => folderItems(page, ROCK)).toEqual([JOB_ID]);
    expect(await storedTrack(page, SIBLING_JOB_ID)).toBeUndefined();

    await reopen(page);
    expect(await folderItems(page, ROCK)).toEqual([JOB_ID]);
    expect(await folderItems(page, UNSORTED)).toEqual([]);
  });

  test("cancelled while the app was closed, it puts the song back on the next launch", async ({ page }) => {
    const { job } = await startReimport(page);
    job.status = "cancelled";
    await reopen(page);
    await expect.poll(() => folderItems(page, ROCK)).toEqual([JOB_ID]);
    expect(await storedTrack(page, SIBLING_JOB_ID)).toBeUndefined();
  });

  test("gone from a restarted server, it puts the song back for good", async ({ page }) => {
    const { job } = await startReimport(page);
    job.status = GONE;
    await reopen(page);
    await expect.poll(() => folderItems(page, ROCK)).toEqual([JOB_ID]);
    expect(await storedTrack(page, SIBLING_JOB_ID)).toBeUndefined();

    await reopen(page);
    expect(await folderItems(page, ROCK)).toEqual([JOB_ID]);
    expect((await storedTrack(page, JOB_ID)).status).toBe("unavailable");
  });

  test("replaces the song it names, not another copy of the same link", async ({ page }) => {
    await seed(page, {
      unsorted: [OTHER_COPY_ID],
      rock: [JOB_ID],
      tracks: {
        [OTHER_COPY_ID]: unavailable(OTHER_COPY_ID, "Other copy"),
        [JOB_ID]: unavailable(JOB_ID, TRACK_TITLE),
      },
    });
    await stubServerTrash(page, { unavailable: [JOB_ID], hidden: [SIBLING_JOB_ID] });
    await open(page);
    await startImport(page, { id: SIBLING_JOB_ID, title: TRACK_TITLE, sourceUrl: SOURCE_URL, replaces: JOB_ID });
    await expect.poll(() => folderItems(page, ROCK)).toEqual([SIBLING_JOB_ID]);
    expect(await folderItems(page, UNSORTED)).toEqual([OTHER_COPY_ID]);
  });
});

test.describe("the re-import request", () => {
  const LINKED_ID = "e2e0abcdef01";
  const NEW_ID = "e2e0abcdef02";
  const LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

  /** An unavailable song from a link; opening it and confirming re-imports. Resolves to the POST bodies. */
  async function clickUnavailableLink(page, status) {
    await seed(page, {
      rock: [LINKED_ID],
      tracks: { [LINKED_ID]: { ...unavailable(LINKED_ID, "Linked"), sourceUrl: LINK } },
    });
    const posted = [];
    await page.route(/\/api\/jobs$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posted.push(route.request().postDataJSON());
      return route.fulfill({ status, json: status === 200 ? { job_id: NEW_ID } : { detail: "busy" } });
    });
    await open(page);
    await page.locator(`#catalogList .cat-item[data-id="${LINKED_ID}"]`).first().dblclick();
    await page.locator(".reimport-confirm .playlist-confirm-go").click();
    await expect.poll(() => posted.length).toBe(1);
    return posted;
  }

  test("names the job it replaces, and the new row takes its place", async ({ page }) => {
    const posted = await clickUnavailableLink(page, 200);
    expect(posted[0]).toMatchObject({ url: LINK, replaces: LINKED_ID });
    await expect.poll(() => folderItems(page, ROCK)).toEqual([NEW_ID]);
  });

  test("says so when the old copy is still importing, and changes nothing", async ({ page }) => {
    await clickUnavailableLink(page, HTTP_CONFLICT);
    await expect(page.locator("#error")).toContainText("still importing");
    expect(await folderItems(page, ROCK)).toEqual([LINKED_ID]);
  });
});

test.describe("a re-import from the import form", () => {
  const LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const SHORT_LINK = "https://youtu.be/dQw4w9WgXcQ";
  const linked = (id, title) => ({ ...fixtureTrack(id, title), sourceUrl: LINK });

  /** Submit `url` from the form; the server answers `status`, with SIBLING_JOB_ID on 200. Resolves to the POST bodies. */
  async function submitLink(page, url, status = 200) {
    const posted = [];
    await page.route(/\/api\/jobs$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posted.push(route.request().postDataJSON());
      return route.fulfill({ status, json: status === 200 ? { job_id: SIBLING_JOB_ID } : { detail: "busy" } });
    });
    await page.locator("#url").fill(url);
    await page.locator("#submit").click();
    await expect.poll(() => posted.length).toBe(1);
    return posted;
  }

  test("of a song already in the library leaves one row, in its folder", async ({ page }) => {
    await seed(page, { rock: [JOB_ID], tracks: { [JOB_ID]: linked(JOB_ID, TRACK_TITLE) } });
    const server = await stubServerTrash(page, { hidden: [SIBLING_JOB_ID] });
    await open(page);
    const posted = await submitLink(page, SHORT_LINK);
    expect(posted[0]).toMatchObject({ url: SHORT_LINK, replaces: JOB_ID });
    await expect.poll(() => folderItems(page, ROCK)).toEqual([SIBLING_JOB_ID]);

    server.hidden.delete(SIBLING_JOB_ID);
    server.trashed.add(JOB_ID);
    await reopen(page);
    await expect.poll(() => folderItems(page, TRASH)).toEqual([JOB_ID]);
    expect(await folderItems(page, ROCK)).toEqual([SIBLING_JOB_ID]);
    expect(await folderItems(page, UNSORTED)).toEqual([]);
  });

  test("refused because the old copy is still importing, says so and changes nothing", async ({ page }) => {
    await seed(page, { rock: [JOB_ID], tracks: { [JOB_ID]: linked(JOB_ID, TRACK_TITLE) } });
    await stubServerTrash(page, { hidden: [SIBLING_JOB_ID] });
    await open(page);
    const posted = await submitLink(page, LINK, HTTP_CONFLICT);
    expect(posted[0].replaces).toBe(JOB_ID);
    await expect(page.locator("#error")).toContainText("still importing");
    expect(await folderItems(page, ROCK)).toEqual([JOB_ID]);
    expect(await folderItems(page, UNSORTED)).toEqual([]);
    expect(await storedTrack(page, SIBLING_JOB_ID)).toBeUndefined();
  });

  test("of a link two songs share names neither", async ({ page }) => {
    await seed(page, {
      rock: [JOB_ID, OTHER_COPY_ID],
      tracks: { [JOB_ID]: linked(JOB_ID, TRACK_TITLE), [OTHER_COPY_ID]: linked(OTHER_COPY_ID, "Other copy") },
    });
    await stubServerTrash(page, { hidden: [SIBLING_JOB_ID] });
    await open(page);
    const posted = await submitLink(page, LINK);
    expect(posted[0].replaces).toBeUndefined();
    await expect.poll(() => folderItems(page, UNSORTED)).toEqual([SIBLING_JOB_ID]);
  });
});

test.describe("a favourite the server refuses", () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test("is taken back and reported", async ({ page }) => {
    await openStudio(page);
    await page.route("**/api/jobs/*/favorite", (route) => route.fulfill({ status: 500, json: { detail: "stubbed" } }));
    const row = page.locator(`#catalogList .cat-item[data-id="${SIBLING_JOB_ID}"]`).first();
    await row.hover();
    await row.locator(".cat-fav").click();

    await expect(row).not.toHaveClass(/\bis-fav\b/);
    expect((await readCatalogState(page)).tracks[SIBLING_JOB_ID].favorite).toBe(false);
    await page.locator("#notifBtn").click();
    await expect(page.locator(".daw-notif-error")).toContainText("Could not save the favorite");
  });
});
