// A track can be favourited at any window width (#724).
//
// Every song's menu offers Add to or Remove from Favorites, a Browse library
// card has a heart on its cover, and every heart goes through one toggle, so
// they cannot disagree with the song head's.

import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, chooseFromSongMenu, openStudio, readCatalogState, openBrowse, browseRow } from "./helpers.mjs";

const row = (page, id) => page.locator(`#catalogList .cat-item[data-id="${id}"]`).first();
const cardHeart = (page, id) => browseRow(page, id).locator(".song-card-fav");
const favoriteIn = async (page, id) => Boolean((await readCatalogState(page))?.tracks?.[id]?.favorite);

test.describe("favourites at a narrow window", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a song's menu can favourite a track that is not the one playing", async ({ page }) => {
    await openStudio(page);

    await chooseFromSongMenu(page, row(page, SIBLING_JOB_ID), "Add to Favorites");

    expect(await favoriteIn(page, SIBLING_JOB_ID)).toBe(true);
    await expect(row(page, SIBLING_JOB_ID)).toHaveClass(/\bis-fav\b/);
    // The menu is not a way of opening the track.
    await expect(row(page, JOB_ID)).toHaveClass(/\bactive\b/);
    await expect(row(page, SIBLING_JOB_ID)).not.toHaveClass(/\bactive\b/);
  });

  test("the Favorites view can take a track back out with the card's heart", async ({ page }) => {
    await openStudio(page);
    await chooseFromSongMenu(page, row(page, SIBLING_JOB_ID), "Add to Favorites");

    await openBrowse(page, "fav");
    await expect(browseRow(page, SIBLING_JOB_ID)).toBeVisible();
    await expect(cardHeart(page, SIBLING_JOB_ID)).toHaveAttribute("aria-pressed", "true");
    await cardHeart(page, SIBLING_JOB_ID).click();

    await expect(browseRow(page, SIBLING_JOB_ID)).toHaveCount(0);
    expect(await favoriteIn(page, SIBLING_JOB_ID)).toBe(false);
  });

  test("keyboard focus reveals the card heart", async ({ page }) => {
    await openStudio(page);
    await openBrowse(page);
    await browseRow(page, SIBLING_JOB_ID).focus();
    await page.keyboard.press("ArrowRight");
    await expect(cardHeart(page, SIBLING_JOB_ID)).toBeFocused();
    await expect(cardHeart(page, SIBLING_JOB_ID)).toBeVisible();
  });
});

test.describe("favourites at a wide window", () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test("the song menu, the card heart and the Now Playing heart stay in step", async ({ page }) => {
    await openStudio(page);
    const npHeart = page.locator("#fav-btn");
    await expect(npHeart).toBeVisible();
    await expect(npHeart).toHaveAttribute("aria-pressed", "false");

    await chooseFromSongMenu(page, row(page, JOB_ID), "Add to Favorites");
    await expect(npHeart).toHaveAttribute("aria-pressed", "true");

    await npHeart.click();
    await openBrowse(page);
    await expect(cardHeart(page, JOB_ID)).toHaveAttribute("aria-pressed", "false");
    expect(await favoriteIn(page, JOB_ID)).toBe(false);
  });
});
