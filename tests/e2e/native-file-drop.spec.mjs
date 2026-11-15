// A file dropped on the desktop app on Linux arrives through the shell, and is
// treated exactly as one dropped anywhere else.
//
// WebKitGTK never gives the page a dropped file. The drag reports its types as
// text/uri-list and text/html, never "Files", so file-drop.spec.mjs's HTML5
// path does not see it, and at drop time there is no File to take even if it
// did. Left alone, WebKit navigated the window to the file or typed its URI
// into the URL box (#672). On Linux the shell takes the drop instead
// (desktop/src-tauri/src/dropin.rs) and the page asks it what arrived.
//
// What these cover is the page's half of that contract, against a stand-in for
// the shell that answers the same three commands the same way. The Rust half
// has its own tests in dropin.rs. No test here drives the real shell, so a
// fault that lives only in Rust will not show up in this file.
import { test, expect } from "@playwright/test";
import {
  seedLibrary,
  stubTauri,
  stubExportEndpoints,
  stubUpdateCheck,
  uiText,
} from "./helpers.mjs";
import { MAX_DURATION_SEC, review, row, stubPreview } from "./batchImport.mjs";
import { MAX_BATCH_FILES } from "../../static/js/batchImportModel.js";

const MB = 1024 * 1024;

/**
 * Replaces the shell's three drop commands with a controllable stand-in.
 *
 * Registered after stubTauri, so it wraps the invoke that stub installed.
 * `window.__shell.emit(signal)` is a drag event reaching the shell; the page's
 * waiting next_drop_signal call is answered from a log by cursor, the way
 * DropInbox answers it.
 */
async function standInShell(page, { native = true } = {}) {
  await page.addInitScript((nativeDrop) => {
    const inner = window.__TAURI__.core.invoke;
    let seq = 0;
    const log = [];
    let waiting = [];
    const shell = {
      calls: [],
      reads: [],
      picks: [],
      picked: null,
      pickFails: false,
      unreadable: new Set(),
      sizes: {},
      emit(signal) {
        seq += 1;
        log.push([seq, signal]);
        waiting = waiting.filter((tryAnswer) => !tryAnswer());
      },
    };
    window.__shell = shell;
    window.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd === "native_file_drop" || cmd === "next_drop_signal" || cmd === "read_dropped_file") {
        shell.calls.push(cmd);
      }
      if (cmd === "native_file_drop") return Promise.resolve(nativeDrop);
      if (cmd === "pick_import_folder") {
        // The shell's chooser hands the picked folder over as a drop.
        shell.picks.push(args);
        if (shell.pickFails) return Promise.reject("the dialog could not be shown");
        if (shell.picked) shell.emit(shell.picked);
        return Promise.resolve(null);
      }
      if (cmd === "next_drop_signal") {
        const after = args?.after ?? seq;
        return new Promise((resolve) => {
          const tryAnswer = () => {
            const hit = log.find(([s]) => s > after);
            if (!hit) return false;
            resolve({ seq: hit[0], signal: hit[1] });
            return true;
          };
          if (!tryAnswer()) waiting.push(tryAnswer);
        });
      }
      if (cmd === "read_dropped_file") {
        shell.reads.push(args.id);
        if (shell.unreadable.has(args.id)) {
          return Promise.reject("could not open the file: No such file or directory");
        }
        return Promise.resolve(new Uint8Array(shell.sizes[args.id] ?? 44).buffer);
      }
      return inner(cmd, args);
    };
  }, native);
}

async function openDesktop(page, opts) {
  await seedLibrary(page);
  await stubTauri(page);
  await standInShell(page, opts);
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // The watcher starts with the rest of the import wiring; wait for it to be
  // listening before any drag reaches the shell.
  await expect
    .poll(() => page.evaluate(() => window.__shell.calls.includes("next_drop_signal")))
    .toBe(opts?.native === false ? false : true);
}

/** A drag from the file manager, entering and then dropping. */
const drop = (page, files) =>
  page.evaluate((f) => {
    for (const d of f) window.__shell.sizes[d.id] = d.size;
    window.__shell.emit({ kind: "enter" });
    window.__shell.emit({ kind: "drop", files: f });
  }, files);

const FOLDER = [
  { id: 1, name: "a.wav", size: 1000, dir: "Rehearsal" },
  { id: 2, name: "setlist.pdf", size: 1000, dir: "Rehearsal" },
  { id: 3, name: "b.flac", size: 1000, dir: "Rehearsal/Live" },
  { id: 4, name: "c.m4a", size: 1000, dir: "Rehearsal/Live/Older" },
];

