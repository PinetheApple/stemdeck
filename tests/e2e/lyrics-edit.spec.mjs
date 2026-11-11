// The user's own lyrics in the Lyrics tab, with the server's endpoints stubbed.
// What the server does with the words is tests/test_lyrics_user_text_api.py.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  LYRICS_LOOKUP,
  fixtureTrack,
  seedCatalogState,
  stubAudioTags,
  stubExportEndpoints,
  stubUpdateCheck,
  answerLyricsChoice,
  LYRICS_REMOVED,
} from "./helpers.mjs";

const WIKIMEDIA = /^https:\/\/((www|query)\.wikidata\.org|[a-z-]+\.wikipedia\.org)\//;
const SYNCED = "[00:00.00]\n[00:00.50] Server one\n[00:02.00] Server two\n[00:04.00] Server three";
const SYNCED_ROWS = ["♪", "Server one", "Server two", "Server three"];

const found = (extra = {}) => ({
  v: 1,
  source: "lrclib",
  track: "Fixture Song",
  artist: "Fixture Band",
  album: "Studio",
  duration: 6,
  synced: SYNCED,
  plain: "Server one\nServer two\nServer three",
  instrumental: false,
  lrclib_id: 201,
  others: [],
  ...extra,
});

const yours = (extra = {}) => found({ source: "user", lrclib_id: null, has_original: true, ...extra });

const JSON_TYPE = "application/json";
const answer = (route, status, body) => route.fulfill({ status, contentType: JSON_TYPE, body: JSON.stringify(body) });

/**
 * Open the fixture track's Lyrics tab. `server` is its lyrics.json (null for
 * none), and a pick or Remove lyrics is kept as answerLyricsChoice keeps it. A
 * PUT of user text keeps the words as user lyrics unless `onPut` answers it; a
 * DELETE puts `original` back unless `onDelete` does; a lookup finds LRCLIB
 * out of reach unless `onLookup` answers it.
 */
async function setUp(page, { server = found(), original = found(), onPut = null, onDelete = null, onLookup = null } = {}) {
  const kept = { lyrics: server };
  const puts = [];
  const deletes = [];
  const lookups = [];
  const choices = [];
  await page.route(LYRICS_LOOKUP, (route) => {
    lookups.push(1);
    if (onLookup) return onLookup(route);
    return answer(route, 502, { detail: "lyrics service unreachable" });
  });
  await page.route(`**/api/jobs/${JOB_ID}/lyrics`, async (route) => {
    if (await answerLyricsChoice(route, kept, choices)) return;
    if (!kept.lyrics) return answer(route, 404, { detail: "no lyrics" });
    return answer(route, kept.lyrics.source ? 200 : 404, kept.lyrics);
  });
  await page.route(`**/api/jobs/${SIBLING_JOB_ID}/lyrics`, (route) => answer(route, 404, { detail: "no lyrics" }));
  await page.route(`**/api/jobs/${JOB_ID}/lyrics/user-text`, async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      puts.push(body);
      if (onPut) return onPut(route, body, kept);
      const lines = body.text.split("\n").filter(Boolean);
      kept.lyrics = yours({ synced: "", plain: lines.join("\n") });
      return answer(route, 200, kept.lyrics);
    }
    deletes.push(1);
    if (onDelete) return onDelete(route, kept);
    kept.lyrics = original;
    return answer(route, 200, kept.lyrics);
  });
  await page.route(`**/api/jobs/${JOB_ID}/vocal-envelope`, (route) => answer(route, 404, { detail: "no vocals" }));
  await page.route(WIKIMEDIA, (route) => route.fulfill({
    status: 200,
    contentType: JSON_TYPE,
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ search: [] }),
  }));
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  await stubAudioTags(page, null);
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: {
        ...fixtureTrack(JOB_ID, "E2E Fixture Track"),
        audioTags: { artist: "Fixture Band", title: "Fixture Song" },
      },
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, "E2E Fixture Track (again)"),
    },
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await openLyrics(page);
  return { kept, puts, deletes, lookups, choices };
}

async function openLyrics(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(".cat-item").first().waitFor({ timeout: 20000 });
  await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().dblclick();
  await expect(page.locator(".app")).not.toHaveClass(/no-track/, { timeout: 15000 });
  await page.locator(".rail-lyrics").click();
}

