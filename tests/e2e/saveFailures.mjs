// Shared by the specs on failed section, grid and tempo saves: what the user is told, and a
// server the test takes down and brings back, so a lost save goes again only when it allows.
import { expect } from "@playwright/test";
import { uiText } from "./helpers.mjs";
import { FAILED_SAVES, holdFirstPatch, failHeldSave } from "./saveRaces.mjs";

// Once the server is back, the page's next health check (every 3 s) notices within seconds.
export const RESENT_WITHIN_MS = 15000;
const HEALTH_PATH = "/api/health";
// The test's own failed check, then one of the page's: only that one marks the server unreachable.
const FAILED_HEALTH_CHECKS = 2;
// A lost save is sent once more on its own when the server answers a health check right away.
export const SENDS_OF_A_LOST_SAVE = 2;

const FAILURE_TEXT = {
  sections: { kind: "sections", refused: "notif.sectionsSaveFailed", lost: "notif.sectionsSavePending" },
  grid: {
    kind: "beatgrid",
    refused: "notif.beatGridSaveFailed",
    lost: "notif.beatGridSavePending",
    reset: "notif.beatGridResetFailed",
  },
  tempo: { kind: "tempo", refused: "notif.tempoSaveFailed", lost: "notif.tempoSavePending" },
};

export const notifications = (page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("stemdeck:failures") || "[]").map(({ kind, message }) => ({ kind, message })),
  );

export async function expectNotified(page, area, how) {
  const { kind, [how]: key } = FAILURE_TEXT[area];
  const message = await uiText(page, key);
  await expect.poll(() => notifications(page)).toEqual([{ kind, message }]);
}

/** Make the next PATCH to `url` fail as `failure` does, run `edit`, and wait until the page has the answer. */
export async function failNextSave(page, url, failure, edit) {
  const hold = await holdFirstPatch(page, `**${url}`, failure.answer);
  await edit();
  await hold.seen;
  await failHeldSave(page, hold, failure, url);
}

/** Resolves once `count` requests matching `matches` have failed. */
function failedRequests(page, count, matches) {
  return new Promise((resolve) => {
    let seen = 0;
    page.on("requestfailed", function countFailedRequest(request) {
      if (!matches(request)) return;
      seen += 1;
      if (seen < count) return;
      page.off("requestfailed", countFailedRequest);
      resolve();
    });
  });
}

const isHealthCheck = (request) => request.url().endsWith(HEALTH_PATH);
export const isSaveTo = (url) => (request) => request.url().endsWith(url) && request.method() === "PATCH";

/**
 * A server the test controls. `loseSaves` loses every PATCH to a URL; `reconnect` takes the
 * whole API down until a health check goes unanswered, then brings it back, refusing those
 * saves from then on when `refuse` is set.
 */
export async function controlServer(page) {
  const state = { down: false, losing: null, refusing: null };
  await page.route("**/api/**", function answerAsTheTestSays(route) {
    const request = route.request();
    if (state.down) return route.abort();
    const save = request.method() === "PATCH" ? request.url() : "";
    if (state.losing && save.endsWith(state.losing)) return FAILED_SAVES.lost.answer(route);
    if (state.refusing && save.endsWith(state.refusing)) return FAILED_SAVES.refused.answer(route);
    return route.fallback();
  });

  /** Lose every save to `url`; resolves once `edit`'s save and its one automatic resend are lost. */
  async function loseSaves(url, edit) {
    state.losing = url;
    const lost = failedRequests(page, SENDS_OF_A_LOST_SAVE, isSaveTo(url));
    await edit();
    await lost;
  }

  async function reconnect({ refuse = false } = {}) {
    state.down = true;
    const unreachable = failedRequests(page, FAILED_HEALTH_CHECKS, isHealthCheck);
    await page.evaluate((path) => { fetch(path).catch(() => {}); }, HEALTH_PATH);
    await unreachable;
    if (refuse) state.refusing = state.losing;
    state.losing = null;
    state.down = false;
  }

  /** Let saves through again without an outage, so no restored connection sends anything. */
  function allowSaves() {
    state.losing = null;
  }

  return { loseSaves, reconnect, allowSaves };
}
