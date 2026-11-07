// A band saved for a track lives on the server. Every job read and PATCH is stubbed,
// so the fixture job shared by the run keeps no saved band. A reload is the next boot.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  SOURCE_URL,
  fixtureTrack,
  readCatalogState,
  seedCatalogState,
  stubAudioTags,
  stubExportEndpoints,
  stubUpdateCheck,
} from "./helpers.mjs";

// Wide enough for the now-playing card, which the bar hides below 1460px.
test.use({ viewport: { width: 1600, height: 900 } });

const WIKIMEDIA = /^https:\/\/([a-z]+\.wikipedia\.org|www\.wikidata\.org|query\.wikidata\.org)\//;
const JOB_URL = /\/api\/jobs\/[a-z0-9]+$/;
const JOB_LIST_URL = /\/api\/jobs\?trashed=include$/;
const FLAG_KEY = "stemdeck.bands_uploaded";
const HELD_KEY = "stemdeck.held_bands";
const CATALOG_MODULE = "/js/catalog.js";
const UNKNOWN_JOB_ID = "e2e000000404";

// artistInfo.js waits this long after a track opens before looking the band up.
const PAST_THE_WAIT_MS = 2000;
const SECOND_PATCH_WOULD_HAVE_LEFT_MS = 250;

const JAY_CHOU_TAG = "周杰倫";

const PICKED = { id: "Q162586", name: "Dream Theater", englishName: "Dream Theater" };
const EARLIER = { id: "Q1", name: "Earlier Band", englishName: "Earlier Band" };
const FOUND = { id: "Q2", name: "Found Band", englishName: "Found Band" };
const SAVED = { id: "Q3", name: "Saved Band", englishName: "Saved Band" };

const ANSWERS = {
  search: { search: [{ id: PICKED.id }] },
  entities: {
    entities: {
      [PICKED.id]: {
        id: PICKED.id,
        labels: { en: { value: PICKED.name } },
        descriptions: { en: { value: "American progressive metal band" } },
        sitelinks: {
          enwiki: { site: "enwiki", title: PICKED.name, url: "https://en.wikipedia.org/wiki/Dream_Theater" },
        },
        claims: { P434: [{}] },
      },
    },
  },
  members: { entities: {} },
  sparql: { results: { bindings: [] } },
  extract: { query: { pages: [{ extract: "Lead.\n== History ==\nIn 1985, three Berklee students formed a band." }] } },
};

/** Set `offline` to fail every lookup and `noMatch` to find nobody; `asked` records the URLs. */
async function stubWikimedia(page) {
  const wikimedia = { asked: [], offline: false, noMatch: false };
  await page.route(WIKIMEDIA, async (route) => {
    const url = new URL(route.request().url());
    wikimedia.asked.push(url.toString());
    if (wikimedia.offline) return route.abort();
    const kind =
      url.host === "query.wikidata.org" ? "sparql"
      : url.host.endsWith("wikipedia.org") ? "extract"
      : url.searchParams.get("action") === "wbsearchentities" ? "search"
      : url.searchParams.get("props") === "labels" ? "members"
      : "entities";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(wikimedia.noMatch && kind === "search" ? { search: [] } : ANSWERS[kind]),
    });
  });
  return wikimedia;
}

const json = (status, body) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const untilPageGone = (handler) => async (route) => {
  try {
    await handler(route);
  } catch {
    // The page went away while the answer was out.
  }
};

/**
 * A server holding bands per job: `bands` is { jobId: { artist, user_band } },
 * `listed` the jobs GET /api/jobs names. Set `server.patchStatus` to fail a save,
 * `server.listStatus` to fail the list, and `server.hold` to a promise to keep
 * PATCH answers back.
 */
