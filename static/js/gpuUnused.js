// Why a GPU StemDeck found is not used for separation: the `gpu_unused` field
// of GET /api/settings, turned into the i18n key and card name of one line.

export const GPU_BACKEND_CUDA = "cuda";
export const GPU_BACKEND_ROCM = "rocm";

export const GPU_UNUSED_REASON = Object.freeze({
  UNSUPPORTED: "unsupported",
  NO_ACCESS: "no-access",
  INSTALL_FAILED: "install-failed",
  CHECK_FAILED: "check-failed",
});

export const GPU_UNUSED_KEY = Object.freeze({
  [GPU_UNUSED_REASON.UNSUPPORTED]: "settings.device.gpuUnused.unsupported",
  [GPU_UNUSED_REASON.NO_ACCESS]: "settings.device.gpuUnused.noAccess",
  [GPU_UNUSED_REASON.INSTALL_FAILED]: "settings.device.gpuUnused.installFailed",
  [GPU_UNUSED_REASON.CHECK_FAILED]: "settings.device.gpuUnused.checkFailed",
});

export const GPU_CARD_NAME = Object.freeze({
  [GPU_BACKEND_CUDA]: "NVIDIA",
  [GPU_BACKEND_ROCM]: "AMD",
});

// A broken torch install stops separation on every device, so its own line
// wins and this one stays hidden.
export function gpuUnusedMessage(settings) {
  const unused = settings?.gpu_unused;
  if (!unused || settings.torch_error) return null;
  const key = GPU_UNUSED_KEY[unused.reason];
  const card = GPU_CARD_NAME[unused.backend];
  if (!key || !card) return null;
  return { key, vars: { card } };
}
