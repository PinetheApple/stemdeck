// The footer control strip has to stay inside the width it has.
//
// It is `overflow-x: auto` with `flex: none` children, so when it stops fitting
// it does not reflow or complain, it just scrolls, and controls sit off the
// right-hand edge with nothing to say so. Measured before the fix against a
// real six-stem track: the strip wants 1443px, so it overflowed by 88px on a
// maximized 1080p window and by 472px at the 1536px logical viewport a 4K panel
// gets at 250% Windows scaling (#586). Nothing in the suite asserted on layout
// width at all, which is why it shipped.
//
// These run at the config's 1280x720 unless a test sets its own viewport.
import { test, expect } from "@playwright/test";
import { openStudio, waitForClickTrack } from "./helpers.mjs";

const stripFits = (page) =>
  page.evaluate(() => {
    const el = document.querySelector(".footer-clusters");
    // Sub-pixel layout means these are not exactly equal even when they fit.
    return el.scrollWidth - el.clientWidth <= 1;
  });

const collapseLevels = (page) =>
  page.evaluate(() =>
    [...document.querySelector(".footer-clusters").classList].filter((c) =>
      c.startsWith("collapse-"),
    ),
  );

const WINDOW_HEIGHT = 800;
const NARROW_WINDOW = { width: 1024, height: WINDOW_HEIGHT };
const WIDE_WIDTH = 1440;
const ROOMY_WIDTHS = [1280, WIDE_WIDTH];
const LIBRARY_STATES = ["open", "collapsed"];
const COLLAPSED_CLASS = "cat-collapsed";
const TRANSPORT_LABELS = [
  ".loop-btn-label",
  ".footer-group-speed > .footer-group-label",
  "#t-pitch-label",
];

const loopButtonWidth = (page) =>
  page.locator("#t-loop").evaluate((el) => el.getBoundingClientRect().width);

async function setLibrary(page, state) {
  const app = page.locator(".app");
  const collapsed = await app.evaluate(
    (el, cls) => el.classList.contains(cls),
    COLLAPSED_CLASS,
  );
  if (collapsed !== (state === "collapsed")) await page.locator("#sidebarCollapseBtn").click();
  if (state === "collapsed") await expect(app).toHaveClass(new RegExp(COLLAPSED_CLASS));
  else await expect(app).not.toHaveClass(new RegExp(COLLAPSED_CLASS));
}

async function expectLabelsReadable(page) {
  for (const selector of TRANSPORT_LABELS) await expect(page.locator(selector)).toBeVisible();
  await expect.poll(() => stripFits(page), { timeout: 5000 }).toBe(true);
}

test.describe("footer fit", () => {
  test("a wide window leaves the strip exactly as it was", async ({ page }) => {
    await page.setViewportSize({ width: 2200, height: 900 });
    await openStudio(page, { tauri: true });
    await waitForClickTrack(page, { revealOptions: false });

    expect(await collapseLevels(page)).toEqual([]);
    expect(await stripFits(page)).toBe(true);
  });

  test("the reporter's geometry no longer overflows", async ({ page }) => {
    // 4K at 250% Windows scaling. This is the window from the bug report.
    await page.setViewportSize({ width: 1536, height: 864 });
    await openStudio(page, { tauri: true });
    await waitForClickTrack(page, { revealOptions: false });

    expect(await stripFits(page)).toBe(true);
  });

  test("at 1280 every click control is on screen, with no disclosure", async ({ page }) => {
    // The click track moved out of the strip into the inspector's Tempo tab,
    // which has the room the footer never did: the options are always laid out
    // in full there, so the popover the strip once needed never opens.
    await page.setViewportSize({ width: 1280, height: 800 });
    await openStudio(page, { tauri: true });
    await waitForClickTrack(page);

    expect(await stripFits(page)).toBe(true);
    await expect(page.locator("#t-metro-more")).toBeHidden();
    for (const id of ["#t-metro", "#t-metro-vol-btn", "#t-metro-countin", "#t-metro-bar", "#t-metro-edit", "#tempoHalf"]) {
      await expect(page.locator(id)).toBeVisible();
    }
  });

  test("the strip opens back up when the room comes back", async ({ page }) => {
    // The fit re-measures from the uncollapsed state every time, so this is the
    // direction that catches a one-way ratchet.
    await page.setViewportSize({ width: 820, height: 800 });
    await openStudio(page, { tauri: true });
    await waitForClickTrack(page, { revealOptions: false });
    await expect.poll(() => collapseLevels(page), { timeout: 5000 }).toContain("collapse-tight");

    await page.setViewportSize({ width: 2200, height: 900 });
    await expect.poll(() => collapseLevels(page), { timeout: 5000 }).toEqual([]);
    expect(await stripFits(page)).toBe(true);
  });

  for (const library of LIBRARY_STATES) {
    test(`at 1024 with the library ${library} the transport keeps its labels and fits`, async ({ page }) => {
      await page.setViewportSize(NARROW_WINDOW);
      await openStudio(page, { tauri: true });
      await waitForClickTrack(page, { revealOptions: false });
      await setLibrary(page, library);

      await expectLabelsReadable(page);
    });
  }

  for (const width of ROOMY_WIDTHS) {
    test(`at ${width} the transport is left fully inline`, async ({ page }) => {
      await page.setViewportSize({ width, height: WINDOW_HEIGHT });
      await openStudio(page, { tauri: true });
      await waitForClickTrack(page, { revealOptions: false });

      await expect.poll(() => collapseLevels(page), { timeout: 5000 }).toEqual([]);
      await expectLabelsReadable(page);
    });
  }

  test("the Loop button is the same size at 1024 as at 1440", async ({ page }) => {
    await page.setViewportSize({ width: WIDE_WIDTH, height: WINDOW_HEIGHT });
    await openStudio(page, { tauri: true });
    await waitForClickTrack(page, { revealOptions: false });
    const wide = await loopButtonWidth(page);

    await page.setViewportSize(NARROW_WINDOW);
    // The full row overflows at 1024, so fitting again is the sign the fit has run.
    await expect.poll(() => stripFits(page), { timeout: 5000 }).toBe(true);
    expect(await loopButtonWidth(page)).toBe(wide);
  });

  // Deleted: "the page itself never scrolls sideways".
  //
  // It could not fail. `html, body { overflow: hidden }` (daw.css:7) means the
  // document has no horizontal scroll to report whatever the footer does, and
  // .footer-clusters is its own `overflow-x: auto` box so its overflow never
  // reaches an ancestor's scrollWidth either. Verified by disabling the fix
  // entirely: it still passed, at the cost of four full openStudio loads.
  //
  // "the reporter's geometry no longer overflows" above is the one that
  // actually fails without the fix, and it is the same property measured
  // where it is observable.
});