async function openTrackFromLibrary(page, id) {
  await page.locator(".rail-library").click();
  await page.locator(`.cat-item[data-id="${id}"]`).first().dblclick();
  await page.locator(".rail-lyrics").click();
}

const editLink = (page) => page.locator(".lyrics-edit-open");
const supplyLink = (page) => page.locator(".lyrics-supply-open");
const editor = (page) => page.locator("#lyricsEditor");
const row = (page, index) => page.locator(".lyrics-edit-row").nth(index);
const rowInput = (page, index) => row(page, index).locator(".lyrics-edit-input");
const rowAction = (page, index, label) => row(page, index).getByRole("button", { name: label, exact: true });
const message = (page) => page.locator("#lyricsEditor .lyrics-align-message");
const save = (page) => page.locator("#lyricsEditor").getByRole("button", { name: "Save", exact: true });
const cancel = (page) => page.locator("#lyricsEditor").getByRole("button", { name: "Cancel", exact: true });
const pasteBox = (page) => page.locator(".lyrics-paste");
const restore = (page) => page.locator(".lyrics-restore");
const shownLines = (page) => page.locator(".lyrics-line");
const shownText = (page) => page.locator(".lyrics-text");
const stored = (page) =>
  page.evaluate((id) => JSON.parse(localStorage.getItem(`stemdeck.lyrics.${id}`) || "null"), JOB_ID);
const lyricsFile = (name, content) => ({
  name,
  mimeType: "application/octet-stream",
  buffer: Buffer.isBuffer(content) ? content : Buffer.from(content),
});
const isPlaying = (page) => page.evaluate(async () => {
  const { transport } = await import("/js/transport.js");
  const before = transport()?.getCurrentTime?.() ?? 0;
  await new Promise((resolve) => setTimeout(resolve, 300));
  return (transport()?.getCurrentTime?.() ?? 0) !== before;
});

async function loadFile(page, name, content) {
  await supplyLink(page).click();
  await page.locator(".lyrics-supply-file").setInputFiles(lyricsFile(name, content));
}

async function pasteAndSave(page, text) {
  await supplyLink(page).click();
  await pasteBox(page).fill(text);
  await save(page).click();
}

