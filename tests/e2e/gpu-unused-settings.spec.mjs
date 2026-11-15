// Settings says, under the compute device, why a GPU StemDeck found is not used.

import { test, expect } from "@playwright/test";
import { seedLibrary } from "./helpers.mjs";

const TORCH_ERROR = "OSError: libtorch_hip.so: cannot open shared object file";
const TORCH_BROKEN_START = "The separation engine could not start";
const CARDS = { cuda: "NVIDIA", rocm: "AMD" };
const LINES = {
  unsupported: (card) => `Your ${card} graphics card isn't supported, so separation uses the processor.`,
  "no-access": (card) => `StemDeck can't reach your ${card} graphics card, so separation uses the processor.`,
  "install-failed": (card) =>
    `Setting up your ${card} graphics card didn't finish, so separation uses the processor.`,
  "check-failed": (card) =>
    `Your ${card} graphics card didn't pass StemDeck's check, so separation uses the processor.`,
};

async function stubSettings(page, extra) {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const body = await (await route.fetch()).json();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...body, demucs_devices_available: ["cpu"], ...extra }),
    });
  });
}

async function openDeviceRow(page, extra) {
  await stubSettings(page, extra);
  await seedLibrary(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#settingsBtn").click();
  await expect(page.locator(".library-editor")).toBeVisible();
  await page.locator('.settings-tab[data-tab="general"]').click();
}

const gpuLine = (page) => page.locator(".set-gpu-unused-desc");
const deviceDesc = (page) => page.locator(".set-demucs-desc");

for (const [reason, line] of Object.entries(LINES)) {
  for (const [backend, card] of Object.entries(CARDS)) {
    test(`${reason} on ${card} says why the GPU is unused`, async ({ page }) => {
      await openDeviceRow(page, { gpu_backend: null, gpu_unused: { reason, backend } });
      await expect(gpuLine(page)).toBeVisible();
      await expect(gpuLine(page)).toHaveText(line(card));
    });
  }
}

test("no gpu_unused shows no line", async ({ page }) => {
  await openDeviceRow(page, { gpu_unused: null });
  await expect(deviceDesc(page)).toBeVisible();
  await expect(gpuLine(page)).toBeHidden();
});

test("a broken torch keeps its own line and hides the GPU one", async ({ page }) => {
  await openDeviceRow(page, {
    torch_error: TORCH_ERROR,
    gpu_unused: { reason: "check-failed", backend: "rocm" },
  });
  await expect(deviceDesc(page)).toContainText(TORCH_BROKEN_START);
  await expect(gpuLine(page)).toBeHidden();
});

test("the line follows the language", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stemdeck.language", JSON.stringify("de")));
  await openDeviceRow(page, { gpu_unused: { reason: "unsupported", backend: "rocm" } });
  await expect(gpuLine(page)).toHaveText(
    "Deine AMD-Grafikkarte wird nicht unterstützt, daher läuft die Trennung auf dem Prozessor.",
  );
});
