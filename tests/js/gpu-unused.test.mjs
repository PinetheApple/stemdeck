// The Settings line that says why a found GPU is not used (#188): which i18n
// key and card name each `gpu_unused` value gets, when it stays hidden, and that
// every language has its own wording with the card name in it.
//
// Run:  node tests/js/gpu-unused.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {};
globalThis.document = { documentElement: { getAttribute: () => null }, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { LANGUAGES, TRANSLATIONS } = await import("../../static/js/i18n.js");
const {
  GPU_BACKEND_CUDA, GPU_BACKEND_ROCM, GPU_UNUSED_KEY, GPU_UNUSED_REASON, gpuUnusedMessage,
} = await import("../../static/js/gpuUnused.js");

const LOCALE_FALLBACK = { "pt-PT": "pt" };
const CARD_PLACEHOLDER = "{card}";
const TORCH_ERROR = "OSError: libtorch_hip.so: cannot open shared object file";
const EXPECTED_KEYS = {
  unsupported: "settings.device.gpuUnused.unsupported",
  "no-access": "settings.device.gpuUnused.noAccess",
  "install-failed": "settings.device.gpuUnused.installFailed",
  "check-failed": "settings.device.gpuUnused.checkFailed",
};
const EXPECTED_CARDS = { cuda: "NVIDIA", rocm: "AMD" };

const settingsWith = (reason, backend, extra = {}) => ({ gpu_unused: { reason, backend }, ...extra });

function ownTable(code) {
  const base = LOCALE_FALLBACK[code] ? TRANSLATIONS[LOCALE_FALLBACK[code]] : {};
  return { ...base, ...TRANSLATIONS[code] };
}

test("each reason slug maps to its own key, for either card", () => {
  for (const [reason, key] of Object.entries(EXPECTED_KEYS)) {
    for (const [backend, card] of Object.entries(EXPECTED_CARDS)) {
      assert.deepEqual(gpuUnusedMessage(settingsWith(reason, backend)), { key, vars: { card } });
    }
  }
});

test("the slug constants are the contract's slugs", () => {
  assert.deepEqual(Object.values(GPU_UNUSED_REASON).sort(), Object.keys(EXPECTED_KEYS).sort());
  assert.deepEqual([GPU_BACKEND_CUDA, GPU_BACKEND_ROCM], Object.keys(EXPECTED_CARDS));
});

test("no gpu_unused hides the line", () => {
  assert.equal(gpuUnusedMessage({ gpu_unused: null }), null);
  assert.equal(gpuUnusedMessage({}), null);
  assert.equal(gpuUnusedMessage(null), null);
});

test("a torch error hides the line", () => {
  assert.equal(gpuUnusedMessage(settingsWith("no-access", "rocm", { torch_error: TORCH_ERROR })), null);
});

test("an unknown reason or card hides the line", () => {
  assert.equal(gpuUnusedMessage(settingsWith("melted", "cuda")), null);
  assert.equal(gpuUnusedMessage(settingsWith("unsupported", "mps")), null);
  assert.equal(gpuUnusedMessage(settingsWith("unsupported", null)), null);
});

test("every language words each reason itself and names the card", () => {
  for (const { code } of LANGUAGES) {
    const table = ownTable(code);
    for (const key of Object.values(GPU_UNUSED_KEY)) {
      const text = table[key];
      assert.ok(typeof text === "string" && text.trim() !== "", `${code}: ${key} missing`);
      assert.ok(text.includes(CARD_PLACEHOLDER), `${code}: ${key} lacks ${CARD_PLACEHOLDER}`);
      if (code !== "en") assert.notEqual(text, TRANSLATIONS.en[key], `${code}: ${key} is English`);
    }
  }
});