async function stubServer(page, { bands = {}, listed = [JOB_ID] } = {}) {
  const server = { patches: [], patchStatus: 200, listStatus: 200, hold: null };
  const withBand = (state) => ({ user_band: null, artist: null, ...state, ...bands[state.job_id] });

  await page.route(JOB_LIST_URL, untilPageGone(async (route) => {
    if (server.listStatus !== 200) return route.fulfill(json(server.listStatus, { detail: "stubbed" }));
    const real = await (await route.fetch()).json();
    await route.fulfill(json(200, real.filter((state) => listed.includes(state.job_id)).map(withBand)));
  }));
  await page.route(JOB_URL, untilPageGone(async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      const answer = await route.fetch();
      if (!answer.ok()) return route.fulfill({ response: answer });
      return route.fulfill(json(200, withBand(await answer.json())));
    }
    if (request.method() !== "PATCH") return route.fallback();
    const id = new URL(request.url()).pathname.split("/").pop();
    const { band } = request.postDataJSON();
    server.patches.push({ id, band });
    if (server.hold) await server.hold;
    if (server.patchStatus !== 200) return route.fulfill(json(server.patchStatus, { detail: "stubbed" }));
    bands[id] = { artist: band, user_band: band };
    const real = await (await page.request.get(`/api/jobs/${JOB_ID}`)).json();
    await route.fulfill(json(200, withBand({ ...real, job_id: id })));
  }));
  return server;
}

const libraryTrack = (id, fields = {}) => ({
  ...fixtureTrack(id, `Track ${id}`),
  audioTagsChecked: true,
  workChecked: true,
  ...fields,
});

/** Boot with `tracks` in the store. `flagSet: false` is a browser still owing its upload. */
async function bootWith(page, tracks, { trashed = [], flagSet = true } = {}) {
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: Object.keys(tracks).filter((id) => !trashed.includes(id)), color: null },
      { id: "trash", name: "Trash", items: trashed, color: null },
    ],
    tracks,
    bandsUploaded: flagSet,
  });
  await boot(page);
}

async function boot(page) {
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  await stubAudioTags(page, null);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(".cat-item").first().waitFor({ timeout: 20000 });
}

async function reboot(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".cat-item").first().waitFor({ timeout: 20000 });
}

async function openTrack(page, id = JOB_ID) {
  await page.locator(`.cat-item[data-id="${id}"]`).first().click();
  await expect(page.locator(".app")).not.toHaveClass(/no-track/, { timeout: 15000 });
}

/** Call an export of the page's own catalog module. */
function callCatalog(page, name, ...args) {
  return page.evaluate(
    async ([path, fn, fnArgs]) => {
      const catalog = await import(new URL(path, location.href).href);
      return catalog[fn](...fnArgs);
    },
    [CATALOG_MODULE, name, args],
  );
}

const uploadFlag = (page) => page.evaluate((key) => window.localStorage.getItem(key), FLAG_KEY);
const savedArtist = async (page, id = JOB_ID) => (await readCatalogState(page))?.tracks?.[id]?.artist ?? null;
const heldBands = (page) => page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) || "{}"), HELD_KEY);
const uploadFinished = (page) => expect.poll(() => uploadFlag(page), { timeout: 15000 }).toBe("true");
const patchCount = (page, server, count) => expect.poll(() => server.patches.length, { timeout: 15000 }).toBe(count);

