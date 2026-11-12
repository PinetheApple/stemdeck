// A song shows where it was imported from, and a failed import says why and can
// be retried from the same source without a second library row.
//
// The e2e backend never fails an import, so the failed jobs are stubbed: the
// job list, each job's state, the retry route and new imports.
import { test, expect } from "@playwright/test";
import {
  JOB_ID, SIBLING_JOB_ID, TRACK_TITLE, SIBLING_TITLE, JOB_LIST_URL, fixtureTrack, openInspectorTab,
  openStudio, seedCatalogState, stubUpdateCheck, uiText,
} from "./helpers.mjs";
import { ROW_KEY } from "../../static/js/rovingRows.js";

const LINK_FAILED = "e2e0fa11ed01";
const FILE_FAILED = "e2e0fa11ed02";
const REPLACEMENT = "e2e0fa11ed03";
const LINK = "https://www.youtube.com/watch?v=Fv3QH1nvJ0E";
const LINK_SHOWN = "youtube.com/watch?v=Fv3QH1nvJ0E";
const FILE_NAME = "Echo (Live at Chapel) - final mix.wav";
const FILE_TITLE = "Echo (Live at Chapel) - final mix";
const STEMS = ["vocals", "drums", "bass", "other"];
const HTTP_GONE = 410;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const HTTP_CONFLICT = 409;
const RESTORE_FIRST_DETAIL = "restore it from the Trash first";
const STEMS_FOLDER_MOVING_DETAIL = "Restart StemDeck to finish moving your stems folder before importing";
const RETRY_URL = /\/api\/jobs\/(e2e0fa11ed0[0-9])\/retry$/;
const FAILED_STATE_URL = /\/api\/jobs\/e2e0fa11ed0[0-9]$/;
const NEW_IMPORT_URL = /\/api\/jobs$/;

const FAILED = {
  [LINK_FAILED]: {
    track: { title: LINK, sourceUrl: LINK, sourceKind: "link", errorCode: "source-unavailable", retryable: true },
    state: { title: LINK, source_url: LINK, source_kind: "link", source_name: null, error_code: "source-unavailable" },
  },
  [FILE_FAILED]: {
    track: { title: FILE_TITLE, sourceUrl: `local:${FILE_TITLE}`, sourceKind: "file", sourceName: FILE_NAME, errorCode: null },
    state: { title: FILE_TITLE, source_url: `local:${FILE_TITLE}`, source_kind: "file", source_name: FILE_NAME, error_code: null },
  },
};

function failedState(id, retryable) {
  return {
    job_id: id,
    status: "error",
    error: "ERROR: raw text the UI must never show",
    error_detail: "raw detail the UI must never show",
    retryable,
    selected_stems: STEMS,
    stems: [],
    created_at: 1700000100,
    trashed_at: null,
    ...FAILED[id].state,
  };
}

function failedTrack(id, { status = "error", retryable = true } = {}) {
  return { id, status, selectedStems: STEMS, stems: STEMS, createdAt: 1700000100, favorite: false, retryable, ...FAILED[id].track };
}

/**
 * The fixture library plus both failed imports, and a server that knows them.
 * `retry` and `retryDetail` answer POST .../retry, once `hold` (a promise) settles;
 * `retryable` is what the server says of each. Returns the server: what the page
 * asked for (retries, new imports and their bodies) and `hold` to set.
 */
async function openFailedLibrary(page, { retry = 200, retryDetail = "stubbed", retryable = {}, stored = {} } = {}) {
  const server = {
    retries: [], imports: [], retry, retryDetail, hold: null,
    retryable: { [LINK_FAILED]: true, [FILE_FAILED]: true, ...retryable },
  };
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, LINK_FAILED, SIBLING_JOB_ID, FILE_FAILED], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
      [LINK_FAILED]: failedTrack(LINK_FAILED, { retryable: server.retryable[LINK_FAILED], ...stored[LINK_FAILED] }),
      [FILE_FAILED]: failedTrack(FILE_FAILED, { retryable: server.retryable[FILE_FAILED], ...stored[FILE_FAILED] }),
    },
  });
  await stubUpdateCheck(page);
  await stubFailedServer(page, server);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(row(page, LINK_FAILED)).toBeVisible();
  return server;
}