/** A folder dropped from the file manager, as the shell reports it: its files. */
const dropFolder = (page, files) =>
  page.evaluate((f) => {
    window.__shell.emit({ kind: "enter" });
    window.__shell.emit({ kind: "drop", folder: true, files: f });
  }, files);

const stubFolderPreview = (page, okNames = []) =>
  stubPreview(page, {
    items: [], playlists: [], max_duration_sec: MAX_DURATION_SEC, capacity_left: { links: 20, files: 20 },
    files: okNames.map((name) => ({ name, status: "ok", existing_job_id: null, replaces: null })),
  });

const state = (page) =>
  page.evaluate(() => {
    const armed = document.getElementById("fileInput")?._files || [];
    const err = document.getElementById("urlDropError");
    return {
      pill: !document.getElementById("filePill").classList.contains("hidden"),
      name: document.getElementById("fileName")?.textContent || "",
      armed: armed.map((f) => ({ name: f.name, size: f.size })),
      error: err && !err.classList.contains("hidden") ? err.textContent : "",
      hovering: document.querySelector(".url-wrap").classList.contains("drag-over"),
      reads: [...window.__shell.reads],
    };
  });

test.describe("a file dropped on the Linux desktop app", () => {
  test("arms the import like a file from the picker", async ({ page }) => {
    await openDesktop(page);
    await drop(page, [{ id: 7, name: "Take 3.flac", size: 3 * MB }]);

    await expect.poll(() => state(page).then((s) => s.pill)).toBe(true);
    const s = await state(page);
    expect(s.name).toBe("Take 3.flac");
    // The staged File carries the bytes the shell read, not just a name.
    expect(s.armed).toEqual([{ name: "Take 3.flac", size: 3 * MB }]);
    expect(s.reads).toEqual([7]);
    expect(s.error).toBe("");
  });

  test("a file that is not audio is refused without being read", async ({ page }) => {
    await openDesktop(page);
    await drop(page, [{ id: 1, name: "notes.txt", size: 10 }]);

    await expect.poll(() => state(page).then((s) => s.error)).toContain("MP3");
    const s = await state(page);
    expect(s.pill).toBe(false);
    expect(s.reads).toEqual([]);
  });

  test("a file over the limit is refused without being read", async ({ page }) => {
    // Screening happens on the name and size the shell reports, so a file that
    // is going to be turned away is never loaded into memory to find that out.
    await openDesktop(page);
    await drop(page, [{ id: 1, name: "huge.wav", size: 900 * MB }]);

    await expect.poll(() => state(page).then((s) => s.error)).toContain("too large");
    expect((await state(page)).reads).toEqual([]);
  });

  test("a dropped folder is reviewed with its subfolders, and only its audio is read", async ({ page }) => {
    await openDesktop(page);
    const asked = await stubFolderPreview(page, ["a.wav", "b.flac", "c.m4a"]);
    await dropFolder(page, FOLDER);

    await expect(review(page).locator(".batch-folder")).toHaveText([
      "Rehearsal", "Rehearsal / Live", "Rehearsal / Live / Older",
    ]);
    await expect(page.locator("#filePill")).toContainText("Rehearsal");
    await expect(row(page, "setlist.pdf").locator(".batch-flag-block")).toHaveText(await uiText(page, "batch.flag.notAudio"));
    await expect(row(page, "b.flac").locator("input")).toBeEnabled();
    expect((await state(page)).reads).toEqual([1, 3, 4]);
    expect(asked[0].files).toEqual(["a.wav", "b.flac", "c.m4a"]);
  });

  test("a dropped folder over the server's limit reads no more than it keeps", async ({ page }) => {
    await openDesktop(page);
    await stubFolderPreview(page);
    const over = 2;
    const files = Array.from({ length: MAX_BATCH_FILES + over }, (_, i) => ({
      id: i + 1, name: `${String(i).padStart(4, "0")}.wav`, size: 10, dir: "Archive",
    }));
    await dropFolder(page, files);

    await expect(review(page).locator(".batch-review-note")).toHaveText(
      await uiText(page, "batch.overCapFiles.other", { max: MAX_BATCH_FILES, count: over }),
    );
    expect((await state(page)).reads).toHaveLength(MAX_BATCH_FILES);
  });

  test("an empty folder says so", async ({ page }) => {
    await openDesktop(page);
    await dropFolder(page, []);

    await expect.poll(() => state(page).then((s) => s.error)).toBe(await uiText(page, "batch.emptyFolder"));
  });

  test("a folder the shell could not read says so", async ({ page }) => {
    await openDesktop(page);
    await page.evaluate(() => window.__shell.emit({ kind: "folderUnreadable" }));

    await expect.poll(() => state(page).then((s) => s.error)).toBe(await uiText(page, "batch.folderUnreadable"));
  });

  test("Add a folder opens the shell's chooser where the WebView has no folder picker", async ({ page }) => {
    // WebKitGTK leaves webkitdirectory off, so the page alone would hide the button.
    await page.addInitScript(() => { delete HTMLInputElement.prototype.webkitdirectory; });
    let webviewChoosers = 0;
    page.on("filechooser", function countWebviewChooser() { webviewChoosers += 1; });
    await openDesktop(page);
    await stubFolderPreview(page);
    await page.evaluate((files) => { window.__shell.picked = { kind: "drop", folder: true, files }; }, FOLDER);

    await expect(page.locator("#emptyStartFolder")).toBeVisible();
    await page.locator("#addFolderBtn").click();

    await expect(review(page).locator(".batch-folder").first()).toHaveText("Rehearsal");
    const picks = await page.evaluate(() => window.__shell.picks);
    expect(picks).toEqual([{ title: await uiText(page, "batch.addFolder") }]);
    expect(webviewChoosers).toBe(0);
  });

  test("a folder chooser that fails to open says so, not that a folder was unreadable", async ({ page }) => {
    await openDesktop(page);
    await page.evaluate(() => { window.__shell.pickFails = true; });
    await page.locator("#addFolderBtn").click();

    await expect.poll(() => state(page).then((s) => s.error)).toBe(await uiText(page, "settings.stemsLocation.pickerFailed"));
  });

  test("of a mixed drop, only the audio is read, and the rest is flagged in the review", async ({ page }) => {
    await openDesktop(page);
    await drop(page, [
      { id: 1, name: "a.wav", size: 1000 },
      { id: 2, name: "cover.jpg", size: 1000 },
      { id: 3, name: "b.mp3", size: 1000 },
    ]);

    const row = (name) => page.locator("#batchReview .batch-item", { hasText: name });
    await expect(row("cover.jpg").locator(".batch-flag-block")).toBeVisible();
    await expect(row("a.wav").locator("input")).toBeEnabled();
    await expect(row("b.mp3").locator("input")).toBeEnabled();
    expect((await state(page)).reads).toEqual([1, 3]);
  });

  test("a file that has gone by the time it is read says so, by name", async ({ page }) => {
    await openDesktop(page);
    await page.evaluate(() => window.__shell.unreadable.add(5));
    await drop(page, [{ id: 5, name: "moved.wav", size: 1000 }]);

    await expect.poll(() => state(page).then((s) => s.error)).toContain("moved.wav");
    expect((await state(page)).pill).toBe(false);
  });

  test("the URL zone lights while a drag is over the window", async ({ page }) => {
    // The HTML5 hover cue never fires on Linux either, for the same reason the
    // drop did not: the drag never says it carries files.
    await openDesktop(page);

    await page.evaluate(() => window.__shell.emit({ kind: "enter" }));
    await expect.poll(() => state(page).then((s) => s.hovering)).toBe(true);

    await page.evaluate(() => window.__shell.emit({ kind: "leave" }));
    await expect.poll(() => state(page).then((s) => s.hovering)).toBe(false);
  });

  test("keeps listening after a drop", async ({ page }) => {
    await openDesktop(page);
    await drop(page, [{ id: 1, name: "first.wav", size: 1000 }]);
    await expect.poll(() => state(page).then((s) => s.name)).toBe("first.wav");

    await drop(page, [{ id: 2, name: "second.wav", size: 1000 }]);
    await expect.poll(() => state(page).then((s) => s.name)).toBe("second.wav");
  });

  test("where the shell does not take drops, the page does not wait on it", async ({ page }) => {
    // Windows and macOS: the HTML5 path carries the files there, and a watcher
    // parked on a command that will never answer would be a call for nothing.
    await openDesktop(page, { native: false });
    await page.waitForTimeout(500);

    const calls = await page.evaluate(() => window.__shell.calls);
    expect(calls).toEqual(["native_file_drop"]);
  });
});
