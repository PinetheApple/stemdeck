// Several songs at once: a pasted list of links or a folder becomes a chip in the
// bar and a review list under it; Queue N sends one import per ticked item and
// keeps going past a refusal. A single link still queues straight away.
//
// The review's preview and the imports are stubbed: the e2e backend reads no
// links and separates nothing.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { seedLibrary, stubUpdateCheck, uiText } from "./helpers.mjs";

const YT = "https://www.youtube.com/watch?v=";
const LINE = {
  inLibrary: `${YT}aaaaaaaaaaa`,
  ok: `${YT}bbbbbbbbbbb`,
  playlist: "https://www.youtube.com/playlist?list=PLworship",
  other: `${YT}ccccccccccc`,
  long: `${YT}ddddddddddd`,
  notLink: "setlist for sunday",
};
const PASTE = [LINE.inLibrary, LINE.ok, LINE.playlist, LINE.other, LINE.long, "", LINE.notLink].join("\n");
const GONE_COPY = "e2e0feed00a1";
const PLAYLIST_TITLE = "Worship Nights";
const PLAYLIST_SONGS = ["Holy Forever", "Same God", "Gratitude", "Jireh", "Echo"];
const MAX_DURATION_SEC = 1200;
const TOO_LONG_SEC = 11560;
const ROWS = 10;
const TICKED_BY_DEFAULT = 7;
const HTTP_FULL = 503;

function linkItem(line, url, status, extra = {}) {
  return {
    input: url ?? LINE.notLink, line, url, title: extra.title ?? null, artist: extra.artist ?? null,
    duration_sec: extra.duration ?? 300, status, existing_job_id: status === "in_library" ? "e2e0feed00a0" : null,
    replaces: extra.replaces ?? null, playlist: extra.playlist ?? null,
  };
}

function preview({ links = 20 } = {}) {
  const tracks = PLAYLIST_SONGS.map((title, i) => linkItem(3, `${YT}p${i}pppppppppp`.slice(0, 43), "ok", {
    title, playlist: { url: LINE.playlist, title: PLAYLIST_TITLE, index: i + 1 },
  }));
  return {
    items: [
      linkItem(1, LINE.inLibrary, "in_library", { title: "Goodness of God", artist: "Bethel Music", replaces: GONE_COPY }),
      linkItem(2, LINE.ok, "ok", { title: "Build My Life", artist: "Housefires", duration: 372 }),
      ...tracks,
      linkItem(4, LINE.other, "ok", { title: "Firm Foundation" }),
      linkItem(5, LINE.long, "too_long", { title: "Sunday livestream archive", duration: TOO_LONG_SEC }),
      { ...linkItem(7, null, "not_a_link"), duration_sec: null },
    ],
    playlists: [{ input: LINE.playlist, line: 3, url: LINE.playlist, title: PLAYLIST_TITLE, found: tracks.length, unavailable: 0, truncated: false }],
    files: [],
    max_duration_sec: MAX_DURATION_SEC,
    capacity_left: { links, files: 20 },
  };
}

/** Answer each new import with the next status; record every request body. */
async function stubImports(page, statuses = []) {
  const posts = [];
  await page.route(/\/api\/jobs$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const status = statuses[posts.length] ?? 200;
    const n = posts.length + 1;
    posts.push(route.request().postDataJSON?.() ?? route.request().postData());
    const body = status === 200 ? { job_id: `e2e0b00000${String(n).padStart(2, "0")}` } : { detail: `refused ${status}` };
    return route.fulfill({ status, json: body });
  });
  return posts;
}

async function stubPreview(page, answer) {
  const asked = [];
  await page.route("**/api/import/preview", (route) => {
    asked.push(route.request().postDataJSON());
    return route.fulfill({ json: answer });
  });
  return asked;
}

async function openBar(page) {
  await seedLibrary(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".url-wrap");
}

