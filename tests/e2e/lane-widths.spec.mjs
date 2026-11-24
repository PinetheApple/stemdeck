// Stem headers, recording tracks, takes and + Track at every stem-column width the
// layout allows: each row's parts inside the row, none on another, the dB readout first to go.
import { test, expect } from "@playwright/test";
import { openStudio } from "./helpers.mjs";

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["microphone"],
});

// 288: variables.css today; 328-480: the stem column's resize range (#233).
const COLUMN_WIDTHS = [288, 328, 400, 480];
const NARROWEST = COLUMN_WIDTHS[0];
const WIDEST = COLUMN_WIDTHS.at(-1);
const COLUMN_VAR = "--daw-col-w";
const WINDOWS = { tall: { width: 1600, height: 1000 }, short: { width: 1366, height: 768 } };
const RECORD_MS = 1200;
const TAKES_URL_PART = "/takes";
const ROW_PARTS = [
  ".mx-name", ".mute", ".solo", ".lane-knob", ".mx-val", ".lane-more", ".eq-lane-mark", ".lane-key",
  ".lane-dl", ".lane-vu", ".rec-folder-btn", ".rec-input-btn", ".rec-arm", ".rec-take-pick", ".rec-chip",
  ".rec-add-btn",
].join(", ");

const recordBtn = (page) => page.locator("#t-rec");

async function addTrackWithTake(page) {
  await page.locator("#recAddTrack").click();
  await page.getByRole("menuitem", { name: "Audio track" }).click();
  await page.locator(".rec-row .rec-arm").first().click();
  await expect(recordBtn(page)).toBeEnabled();
  await recordBtn(page).click();
  await expect(recordBtn(page)).toHaveClass(/\bis-recording\b/, { timeout: 15000 });
  await page.waitForTimeout(RECORD_MS);
  await recordBtn(page).click();
  await expect(page.locator(".rec-take-row .rec-chip.is-primary")).toBeVisible({ timeout: 15000 });
}

async function removeTracks({ page, request }) {
  const jobId = await page.evaluate(async () => (await import("/js/state.js")).currentJobId);
  if (!jobId) return;
  const { tracks = [] } = await (await request.get(`/api/jobs/${jobId}${TAKES_URL_PART}`)).json();
  for (const track of tracks) await request.delete(`/api/jobs/${jobId}/tracks/${track.id}`);
}

test.afterEach(removeTracks);

async function setColumnWidth(page, px) {
  await page.evaluate(([name, value]) => {
    document.querySelector(".app").style.setProperty(name, value);
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, [COLUMN_VAR, `${px}px`]);
}

/** Rows whose parts stick out of the row, sit on each other, or cut a stem's name short. */
function rowProblems(page) {
  return page.evaluate((partsSelector) => {
    const TOLERANCE = 0.5;
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > TOLERANCE
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > TOLERANCE;
    const inside = (r, box) => r.left >= box.left - TOLERANCE && r.right <= box.right + TOLERANCE
      && r.top >= box.top - TOLERANCE && r.bottom <= box.bottom + TOLERANCE;
    const rows = [...document.querySelectorAll(".mixer-column > *")].filter(shown);
    const problems = [];
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      const parts = [...row.querySelectorAll(partsSelector)].filter(shown)
        .filter((el) => !el.parentElement.closest(partsSelector));
      const label = row.dataset.stem || row.className;
      for (const el of parts) {
        if (!inside(el.getBoundingClientRect(), box)) problems.push(`${label}: ${el.className} outside`);
      }
      parts.forEach((a, i) => parts.slice(i + 1).forEach((b) => {
        if (overlap(a.getBoundingClientRect(), b.getBoundingClientRect())) {
          problems.push(`${label}: ${a.className} on ${b.className}`);
        }
      }));
      const name = row.matches("[data-stem]") ? row.querySelector(".mx-name") : null;
      if (name && name.scrollWidth > name.clientWidth + 1) problems.push(`${label}: name cut`);
    }
    return problems;
  }, ROW_PARTS);
}

const shownStemDb = (page) => page.locator(".lane-header[data-stem]:not(.hidden):not(.unavailable) .mx-val:visible");
const faderWidth = async (page) => (await page.locator('.lane-header[data-stem="vocals"] .lane-knob').boundingBox()).width;

for (const [kind, viewport] of Object.entries(WINDOWS)) {
  test(`on a ${kind} window every row fits at every allowed column width`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openStudio(page);
    await addTrackWithTake(page);
    for (const width of COLUMN_WIDTHS) {
      await setColumnWidth(page, width);
      expect(await rowProblems(page), `column ${width}px`).toEqual([]);
    }
  });
}

test("the dB readout is the first to go, and the fader grows with the column", async ({ page }) => {
  await page.setViewportSize(WINDOWS.tall);
  await openStudio(page);
  await setColumnWidth(page, WIDEST);
  await expect(shownStemDb(page).first()).toBeVisible();
  const wide = await faderWidth(page);
  await setColumnWidth(page, NARROWEST);
  await expect(shownStemDb(page)).toHaveCount(0);
  await expect(page.locator('.lane-header[data-stem="vocals"] .lane-x')).toBeVisible();
  expect(await faderWidth(page)).toBeLessThan(wide);
});
