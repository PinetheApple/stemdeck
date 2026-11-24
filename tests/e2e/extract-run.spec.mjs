import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, failureMessages, openStudio } from "./helpers.mjs";
import { DEFAULT_VERSION_ID as DEFAULT_ID } from "../../static/js/versionModel.js";
import { SOURCE_GONE_DETAIL } from "../../static/js/extractRun.js";

const TWO_STEMS = ["vocals", "drums"];
const WITH_BASS = ["vocals", "drums", "bass"];
const V2_DRUMS = 0.25;
const MIX_KEY = `stemdeck:mix:${JOB_ID}`;
const EXTRACT_PATH = `**/api/jobs/${JOB_ID}/versions/extract`;
const OOM_SENTENCE = "There wasn't enough memory to finish. Close other apps, then retry.";
const LINK_DEAD_SENTENCE = "The link no longer works. The song is unchanged.";
const FILELESS = ["guitar", "piano"];
const SLOW_HINT = "Saved as a new version. Takes a few minutes.";

const versionsUrl = (id) => `/api/jobs/${id}/versions`;
const versionKey = (vid) => `${MIX_KEY}:${vid}`;
const laneMix = (drums) => ({ drums: { volume: drums, muted: false, soloed: false, pitch: 0 } });
const songRow = (page) => page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`).first();
const versionRows = (page) => page.locator(`#catalogList .cat-version[data-id="${JOB_ID}"]`);
const rowLabel = (page) => songRow(page).locator(".cat-queue-label");
const rowBarFill = (page) => songRow(page).locator(".cat-progress-fill");
const extractDialog = (page) => page.locator(".extract-more-backdrop");
const extractForm = (page) => extractDialog(page).locator(".cat-extract-more");
const storedMix = (page, key) => page.evaluate((k) => JSON.parse(window.localStorage.getItem(k) ?? "\"absent\""), key);

const running = (phase, progress) => ({ state: "running", phase, progress, stems: ["bass"], error: null, version_id: null });
const ended = (state, extra = {}) => ({ state, phase: "finishing", progress: 1, stems: ["bass"], error: null, version_id: null, ...extra });

test.afterEach(async ({ request }) => {
  await request.post(`${versionsUrl(JOB_ID)}/${DEFAULT_ID}/open`);
  const { versions } = await (await request.get(versionsUrl(JOB_ID))).json();
  for (const v of versions.filter((x) => x.id !== DEFAULT_ID)) await request.delete(`${versionsUrl(JOB_ID)}/${v.id}`);
});