async function paste(page, text) {
  await page.locator("#url").focus();
  await page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData("text", value);
    document.getElementById("url").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

const review = (page) => page.locator("#batchReview");
const row = (page, title) => review(page).locator(".batch-item", { hasText: title });
const queueButton = (page) => review(page).locator(".batch-queue");

async function pasteList(page, answer = preview()) {
  await openBar(page);
  const asked = await stubPreview(page, answer);
  await paste(page, PASTE);
  await expect(row(page, "Build My Life")).toBeVisible();
  return asked;
}

test.describe("batch import", () => {
  test("a single link skips the review and queues as before", async ({ page }) => {
    await openBar(page);
    const posts = await stubImports(page);
    await page.locator("#url").fill(LINE.ok);
    await expect(page.locator("#submit")).toHaveText(await uiText(page, "process.extractStems"));
    await page.locator("#submit").click();

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].url).toBe(LINE.ok);
    await expect(review(page)).toHaveCount(0);
  });

  test("a pasted list is reviewed with its flags and line numbers", async ({ page }) => {
    const asked = await pasteList(page);
    expect(asked[0].links).toEqual(PASTE.split("\n"));

    const pill = page.locator("#filePill");
    await expect(pill).toContainText(await uiText(page, "batch.links.other", { count: 6 }));
    await expect(pill).toContainText(await uiText(page, "batch.songs.other", { count: ROWS }));
    await expect(page.locator("#submit")).toHaveText(await uiText(page, "batch.review.other", { count: ROWS }));

    await expect(row(page, "Goodness of God").locator(".batch-flag-dup")).toHaveText(await uiText(page, "batch.flag.inLibrary"));
    await expect(row(page, "Sunday livestream").locator(".batch-flag-block")).toHaveText(await uiText(page, "batch.flag.tooLong", { minutes: 20 }));
    await expect(row(page, "Sunday livestream").locator(".batch-item-sub")).toHaveText("3:12:40");
    const notLink = row(page, LINE.notLink);
    await expect(notLink.locator(".batch-flag-block")).toHaveText(await uiText(page, "batch.flag.notALink"));
    await expect(notLink.locator(".batch-item-sub")).toHaveText(await uiText(page, "batch.line", { line: 7 }));
    await expect(notLink.locator("input")).toBeDisabled();
    await expect(row(page, "Sunday livestream").locator("input")).toBeDisabled();
    await expect(queueButton(page)).toHaveText(await uiText(page, "batch.queue.other", { count: TICKED_BY_DEFAULT }));
  });

  test("In library starts unticked, and ticked it is sent with the copy it replaces", async ({ page }) => {
    await pasteList(page);
    const posts = await stubImports(page);
    const dup = row(page, "Goodness of God").locator("input");
    await expect(dup).not.toBeChecked();
    await dup.check();
    await expect(queueButton(page)).toHaveText(await uiText(page, "batch.queue.other", { count: TICKED_BY_DEFAULT + 1 }));

    await queueButton(page).click();
    await expect.poll(() => posts.length).toBe(TICKED_BY_DEFAULT + 1);
    const sent = posts.find((p) => p.url === LINE.inLibrary);
    expect(sent.replaces).toBe(GONE_COPY);
    expect(posts.filter((p) => p.replaces)).toHaveLength(1);
  });

  test("× drops an item and a playlist's box ticks all of it", async ({ page }) => {
    await pasteList(page);
    await row(page, "Build My Life").locator(".batch-item-drop").click();
    await expect(row(page, "Build My Life")).toHaveCount(0);
    await expect(queueButton(page)).toHaveText(await uiText(page, "batch.queue.other", { count: TICKED_BY_DEFAULT - 1 }));

    const group = review(page).locator(".batch-group");
    await expect(review(page).locator(".batch-item.is-child")).toHaveCount(3);
    await review(page).locator(".batch-more-btn").click();
    await expect(review(page).locator(".batch-item.is-child")).toHaveCount(PLAYLIST_SONGS.length);

    await group.locator("input").uncheck();
    await expect(review(page).locator(".batch-item.is-child input:checked")).toHaveCount(0);
    await expect(queueButton(page)).toHaveText(await uiText(page, "batch.queue.one", { count: 1 }));
    await review(page).locator(".batch-item.is-child input").first().check();
    expect(await group.locator("input").evaluate((box) => box.indeterminate)).toBe(true);
  });

  test("Queue N sends one import per ticked item, with its title and Detect structure", async ({ page }) => {
    await pasteList(page);
    const posts = await stubImports(page);
    await page.locator("#autoSectionsBtn").click();
    await expect(page.locator("#autoSectionsBtn")).toHaveAttribute("aria-pressed", "true");
    await expect(review(page).locator(".batch-review-summary")).toContainText(await uiText(page, "batch.structureOn"));

    await queueButton(page).click();
    await expect.poll(() => posts.length).toBe(TICKED_BY_DEFAULT);
    expect(posts.map((p) => p.title)).toEqual(["Build My Life", ...PLAYLIST_SONGS, "Firm Foundation"]);
    expect(posts.every((p) => p.auto_sections === true)).toBe(true);
    await expect(review(page)).toHaveCount(0);
    await expect(page.locator("#filePill")).toBeHidden();
    await expect(page.locator(`.cat-item[data-id="e2e0b0000001"]`)).toContainText("Build My Life");
    await page.locator("#autoSectionsBtn").click();
  });

  test("Queue N is held to the room left in the queue, and says so", async ({ page }) => {
    await pasteList(page, preview({ links: 3 }));
    await expect(queueButton(page)).toHaveText(await uiText(page, "batch.queue.other", { count: 3 }));
    await expect(review(page).locator(".batch-review-clamp")).toHaveText(await uiText(page, "batch.onlyFit.other", { count: 3 }));
  });

  test("a full queue mid-batch keeps the rest as not queued, each with Retry", async ({ page }) => {
    await pasteList(page);
    const posts = await stubImports(page, [200, HTTP_FULL]);
    await queueButton(page).click();

    await expect(row(page, "Holy Forever").locator(".batch-flag-block")).toHaveText(await uiText(page, "batch.flag.notQueued"));
    expect(posts).toHaveLength(2);
    await expect(row(page, "Build My Life")).toHaveCount(0);
    await review(page).locator(".batch-more-btn").click();
    await expect(review(page).locator(".batch-item-retry")).toHaveCount(TICKED_BY_DEFAULT - 1);

    await row(page, "Firm Foundation").locator(".batch-item-retry").click();
    await expect.poll(() => posts.length).toBe(3);
    expect(posts[2].url).toBe(LINE.other);
    await expect(row(page, "Firm Foundation")).toHaveCount(0);
  });

  test("Escape closes the review and gives the bar back its focus", async ({ page }) => {
    await pasteList(page);
    await page.keyboard.press("Escape");
    await expect(review(page)).toHaveCount(0);
    await expect(page.locator("#submit")).toBeFocused();
    await page.locator("#submit").click();
    await expect(review(page)).toBeVisible();
  });
});

