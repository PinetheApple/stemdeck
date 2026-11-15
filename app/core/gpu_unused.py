"""Why a GPU the desktop app found is not the one separating (#188).

The desktop shell decides the torch device once per setup run and records the
outcome in DATA_DIR/config.json: `torchDeviceReason` says why, `gpuBackend`
says which torch build the card needed ("cuda" for NVIDIA, "rocm" for AMD).
The reason alone cannot name the card: an AMD install that fails runs through
the same candidate loop as an NVIDIA one and is recorded as `cuda-*` too.

Settings shows one plain line from this, and only when a card was found and
left unused. Everything else -- the GPU in use, no GPU, a CPU-only package,
macOS, a record older than either key, Docker or a dev checkout with no record
at all -- says nothing. The server hands over identity only (a slug and the
backend); the wording lives in the UI's i18n table.
"""

from __future__ import annotations

import json
import logging
from typing import TypedDict

from app.core.config import DATA_DIR, GPU_BACKEND_CUDA, GPU_BACKEND_ROCM

logger = logging.getLogger("stemdeck.gpu_unused")

SETUP_CONFIG_PATH = DATA_DIR / "config.json"
SETUP_REASON_KEY = "torchDeviceReason"
SETUP_BACKEND_KEY = "gpuBackend"

UNUSED_UNSUPPORTED = "unsupported"
UNUSED_NO_ACCESS = "no-access"
UNUSED_INSTALL_FAILED = "install-failed"
UNUSED_CHECK_FAILED = "check-failed"

# The desktop's reasons (desktop/src-tauri/src/main.rs, rocm.rs) for a found card.
_UNUSED_BY_REASON: dict[str, str] = {
    "cuda-unsupported-gpu": UNUSED_UNSUPPORTED,
    "rocm-unsupported-gpu": UNUSED_UNSUPPORTED,
    "rocm-no-kfd-access": UNUSED_NO_ACCESS,
    "cuda-install-failed": UNUSED_INSTALL_FAILED,
    "cuda-install-failed-cpu-restore-failed": UNUSED_INSTALL_FAILED,
    "cuda-verify-failed": UNUSED_CHECK_FAILED,
    "cuda-verify-failed-cpu-restore-failed": UNUSED_CHECK_FAILED,
}
_CARD_BACKENDS = frozenset((GPU_BACKEND_CUDA, GPU_BACKEND_ROCM))


class GpuUnused(TypedDict):
    reason: str
    backend: str


def _read_setup_record() -> dict[str, object]:
    try:
        record = json.loads(SETUP_CONFIG_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        logger.warning("cannot read the desktop setup record %s: %s", SETUP_CONFIG_PATH, exc)
        return {}
    return record if isinstance(record, dict) else {}


def gpu_unused() -> GpuUnused | None:
    """Why the GPU the desktop found is not used and which card it is, or None
    when there is nothing to say."""
    record = _read_setup_record()
    reason = _UNUSED_BY_REASON.get(str(record.get(SETUP_REASON_KEY)))
    backend = record.get(SETUP_BACKEND_KEY)
    if reason is None or backend not in _CARD_BACKENDS:
        return None
    return {"reason": reason, "backend": str(backend)}
