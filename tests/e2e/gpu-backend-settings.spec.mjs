// Settings names an AMD GPU where a ROCm build of torch drives the "cuda" device.

import { test, expect } from "@playwright/test";
import { seedLibrary } from "./helpers.mjs";

const AVAILABLE_ON_GPU = ["cuda", "cpu"];

async function stubGpuBackend(page, backend) {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const body = await (await route.fetch()).json();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...body,
        gpu_backend: backend,
        demucs_devices_available: backend ? AVAILABLE_ON_GPU : ["cpu"],
      }),
    });
  });
}

async function openTab(page, tab) {
  await page.locator(`.settings-tab[data-tab="${tab}"]`).click();
}

async function openSettings(page, backend) {
  await stubGpuBackend(page, backend);
  await seedLibrary(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#settingsBtn").click();
  await expect(page.locator(".library-editor")).toBeVisible();
}

const cudaOption = (page) => page.locator('.set-demucs-device option[value="cuda"]');
const transcribeAuto = (page) => page.locator('.set-transcribe-lyrics option[value="auto"]');
const transcribeDesc = (page) => page.locator(".set-transcribe-desc");

test("a ROCm torch names the GPU as AMD", async ({ page }) => {
  await openSettings(page, "rocm");
  await openTab(page, "general");
  await expect(cudaOption(page)).toHaveText("ROCm (AMD)");
  await openTab(page, "details");
  await expect(transcribeAuto(page)).toHaveText("Auto (NVIDIA/AMD GPU only)");
  await expect(transcribeDesc(page)).toContainText("for an NVIDIA/AMD GPU");
});

test("a ROCm torch's wording follows the language", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stemdeck.language", JSON.stringify("de")));
  await openSettings(page, "rocm");
  await openTab(page, "details");
  await expect(transcribeAuto(page)).toHaveText("Auto (nur NVIDIA/AMD-GPU)");
  await expect(transcribeDesc(page)).toContainText("für eine NVIDIA/AMD-GPU");
});

for (const backend of ["cuda", null]) {
  test(`gpu_backend ${backend}: today's NVIDIA wording`, async ({ page }) => {
    await openSettings(page, backend);
    await openTab(page, "general");
    await expect(cudaOption(page)).toHaveText(/^CUDA \(NVIDIA\)/);
    await openTab(page, "details");
    await expect(transcribeAuto(page)).toHaveText("Auto (NVIDIA GPU only)");
    await expect(transcribeDesc(page)).toContainText("for an NVIDIA GPU");
  });
}