/** Add `missing` to the song's versions payload, as the server names stems with no file. */
async function stubMissingFiles(page, missing) {
  await page.route(`**${versionsUrl(JOB_ID)}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    return route.fulfill({ response: res, json: { ...(await res.json()), missing_files: missing } });
  });
}

/** Answer the extract routes from `run.view`, which the test moves along; record the stops. */
async function stubExtractRun(page, request, first) {
  const run = { view: first, stops: 0 };
  await page.route(EXTRACT_PATH, async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: run.view });
    const state = await (await request.get(versionsUrl(JOB_ID))).json();
    return route.fulfill({ status: 202, json: { extracting: run.view, ...state } });
  });
  await page.route(`${EXTRACT_PATH}/cancel`, (route) => {
    run.stops += 1;
    return route.fulfill({ json: ended("cancelled") });
  });
  return run;
}

async function openOnTwoLanes(page, request) {
  const res = await request.post(versionsUrl(JOB_ID), { data: { name: "Two lanes", stems: TWO_STEMS, open: true } });
  const v2 = (await res.json()).version;
  await page.addInitScript(([key, mix]) => {
    if (window.sessionStorage.getItem("e2e.mixes")) return;
    window.sessionStorage.setItem("e2e.mixes", "1");
    window.localStorage.setItem(key, JSON.stringify(mix));
  }, [versionKey(v2.id), laneMix(V2_DRUMS)]);
  await openStudio(page);
  await expect.poll(() => lanes(page)).toEqual([...TWO_STEMS].sort());
  return v2;
}

function lanes(page) {
  return page.evaluate(async () => [...(await import("/js/state.js")).selectedStems].sort());
}

function playhead(page) {
  return page.evaluate(async () => {
    const { audioEngine, multitrack } = await import("/js/state.js");
    return (audioEngine ?? multitrack).getCurrentTime();
  });
}

async function openRowMenu(page) {
  await songRow(page).hover();
  await songRow(page).locator(".cat-more").click();
  return page.locator(".lib-menu");
}

/** Open Extract more from the row's menu and ask for Bass only. */
async function extractBass(page) {
  const menu = await openRowMenu(page);
  await menu.getByRole("menuitem", { name: "Extract more stems…" }).click();
  const form = extractForm(page);
  for (const name of ["Guitar", "Piano", "Other"]) await form.locator(".cat-extract-more-chip", { hasText: name }).click();
  await form.locator(".cat-extract-more-go").click();
  await expect(form).toHaveCount(0);
}

function requestExtract(page, id) {
  return page.evaluate((trackId) => {
    document.dispatchEvent(new CustomEvent("versions:extract", { detail: { id: trackId } }));
  }, id);
}

function formSong(page) {
  return extractDialog(page).getAttribute("data-id");
}

function isInLibrary(page, id) {
  return page.evaluate(async (trackId) => Boolean((await import("/js/catalog.js")).getLibraryTrack(trackId)), id);
}

async function expectStillPlays(page) {
  const before = await playhead(page);
  await page.locator("#t-play").click();
  await expect.poll(() => playhead(page)).toBeGreaterThan(before);
  await page.locator("#t-play").click();
}

test("Extract more stems is a dialog that dims the page, closes on Esc and hands focus back", async ({ page, request }) => {
  await openOnTwoLanes(page, request);
  const menu = await openRowMenu(page);
  await menu.getByRole("menuitem", { name: "Extract more stems…" }).click();
  const dialog = extractDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("role", "dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("#catalogList .cat-extract-more")).toHaveCount(0);
  const scrim = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--scrim").trim());
  expect(await dialog.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(scrim);
  await expect(extractForm(page).locator(".cat-extract-more-go")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(songRow(page)).toBeFocused();
});

test("with the song's row off screen, the dialog hands focus back to what opened it", async ({ page, request }) => {
  await openOnTwoLanes(page, request);
  await page.locator("#catalogSearch").fill("zzzz");
  await expect(songRow(page)).toHaveCount(0);
  const opener = page.locator("#songMoreBtn");
  await opener.focus();
  await page.evaluate((trackId) => {
    const anchor = document.getElementById("songMoreBtn");
    document.dispatchEvent(new CustomEvent("versions:extract", { detail: { id: trackId, anchor } }));
  }, JOB_ID);
  await expect(extractDialog(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(extractDialog(page)).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("the form says it takes minutes only when a chosen stem has no file", async ({ page, request }) => {
  await stubMissingFiles(page, FILELESS);
  await openOnTwoLanes(page, request);
  const menu = await openRowMenu(page);
  await menu.getByRole("menuitem", { name: "Extract more stems…" }).click();
  const form = extractForm(page);
  const hint = form.locator(".cat-extract-more-hint");
  await expect(hint).toHaveText("Saved as a new version. Takes a few minutes.");
  for (const name of ["Guitar", "Piano"]) await form.locator(".cat-extract-more-chip", { hasText: name }).click();
  await expect(hint).toHaveText("Saved as a new version.");
});

test("a slower answer for an earlier song does not take the form from a later one", async ({ page, request }) => {
  await stubMissingFiles(page, FILELESS);
  await openOnTwoLanes(page, request);
  expect(await isInLibrary(page, SIBLING_JOB_ID)).toBe(true);
  let releaseSibling;
  const siblingHeld = new Promise((resolve) => { releaseSibling = resolve; });
  await page.route(`**${versionsUrl(SIBLING_JOB_ID)}`, async (route) => {
    await siblingHeld;
    return route.fulfill({ response: await route.fetch() });
  });
  const siblingAnswered = page.waitForResponse((res) => res.url().endsWith(versionsUrl(SIBLING_JOB_ID)));

  await requestExtract(page, SIBLING_JOB_ID);
  await requestExtract(page, JOB_ID);
  const hint = extractForm(page).locator(".cat-extract-more-hint");
  await expect(hint).toHaveText(SLOW_HINT);
  expect(await formSong(page)).toBe(JOB_ID);

  releaseSibling();
  await siblingAnswered;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await formSong(page)).toBe(JOB_ID);
  await expect(hint).toHaveText(SLOW_HINT);
});

test("a run shows on the row and the song head, the song plays, and the new version opens when done", async ({ page, request }) => {
  const v2 = await openOnTwoLanes(page, request);
  const run = await stubExtractRun(page, request, running("queued", 0));
  await extractBass(page);

  await expect(rowLabel(page)).toHaveText("Waiting to extract");
  await expect(songRow(page)).toHaveClass(/\bqueue-pending\b/);
  await expect(rowBarFill(page)).toHaveCount(0);

  run.view = running("separating", 0.3);
  await expect(rowLabel(page)).toHaveText("Extracting 30%");
  await expect(rowBarFill(page)).toHaveAttribute("style", /width: 30%/);
  await expect(page.locator("#songHead #npExtracting")).toHaveText("Extracting 30%");
  await expectStillPlays(page);

  const made = await request.post(versionsUrl(JOB_ID), { data: { name: "+ Bass", stems: WITH_BASS, open: true } });
  const created = (await made.json()).version;
  run.view = ended("done", { version_id: created.id });

  await expect(page.locator("#npVersionBtn")).toHaveText("+ Bass");
  await expect.poll(() => lanes(page)).toEqual([...WITH_BASS].sort());
  await expect(versionRows(page)).toHaveCount(3);
  await expect(rowLabel(page)).toHaveCount(0);
  await expect(page.locator("#npExtracting")).toHaveCount(0);
  expect(await storedMix(page, versionKey(created.id))).toEqual(laneMix(V2_DRUMS));
  expect(await storedMix(page, versionKey(v2.id))).toEqual(laneMix(V2_DRUMS));
});

test("a failed run tells why in a notification and leaves the song as it was", async ({ page, request }) => {
  await openOnTwoLanes(page, request);
  const run = await stubExtractRun(page, request, running("separating", 0.5));
  await extractBass(page);
  await expect(rowLabel(page)).toHaveText("Extracting 50%");

  run.view = ended("failed", { error: "out-of-memory" });
  await expect(rowLabel(page)).toHaveCount(0);
  await expect.poll(() => failureMessages(page)).toEqual([OOM_SENTENCE]);
  await page.locator("#notifBtn").click();
  await expect(page.locator(".daw-notif-card-title").first()).toHaveText("Stems not extracted");
  await expect(page.locator(".daw-notif-card-desc").first()).toContainText(OOM_SENTENCE);
  await page.keyboard.press("Escape");
  await expect(versionRows(page)).toHaveCount(2);
  await expect.poll(() => lanes(page)).toEqual([...TWO_STEMS].sort());
  await expectStillPlays(page);
});

test("a download that fails says the link no longer works and leaves the song as it was", async ({ page, request }) => {
  await openOnTwoLanes(page, request);
  const run = await stubExtractRun(page, request, running("downloading", 0.3));
  await extractBass(page);
  await expect(rowLabel(page)).toHaveText("Downloading 30%");

  run.view = ended("failed", { phase: "downloading", progress: 0.25, error: "source-unavailable" });
  await expect(rowLabel(page)).toHaveCount(0);
  await expect.poll(() => failureMessages(page)).toEqual([LINK_DEAD_SENTENCE]);
  await expect(versionRows(page)).toHaveCount(2);
  await expect.poll(() => lanes(page)).toEqual([...TWO_STEMS].sort());
});

test("Stop extracting takes Extract more's place in both menus and stops only the run", async ({ page, request }) => {
  await openOnTwoLanes(page, request);
  const run = await stubExtractRun(page, request, running("separating", 0.4));
  await extractBass(page);
  await expect(rowLabel(page)).toHaveText("Extracting 40%");

  await page.locator("#songMoreBtn").click();
  const menu = page.locator(".lib-menu");
  await expect(menu.getByRole("menuitem", { name: "Stop extracting" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Extract more stems…" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await (await openRowMenu(page)).getByRole("menuitem", { name: "Stop extracting" }).click();
  await expect.poll(() => run.stops).toBe(1);
  run.view = ended("cancelled");
  await expect(rowLabel(page)).toHaveCount(0);
  await expect(songRow(page).locator(".cat-versions-toggle")).toHaveText("2 versions");
  expect(await failureMessages(page)).toEqual([]);
});

test("a re-download shows as Downloading, then Extracting, in the song head and on Stage", async ({ page, request }) => {
  await openOnTwoLanes(page, request);
  const run = await stubExtractRun(page, request, running("downloading", 0.42));
  await extractBass(page);
  await expect(rowLabel(page)).toHaveText("Downloading 42%");
  await expect(rowBarFill(page)).toHaveAttribute("style", /width: 42%/);
  await expect(page.locator("#npExtracting")).toHaveText("Downloading 42%");

  run.view = running("separating", 0.42);
  await page.locator("#stageModeBtn").click();
  await expect(page.locator("#stageView #stageExtracting")).toHaveText("Extracting 42%");
  run.view = ended("cancelled");
  await expect(page.locator("#stageExtracting")).toBeHidden();
});

test("a song whose audio was not kept is refused in the form, with nothing started", async ({ page, request }) => {
  await openOnTwoLanes(page, request);
  await page.route(EXTRACT_PATH, (route) => route.fulfill({ status: 409, json: { detail: SOURCE_GONE_DETAIL } }));
  const menu = await openRowMenu(page);
  await menu.getByRole("menuitem", { name: "Extract more stems…" }).click();
  const form = extractForm(page);
  await form.locator(".cat-extract-more-go").click();

  await expect(form.locator(".cat-extract-more-error")).toHaveText(
    "This song's original audio wasn't kept. Import it again to get these stems.",
  );
  await expect(form.locator(".cat-extract-more-chip")).toHaveCount(0);
  await expect(form.locator(".cat-extract-more-cancel")).toBeFocused();
  await form.locator(".cat-extract-more-cancel").click();
  await expect(form).toHaveCount(0);
  await expect(rowLabel(page)).toHaveCount(0);
  expect(await failureMessages(page)).toEqual([]);
});

test("with another song shown over the playing one, the head shows that song's run and Stage the playing one's", async ({ page, request }) => {
  await openOnTwoLanes(page, request);
  const run = await stubExtractRun(page, request, running("separating", 0.3));
  await extractBass(page);
  await expect(page.locator("#npExtracting")).toHaveText("Extracting 30%");

  await page.locator("#t-play").click();
  await page.evaluate(async (id) => (await import("/js/openSong.js")).openSong(id), SIBLING_JOB_ID);
  await expect(page.locator("#openPreview")).toBeVisible();
  await expect(page.locator("#npExtracting")).toHaveCount(0);
  await page.locator("#stageModeBtn").click();
  await expect(page.locator("#stageView #stageExtracting")).toHaveText("Extracting 30%");
  run.view = ended("cancelled");
  await expect(page.locator("#stageExtracting")).toBeHidden();
});