test.describe("saving a band for a track", () => {
  async function pickInBox(page) {
    await page.locator("#np-details-btn").click();
    await page.locator("#artistQuery").fill(PICKED.name);
    await page.locator("#artistQuery").press("Enter");
    const save = page.locator(".artist-save");
    await expect(save).toHaveText("Save for this track");
    await save.click();
    return save;
  }

  test("the button sends the band to the server and says Saved once it answered", async ({ page }) => {
    await stubWikimedia(page);
    const server = await stubServer(page);
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID) });
    await openTrack(page);

    const save = await pickInBox(page);

    await expect(save).toHaveText("Saved for this track");
    await expect(save).toBeDisabled();
    expect(server.patches).toEqual([{ id: JOB_ID, band: PICKED }]);
    await expect(page.locator("#np-artist")).toHaveText(PICKED.name);
    expect(await savedArtist(page)).toEqual(PICKED);
  });

  test("a refused save rolls back, says so, and the button never reads Saved", async ({ page }) => {
    await stubWikimedia(page);
    const server = await stubServer(page);
    server.patchStatus = 500;
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID) });
    await openTrack(page);

    const save = await pickInBox(page);

    await expect(page.locator("#notifBadge")).not.toHaveClass(/hidden/);
    await expect(save).toHaveText("Save for this track");
    await expect(save).toBeEnabled();
    await expect(page.locator("#np-artist")).toBeHidden();
    expect(await savedArtist(page)).toBeNull();
  });

  test("a refused save restores the earlier band and names it in the notifications", async ({ page }) => {
    const server = await stubServer(page);
    server.patchStatus = 500;
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) });
    await openTrack(page);

    expect(await callCatalog(page, "setCurrentTrackArtist", PICKED)).toBe(false);

    await expect(page.locator("#np-artist")).toHaveText(EARLIER.name);
    expect(await savedArtist(page)).toEqual(EARLIER);
    await page.locator("#notifBtn").click();
    await expect(page.locator(".daw-notif-error")).toContainText("Band not saved");
  });

  test("two refused picks go back to the band before the first, not to the first", async ({ page }) => {
    const server = await stubServer(page);
    let release;
    server.hold = new Promise((resolve) => { release = resolve; });
    server.patchStatus = 500;
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) });
    await openTrack(page);

    const first = callCatalog(page, "setCurrentTrackArtist", PICKED);
    const second = callCatalog(page, "setCurrentTrackArtist", SAVED);
    await expect.poll(() => server.patches.length).toBe(2);
    release();

    expect(await first).toBe(false);
    expect(await second).toBe(false);
    await expect(page.locator("#np-artist")).toHaveText(EARLIER.name);
    expect(await savedArtist(page)).toEqual(EARLIER);
  });

  test("a late answer lands on the track it was for, not the one open by then", async ({ page }) => {
    const server = await stubServer(page, { listed: [JOB_ID, SIBLING_JOB_ID] });
    let release;
    server.hold = new Promise((resolve) => { release = resolve; });
    server.patchStatus = 500;
    await bootWith(page, {
      [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }),
      [SIBLING_JOB_ID]: libraryTrack(SIBLING_JOB_ID, { artist: SAVED }),
    });
    await openTrack(page);

    const saving = callCatalog(page, "setCurrentTrackArtist", PICKED);
    await expect.poll(() => server.patches.length).toBe(1);
    await openTrack(page, SIBLING_JOB_ID);
    await expect(page.locator("#np-artist")).toHaveText(SAVED.name, { timeout: 15000 });
    release();

    expect(await saving).toBe(false);
    await expect.poll(() => savedArtist(page)).toEqual(EARLIER);
    expect(await savedArtist(page, SIBLING_JOB_ID)).toEqual(SAVED);
    await expect(page.locator("#np-artist")).toHaveText(SAVED.name);
  });

  test("an invalid id is refused and sends nothing", async ({ page }) => {
    const server = await stubServer(page);
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID) });
    await openTrack(page);

    expect(await callCatalog(page, "setCurrentTrackArtist", { id: "not-an-item", name: "Nope" })).toBe(false);

    expect(server.patches).toEqual([]);
    expect(await savedArtist(page)).toBeNull();
  });

  test("a band guessed from the file's tags stays local", async ({ page }) => {
    await stubWikimedia(page);
    const server = await stubServer(page);
    await bootWith(page, {
      [JOB_ID]: libraryTrack(JOB_ID, { audioTags: { artist: PICKED.name, title: "Metropolis Pt. 1" } }),
    });
    await openTrack(page);

    await expect.poll(() => savedArtist(page), { timeout: 15000 }).toEqual(PICKED);
    await page.waitForTimeout(PAST_THE_WAIT_MS);
    expect(server.patches).toEqual([]);
  });
});