test.describe("correcting lyrics line by line", () => {
  test("edit, add, split and delete go up joined by line, keeping timing", async ({ page }) => {
    const { puts } = await setUp(page);
    await expect(shownLines(page).first()).toBeVisible();
    await editLink(page).click();
    await expect(page.locator("#lyricsBody")).toBeHidden();
    await expect(page.locator(".lyrics-edit-input")).toHaveCount(3);
    await expect(rowInput(page, 0)).toHaveValue("Server one");

    await rowInput(page, 0).fill("Corrected one");
    await rowAction(page, 0, "Add a line below").click();
    await rowInput(page, 1).fill("A new line");
    await rowInput(page, 2).evaluate((input) => input.setSelectionRange(7, 7));
    await rowAction(page, 2, "Split this line at the cursor").click();
    await expect(rowInput(page, 2)).toHaveValue("Server");
    await expect(rowInput(page, 3)).toHaveValue("two");
    await rowAction(page, 4, "Delete this line").click();
    await save(page).click();

    await expect(editor(page)).toBeHidden();
    expect(puts).toEqual([{ text: "Corrected one\nA new line\nServer\ntwo", keep_timing: true }]);
    await expect(shownText(page)).toHaveText(["Corrected one", "A new line", "Server", "two"]);
    await expect(page.locator(".lyrics-match-meta")).toContainText("Your lyrics");
  });

  test("a long line wraps and shows whole, and grows as it is typed", async ({ page }) => {
    const longLine = "Behold, Jehovah, seated on the throne, the well that overflows with mercy evermore";
    await setUp(page, { server: found({ synced: "", plain: `${longLine}\nShort` }) });
    await editLink(page).click();
    const fits = (input) => input.evaluate((area) => area.scrollHeight <= area.clientHeight);
    await expect.poll(() => fits(rowInput(page, 0))).toBe(true);
    const longBox = await rowInput(page, 0).boundingBox();
    const shortBox = await rowInput(page, 1).boundingBox();
    expect(longBox.height).toBeGreaterThan(shortBox.height);
    expect(longBox.width).toBe(shortBox.width);
    await rowInput(page, 1).fill(longLine);
    expect(await fits(rowInput(page, 1))).toBe(true);
    expect((await rowInput(page, 1).boundingBox()).height).toBe(longBox.height);
  });

  test("a pasted newline starts a row of its own, with the caret after the paste", async ({ page }) => {
    const { puts } = await setUp(page);
    await editLink(page).click();
    await rowInput(page, 0).fill("Pasted one\nPasted two");
    await expect(page.locator(".lyrics-edit-input")).toHaveCount(4);
    await expect(rowInput(page, 0)).toHaveValue("Pasted one");
    await expect(rowInput(page, 1)).toHaveValue("Pasted two");
    await expect(rowInput(page, 1)).toBeFocused();
    expect(await rowInput(page, 1).evaluate((area) => area.selectionStart)).toBe("Pasted two".length);
    await save(page).click();
    await expect(editor(page)).toBeHidden();
    expect(puts[0].text.split("\n")).toEqual(["Pasted one", "Pasted two", "Server two", "Server three"]);
  });

  test("Enter splits a line at the cursor, and not while an input method is composing", async ({ page }) => {
    await setUp(page);
    await editLink(page).click();
    await rowInput(page, 0).evaluate((input) => {
      input.focus();
      input.setSelectionRange(6, 6);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    });
    await expect(page.locator(".lyrics-edit-input")).toHaveCount(3);
    await page.keyboard.press("Enter");
    await expect(page.locator(".lyrics-edit-input")).toHaveCount(4);
    await expect(rowInput(page, 1)).toHaveValue("one");
    await expect(rowInput(page, 1)).toBeFocused();
  });

  test("Cancel sends nothing and shows the lyrics as they were", async ({ page }) => {
    const { puts } = await setUp(page);
    await editLink(page).click();
    await rowInput(page, 0).fill("Never kept");
    await cancel(page).click();
    await expect(editor(page)).toBeHidden();
    await expect(shownLines(page).filter({ hasText: "Server one" })).toBeVisible();
    expect(puts).toEqual([]);
  });

  test("Save with nothing changed leaves the lyrics as found", async ({ page }) => {
    const { puts } = await setUp(page);
    await editLink(page).click();
    await save(page).click();
    await expect(editor(page)).toBeHidden();
    expect(puts).toEqual([]);
    await expect(page.locator(".lyrics-match-meta")).not.toContainText("Your lyrics");
  });

  test("the lines to time are flagged, by lines with words, with the way into Sync lines", async ({ page }) => {
    await setUp(page, { server: yours({ untimed_lines: [0, 2] }) });
    await expect(page.locator(".lyrics-line.untimed")).toHaveText(["Server one", "Server three"]);
    await expect(page.locator(".lyrics-line.untimed").first()).toHaveAttribute("data-flag", "needs timing");
    const note = page.locator(".lyrics-untimed");
    await expect(note).toContainText("Lines needing timing: 2");
    await note.getByRole("button").click();
    await expect(page.locator("#lyricsSync")).toBeVisible();
    await expect(note).toBeHidden();
  });

  test("timing by hand or from the vocals overrides the flags", async ({ page }) => {
    const user = "[00:00.50] Server one\n[00:02.00] Server two\n[00:04.00] Server three";
    await setUp(page, { server: yours({ untimed_lines: [0], user_synced: user }) });
    await expect(shownLines(page).first()).toBeVisible();
    await expect(page.locator(".lyrics-line.untimed")).toHaveCount(0);
    await expect(page.locator(".lyrics-untimed")).toBeHidden();
  });

  test("a refused edit stays open with the server's words", async ({ page }) => {
    await setUp(page, { onPut: (route) => answer(route, 422, { detail: "Line 2 has a timestamp inside it." }) });
    await editLink(page).click();
    await rowInput(page, 1).fill("Words [01:00 more");
    await save(page).click();
    await expect(message(page)).toHaveText("Line 2 has a timestamp inside it.");
    await expect(message(page)).toHaveClass(/error/);
    await expect(rowInput(page, 1)).toHaveValue("Words [01:00 more");
    await expect(save(page)).toBeEnabled();
  });

  test("Chinese, Japanese and Korean lines are tagged while typed and when shown", async ({ page }) => {
    await setUp(page);
    await editLink(page).click();
    await rowInput(page, 0).fill("夜に駆ける");
    await expect(rowInput(page, 0)).toHaveAttribute("lang", "ja");
    await rowInput(page, 1).fill("사랑해");
    await expect(rowInput(page, 1)).toHaveAttribute("lang", "ko");
    await rowInput(page, 1).fill("Plain again");
    await expect(rowInput(page, 1)).not.toHaveAttribute("lang");
    await save(page).click();
    await expect(shownText(page).first()).toHaveAttribute("lang", "ja");
  });

  test("markup in a line stays text", async ({ page }) => {
    await setUp(page);
    await editLink(page).click();
    await rowInput(page, 0).fill('<img src=x onerror="window.__pwned=1">');
    await save(page).click();
    await expect(shownText(page).first()).toHaveText('<img src=x onerror="window.__pwned=1">');
    await expect(page.locator("#lyricsBody img")).toHaveCount(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });
});

test.describe("the app's keys while editing", () => {
  test("typing a space in a line does not start playback", async ({ page }) => {
    await setUp(page);
    await editLink(page).click();
    await rowInput(page, 0).focus();
    await page.keyboard.press("Space");
    expect(await isPlaying(page)).toBe(false);
    await expect(rowInput(page, 0)).toHaveValue(/^.{11}$/);
  });

  test("Space on the editor's buttons does not start playback, and Backspace does not trash the track", async ({ page }) => {
    await setUp(page);
    await editLink(page).click();
    await rowAction(page, 0, "Add a line below").focus();
    await page.keyboard.press("Backspace");
    await cancel(page).focus();
    await page.keyboard.press("Backspace");
    await expect(editor(page)).toBeVisible();
    await page.locator(".rail-library").click();
    await expect(page.locator(`.cat-item[data-id="${JOB_ID}"]`).first()).toBeVisible();
    await page.locator(".rail-lyrics").click();
    await rowAction(page, 0, "Delete this line").focus();
    await page.keyboard.press("Space");
    await expect(page.locator(".lyrics-edit-input")).toHaveCount(2);
    expect(await isPlaying(page)).toBe(false);
  });
});

test.describe("supplying lyrics", () => {
  for (const [name, content] of [["empty.txt", ""], ["blank.lrc", " \n\t\n"], ["bom.txt", "\uFEFF"]]) {
    test(`a file with no words is refused and changes nothing: ${name}`, async ({ page }) => {
      const { puts } = await setUp(page);
      await supplyLink(page).click();
      await pasteBox(page).fill("Typed before");
      await page.locator(".lyrics-supply-file").setInputFiles(lyricsFile(name, content));
      await expect(message(page)).toHaveText("This file is empty, so there are no lyrics to use.");
      await expect(message(page)).toHaveClass(/error/);
      await expect(pasteBox(page)).toHaveValue("Typed before");
      expect(puts).toEqual([]);
    });
  }

  test("pasted text goes up without keep_timing and can be timed with Sync lines", async ({ page }) => {
    const { puts } = await setUp(page, { server: null, original: null });
    await pasteAndSave(page, "Pasted one\nPasted two");
    await expect(editor(page)).toBeHidden();
    expect(puts).toEqual([{ text: "Pasted one\nPasted two" }]);
    await expect(shownText(page)).toHaveText(["Pasted one", "Pasted two"]);
    await expect(page.locator(".lyrics-untimed")).toContainText("no timing yet");

    const synced = [];
    await page.route(`**/api/jobs/${JOB_ID}/lyrics/user-synced`, (route) => {
      synced.push(route.request().postDataJSON().synced);
      return answer(route, 200, { user_synced: synced.at(-1) });
    });
    const toggle = page.locator(".lyrics-tools .lyrics-sync-toggle");
    await expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    await toggle.click();
    await expect(page.locator("#lyricsSync")).toBeVisible();
    await expect(shownLines(page)).toHaveText(["Pasted one", "Pasted two"]);
    await page.keyboard.press("t");
    await expect.poll(() => synced.at(-1)).toContain("Pasted two");
    expect(synced.at(-1)).toContain("Pasted one");
  });

  test("Sync lines left untouched puts the plain text back, with nothing saved", async ({ page }) => {
    const synced = [];
    await page.route(`**/api/jobs/${JOB_ID}/lyrics/user-synced`, (route) => {
      synced.push(1);
      return answer(route, 200, {});
    });
    await setUp(page, { server: yours({ synced: "", plain: "Plain one\nPlain two", has_original: false }) });
    await page.locator(".lyrics-tools .lyrics-sync-toggle").click();
    await expect(shownLines(page)).toHaveCount(2);
    await page.locator("#lyricsSync .lyrics-align-done").click();
    await expect(shownLines(page)).toHaveCount(0);
    await expect(shownText(page)).toHaveText(["Plain one", "Plain two"]);
    expect(synced).toEqual([]);
  });

  test("an .lrc file goes up as it is, without keep_timing", async ({ page }) => {
    const lrc = "[00:01.00] Filed one\n[00:02.00] Filed two";
    const { puts } = await setUp(page, {
      onPut: (route, body, kept) => {
        kept.lyrics = yours({ synced: body.text, plain: "Filed one\nFiled two" });
        return answer(route, 200, kept.lyrics);
      },
    });
    await loadFile(page, "song.lrc", lrc);
    await expect(pasteBox(page)).toHaveValue(lrc);
    await expect(message(page)).toContainText("song.lrc");
    await save(page).click();
    await expect(editor(page)).toBeHidden();
    expect(puts).toEqual([{ text: lrc }]);
    await expect(shownLines(page)).toHaveText(["Filed one", "Filed two"]);
  });

  test("a .txt file loads as plain text", async ({ page }) => {
    const { puts } = await setUp(page);
    await loadFile(page, "song.TXT", "Typed one\nTyped two");
    await save(page).click();
    await expect(editor(page)).toBeHidden();
    expect(puts).toEqual([{ text: "Typed one\nTyped two" }]);
  });

  test("a file too big is refused without being read", async ({ page }) => {
    const { puts } = await setUp(page);
    await supplyLink(page).click();
    await page.evaluate(() => {
      window.__read = false;
      const real = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function arrayBufferSpy() {
        window.__read = true;
        return real.call(this);
      };
    });
    await page.locator(".lyrics-supply-file").setInputFiles(lyricsFile("huge.lrc", Buffer.alloc(400_001, 0x61)));
    await expect(message(page)).toHaveText("Too long: lyrics can be at most 100,000 characters.");
    await expect(message(page)).toHaveClass(/error/);
    await expect(pasteBox(page)).toHaveValue("");
    expect(await page.evaluate(() => window.__read)).toBe(false);
    expect(puts).toEqual([]);
  });

  test("a binary file is refused", async ({ page }) => {
    const { puts } = await setUp(page);
    await loadFile(page, "cover.txt", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x1a]));
    await expect(message(page)).toHaveText("This file is not UTF-8 text, so it cannot be used as lyrics.");
    await expect(pasteBox(page)).toHaveValue("");
    expect(puts).toEqual([]);
  });

  test("another kind of file is refused", async ({ page }) => {
    await setUp(page);
    await loadFile(page, "cover.png", "not lyrics");
    await expect(message(page)).toHaveText("Only .lrc and .txt files can be loaded.");
  });

  test("a sentence from the server is shown as it is", async ({ page }) => {
    await setUp(page, { onPut: (route) => answer(route, 422, { detail: "There are no lyrics in this." }) });
    await pasteAndSave(page, "   ");
    await expect(message(page)).toHaveText("There are no lyrics in this.");
  });

  test("list-shaped detail is never shown as an object", async ({ page }) => {
    await setUp(page, {
      onPut: (route) => answer(route, 422, { detail: [{ loc: ["body", "text"], msg: "field required", type: "missing" }] }),
    });
    await pasteAndSave(page, "Words");
    await expect(message(page)).toHaveText("The server could not do this (error 422). Try again.");
    await expect(message(page)).not.toContainText("[object");
    await expect(pasteBox(page)).toHaveValue("Words");
  });

  test("a 413 has a clear message", async ({ page }) => {
    await setUp(page, { onPut: (route) => answer(route, 413, { detail: "body too large" }) });
    await pasteAndSave(page, "Words");
    await expect(message(page)).toHaveText("Too long: lyrics can be at most 100,000 characters.");
  });

  test("a network failure has a clear message, and keeps the text", async ({ page }) => {
    await setUp(page, { onPut: (route) => route.abort("internetdisconnected") });
    await pasteAndSave(page, "Words");
    await expect(message(page)).toHaveText("Could not reach the server. Check the connection and try again.");
    await expect(pasteBox(page)).toHaveValue("Words");
  });

  test("a song with no lyrics found can still be given some", async ({ page }) => {
    await setUp(page, { server: null, original: null });
    await expect(page.locator("#lyricsStatus")).not.toBeEmpty();
    await expect(editLink(page)).toBeHidden();
    await expect(supplyLink(page)).toBeVisible();
  });
});

