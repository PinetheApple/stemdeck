import { test, expect } from "@playwright/test";
import {
  EXTRACT_NEXT,
  JOB_ID,
  LONG_QUEUE_WAITING_IDS,
  QUEUE_ROW,
  queueRow,
  seedLibrary,
  stubFavorites,
  stubLongQueue,
  stubUpdateCheck,
} from "./helpers.mjs";

const [FIRST_WAITING, SECOND_WAITING, THIRD_WAITING] = LONG_QUEUE_WAITING_IDS;
const REDRAWS = 4;
const LOWER_PART_OF_ROW = 0.8;
const LIST = "#catalogList";
const DROP_BELOW = ".drop-below";

async function openQueue(page) {
  await seedLibrary(page);
  await stubFavorites(page);
  await stubUpdateCheck(page);
  const queue = await stubLongQueue(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(`.cat-item[data-id="${JOB_ID}"]`)).toBeVisible();
  await page.evaluate(() => import("/js/queue.js").then((m) => m.refreshQueue()));
  await page.locator(".rail-queue").click();
  await expect(page.locator(EXTRACT_NEXT).first()).toBeAttached();
  return queue;
}

/** Rebuild the list `times` times by changing the waiting order, ending on the original order. */
async function redrawQueue(page, queue, times) {
  for (let i = 0; i < times; i++) {
    const ids = i % 2 ? LONG_QUEUE_WAITING_IDS : [...LONG_QUEUE_WAITING_IDS].reverse();
    await queue.setWaiting(ids);
    await expect(page.locator(QUEUE_ROW).nth(1)).toHaveAttribute("data-id", ids[0]);
  }
  await queue.setWaiting(LONG_QUEUE_WAITING_IDS);
  await expect(page.locator(QUEUE_ROW).nth(1)).toHaveAttribute("data-id", FIRST_WAITING);
}

/** How many of the list's own dragover listeners act on one dragover over `jobId`'s row. */
function listDragoverHandlers(page, jobId) {
  return page.evaluate(([listSelector, rowSelector]) => {
    const list = document.querySelector(listSelector);
    const dragged = document.querySelector(rowSelector);
    const dataTransfer = new DataTransfer();
    dragged.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));

    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer });
    let handled = 0;
    const preventDefault = over.preventDefault.bind(over);
    over.preventDefault = function countListHandler() {
      if (over.currentTarget === list) handled += 1;
      preventDefault();
    };
    dragged.dispatchEvent(over);
    dragged.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    return handled;
  }, [LIST, queueRow(jobId)]);
}

async function dragBelow(page, draggedId, targetId) {
  const target = page.locator(queueRow(targetId));
  const { width, height } = await target.boundingBox();
  await page.locator(queueRow(draggedId)).dragTo(target, {
    targetPosition: { x: width / 2, y: height * LOWER_PART_OF_ROW },
  });
}

/** Count the clicks that reach `jobId`'s row from here on; read them with `rowClicks`. */
async function countRowClicks(page, jobId) {
  await page.locator(queueRow(jobId)).evaluate((el) => {
    window.queueRowClicks = 0;
    el.addEventListener("click", function countRowClick() {
      window.queueRowClicks += 1;
    });
  });
}

const rowClicks = (page) => page.evaluate(() => window.queueRowClicks);

/** Keep reorder answers back until the returned function is called. */
async function holdReorders(page) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/queue/reorder", async (route) => {
    await released;
    await route.fallback();
  });
  return release;
}

test.describe("import queue reordering", () => {
  test("the list handles a dragover once however often it has redrawn", async ({ page }) => {
    const queue = await openQueue(page);
    await redrawQueue(page, queue, REDRAWS);

    expect(await listDragoverHandlers(page, SECOND_WAITING)).toBe(1);
  });

  test("dragging a waiting row below another moves it there", async ({ page }) => {
    const queue = await openQueue(page);
    await redrawQueue(page, queue, REDRAWS);

    await dragBelow(page, FIRST_WAITING, SECOND_WAITING);

    await expect.poll(() => queue.reorders).toEqual([{ job_id: FIRST_WAITING, after: SECOND_WAITING }]);
    await expect(page.locator(QUEUE_ROW).nth(2)).toHaveAttribute("data-id", FIRST_WAITING);
    await expect(page.locator(DROP_BELOW)).toHaveCount(0);
  });

  test("extract next moves the row to the front of the waiting imports", async ({ page }) => {
    const queue = await openQueue(page);
    await countRowClicks(page, THIRD_WAITING);
    const release = await holdReorders(page);
    const button = page.locator(`${queueRow(THIRD_WAITING)} ${EXTRACT_NEXT}`);

    await button.click();

    await expect(button).toBeDisabled();
    expect(await rowClicks(page)).toBe(0);
    release();
    await expect.poll(() => queue.reorders).toEqual([{ job_id: THIRD_WAITING, after: null }]);
    await expect(page.locator(QUEUE_ROW).nth(1)).toHaveAttribute("data-id", THIRD_WAITING);
  });
});
