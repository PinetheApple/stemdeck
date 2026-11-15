// A set of stems silenced on top of the song's mix, for a view that plays the
// song without them. The user's mix, what is saved of it and the lane buttons
// stay as they were, and the next song starts without it.
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio } from "./helpers.mjs";

const SILENCED = "vocals";
const HEARD = "drums";
const NEW_HEARD_LEVEL = 0.5;
const SONG_OPEN_TIMEOUT_MS = 20000;

/** Record the gain applyMix last gave each stem on the engine playing now. */
function watchGains(page) {
  return page.evaluate(async () => {
    const { audioEngine } = await import("/js/state.js");
    const setGain = audioEngine.setGain;
    window.__e2eGains = {};
    audioEngine.setGain = function recordGain(name, value) {
      window.__e2eGains[name] = value;
      return setGain(name, value);
    };
  });
}

const gains = (page) => page.evaluate(() => ({ ...window.__e2eGains }));
const mixer = (page, call, ...args) => page.evaluate(
  async ([name, callArgs]) => (await import("/js/mixer.js"))[name](...callArgs),
  [call, args],
);
const storedMix = (page) => page.evaluate((id) => JSON.parse(localStorage.getItem(`stemdeck:mix:${id}`)), JOB_ID);
/** Whether an engine is up that is not the one `watchGains` last wrapped. */
const freshEngineReady = (page) => page.evaluate(async () => {
  const { audioEngine } = await import("/js/state.js");
  return Boolean(audioEngine) && !audioEngine.setGain.name.startsWith("recordGain");
});

test("silenced stems play at zero without changing the saved mix, until the song changes", async ({ page }) => {
  await openStudio(page);
  await expect.poll(() => freshEngineReady(page)).toBe(true);
  await watchGains(page);

  await mixer(page, "setStemOverride", [SILENCED]);
  expect((await gains(page))[SILENCED]).toBe(0);
  expect((await gains(page))[HEARD]).toBeGreaterThan(0);

  await mixer(page, "setLaneVolume", HEARD, NEW_HEARD_LEVEL);
  expect((await gains(page))[SILENCED]).toBe(0);
  await expect.poll(() => storedMix(page).then((mix) => mix?.[HEARD]?.volume)).toBe(NEW_HEARD_LEVEL);
  expect((await storedMix(page))[SILENCED].muted).toBe(false);
  await expect(page.locator(`.lane-header[data-stem="${SILENCED}"]`)).not.toHaveClass(/\bmuted\b/);

  await mixer(page, "clearStemOverride");
  expect((await gains(page))[SILENCED]).toBeGreaterThan(0);

  await mixer(page, "setStemOverride", [SILENCED]);
  await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first().dblclick();
  await expect.poll(() => freshEngineReady(page), { timeout: SONG_OPEN_TIMEOUT_MS }).toBe(true);
  await watchGains(page);
  await mixer(page, "applyMix");
  expect((await gains(page))[SILENCED]).toBeGreaterThan(0);
});