test.describe("the server's band against the browser's", () => {
  test("a band saved on the server beats the browser's, in the store and on the card", async ({ page }) => {
    await stubServer(page, { bands: { [JOB_ID]: { artist: SAVED, user_band: SAVED } } });
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) });

    await expect.poll(() => savedArtist(page), { timeout: 15000 }).toEqual(SAVED);
    await openTrack(page);
    await expect(page.locator("#np-artist")).toHaveText(SAVED.name);
  });

  test("a found band beats the browser's once the upload has finished", async ({ page }) => {
    await stubServer(page, { bands: { [JOB_ID]: { artist: FOUND } } });
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) });

    await expect.poll(() => savedArtist(page), { timeout: 15000 }).toEqual(FOUND);
  });

  test("a state with no band keeps the local one", async ({ page }) => {
    await stubServer(page);
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) });
    await openTrack(page);

    await expect(page.locator("#np-artist")).toHaveText(EARLIER.name);
    expect(await savedArtist(page)).toEqual(EARLIER);
  });

  test("a fresh browser shows the saved band in the library and on the card", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    await stubServer(page, { bands: { [JOB_ID]: { artist: SAVED, user_band: SAVED } }, listed: [JOB_ID] });
    await boot(page);

    const row = page.locator(`.cat-item[data-id="${JOB_ID}"]`).first();
    await expect(row).toContainText(SAVED.name);
    await openTrack(page);
    await expect(page.locator("#np-artist")).toHaveText(SAVED.name);
    await context.close();
  });
});

test.describe("re-importing a track's source", () => {
  const reimport = { id: SIBLING_JOB_ID, title: "Re-imported", status: "queued", stems: [], sourceUrl: SOURCE_URL };

  test("a band saved on the server goes to the new job", async ({ page }) => {
    const server = await stubServer(page, { bands: { [JOB_ID]: { artist: SAVED, user_band: SAVED } }, listed: [JOB_ID] });
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) });
    await expect.poll(() => savedArtist(page), { timeout: 15000 }).toEqual(SAVED);

    const answered = page.waitForResponse((response) => response.request().method() === "PATCH");
    await callCatalog(page, "addTrackToLibrary", reimport);
    await answered;

    expect(server.patches).toEqual([{ id: SIBLING_JOB_ID, band: SAVED }]);
    await expect.poll(() => savedArtist(page, SIBLING_JOB_ID)).toEqual(SAVED);
  });

  test("a guess is not sent to the new job", async ({ page }) => {
    const server = await stubServer(page, { bands: { [JOB_ID]: { artist: FOUND } }, listed: [JOB_ID] });
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) });
    await expect.poll(() => savedArtist(page), { timeout: 15000 }).toEqual(FOUND);

    await callCatalog(page, "addTrackToLibrary", reimport);

    await page.waitForTimeout(SECOND_PATCH_WOULD_HAVE_LEFT_MS);
    expect(server.patches).toEqual([]);
  });
});

test.describe("holding local bands until the upload has finished", () => {
  const renamedState = {
    job_id: JOB_ID,
    title: "Track",
    user_artist: "New Artist",
    artist: null,
    user_band: null,
  };

  test("a found band cannot replace a pick a failed upload still owes, and the next boot sends it", async ({ page }) => {
    const server = await stubServer(page, { bands: { [JOB_ID]: { artist: FOUND } } });
    server.patchStatus = 500;
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) }, { flagSet: false });
    await patchCount(page, server, 1);
    await openTrack(page);

    await expect(page.locator("#np-artist")).toHaveText(EARLIER.name);
    expect(await savedArtist(page)).toEqual(EARLIER);

    server.patchStatus = 200;
    await reboot(page);
    await uploadFinished(page);
    expect(server.patches).toEqual([{ id: JOB_ID, band: EARLIER }, { id: JOB_ID, band: EARLIER }]);
  });

  for (const flagSet of [false, true]) {
    test(`an artist rename clears a local band, with the upload ${flagSet ? "finished" : "owed"}`, async ({ page }) => {
      const server = await stubServer(page);
      server.patchStatus = 500;
      await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) }, { flagSet });
      if (!flagSet) await patchCount(page, server, 1);

      await callCatalog(page, "applyRenamedState", JOB_ID, renamedState);

      await expect.poll(() => savedArtist(page)).toBeNull();
    });
  }

  test("a title rename's answer leaves the band alone", async ({ page }) => {
    await stubServer(page);
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) });

    await callCatalog(page, "applyRenamedState", JOB_ID, { ...renamedState, title: "New Title", user_artist: null });

    expect(await savedArtist(page)).toEqual(EARLIER);
  });
});