async function stubFailedServer(page, server) {
  await page.route(JOB_LIST_URL, async (route) => {
    const jobs = await (await route.fetch()).json();
    await route.fulfill({ json: [...jobs, ...Object.keys(FAILED).map((id) => failedState(id, server.retryable[id]))] });
  });
  await page.route(FAILED_STATE_URL, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    return route.fulfill({ json: failedState(id, server.retryable[id]) });
  });
  await page.route(RETRY_URL, async (route) => {
    const [, id] = new URL(route.request().url()).pathname.match(RETRY_URL);
    server.retries.push(id);
    await server.hold;
    if (server.retry !== 200) return route.fulfill({ status: server.retry, json: { detail: server.retryDetail } });
    return route.fulfill({ json: { ...failedState(id, false), status: "queued", error_code: null } });
  });
  await page.route(NEW_IMPORT_URL, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    server.imports.push(route.request());
    return route.fulfill({ json: { job_id: REPLACEMENT, status: "queued" } });
  });
}

const row = (page, id) => page.locator(`#catalogList .cat-item[data-id="${id}"]`);
const panel = (page, id) => row(page, id).locator(".import-fail-panel");
const libraryRowIds = (page) =>
  page.locator("#catalogList .cat-item").evaluateAll((rows) => rows.map((r) => r.dataset.id));

async function expectPointer(locator) {
  await expect(locator).toHaveCSS("cursor", "pointer");
}

/** Open the fixture song with the server reporting `source` as where it came from. */
async function openSongWithSource(page, source) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text) => { window.__copied = text; } },
    });
  });
  await page.route(new RegExp(`/api/jobs/${JOB_ID}$`), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const state = await (await route.fetch()).json();
    await route.fulfill({ json: { ...state, ...source } });
  });
  await openStudio(page);
  await openInspectorTab(page, "details");
  return page.locator(".details-song .import-source");
}

test.describe("import source in Details", () => {
  test("a link shows short, copies and opens in full, and the File card drops YouTube", async ({ page }) => {
    const source = await openSongWithSource(page, { source_url: LINK, source_kind: "link", source_name: null });

    await expect(source.locator(".import-source-text")).toHaveText(LINK_SHOWN);
    await expect(source.locator(".import-source-text")).toHaveAttribute("title", LINK);
    const open = source.locator(".import-source-open");
    await expect(open).toHaveAttribute("href", LINK);
    await expect(open).toHaveAttribute("target", "_blank");
    const copy = source.locator(".import-source-copy");
    await copy.click();
    expect(await page.evaluate(() => window.__copied)).toBe(LINK);
    await expect(copy).toHaveAttribute("title", await uiText(page, "source.copied"));
    await expectPointer(copy);
    await expectPointer(open);
    await expect(page.locator(".details-song .daw-track-meta-line")).not.toContainText("YouTube");
    await expect(page.locator("#track-source")).toHaveCount(0);
  });

  test("an upload shows its original file name, with nothing to copy or open", async ({ page }) => {
    const source = await openSongWithSource(page, { source_url: "local:e2e-fixture", source_kind: "file", source_name: FILE_NAME });

    await expect(source.locator(".import-source-text")).toHaveText(FILE_NAME);
    await expect(source.locator(".import-source-copy, .import-source-open")).toHaveCount(0);
    await expect(page.locator(".details-song .daw-track-meta-line")).not.toContainText(await uiText(page, "track.localFile"));
  });

  test("an older upload with no file name shows its title", async ({ page }) => {
    const source = await openSongWithSource(page, { source_url: "local:e2e-fixture", source_kind: "file", source_name: null });
    await expect(source.locator(".import-source-text")).toHaveText("e2e-fixture");
  });
});

