import { test, expect } from "@playwright/test";
import { KEY, seedLibrary, stubUpdateCheck, uiText } from "./helpers.mjs";
import { PASTE, paste, preview, queueButton, review, stubImports, stubPreview } from "./batchImport.mjs";

const SIZES = [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }];
const COLLAPSED_KEY = "stemdeck.catalog.collapsed";
const SEARCH_ITEMS = [{ title: "The Best", duration: 250, uploader: "Tina Turner", thumbnail: null, too_long: false, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }];
const AUDIO_NAME = "dropped.wav";
const AUDIO_BYTES = 64;
const MAX_DURATION_SEC = 1200;
const TYPING_DELAY_MS = 25;
const CENTRE_SLACK_PX = 1;

const popover = (page) => page.locator("#composerDrawer");
const badge = (page) => page.locator("#addSongReviewBadge");
const addSong = (page) => page.locator("#addSongBtn");

async function openApp(page, size = SIZES[0]) {
  await page.setViewportSize(size);
  await seedLibrary(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await addSong(page).waitFor();
}

async function stubSearch(page) {
  await page.route("**/api/search", (route) => route.fulfill({
    json: { items: SEARCH_ITEMS, max_duration_sec: MAX_DURATION_SEC, cached: false },
  }));
}

/** A drag carrying one audio file, fired at the body: the gesture used anywhere in the window. */
async function dragFile(page, type) {
  await page.evaluate(([name, bytes, eventType]) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], name, { type: "audio/wav" }));
    document.body.dispatchEvent(new DragEvent(eventType, { dataTransfer: data, bubbles: true, cancelable: true }));
  }, [AUDIO_NAME, AUDIO_BYTES, type]);
}

const viewportBox = (page) => page.evaluate(() => ({ width: innerWidth, height: innerHeight }));

for (const size of SIZES) {
  test(`Add song opens the whole import form inside the window at ${size.width}px`, async ({ page }) => {
    await openApp(page, size);
    await expect(popover(page)).toBeHidden();
    await addSong(page).click();

    await expect(popover(page)).toBeVisible();
    await expect(addSong(page)).toHaveAttribute("aria-expanded", "true");
    await expect(popover(page).getByRole("heading")).toHaveText(await uiText(page, "addsong.title"));
    for (const id of ["url", "uploadFileBtn", "addFolderBtn", "stemAllBtn", "vocalModeToggle", "autoSectionsBtn", "submit"]) {
      await expect(popover(page).locator(`#${id}`), id).toBeVisible();
    }
    await expect(page.locator("#url")).toBeFocused();

    const box = await popover(page).boundingBox();
    const button = await addSong(page).boundingBox();
    const view = await viewportBox(page);
    expect(box.y).toBeGreaterThanOrEqual(button.y + button.height);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  });
}

test("Esc, a click outside and Add song itself each close the popover", async ({ page }) => {
  await openApp(page);
  await addSong(page).click();
  await page.keyboard.press(KEY.ESCAPE);
  await expect(popover(page)).toBeHidden();
  await expect(addSong(page)).toBeFocused();
  await expect(addSong(page)).toHaveAttribute("aria-expanded", "false");

  await addSong(page).click();
  await page.locator("#emptyStartTitle").click();
  await expect(popover(page)).toBeHidden();

  await addSong(page).click();
  await addSong(page).click();
  await expect(popover(page)).toBeHidden();
});

test("Esc closes the search results first, then the popover", async ({ page }) => {
  await stubSearch(page);
  await openApp(page);
  await addSong(page).click();
  await page.locator("#url").pressSequentially("best ", { delay: TYPING_DELAY_MS });
  await expect(page.locator(".search-row").first()).toBeVisible();

  await page.locator(".search-tab").nth(1).click();
  await expect(popover(page), "a click in the results is not a click outside").toBeVisible();
  await expect(page.locator(".search-panel")).toBeVisible();
  await page.locator("#url").focus();
  await page.keyboard.press(KEY.ESCAPE);
  await expect(page.locator(".search-panel")).toBeHidden();
  await expect(popover(page)).toBeVisible();

  await page.keyboard.press(KEY.ESCAPE);
  await expect(popover(page)).toBeHidden();
});

