// Renaming a section: double-click it, type in Edit section, Enter. Esc leaves
// the name alone, and a locked section keeps its name until it is unlocked.
import { test, expect } from "@playwright/test";
import { openStudio, sectionEditDialog, JOB_ID } from "./helpers.mjs";

const VERSE = { id: "s1", name: "Verse", start: 1, end: 3, color: "#4a7fff" };

test.afterEach(async ({ page }) => {
  await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections: [] } });
});

async function seed(page, sections) {
  const res = await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections } });
  expect(res.ok(), "seeding sections").toBe(true);
}

const savedSections = async (page) => {
  const res = await page.request.get(`/api/jobs/${JOB_ID}`);
  return (await res.json()).sections ?? [];
};

const label = (page) => page.locator('.section-block[data-id="s1"] .section-label');
const nameField = (page) => page.locator("#sectionEditName");

test.describe("renaming a section", () => {
  test("a double-click opens Edit section with the name focused, and it stays focused", async ({ page }) => {
    await seed(page, [VERSE]);
    await openStudio(page);

    await label(page).dblclick();

    await expect(sectionEditDialog(page)).toBeVisible();
    await expect(nameField(page)).toHaveValue("Verse");
    await page.waitForTimeout(250);
    await expect(nameField(page)).toBeFocused();
  });

  test("typing a new name and pressing Enter saves it, and drops the detected kind", async ({ page }) => {
    await seed(page, [{ ...VERSE, kind: "verse" }]);
    await openStudio(page);

    await label(page).dblclick();
    await nameField(page).fill("Hook");
    await nameField(page).press("Enter");

    await expect(sectionEditDialog(page)).toBeHidden();
    await expect(label(page)).toHaveText("Hook");
    await expect.poll(async () => (await savedSections(page))[0]?.name).toBe("Hook");
    expect((await savedSections(page))[0].kind ?? null).toBe(null);
  });

  test("a locked section's name cannot be edited", async ({ page }) => {
    await seed(page, [{ ...VERSE, locked: true }]);
    await openStudio(page);

    await label(page).dblclick();

    await expect(nameField(page)).toBeDisabled();
    await expect(page.locator("#sectionEditLock")).toHaveAttribute("aria-pressed", "true");
  });

  test("unlocking restores renaming", async ({ page }) => {
    await seed(page, [{ ...VERSE, locked: true }]);
    await openStudio(page);

    await label(page).dblclick();
    await page.locator("#sectionEditLock").click();
    await nameField(page).fill("Bridge");
    await nameField(page).press("Enter");

    await expect.poll(async () => (await savedSections(page))[0]?.name).toBe("Bridge");
    expect((await savedSections(page))[0].locked).toBe(false);
  });

  test("Escape leaves the original name alone", async ({ page }) => {
    await seed(page, [VERSE]);
    await openStudio(page);

    await label(page).dblclick();
    await nameField(page).fill("Discarded");
    await nameField(page).press("Escape");

    await expect(sectionEditDialog(page)).toBeHidden();
    await expect(label(page)).toHaveText("Verse");
  });
});