test.describe("a band the upload left unsent", () => {
  const guessedTrack = (id = JOB_ID) => libraryTrack(id, { artist: EARLIER, audioTags: { artist: EARLIER.name } });
  const heldEntry = { band: EARLIER, tagName: EARLIER.name };

  /** Boot a browser owing its upload, so the guess lands on the held list the real way. */
  async function bootHolding(page, bands = {}) {
    const server = await stubServer(page, { bands });
    await bootWith(page, { [JOB_ID]: guessedTrack() }, { flagSet: false });
    await uploadFinished(page);
    expect(await heldBands(page)).toEqual({ [JOB_ID]: heldEntry });
    return server;
  }

  const showsBand = async (page, band) => {
    await openTrack(page);
    await expect(page.locator("#np-artist")).toHaveText(band.name);
    expect(await savedArtist(page)).toEqual(band);
  };

  test("survives a differing found band across reloads and becomes saved", async ({ page }) => {
    const bands = {};
    const server = await bootHolding(page, bands);

    bands[JOB_ID] = { artist: FOUND };
    await reboot(page);
    await patchCount(page, server, 1);

    expect(server.patches).toEqual([{ id: JOB_ID, band: EARLIER }]);
    await expect.poll(() => heldBands(page)).toEqual({});
    await showsBand(page, EARLIER);

    await reboot(page);
    await page.waitForTimeout(SECOND_PATCH_WOULD_HAVE_LEFT_MS);
    expect(server.patches.length, "saved, so not sent again").toBe(1);
    await showsBand(page, EARLIER);
  });

  test("equal to the found band at upload is protected from a later different one", async ({ page }) => {
    const bands = { [JOB_ID]: { artist: EARLIER } };
    const server = await stubServer(page, { bands });
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) }, { flagSet: false });
    await uploadFinished(page);
    expect(server.patches).toEqual([]);
    expect(await heldBands(page)).toEqual({ [JOB_ID]: { band: EARLIER, tagName: "" } });

    bands[JOB_ID] = { artist: FOUND };
    await reboot(page);
    await patchCount(page, server, 1);

    expect(server.patches).toEqual([{ id: JOB_ID, band: EARLIER }]);
    await showsBand(page, EARLIER);
  });

  test("stays held and unsent while the server finds nothing or the same band", async ({ page }) => {
    const bands = {};
    const server = await bootHolding(page, bands);

    await reboot(page);
    await page.waitForTimeout(SECOND_PATCH_WOULD_HAVE_LEFT_MS);
    bands[JOB_ID] = { artist: EARLIER };
    await reboot(page);
    await page.waitForTimeout(SECOND_PATCH_WOULD_HAVE_LEFT_MS);

    expect(server.patches).toEqual([]);
    expect(await heldBands(page)).toEqual({ [JOB_ID]: heldEntry });
  });

  test("a refused save keeps it on show and on the list, and a later state retries", async ({ page }) => {
    const bands = {};
    const server = await bootHolding(page, bands);

    bands[JOB_ID] = { artist: FOUND };
    server.patchStatus = 500;
    await reboot(page);
    await patchCount(page, server, 1);
    await page.waitForTimeout(SECOND_PATCH_WOULD_HAVE_LEFT_MS);

    expect(await heldBands(page)).toEqual({ [JOB_ID]: heldEntry });
    await expect(page.locator("#notifBadge")).toHaveClass(/hidden/);
    await showsBand(page, EARLIER);

    server.patchStatus = 200;
    await reboot(page);
    await expect.poll(() => heldBands(page), { timeout: 15000 }).toEqual({});
    expect(new Set(server.patches.map(({ band }) => band.id))).toEqual(new Set([EARLIER.id]));
    await showsBand(page, EARLIER);
  });

  test("a 404 on the save counts as done", async ({ page }) => {
    const bands = {};
    const server = await bootHolding(page, bands);

    bands[JOB_ID] = { artist: FOUND };
    server.patchStatus = 404;
    await reboot(page);
    await patchCount(page, server, 1);

    await expect.poll(() => heldBands(page)).toEqual({});
  });

  test("a band saved on the server drops it and wins, unsent", async ({ page }) => {
    const bands = {};
    const server = await bootHolding(page, bands);

    bands[JOB_ID] = { artist: SAVED, user_band: SAVED };
    await reboot(page);

    await expect.poll(() => heldBands(page), { timeout: 15000 }).toEqual({});
    expect(server.patches).toEqual([]);
    await showsBand(page, SAVED);
  });

  test("negative control: an artist rename here drops it, and the server's band wins", async ({ page }) => {
    const bands = {};
    const server = await bootHolding(page, bands);

    const renamed = { job_id: JOB_ID, title: "Track", user_artist: "New Artist", artist: null, user_band: null };
    await callCatalog(page, "applyRenamedState", JOB_ID, renamed);
    expect(await heldBands(page)).toEqual({});
    expect(await savedArtist(page)).toBeNull();

    bands[JOB_ID] = { artist: FOUND, user_artist: "New Artist" };
    await reboot(page);

    await expect.poll(() => savedArtist(page), { timeout: 15000 }).toEqual(FOUND);
    expect(server.patches).toEqual([]);
  });

  test("negative control: a rename elsewhere, seen in a state, drops it too", async ({ page }) => {
    const bands = {};
    const server = await bootHolding(page, bands);

    bands[JOB_ID] = { artist: FOUND, user_artist: "New Artist" };
    await reboot(page);

    await expect.poll(() => heldBands(page), { timeout: 15000 }).toEqual({});
    await expect.poll(() => savedArtist(page)).toEqual(FOUND);
    expect(server.patches).toEqual([]);
  });

  test("an artist rename leaving the tag name the same drops it too", async ({ page }) => {
    await bootHolding(page);

    const renamed = { job_id: JOB_ID, title: "Track", user_artist: `${EARLIER.name} feat. Guest`, artist: null, user_band: null };
    await callCatalog(page, "applyRenamedState", JOB_ID, renamed);

    expect(await heldBands(page)).toEqual({});
  });

  test("saving in the artist box drops it", async ({ page }) => {
    const server = await bootHolding(page);
    await openTrack(page);

    expect(await callCatalog(page, "setCurrentTrackArtist", PICKED)).toBe(true);

    expect(await heldBands(page)).toEqual({});
    expect(server.patches).toEqual([{ id: JOB_ID, band: PICKED }]);
    await showsBand(page, PICKED);
  });

  test("a refused save in the artist box keeps it", async ({ page }) => {
    const server = await bootHolding(page);
    server.patchStatus = 500;
    await openTrack(page);

    expect(await callCatalog(page, "setCurrentTrackArtist", PICKED)).toBe(false);

    expect(await heldBands(page)).toEqual({ [JOB_ID]: heldEntry });
    await showsBand(page, EARLIER);
  });

  test("deleting the track drops it", async ({ page }) => {
    await stubServer(page, { listed: [JOB_ID, SIBLING_JOB_ID] });
    await page.route(JOB_URL, untilPageGone(async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      await route.fulfill(json(200, {}));
    }));
    await bootWith(
      page,
      { [JOB_ID]: libraryTrack(JOB_ID), [SIBLING_JOB_ID]: guessedTrack(SIBLING_JOB_ID) },
      { trashed: [SIBLING_JOB_ID], flagSet: false },
    );
    await uploadFinished(page);
    expect(await heldBands(page)).toEqual({ [SIBLING_JOB_ID]: heldEntry });

    await page.locator(".rail-trash").click();
    await page.locator("#clearBinBtn").click();

    await expect.poll(() => heldBands(page)).toEqual({});
  });

  test("a re-import moves it to the new job, and a found band there cannot replace it", async ({ page }) => {
    const bands = {};
    const server = await bootHolding(page, bands);

    await callCatalog(page, "addTrackToLibrary", {
      id: SIBLING_JOB_ID,
      title: "Re-imported",
      status: "queued",
      stems: [],
      sourceUrl: SOURCE_URL,
    });

    expect(await heldBands(page)).toEqual({ [SIBLING_JOB_ID]: heldEntry });
    expect(await savedArtist(page, SIBLING_JOB_ID)).toEqual(EARLIER);
    expect(server.patches).toEqual([]);

    await callCatalog(page, "addTrackToLibrary", {
      id: SIBLING_JOB_ID,
      title: "Re-imported",
      status: "done",
      stems: [],
      sourceUrl: SOURCE_URL,
      artist: FOUND,
    });
    await expect.poll(() => savedArtist(page, SIBLING_JOB_ID)).toEqual(EARLIER);
  });
});