test("a pasted list opens the review as a dialog over the whole page, and Esc keeps the batch", async ({ page }) => {
  await openApp(page);
  await stubPreview(page, preview());
  await addSong(page).click();
  await paste(page, PASTE);

  await expect(review(page)).toBeVisible();
  await expect(review(page)).toHaveAttribute("aria-modal", "true");
  await expect(popover(page)).toBeHidden();
  const view = await viewportBox(page);
  expect(await page.locator(".batch-scrim").boundingBox()).toEqual({ x: 0, y: 0, ...view });
  const box = await review(page).boundingBox();
  expect(Math.abs(box.x + box.width / 2 - view.width / 2)).toBeLessThanOrEqual(CENTRE_SLACK_PX);
  expect(Math.abs(box.y + box.height / 2 - view.height / 2)).toBeLessThanOrEqual(CENTRE_SLACK_PX);

  await expect(review(page).locator(".batch-queue")).toBeEnabled();
  await page.keyboard.press(KEY.ESCAPE);
  await expect(review(page)).toHaveCount(0);
  await expect(addSong(page)).toBeFocused();
  await addSong(page).click();
  await expect(page.locator("#filePill")).toBeVisible();
  const held = preview().items.length;
  await expect(page.locator("#submit")).toHaveText(await uiText(page, "batch.review.other", { count: held }));
});

test("files dragged anywhere over the window show the drop overlay, and the drop still stages them", async ({ page }) => {
  await openApp(page);
  const overlay = page.locator("#dropOverlay");
  await expect(overlay).toBeHidden();

  await dragFile(page, "dragenter");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveText(await uiText(page, "batch.dropHere"));
  await dragFile(page, "dragleave");
  await expect(overlay).toBeHidden();

  await dragFile(page, "dragenter");
  await dragFile(page, "drop");
  await expect(overlay).toBeHidden();
  await expect(popover(page)).toBeVisible();
  await expect(page.locator("#fileName")).toHaveText(AUDIO_NAME);
});

test("the empty studio's buttons open Add song on their action", async ({ page }) => {
  await openApp(page);
  const start = page.locator("#emptyStart");
  for (const id of ["emptyStartUpload", "emptyStartFolder"]) {
    const chooser = page.waitForEvent("filechooser");
    await start.locator(`#${id}`).click();
    await chooser;
    await expect(popover(page), id).toBeVisible();
    await page.keyboard.press(KEY.ESCAPE);
    await expect(popover(page)).toBeHidden();
  }
  await start.locator("#emptyStartLink").click();
  await expect(popover(page)).toBeVisible();
  await expect(page.locator("#url")).toBeFocused();
});

test("Browse library sits beside them and opens Browse library from a collapsed sidebar", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "1"), COLLAPSED_KEY);
  await openApp(page);
  await expect(page.locator(".app")).toHaveClass(/\bcat-collapsed\b/);
  const browse = page.locator("#emptyStart #emptyStartBrowse");
  await expect(browse).toHaveText(await uiText(page, "addsong.browseLibrary"));

  await browse.click();
  await expect(page.locator("#browseLibrary")).toBeVisible();
  await expect(page.locator("#browseSearch")).toBeFocused();
});

/** Paste a list, then close its review with Esc so the batch waits. */
async function holdBatch(page) {
  await stubPreview(page, preview());
  await addSong(page).click();
  await paste(page, PASTE);
  await expect(queueButton(page)).toBeEnabled();
  await expect(badge(page), "hidden while the review is open").toBeHidden();
  await page.keyboard.press(KEY.ESCAPE);
}

test("a waiting batch shows its count on Add song's corner, and the badge reopens its review", async ({ page }) => {
  await openApp(page);
  const posts = await stubImports(page);
  await expect(badge(page)).toBeHidden();
  await holdBatch(page);

  const held = preview().items.length;
  const label = await uiText(page, "batch.review.other", { count: held });
  await expect(badge(page)).toHaveText(String(held));
  await expect(badge(page)).toHaveAttribute("title", label);
  await expect(badge(page)).toHaveAttribute("aria-label", label);
  const badgeBox = await badge(page).boundingBox();
  const buttonBox = await addSong(page).boundingBox();
  const buttonRight = buttonBox.x + buttonBox.width;
  expect(badgeBox.x, "it straddles Add song's right edge").toBeLessThan(buttonRight);
  expect(badgeBox.x + badgeBox.width).toBeGreaterThan(buttonRight);
  expect(badgeBox.y, "on its top corner").toBeLessThan(buttonBox.y + buttonBox.height / 2);

  await badge(page).click();
  await expect(review(page)).toBeVisible();
  await expect(badge(page)).toBeHidden();
  await queueButton(page).click();
  await expect.poll(() => posts.length).toBeGreaterThan(0);
  await expect(review(page)).toHaveCount(0);
  await expect(badge(page), "gone once the batch is imported").toBeHidden();
});

test("clearing the waiting batch's chip takes the badge away", async ({ page }) => {
  await openApp(page);
  await holdBatch(page);
  await expect(badge(page)).toBeVisible();
  await addSong(page).click();
  await page.locator("#fileClear").click();
  await expect(badge(page)).toBeHidden();
});
