// A song's versions (#96): rows under the song, the studio pill, Save as new,
// Extract more stems and delete, each version keeping its own lanes and mix.
import { test, expect } from "@playwright/test";
import {
  JOB_ID, KEY, SIBLING_JOB_ID, SIBLING_TITLE, TRACK_TITLE, fixtureTrack, openStudio, seedLibrary, stubServerTrash,
} from "./helpers.mjs";

const ALL_STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"];
const TWO_STEMS = ["vocals", "drums"];
const DEFAULT_ID = "main";
const MIX_KEY = `stemdeck:mix:${JOB_ID}`;
const ORIGINAL_DRUMS = 0.5;
const V2_DRUMS = 0.25;
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const PLAY_MS = 600;

// Tags and work already answered, so opening asks the server for nothing.
const TAGS_CHECKED = { audioTagsChecked: true, workChecked: true };
const TAGS_CHECKED_CATALOG = {
  folders: [
    { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
    { id: "trash", name: "Trash", items: [], color: null },
  ],
  tracks: {
    [JOB_ID]: { ...fixtureTrack(JOB_ID, TRACK_TITLE), ...TAGS_CHECKED },
    [SIBLING_JOB_ID]: { ...fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE), ...TAGS_CHECKED },
  },
};

const versionsUrl = (id) => `/api/jobs/${id}/versions`;
const laneMix = (drums) => ({ drums: { volume: drums, muted: false, soloed: false, pitch: 0 } });
const versionKey = (vid) => `${MIX_KEY}:${vid}`;

// The e2e server lives for the whole run, so each test leaves both songs with the Original only.
test.afterEach(async ({ request }) => {
  for (const id of [JOB_ID, SIBLING_JOB_ID]) {
    await request.post(`${versionsUrl(id)}/${DEFAULT_ID}/open`);
    const { versions } = await (await request.get(versionsUrl(id))).json();
    for (const v of versions.filter((x) => x.id !== DEFAULT_ID)) await request.delete(`${versionsUrl(id)}/${v.id}`);
  }
});

async function createVersion(request, id, { name, stems, open = false }) {
  const res = await request.post(versionsUrl(id), { data: { name, stems, open } });
  expect(res.status()).toBe(201);
  return (await res.json()).version;
}

async function serverVersions(request, id = JOB_ID) {
  return (await request.get(versionsUrl(id))).json();
}

/** Seed `mixes` (store key → mix) before any script runs. */
async function seedMixes(page, mixes) {
  await page.addInitScript((entries) => {
    if (window.sessionStorage.getItem("e2e.mixes")) return;
    window.sessionStorage.setItem("e2e.mixes", "1");
    for (const [key, value] of entries) window.localStorage.setItem(key, JSON.stringify(value));
  }, Object.entries(mixes));
}

function studioState(page) {
  return page.evaluate(async () => {
    const state = await import("/js/state.js");
    return {
      lanes: [...state.selectedStems].sort(),
      versionId: state.currentVersionId,
      drums: state.mixerState.drums?.volume,
    };
  });
}

function playhead(page) {
  return page.evaluate(async () => {
    const { audioEngine, multitrack } = await import("/js/state.js");
    return (audioEngine ?? multitrack).getCurrentTime();
  });
}

const storedMix = (page, key) => page.evaluate((k) => JSON.parse(window.localStorage.getItem(k) ?? "\"absent\""), key);
const songRow = (page, id = JOB_ID) => page.locator(`#catalogList .cat-item[data-id="${id}"]`).first();
const versionRows = (page, id = JOB_ID) => page.locator(`#catalogList .cat-version[data-id="${id}"]`);
const versionRow = (page, vid, id = JOB_ID) => page.locator(`#catalogList .cat-version[data-id="${id}"][data-version="${vid}"]`);