const FAILED_ID = "e2e0b0000003";
const RUNNING_ID = "e2e0b0000001";
const WAITING_ID = "e2e0b0000002";

test("a failed item stays in the queue with its reason and Retry", async ({ page }) => {
  await openBar(page);
  const titles = ["Build My Life", "Firm Foundation", "Same God"];
  const urls = [LINE.ok, LINE.other, LINE.inLibrary];
  await stubPreview(page, {
    ...preview(), playlists: [], items: urls.map((url, i) => linkItem(i + 1, url, "ok", { title: titles[i] })),
  });
  await stubImports(page);
  let queued = [WAITING_ID, FAILED_ID];
  const job = (id) => ({ job_id: id, status: "queued", title: id, source_url: LINE.ok });
  await page.route("**/api/queue", (route) => route.fulfill({
    json: { running: { ...job(RUNNING_ID), status: "processing", stage: "Separating", progress: 0.4 }, queued: queued.map(job), paused: false },
  }));
  await page.route("**/api/queue/events", (route) => route.abort());
  await page.route(`**/api/jobs/${FAILED_ID}`, (route) => route.fulfill({
    json: { job_id: FAILED_ID, status: "error", error_code: "source-unavailable", retryable: true, title: "Same God", source_url: LINE.inLibrary, source_kind: "link", stems: [], selected_stems: [] },
  }));
  const retries = [];
  await page.route(`**/api/jobs/${FAILED_ID}/retry`, (route) => {
    retries.push(route.request().url());
    return route.fulfill({ json: { job_id: FAILED_ID, status: "queued", title: "Same God", source_url: LINE.inLibrary } });
  });
  await paste(page, urls.join("\n"));
  await expect(queueButton(page)).toHaveText(await uiText(page, "batch.queue.other", { count: 3 }));
  await queueButton(page).click();
  await expect(review(page)).toHaveCount(0);

  const refresh = () => page.evaluate(async () => (await import("/js/queue.js")).refreshQueue());
  await refresh();
  await page.locator(".rail-queue").click();
  queued = [WAITING_ID];
  await refresh();

  const failed = page.locator(`.batch-failed-row[data-id="${FAILED_ID}"]`);
  await expect(failed.locator(".batch-failed-label")).toHaveText(await uiText(page, "importFail.reason.sourceUnavailable"));
  const head = page.locator(".batch-head");
  await expect(head).toContainText(await uiText(page, "batch.doneOf", { done: 0, total: 3 }));
  await expect(head).toContainText(await uiText(page, "batch.failedCount.one", { count: 1 }));
  await expect(head.locator(".batch-retry-failed")).toBeVisible();
  await failed.locator(".batch-failed-retry").click();
  await expect.poll(() => retries.length).toBe(1);
});