test.describe("failed import rows", () => {
  test("a failed row says Import failed in red and keeps Retry visible", async ({ page }) => {
    await openFailedLibrary(page);
    const failed = row(page, LINK_FAILED);

    await expect(failed.locator(".cat-title")).toHaveText("YouTube link");
    const label = failed.locator(".cat-sub");
    await expect(label).toHaveText(await uiText(page, "notifKind.importFailed"));
    const danger = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--danger").trim());
    const red = await page.evaluate((c) => { const el = document.createElement("i"); el.style.color = c; document.body.append(el); const v = getComputedStyle(el).color; el.remove(); return v; }, danger);
    await expect(label.locator("span").first()).toHaveCSS("color", red);
    const retry = failed.locator(".cat-retry");
    await expect(retry).toHaveCSS("opacity", "1");
    await expect(retry).toBeVisible();
    await expectPointer(retry);
    await expect(failed.locator(".row-play, .cat-fav, .cat-del, .cat-more")).toHaveCount(0);
    await expect(panel(page, LINK_FAILED)).toBeHidden();
    await expect(page.getByText("raw text the UI must never show")).toHaveCount(0);
  });

  test("selecting it opens the reason, the source, Retry and Trash", async ({ page }) => {
    await openFailedLibrary(page);
    await row(page, LINK_FAILED).click();

    const detail = panel(page, LINK_FAILED);
    await expect(detail.locator(".import-fail-reason")).toHaveText(await uiText(page, "importFail.reason.sourceUnavailable"));
    await expect(detail.locator(".import-source-text")).toHaveText(LINK_SHOWN);
    await expect(detail.locator(".import-fail-primary")).toHaveText(await uiText(page, "importFail.retry"));
    await expect(detail.locator(".import-fail-trash")).toBeVisible();
    await expectPointer(detail.locator(".import-fail-primary"));
    await expectPointer(detail.locator(".import-fail-trash"));
    await expect(row(page, LINK_FAILED).locator(".cat-retry")).toBeHidden();

    await row(page, FILE_FAILED).click();
    await expect(panel(page, FILE_FAILED).locator(".import-fail-reason")).toHaveText(await uiText(page, "importFail.reason.unknown"));
    await expect(panel(page, FILE_FAILED).locator(".import-source-text")).toHaveText(FILE_NAME);
    await expect(panel(page, LINK_FAILED)).toBeHidden();
  });

  test("Retry queues the same job: no new row and no new import", async ({ page }) => {
    const server = await openFailedLibrary(page);
    const before = await libraryRowIds(page);

    await row(page, LINK_FAILED).locator(".cat-retry").click();

    await expect(row(page, LINK_FAILED).locator(".cat-sub")).toHaveText(await uiText(page, "job.processing"));
    expect(server.retries).toEqual([LINK_FAILED]);
    expect(server.imports).toHaveLength(0);
    expect(await libraryRowIds(page)).toEqual(before);
    await expect(row(page, LINK_FAILED)).not.toHaveClass(/is-failed/);
  });

  test("a link the server forgot is imported again in place of the failed row", async ({ page }) => {
    const server = await openFailedLibrary(page, { retry: HTTP_NOT_FOUND });
    await row(page, LINK_FAILED).locator(".cat-retry").click();

    await expect(row(page, REPLACEMENT)).toBeVisible();
    await expect(row(page, LINK_FAILED)).toHaveCount(0);
    expect(server.imports).toHaveLength(1);
    expect(server.imports[0].postDataJSON()).toMatchObject({ url: LINK, replaces: LINK_FAILED, stems: STEMS });
  });

  test("a file that is gone offers Pick the file again, which uploads in its place", async ({ page }) => {
    const server = await openFailedLibrary(page, { retry: HTTP_GONE });
    await row(page, FILE_FAILED).locator(".cat-retry").click();

    const detail = panel(page, FILE_FAILED);
    await expect(detail.locator(".import-fail-reason")).toHaveText(await uiText(page, "importFail.reason.fileGone"));
    const pick = detail.locator(".import-fail-primary");
    await expect(pick).toHaveText(await uiText(page, "importFail.pickAgain"));
    const chooser = page.waitForEvent("filechooser");
    await pick.click();
    await (await chooser).setFiles({ name: FILE_NAME, mimeType: "audio/wav", buffer: Buffer.from("RIFF") });

    await expect(row(page, REPLACEMENT)).toBeVisible();
    await expect(row(page, FILE_FAILED)).toHaveCount(0);
    expect(server.retries).toEqual([FILE_FAILED]);
    const body = server.imports[0].postDataBuffer().toString("latin1");
    expect(body).toContain(`name="replaces"\r\n\r\n${FILE_FAILED}`);
    expect(body).toContain(`filename="${FILE_NAME}"`);
  });

  test("a full queue says so in words", async ({ page }) => {
    await openFailedLibrary(page, { retry: HTTP_UNAVAILABLE });
    await row(page, LINK_FAILED).locator(".cat-retry").click();
    await expect(page.locator("#error .error-msg")).toHaveText(await uiText(page, "playlist.queueFull"));
  });

  test("after a restart a failed import still retries as the same job", async ({ page }) => {
    const server = await openFailedLibrary(page, { stored: { [LINK_FAILED]: { status: "processing" } } });
    const failed = row(page, LINK_FAILED);
    await expect(failed).toHaveClass(/is-failed/);
    await failed.click();
    await expect(panel(page, LINK_FAILED).locator(".import-fail-reason")).toHaveText(await uiText(page, "importFail.reason.sourceUnavailable"));

    await panel(page, LINK_FAILED).locator(".import-fail-primary").click();
    await expect(failed.locator(".cat-sub")).toHaveText(await uiText(page, "job.processing"));
    expect(server.retries).toEqual([LINK_FAILED]);
    expect(server.imports).toHaveLength(0);
  });

  test("a second press while a retry is in flight sends nothing", async ({ page }) => {
    const server = await openFailedLibrary(page);
    let release;
    server.hold = new Promise((resolve) => { release = resolve; });
    await row(page, LINK_FAILED).locator(".cat-retry").click();
    await expect.poll(() => server.retries.length).toBe(1);
    await panel(page, LINK_FAILED).locator(".import-fail-primary").click();
    await page.evaluate(async (id) => (await import("/js/catalog.js")).retryFailedImport(id), LINK_FAILED);
    release();

    await expect(row(page, LINK_FAILED).locator(".cat-sub")).toHaveText(await uiText(page, "job.processing"));
    expect(server.retries).toEqual([LINK_FAILED]);
  });

  test("a retry while the stems folder moves says why", async ({ page }) => {
    await openFailedLibrary(page, { retry: HTTP_CONFLICT, retryDetail: STEMS_FOLDER_MOVING_DETAIL });
    await row(page, LINK_FAILED).locator(".cat-retry").click();
    await expect(page.locator("#error .error-msg"))
      .toHaveText(await uiText(page, "job.startFailed", { message: STEMS_FOLDER_MOVING_DETAIL }));
  });

  test("a failed job in the Trash says to restore it first", async ({ page }) => {
    await openFailedLibrary(page, { retry: HTTP_CONFLICT, retryDetail: RESTORE_FIRST_DETAIL });
    await row(page, LINK_FAILED).locator(".cat-retry").click();
    await expect(page.locator("#error .error-msg")).toHaveText(await uiText(page, "importFail.restoreFirst"));
  });

  test("the panel's controls are the row's actions: arrow keys reach them, Tab does not stop on them", async ({ page }) => {
    await openFailedLibrary(page);
    await row(page, LINK_FAILED).click();
    const controls = panel(page, LINK_FAILED).locator("button, a");
    await expect(controls).toHaveCount(4);
    for (const control of await controls.all()) await expect(control).toHaveAttribute("tabindex", "-1");

    await row(page, LINK_FAILED).focus();
    const reached = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press(ROW_KEY.INTO);
      reached.push(await page.evaluate(() => document.activeElement.className));
    }
    expect(reached).toEqual([
      expect.stringContaining("import-source-copy"), expect.stringContaining("import-source-open"),
      expect.stringContaining("import-fail-primary"), expect.stringContaining("import-fail-trash"),
    ]);
  });

  test("after Retry, focus is on the retried row", async ({ page }) => {
    await openFailedLibrary(page);
    await row(page, LINK_FAILED).locator(".cat-retry").click();
    await expect(row(page, LINK_FAILED).locator(".cat-sub")).toHaveText(await uiText(page, "job.processing"));
    await expect(row(page, LINK_FAILED)).toBeFocused();
  });

  test("after a Retry finds the file gone, focus is on Pick the file again", async ({ page }) => {
    await openFailedLibrary(page, { retry: HTTP_GONE });
    await row(page, FILE_FAILED).locator(".cat-retry").click();
    await expect(panel(page, FILE_FAILED).locator(".import-fail-primary")).toBeFocused();
  });
});