test.describe("the user's lyrics come first", () => {
  test("over a lookup this session that kept nothing", async ({ page }) => {
    const { kept, lookups } = await setUp(page, {
      server: null,
      original: null,
      onLookup: (route) => answer(route, 404, {}),
    });
    await expect(page.locator("#lyricsStatus")).toContainText("No lyrics found");
    kept.lyrics = yours({ has_original: false });
    await openTrackFromLibrary(page, JOB_ID);
    await expect(shownLines(page)).toHaveText(SYNCED_ROWS);
    expect(lookups).toHaveLength(1);
    await expect(page.locator(".lyrics-match-meta")).toContainText("Your lyrics");
  });

  test("and survive a reload", async ({ page }) => {
    await setUp(page);
    await pasteAndSave(page, "Mine one\nMine two");
    await expect(shownText(page)).toHaveText(["Mine one", "Mine two"]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().dblclick();
    await page.locator(".rail-lyrics").click();
    await expect(shownText(page)).toHaveText(["Mine one", "Mine two"]);
    expect(await stored(page)).toBeNull();
  });

  test("and no version is offered in their place", async ({ page }) => {
    const other = found({ lrclib_id: 202, album: "Live", plain: "Live words", synced: "" });
    await setUp(page, { server: yours({ others: [other] }) });
    await expect(shownLines(page)).toHaveText(SYNCED_ROWS);
    await expect(page.locator(".lyrics-tools")).not.toContainText("Other versions");
    await expect(page.locator(".lyrics-version")).toHaveCount(0);
  });

  test("a lookup still running when lyrics are saved does not replace them", async ({ page }) => {
    let release = null;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await setUp(page, {
      server: null,
      original: null,
      // The tab aborts it, so the answer has nowhere to go.
      onLookup: async (route) => {
        await held;
        await answer(route, 200, found({ lrclib_id: 300, plain: "Looked up", synced: "" })).catch(() => {});
      },
    });
    await expect(page.locator("#lyricsStatus")).toContainText("Searching");
    await pasteAndSave(page, "Mine one");
    await expect(shownText(page)).toHaveText(["Mine one"]);
    release();
    await page.waitForTimeout(300);
    await expect(shownText(page)).toHaveText(["Mine one"]);
  });
});

test.describe("going back", () => {
  test("to what was replaced, offered only when there is something", async ({ page }) => {
    const { deletes } = await setUp(page, { server: yours() });
    await expect(restore(page)).toHaveText("Back to original");
    await restore(page).click();
    await expect(page.locator(".lyrics-match-meta")).toHaveText("Fixture Band · Studio");
    await expect(shownLines(page)).toHaveText(SYNCED_ROWS);
    await expect(restore(page)).toHaveCount(0);
    expect(deletes).toHaveLength(1);
  });

  test("with no original, Remove lyrics drops them and keeps the removal on the server", async ({ page }) => {
    const other = found({ lrclib_id: 202, album: "Live", plain: "Live words", synced: "", duration: 300 });
    const { deletes, choices, kept } = await setUp(page, {
      server: yours({ has_original: false }),
      onDelete: (route, held) => {
        held.lyrics = { others: [other] };
        return answer(route, 404, held.lyrics);
      },
    });
    await expect(restore(page)).toHaveText("Remove lyrics");
    await restore(page).click();
    await expect(page.locator("#lyricsStatus")).toHaveText("Lyrics removed for this track.");
    await expect(page.locator(".lyrics-version")).toHaveCount(0);
    expect(deletes).toHaveLength(1);
    expect(choices.map((c) => c.method)).toEqual(["DELETE"]);
    expect(kept.lyrics).toEqual(LYRICS_REMOVED);
    expect(await stored(page)).toBeNull();
  });

  test("a 404 with nothing leaves the track with nothing, and a way to supply some", async ({ page }) => {
    await setUp(page, {
      server: yours({ has_original: false }),
      onDelete: (route, kept) => {
        kept.lyrics = null;
        return answer(route, 404, { detail: "no lyrics" });
      },
    });
    await restore(page).click();
    await expect(shownLines(page)).toHaveCount(0);
    await expect(supplyLink(page)).toBeVisible();
    await expect(editLink(page)).toBeHidden();
  });

  test("a refusal says so and leaves the lyrics", async ({ page }) => {
    await setUp(page, {
      server: yours(),
      onDelete: (route) => answer(route, 500, { detail: "could not restore lyrics" }),
    });
    await restore(page).click();
    await expect(page.locator("#lyricsStatus")).toHaveText("could not restore lyrics");
    await expect(page.locator("#lyricsStatus")).toHaveClass(/error/);
    await expect(shownLines(page)).toHaveText(SYNCED_ROWS);
  });

  test("offline says so", async ({ page }) => {
    await setUp(page, { server: yours(), onDelete: (route) => route.abort("internetdisconnected") });
    await restore(page).click();
    await expect(page.locator("#lyricsStatus")).toHaveText("Could not reach the server. Check the connection and try again.");
  });
});

test.describe("switching track", () => {
  function holding() {
    let release = null;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    return { held, release };
  }

  test("an unsaved edit is put aside and comes back with the track", async ({ page }) => {
    const { puts } = await setUp(page);
    await editLink(page).click();
    await rowInput(page, 0).fill("Half typed");
    await openTrackFromLibrary(page, SIBLING_JOB_ID);
    await expect(editor(page)).toBeHidden();
    await openTrackFromLibrary(page, JOB_ID);
    await expect(rowInput(page, 0)).toHaveValue("Half typed");
    await expect(message(page)).toHaveText("Your unsaved changes for this track were kept.");
    expect(puts).toEqual([]);
    await cancel(page).click();
    await expect(editor(page)).toBeHidden();
    await openTrackFromLibrary(page, SIBLING_JOB_ID);
    await openTrackFromLibrary(page, JOB_ID);
    await expect(editor(page)).toBeHidden();
  });

  test("an editor with no changes is simply closed", async ({ page }) => {
    await setUp(page);
    await editLink(page).click();
    await openTrackFromLibrary(page, SIBLING_JOB_ID);
    await openTrackFromLibrary(page, JOB_ID);
    await expect(editor(page)).toBeHidden();
    await expect(shownLines(page)).toHaveText(SYNCED_ROWS);
  });

  test("a save answered after a switch does not paint on the new track", async ({ page }) => {
    const { held, release } = holding();
    const { kept } = await setUp(page, {
      onPut: async (route, body, state) => {
        await held;
        state.lyrics = yours({ synced: "", plain: body.text });
        return answer(route, 200, state.lyrics);
      },
    });
    await pasteAndSave(page, "Late words");
    await openTrackFromLibrary(page, SIBLING_JOB_ID);
    await expect(editor(page)).toBeHidden();
    release();
    await expect.poll(() => kept.lyrics?.plain).toBe("Late words");
    await page.waitForTimeout(300);
    await expect(shownText(page)).toHaveCount(0);
    await expect(page.locator(".lyrics-match-meta")).toHaveCount(0);
    await expect(editor(page)).toBeHidden();

    await openTrackFromLibrary(page, JOB_ID);
    await expect(shownText(page)).toHaveText(["Late words"]);
    await expect(editor(page)).toBeHidden();
  });

  test("a save refused after a switch is waiting with its text on the way back", async ({ page }) => {
    const { held, release } = holding();
    await setUp(page, {
      onPut: async (route) => {
        await held;
        return answer(route, 422, { detail: "There are no lyrics in this." });
      },
    });
    await pasteAndSave(page, "Doomed words");
    await openTrackFromLibrary(page, SIBLING_JOB_ID);
    release();
    await page.waitForTimeout(300);
    await expect(editor(page)).toBeHidden();
    await openTrackFromLibrary(page, JOB_ID);
    await expect(pasteBox(page)).toHaveValue("Doomed words");
    await expect(message(page)).toHaveText("There are no lyrics in this.");
  });

  test("going back, answered after a switch, does not paint on the new track", async ({ page }) => {
    const { held, release } = holding();
    await setUp(page, {
      server: yours(),
      onDelete: async (route, state) => {
        await held;
        state.lyrics = found();
        return answer(route, 200, state.lyrics);
      },
    });
    await restore(page).click();
    await openTrackFromLibrary(page, SIBLING_JOB_ID);
    release();
    await page.waitForTimeout(300);
    await expect(shownLines(page)).toHaveCount(0);
  });
});
