import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio } from "./helpers.mjs";

const SILENCED = "vocals";
const HEARD = "drums";
const NEW_HEARD_LEVEL = 0.5;
const SONG_OPEN_TIMEOUT_MS = 20000;
const GAIN_RECORDER = "recordGain";

/** Record the gain applyMix last gave each stem on the engine playing now. */
function watchGains(page) {
  return page.evaluate(async (recorderName) => {
    const { audioEngine } = await import("/js/state.js");
    const setGain = audioEngine.setGain;
    window.__e2eGains = {};
    const recorder = {
      [recorderName](name, value) {
        window.__e2eGains[name] = value;
        return setGain(name, value);
      },
    };
    audioEngine.setGain = recorder[recorderName];
  }, GAIN_RECORDER);
}

const gains = (page) => page.evaluate(() => ({ ...window.__e2eGains }));
const mixer = (page, call, ...args) => page.evaluate(
  async ([name, callArgs]) => (await import("/js/mixer.js"))[name](...callArgs),
  [call, args],
);
const storedMix = (page) => page.evaluate((id) => JSON.parse(localStorage.getItem(`stemdeck:mix:${id}`)), JOB_ID);
/** Whether an engine is up that is not the one `watchGains` last wrapped. */
const freshEngineReady = (page) => page.evaluate(async (recorderName) => {
  const { audioEngine } = await import("/js/state.js");
  return Boolean(audioEngine) && audioEngine.setGain.name !== recorderName;
}, GAIN_RECORDER);

test("silenced stems play at zero without changing the saved mix, until the song changes", async ({ page }) => {
  await openStudio(page);
  await expect.poll(() => freshEngineReady(page)).toBe(true);
  await watchGains(page);

  await mixer(page, "setSilencedStems", [SILENCED]);
  expect((await gains(page))[SILENCED]).toBe(0);
  expect((await gains(page))[HEARD]).toBeGreaterThan(0);

  await mixer(page, "setLaneVolume", HEARD, NEW_HEARD_LEVEL);
  expect((await gains(page))[SILENCED]).toBe(0);
  await expect.poll(() => storedMix(page).then((mix) => mix?.[HEARD]?.volume)).toBe(NEW_HEARD_LEVEL);
  expect((await storedMix(page))[SILENCED].muted).toBe(false);
  await expect(page.locator(`.lane-header[data-stem="${SILENCED}"]`)).not.toHaveClass(/\bmuted\b/);

  await mixer(page, "clearSilencedStems");
  expect((await gains(page))[SILENCED]).toBeGreaterThan(0);

  await mixer(page, "setSilencedStems", [SILENCED]);
  await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first().dblclick();
  await expect.poll(() => freshEngineReady(page), { timeout: SONG_OPEN_TIMEOUT_MS }).toBe(true);
  await watchGains(page);
  await mixer(page, "applyMix");
  expect((await gains(page))[SILENCED]).toBeGreaterThan(0);
});

test("a silenced stem that is soloed does not silence the rest", async ({ page }) => {
  await openStudio(page);
  await expect.poll(() => freshEngineReady(page)).toBe(true);
  await page.locator(`.lane-header[data-stem="${SILENCED}"] .solo`).click();
  await expect.poll(() => storedMix(page).then((mix) => mix?.[SILENCED]?.soloed)).toBe(true);
  await watchGains(page);

  await mixer(page, "setSilencedStems", [SILENCED]);
  expect((await gains(page))[SILENCED]).toBe(0);
  expect((await gains(page))[HEARD]).toBeGreaterThan(0);
  expect((await storedMix(page))[SILENCED]).toMatchObject({ soloed: true, muted: false });
});
