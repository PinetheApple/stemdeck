// The wave panel hides overflow, so a toolbar too wide for it is clipped, not scrolled.
import { test, expect } from "@playwright/test";
import { openStudio, waitForClickTrack, waitForPanesSettled } from "./helpers.mjs";

const WINDOW_HEIGHT = 800;
const WIDTHS = [1024, 1440];
const LIBRARY_STATES = ["open", "collapsed"];
const INSPECTOR_STATES = ["shown", "hidden"];
const COLLAPSED_CLASS = "cat-collapsed";
const CONTROLS = "#beatgrid-toolbar button, #beatgrid-toolbar input";
// Sub-pixel layout puts edges a fraction past each other even when they fit.
const EDGE_SLACK = 0.5;
// The library re-checks its room from a ResizeObserver that queues the fit for the next frame.
const FRAMES_FOR_ROOM_CHECK = 3;

async function expectLibrary(page, state) {
  const app = page.locator(".app");
  if (state === "collapsed") await expect(app).toHaveClass(new RegExp(COLLAPSED_CLASS));
  else await expect(app).not.toHaveClass(new RegExp(COLLAPSED_CLASS));
}

async function setLibrary(page, state) {
  const collapsed = await page.locator(".app").evaluate(
    (el, cls) => el.classList.contains(cls),
    COLLAPSED_CLASS,
  );
  if (collapsed !== (state === "collapsed")) await page.locator("#sidebarCollapseBtn").click();
  await expectLibrary(page, state);
}

async function waitForRoomCheck(page) {
  await page.evaluate(async (frames) => {
    for (let i = 0; i < frames; i++) await new Promise(requestAnimationFrame);
  }, FRAMES_FOR_ROOM_CHECK);
  await waitForPanesSettled(page);
}

async function setInspector(page, state) {
  const inspector = page.locator("#inspector");
  if ((await inspector.isVisible()) !== (state === "shown")) {
    await page.locator("#inspectorToggleBtn").click();
  }
  if (state === "shown") await expect(inspector).toBeVisible();
  else await expect(inspector).toBeHidden();
}

async function openGridEditor(page) {
  await setInspector(page, "shown");
  await page.locator("#t-metro-edit").click();
  await expect(page.locator("#beatgrid-toolbar")).toBeVisible();
}

// Ids of the toolbar controls not wholly inside the toolbar and every clipping ancestor.
const clippedControls = (page) =>
  page.evaluate(
    ({ selector, slack }) => {
      const toolbar = document.querySelector("#beatgrid-toolbar");
      const boxes = [toolbar];
      for (let el = toolbar.parentElement; el; el = el.parentElement) {
        if (getComputedStyle(el).overflowX !== "visible") boxes.push(el);
      }
      const inside = (r, box) =>
        r.left >= box.left - slack && r.right <= box.right + slack;
      return [...document.querySelectorAll(selector)]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return !boxes.every((box) => inside(r, box.getBoundingClientRect()));
        })
        .map((el) => el.id);
    },
    { selector: CONTROLS, slack: EDGE_SLACK },
  );

test.describe("beat-grid toolbar fit", () => {
  for (const width of WIDTHS) {
    for (const library of LIBRARY_STATES) {
      for (const inspector of INSPECTOR_STATES) {
        test(`every control fits at ${width}px, library ${library}, inspector ${inspector}`, async ({ page }) => {
          await page.setViewportSize({ width, height: WINDOW_HEIGHT });
          await openStudio(page, { tauri: true });
          await waitForClickTrack(page, { revealOptions: false });
          await waitForPanesSettled(page);
          await openGridEditor(page);
          await setInspector(page, inspector);
          await waitForRoomCheck(page);
          await setLibrary(page, library);
          await waitForRoomCheck(page);

          await expect(page.locator("#beatgrid-toolbar")).toBeVisible();
          await expectLibrary(page, library);
          expect(await clippedControls(page)).toEqual([]);
        });
      }
    }
  }
});