/** A folder on disk with a subfolder, for the folder picker. */
function folderOnDisk(name) {
  const root = join(homedir(), ".cache", "agent-scratch", "h", "36ui", "e2e-folder", name);
  mkdirSync(join(root, "Acoustic"), { recursive: true });
  writeFileSync(join(root, "01 Song.wav"), "RIFF0000WAVE");
  writeFileSync(join(root, "setlist.pdf"), "%PDF");
  writeFileSync(join(root, "Acoustic", "Echo.mp3"), "ID3");
  return root;
}

test("a picked folder is reviewed with its subfolders and what is not audio", async ({ page }) => {
  await openBar(page);
  const asked = await stubPreview(page, {
    items: [], playlists: [], max_duration_sec: MAX_DURATION_SEC, capacity_left: { links: 20, files: 20 },
    files: [{ name: "01 Song.wav", status: "in_library", existing_job_id: "e2e0feed00b0", replaces: null }, { name: "Echo.mp3", status: "ok", existing_job_id: null, replaces: null }],
  });
  await page.locator("#folderInput").setInputFiles(folderOnDisk("Sunday set"));

  await expect(page.locator("#filePill")).toContainText("Sunday set");
  await expect(review(page).locator(".batch-folder")).toHaveText(["Sunday set", "Sunday set / Acoustic"]);
  await expect(row(page, "setlist.pdf").locator(".batch-flag-block")).toHaveText(await uiText(page, "batch.flag.notAudio"));
  await expect(row(page, "01 Song.wav").locator("input")).not.toBeChecked();
  expect(asked[0].files).toEqual(["01 Song.wav", "Echo.mp3"]);
});

test("a dropped folder is walked into its subfolders", async ({ page }) => {
  await openBar(page);
  await stubPreview(page, { items: [], playlists: [], files: [], max_duration_sec: MAX_DURATION_SEC, capacity_left: { links: 20, files: 20 } });
  await page.evaluate(() => {
    const file = (name) => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(new File(["RIFF"], name)) });
    const dir = (name, children) => ({
      isFile: false, isDirectory: true, name,
      createReader: () => { let read = false; return { readEntries: (ok) => { ok(read ? [] : children); read = true; } }; },
    });
    const tree = dir("Rehearsal", [file("a.wav"), dir("Live", [file("b.flac"), dir("Older", [file("c.m4a")])])]);
    DataTransferItem.prototype.webkitGetAsEntry = function webkitGetAsEntry() { return tree; };
    const data = new DataTransfer();
    data.items.add(new File([""], "Rehearsal"));
    document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  });

  await expect(review(page).locator(".batch-folder")).toHaveText(["Rehearsal", "Rehearsal / Live", "Rehearsal / Live / Older"]);
  await expect(review(page).locator(".batch-item")).toHaveCount(3);
  await expect(page.locator("#submit")).toHaveText(await uiText(page, "batch.review.other", { count: 3 }));
});

test("Add a folder is hidden where the browser cannot pick one", async ({ page }) => {
  await page.addInitScript(() => { delete HTMLInputElement.prototype.webkitdirectory; });
  await openBar(page);
  await expect(page.locator("#addFolderBtn")).toBeHidden();
  await expect(page.locator("#emptyStartFolder")).toBeHidden();
  await expect(page.locator("#uploadFileBtn")).toBeVisible();
});

test("Add a folder shows where the browser can pick one", async ({ page }) => {
  await openBar(page);
  await expect(page.locator("#addFolderBtn")).toBeVisible();
  await expect(page.locator("#emptyStartFolder")).toBeVisible();
});