test.describe("uploading the browser's bands at boot", () => {
  test("a track with no tag can hold no guess: sent once, one at a time, trashed too, and not again", async ({ page }) => {
    const wikimedia = await stubWikimedia(page);
    const server = await stubServer(page, { listed: [JOB_ID, SIBLING_JOB_ID] });
    let release;
    server.hold = new Promise((resolve) => { release = resolve; });
    await bootWith(
      page,
      {
        [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }),
        [SIBLING_JOB_ID]: libraryTrack(SIBLING_JOB_ID, { artist: SAVED }),
      },
      { trashed: [SIBLING_JOB_ID], flagSet: false },
    );

    await patchCount(page, server, 1);
    await page.waitForTimeout(SECOND_PATCH_WOULD_HAVE_LEFT_MS);
    expect(server.patches.length, "the second waits for the first").toBe(1);
    expect(await uploadFlag(page)).toBeNull();
    release();
    await uploadFinished(page);

    expect(server.patches).toEqual([
      { id: JOB_ID, band: EARLIER },
      { id: SIBLING_JOB_ID, band: SAVED },
    ]);
    expect(wikimedia.asked).toEqual([]);

    await reboot(page);
    await page.waitForTimeout(SECOND_PATCH_WOULD_HAVE_LEFT_MS);
    expect(server.patches.length, "the flag stops a second run").toBe(2);
  });

  test("a band matching the tag is a guess: skipped unasked, and held", async ({ page }) => {
    const wikimedia = await stubWikimedia(page);
    const server = await stubServer(page);
    await bootWith(
      page,
      { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER, audioTags: { artist: EARLIER.name } }) },
      { flagSet: false },
    );

    await uploadFinished(page);
    expect(server.patches).toEqual([]);
    expect(wikimedia.asked).toEqual([]);
    expect(await heldBands(page)).toEqual({ [JOB_ID]: { band: EARLIER, tagName: EARLIER.name } });
  });

  test("a lookup answering the track's own id is a guess, whatever the tag's script", async ({ page }) => {
    const wikimedia = await stubWikimedia(page);
    const server = await stubServer(page);
    const jayChou = { id: PICKED.id, name: "Jay Chou", englishName: "Jay Chou" };
    await bootWith(
      page,
      { [JOB_ID]: libraryTrack(JOB_ID, { artist: jayChou, audioTags: { artist: JAY_CHOU_TAG } }) },
      { flagSet: false },
    );

    await uploadFinished(page);
    expect(wikimedia.asked.length).toBeGreaterThan(0);
    expect(server.patches).toEqual([]);
    expect(await savedArtist(page)).toEqual(jayChou);
  });

  test("a lookup answering another id means a pick: sent", async ({ page }) => {
    await stubWikimedia(page);
    const server = await stubServer(page);
    await bootWith(
      page,
      { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER, audioTags: { artist: PICKED.name } }) },
      { flagSet: false },
    );

    await uploadFinished(page);
    expect(server.patches).toEqual([{ id: JOB_ID, band: EARLIER }]);
  });

  test("a lookup finding nobody means a pick: sent", async ({ page }) => {
    const wikimedia = await stubWikimedia(page);
    wikimedia.noMatch = true;
    const server = await stubServer(page);
    await bootWith(
      page,
      { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER, audioTags: { artist: PICKED.name } }) },
      { flagSet: false },
    );

    await uploadFinished(page);
    expect(server.patches).toEqual([{ id: JOB_ID, band: EARLIER }]);
  });

  test("a throwing lookup leaves that track and the flag for the next boot, and the others go on", async ({ page }) => {
    const wikimedia = await stubWikimedia(page);
    wikimedia.offline = true;
    const server = await stubServer(page, { listed: [JOB_ID, SIBLING_JOB_ID] });
    await bootWith(
      page,
      {
        [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER, audioTags: { artist: PICKED.name } }),
        [SIBLING_JOB_ID]: libraryTrack(SIBLING_JOB_ID, { artist: SAVED }),
      },
      { flagSet: false },
    );

    await patchCount(page, server, 1);
    expect(server.patches).toEqual([{ id: SIBLING_JOB_ID, band: SAVED }]);
    expect(await uploadFlag(page)).toBeNull();
    await expect(page.locator("#notifBadge")).toHaveClass(/hidden/);

    wikimedia.offline = false;
    await reboot(page);
    await uploadFinished(page);
    expect(server.patches).toEqual([
      { id: SIBLING_JOB_ID, band: SAVED },
      { id: JOB_ID, band: EARLIER },
    ]);
  });

  for (const status of [404, 422]) {
    test(`a ${status} counts as done, silently`, async ({ page }) => {
      const server = await stubServer(page);
      server.patchStatus = status;
      await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) }, { flagSet: false });

      await uploadFinished(page);
      expect(server.patches).toEqual([{ id: JOB_ID, band: EARLIER }]);
      await expect(page.locator("#notifBadge")).toHaveClass(/hidden/);
    });
  }

  test("a job missing from the list is asked for anyway, and its 404 counts as done", async ({ page }) => {
    const server = await stubServer(page, { listed: [] });
    server.patchStatus = 404;
    await bootWith(
      page,
      { [UNKNOWN_JOB_ID]: libraryTrack(UNKNOWN_JOB_ID, { artist: EARLIER }) },
      { flagSet: false },
    );

    await uploadFinished(page);
    expect(server.patches).toEqual([{ id: UNKNOWN_JOB_ID, band: EARLIER }]);
  });

  test("a 500 leaves the flag unset and shows nothing, and the next boot retries", async ({ page }) => {
    const server = await stubServer(page);
    server.patchStatus = 500;
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) }, { flagSet: false });

    await patchCount(page, server, 1);
    await page.waitForTimeout(SECOND_PATCH_WOULD_HAVE_LEFT_MS);
    expect(await uploadFlag(page)).toBeNull();
    await expect(page.locator("#notifBadge")).toHaveClass(/hidden/);
    expect(await savedArtist(page)).toEqual(EARLIER);

    server.patchStatus = 200;
    await reboot(page);
    await uploadFinished(page);
    expect(server.patches.length).toBe(2);
  });

  test("an invalid id is not sent", async ({ page }) => {
    const server = await stubServer(page);
    await bootWith(
      page,
      { [JOB_ID]: libraryTrack(JOB_ID, { artist: { id: "not-an-item", name: "Nope" } }) },
      { flagSet: false },
    );

    await uploadFinished(page);
    expect(server.patches).toEqual([]);
  });

  test("boot completes with the list refused", async ({ page }) => {
    const server = await stubServer(page);
    server.listStatus = 500;
    await bootWith(page, { [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }) }, { flagSet: false });

    await openTrack(page);
    await expect(page.locator("#np-artist")).toHaveText(EARLIER.name);
    expect(server.patches).toEqual([]);
    expect(await uploadFlag(page)).toBeNull();
    await expect(page.locator("#notifBadge")).toHaveClass(/hidden/);
  });

  test("boot completes with lookups and saves failing", async ({ page }) => {
    const wikimedia = await stubWikimedia(page);
    wikimedia.offline = true;
    const server = await stubServer(page, { listed: [JOB_ID, SIBLING_JOB_ID] });
    server.patchStatus = 500;
    await bootWith(
      page,
      {
        [JOB_ID]: libraryTrack(JOB_ID, { artist: EARLIER }),
        [SIBLING_JOB_ID]: libraryTrack(SIBLING_JOB_ID, { artist: SAVED, audioTags: { artist: PICKED.name } }),
      },
      { flagSet: false },
    );

    await openTrack(page);
    await expect(page.locator("#np-artist")).toHaveText(EARLIER.name);
    await patchCount(page, server, 1);
    expect(await uploadFlag(page)).toBeNull();
    await expect(page.locator("#notifBadge")).toHaveClass(/hidden/);
  });
});
