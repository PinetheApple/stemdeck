// A rename or a heart refused while StemData moves says to wait for the move (#177).
// The server's side is tests/test_stems_move_guard_edits_api.py.
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, failureMessages, openStudio, stubAudioTags, uiText } from "./helpers.mjs";
import { EDIT_FOLDER_MOVING_DETAIL, FOLDER_MOVING_KEY } from "../../static/js/folderMoving.js";
import { HTTP_CONFLICT } from "../../static/js/lyricsTranscribe.js";

test.use({ viewport: { width: 1600, height: 900 } });

const refuse = (route) => route.fulfill({
  status: HTTP_CONFLICT,
  contentType: "application/json",
  body: JSON.stringify({ detail: EDIT_FOLDER_MOVING_DETAIL }),
});

function refuseRenames(route) {
  return route.request().method() === "PATCH" ? refuse(route) : route.continue();
}

test("a rename refused for the move says to wait for it", async ({ page }) => {
  await stubAudioTags(page, null);
  await openStudio(page);
  await page.route(`**/api/jobs/${JOB_ID}`, refuseRenames);
  const moving = await uiText(page, FOLDER_MOVING_KEY);

  await page.locator("#title").click();
  await page.locator("#songHead .rename-title").fill("Not saved");
  await page.locator("#songHead .rename-title").press("Enter");

  await expect(page.locator("#songHead .rename-error")).toHaveText(moving);
});

test("a heart refused for the move is taken back and says to wait for it", async ({ page }) => {
  await openStudio(page);
  await page.route("**/api/jobs/*/favorite", refuse);
  const moving = await uiText(page, FOLDER_MOVING_KEY);
  const row = page.locator(`#catalogList .cat-item[data-id="${SIBLING_JOB_ID}"]`).first();

  await row.hover();
  await row.locator(".cat-fav").click();

  await expect.poll(() => failureMessages(page)).toContain(moving);
  await expect(row).not.toHaveClass(/\bis-fav\b/);
});
