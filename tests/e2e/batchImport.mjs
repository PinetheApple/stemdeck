// Stubs and steps the batch import specs share: the review's preview answer,
// the imports, and opening the bar with a pasted list.
import { expect } from "@playwright/test";
import { seedLibrary, stubUpdateCheck } from "./helpers.mjs";

export const YT = "https://www.youtube.com/watch?v=";
export const LINE = {
  inLibrary: `${YT}aaaaaaaaaaa`,
  ok: `${YT}bbbbbbbbbbb`,
  playlist: "https://www.youtube.com/playlist?list=PLworship",
  other: `${YT}ccccccccccc`,
  long: `${YT}ddddddddddd`,
  notLink: "setlist for sunday",
};
export const PASTE = [LINE.inLibrary, LINE.ok, LINE.playlist, LINE.other, LINE.long, "", LINE.notLink].join("\n");
export const GONE_COPY = "e2e0feed00a1";
export const PLAYLIST_TITLE = "Worship Nights";
export const PLAYLIST_SONGS = ["Holy Forever", "Same God", "Gratitude", "Jireh", "Echo"];
export const MAX_DURATION_SEC = 1200;
export const TOO_LONG_SEC = 11560;
export const ROWS = 10;
export const TICKED_BY_DEFAULT = 7;
export const HTTP_FULL = 503;

export function linkItem(line, url, status, extra = {}) {
  return {
    input: url ?? LINE.notLink, line, url, title: extra.title ?? null, artist: extra.artist ?? null,
    duration_sec: extra.duration ?? 300, status, existing_job_id: status === "in_library" ? "e2e0feed00a0" : null,
    replaces: extra.replaces ?? null, playlist: extra.playlist ?? null,
  };
}

export function preview({ links = 20 } = {}) {
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
export async function stubImports(page, statuses = []) {
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

export async function stubPreview(page, answer) {
  const asked = [];
  await page.route("**/api/import/preview", (route) => {
    asked.push(route.request().postDataJSON());
    return route.fulfill({ json: answer });
  });
  return asked;
}

export async function openBar(page) {
  await seedLibrary(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".url-wrap");
}

export async function paste(page, text) {
  await page.locator("#url").focus();
  await page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData("text", value);
    document.getElementById("url").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

export const review = (page) => page.locator("#batchReview");
export const row = (page, title) => review(page).locator(".batch-item", { hasText: title });
export const queueButton = (page) => review(page).locator(".batch-queue");

export async function pasteList(page, answer = preview()) {
  await openBar(page);
  const asked = await stubPreview(page, answer);
  await paste(page, PASTE);
  await expect(row(page, "Build My Life")).toBeVisible();
  return asked;
}