async function expandVersions(page) {
  const toggle = songRow(page).locator(".cat-versions-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function openVersionMenu(page, vid) {
  const row = versionRow(page, vid);
  await row.hover();
  await row.locator(".cat-more").click();
  return page.locator(".lib-menu");
}

test("a song from before versions opens as the Original with its saved mix and writes nothing", async ({ page }) => {
  const writes = [];
  page.on("request", (req) => {
    if (WRITE_METHODS.has(req.method()) && new URL(req.url()).pathname.startsWith("/api/jobs/")) {
      writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
    }
  });
  await seedMixes(page, { [MIX_KEY]: laneMix(ORIGINAL_DRUMS) });
  await openStudio(page, { catalog: TAGS_CHECKED_CATALOG });

  await expect.poll(() => studioState(page)).toMatchObject({ versionId: DEFAULT_ID, drums: ORIGINAL_DRUMS });
  await expect(songRow(page).locator(".cat-versions-toggle")).toHaveCount(0);
  await expect(page.locator("#npVersionBtn")).toBeHidden();
  expect(writes).toEqual([]);
});

test("version rows open, close and follow the library keyboard", async ({ page, request }) => {
  const v2 = await createVersion(request, JOB_ID, { name: "Two lanes", stems: TWO_STEMS });
  await openStudio(page);

  const toggle = songRow(page).locator(".cat-versions-toggle");
  await expect(toggle).toHaveText("2 versions");
  await expect(versionRows(page)).toBeHidden();
  await expandVersions(page);
  await expect(versionRows(page)).toHaveCount(2);
  await expect(versionRow(page, DEFAULT_ID)).toHaveClass(/\bactive\b/);
  await expect(songRow(page)).toHaveClass(/has-open-version/);
  await expect(songRow(page)).not.toHaveClass(/\bactive\b/);

  await songRow(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(versionRow(page, DEFAULT_ID)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(versionRow(page, v2.id)).toBeFocused();
  await page.keyboard.press(KEY.DELETE);
  await expect(songRow(page)).toBeVisible();
  await expect(page.locator(".rail-trash")).toHaveAttribute("aria-label", "Trash");

  await page.keyboard.press(KEY.ENTER);
  await expect.poll(() => studioState(page)).toMatchObject({ versionId: v2.id, lanes: [...TWO_STEMS].sort() });
  await expect(versionRow(page, v2.id)).toHaveClass(/\bactive\b/);
  await expect(page.locator("#npVersionBtn")).toHaveText("Two lanes");

  await toggle.click();
  await expect(versionRows(page)).toBeHidden();
  await expect(songRow(page)).toHaveClass(/\bactive\b/);
});

test("a version with the same lanes takes over the mix without reloading the song", async ({ page, request }) => {
  const v2 = await createVersion(request, JOB_ID, { name: "Quiet drums", stems: ALL_STEMS });
  await seedMixes(page, { [MIX_KEY]: laneMix(ORIGINAL_DRUMS), [versionKey(v2.id)]: laneMix(V2_DRUMS) });
  const bundles = [];
  await page.route("**/api/jobs/*/bundle.zip**", (route) => {
    bundles.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ status: 200, contentType: "application/zip", body: Buffer.from("PK") });
  });
  await openStudio(page);
  await page.locator("#t-play").click();
  await page.waitForTimeout(PLAY_MS);
  const stemLoads = [];
  page.on("request", (req) => { if (req.url().includes("/stems/")) stemLoads.push(req.url()); });
  const timeBefore = await playhead(page);

  await page.locator("#npVersionBtn").click();
  await page.getByRole("menuitemradio", { name: "Quiet drums" }).click();
  await expect.poll(() => studioState(page)).toMatchObject({ versionId: v2.id, drums: V2_DRUMS });
  await expect.poll(() => playhead(page)).toBeGreaterThan(timeBefore);
  expect(stemLoads).toEqual([]);

  await page.evaluate(async () => (await import("/js/player.js")).downloadSongBundle());
  await expect.poll(() => bundles.length).toBe(1);
  const lanes = bundles[0].get("stems").split(",");
  expect(bundles[0].get("volumes").split(",")[lanes.indexOf("drums")]).toBe(V2_DRUMS.toFixed(3));
});

test("Save as new starts as Version 2 in rename and keeps the mix", async ({ page, request }) => {
  await createVersion(request, JOB_ID, { name: "Other", stems: TWO_STEMS });
  await seedMixes(page, { [MIX_KEY]: laneMix(ORIGINAL_DRUMS) });
  await openStudio(page);
  await expandVersions(page);

  const menu = await openVersionMenu(page, DEFAULT_ID);
  await menu.getByRole("menuitem", { name: "Save as new version" }).click();
  const input = page.locator("#catalogList .cat-version.renaming-row .rename-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Version 2");
  await input.press(KEY.ENTER);

  await expect(versionRows(page)).toHaveCount(3);
  const { versions, open_version: openId } = await serverVersions(request);
  const created = versions.find((v) => v.name === "Version 2");
  expect(created.stems).toEqual(ALL_STEMS);
  expect(openId).toBe(created.id);
  expect(await storedMix(page, versionKey(created.id))).toMatchObject(laneMix(ORIGINAL_DRUMS));
  await expect.poll(() => studioState(page)).toMatchObject({ versionId: created.id, drums: ORIGINAL_DRUMS });
});

test("Extract more stems makes a version from the stems it adds, or opens the one that has them", async ({ page, request }) => {
  const v2 = await createVersion(request, JOB_ID, { name: "Two lanes", stems: TWO_STEMS, open: true });
  await openStudio(page);
  await expect.poll(() => studioState(page)).toMatchObject({ lanes: [...TWO_STEMS].sort() });

  await songRow(page).hover();
  await songRow(page).locator(".cat-more").click();
  await page.getByRole("menuitem", { name: "Extract more stems…" }).click();
  const form = page.locator("#catalogList .cat-extract-more");
  const chips = form.locator(".cat-extract-more-chip");
  await expect(chips).toHaveText(["Bass", "Guitar", "Piano", "Other"]);
  await chips.filter({ hasText: "Guitar" }).click();
  await chips.filter({ hasText: "Piano" }).click();
  await form.locator(".cat-extract-more-go").click();

  await expect(form).toHaveCount(0);
  await expect(versionRows(page)).toHaveCount(3);
  await expect(page.locator("#npVersionBtn")).toHaveText("+ Bass, Other");
  await expect.poll(() => studioState(page)).toMatchObject({ lanes: ["bass", "drums", "other", "vocals"] });

  await page.locator("#npVersionBtn").click();
  await page.getByRole("menuitemradio", { name: "Two lanes" }).click();
  await expect.poll(() => studioState(page)).toMatchObject({ versionId: v2.id });
  await songRow(page).hover();
  await songRow(page).locator(".cat-more").click();
  await page.getByRole("menuitem", { name: "Extract more stems…" }).click();
  await chips.filter({ hasText: "Guitar" }).click();
  await chips.filter({ hasText: "Piano" }).click();
  await form.locator(".cat-extract-more-go").click();
  await expect(page.locator("#npVersionBtn")).toHaveText("+ Bass, Other");
  await expect(versionRows(page)).toHaveCount(3);
});

test("a deleted version takes its mix with it, and one version left is a plain row", async ({ page, request }) => {
  const v2 = await createVersion(request, JOB_ID, { name: "Doomed", stems: TWO_STEMS });
  await seedMixes(page, { [versionKey(v2.id)]: laneMix(V2_DRUMS) });
  await openStudio(page);
  await expandVersions(page);

  const menu = await openVersionMenu(page, v2.id);
  await menu.getByRole("menuitem", { name: "Delete version" }).click();
  const armed = versionRow(page, v2.id).locator(".cat-version-del");
  await expect(armed).toHaveText("Delete?");
  await armed.click();

  await expect(versionRows(page)).toHaveCount(0);
  await expect(songRow(page).locator(".cat-versions-toggle")).toHaveCount(0);
  expect((await serverVersions(request)).versions.map((v) => v.id)).toEqual([DEFAULT_ID]);
  await expect.poll(() => storedMix(page, versionKey(v2.id))).toBeNull();
});

test("a setlist and Up Next play the version opened last", async ({ page, request }) => {
  await createVersion(request, JOB_ID, { name: "Two lanes", stems: TWO_STEMS, open: true });
  const setlist = await (await request.post("/api/setlists", { data: { name: "Gig", song_ids: [SIBLING_JOB_ID, JOB_ID] } })).json();
  try {
    await openStudio(page);
    await page.locator("#libTabSetlists").click();
    await page.locator(".setlist-play").click();
    await expect(page.locator("#title")).toContainText("again");
    await page.locator("#t-next").click();
    await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
    await expect.poll(() => studioState(page)).toMatchObject({ lanes: [...TWO_STEMS].sort() });
  } finally {
    await request.delete(`/api/setlists/${setlist.id}`);
  }
});

test("emptying the Trash forgets the mixes of the song's other versions", async ({ page, request }) => {
  const v2 = await createVersion(request, SIBLING_JOB_ID, { name: "Gone", stems: TWO_STEMS });
  const key = `stemdeck:mix:${SIBLING_JOB_ID}:${v2.id}`;
  await stubServerTrash(page, { trashed: [SIBLING_JOB_ID] });
  await page.route(`**/api/jobs/${SIBLING_JOB_ID}`, (route) => (route.request().method() === "DELETE"
    ? route.fulfill({ status: 200, json: { deleted: true } })
    : route.fallback()));
  await seedMixes(page, { [key]: laneMix(V2_DRUMS) });
  await seedLibrary(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".rail-trash")).toHaveAttribute("aria-label", "Trash (1)");

  await page.locator(".rail-trash").click();
  await page.locator("#clearBinBtn").click();
  await page.locator("#clearBinBtn").click();
  await expect.poll(() => storedMix(page, key)).toBeNull();
});

test("Trash shows no version rows", async ({ page, request }) => {
  await createVersion(request, SIBLING_JOB_ID, { name: "Binned", stems: TWO_STEMS });
  await stubServerTrash(page, { trashed: [SIBLING_JOB_ID] });
  await seedLibrary(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(".rail-trash").click();
  await expect(page.locator(`#catalogList .cat-item.in-trash[data-id="${SIBLING_JOB_ID}"]`)).toBeVisible();
  await expect(page.locator("#catalogList .cat-versions-toggle, #catalogList .cat-version")).toHaveCount(0);
});
