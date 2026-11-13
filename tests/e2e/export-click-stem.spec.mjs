// Export All Stems with "Include click track" (#93): ticked, the zip carries the
// click as one more file in the stems' format; unticked, it carries the stems only.

import { test, expect } from "@playwright/test";
import { openStudio, exportUi, waitForClickTrack, TRACK_TITLE } from "./helpers.mjs";

const STEMS_ZIP = /\/api\/jobs\/[a-f0-9]{12}\/stems\/all\.zip\?/;
const FORMAT = "flac";
const SONG_SLUG = TRACK_TITLE.replace(/[^a-zA-Z0-9]+/g, "_");
const CLICK_ENTRY = `${SONG_SLUG}_click.${FORMAT}`;

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_BYTES = 22;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_BYTES = 46;

// Member names from the zip's central directory (no zip64, no archive comment).
function zipEntryNames(buf) {
  const eocd = buf.length - EOCD_MIN_BYTES;
  expect(buf.readUInt32LE(eocd)).toBe(EOCD_SIGNATURE);
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(CENTRAL_SIGNATURE);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const nameStart = at + CENTRAL_HEADER_BYTES;
    names.push(buf.toString("utf8", nameStart, nameStart + nameLen));
    at = nameStart + nameLen + extraLen + commentLen;
  }
  return names;
}

async function exportStemsZip(page, { includeClick }) {
  const ui = exportUi(page);
  await ui.open();
  await ui.fmt(FORMAT).click();
  await page.locator("#t-export-click").setChecked(includeClick);
  const zip = page.waitForResponse((r) => STEMS_ZIP.test(r.url()));
  await ui.stems.click();
  const response = await zip;
  expect(response.status()).toBe(200);
  return zipEntryNames(await response.body());
}

test.describe("Export All Stems click file", () => {
  test.beforeEach(async ({ page }) => {
    await openStudio(page);
    await waitForClickTrack(page, { revealOptions: false });
  });

  test("ticked, the zip holds the click in the stems' format", async ({ page }) => {
    const names = await exportStemsZip(page, { includeClick: true });
    expect(names).toContain(CLICK_ENTRY);
    expect(names.filter((n) => n.endsWith(`.${FORMAT}`))).toEqual(names);
  });

  test("unticked, the zip holds the stems only", async ({ page }) => {
    const names = await exportStemsZip(page, { includeClick: false });
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain(CLICK_ENTRY);
    expect(names.some((n) => n.includes("_click."))).toBe(false);
  });
});
