"""Tests for the pipeline failure classifier and SeparationError (#294, #277)."""

from __future__ import annotations

import pytest

from app.pipeline.errors import (
    CAUSE_DISK_FULL,
    CAUSE_OUT_OF_MEMORY,
    CAUSE_UNSUPPORTED_DEVICE,
    SeparationError,
    classify_failure,
)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB", CAUSE_OUT_OF_MEMORY),
        ("RuntimeError: MPS backend out of memory (MPS allocated: 5.2 GB)", CAUSE_OUT_OF_MEMORY),
        ("OSError: cannot allocate memory", CAUSE_OUT_OF_MEMORY),
        ("RuntimeError: no kernel image is available for execution", CAUSE_UNSUPPORTED_DEVICE),
        ("AssertionError: Torch not compiled with CUDA enabled", CAUSE_UNSUPPORTED_DEVICE),
        # A ROCm build of torch on an AMD GPU, in HIP's and MIOpen's words. The
        # first two match older patterns, kept so a reordering cannot lose them.
        (
            "torch.OutOfMemoryError: HIP out of memory. Tried to allocate 1.50 GiB",
            CAUSE_OUT_OF_MEMORY,
        ),
        ("RuntimeError: HIP error: invalid device function", CAUSE_UNSUPPORTED_DEVICE),
        (
            "hipErrorNoBinaryForGpu: Unable to find code object for all current devices!",
            CAUSE_UNSUPPORTED_DEVICE,
        ),
        ("RuntimeError: No HIP GPUs are available", CAUSE_UNSUPPORTED_DEVICE),
        ("RuntimeError: miopenStatusUnknownError", CAUSE_UNSUPPORTED_DEVICE),
        ("RuntimeError: miopenStatusAllocFailed", CAUSE_OUT_OF_MEMORY),
        ("OSError: [Errno 28] No space left on device", CAUSE_DISK_FULL),
        ("Invalid data found when processing input", "bad-input"),
        ("RuntimeError: no stems produced by demucs", "bad-input"),
        ("something entirely novel went wrong", "unknown"),
        ("", "unknown"),
        # Source-fetch failures (#434). Strings taken verbatim from the yt-dlp
        # output in the issue rather than paraphrased.
        ("ERROR: [youtube] abc: Sign in to confirm you're not a bot.", "source-blocked"),
        ("HTTP Error 429: Too Many Requests", "source-blocked"),
        ("ERROR: [youtube] abc: Requested format is not available", "source-unavailable"),
        ("WARNING: Only images are available for download.", "source-unavailable"),
        ("n challenge solving failed: Some formats may be missing.", "source-unavailable"),
        ("ERROR: [youtube] abc: Video unavailable", "source-unavailable"),
        (
            "ERROR: [youtube] abc: Private video. Sign in if you've been granted access",
            "source-unavailable",
        ),
    ],
)
def test_classify_failure(text: str, expected: str):
    assert classify_failure(text) == expected


def test_resource_causes_win_over_source_causes():
    """A disk-full that happens mid-download is a disk-full, not a fetch
    failure: the resource-level patterns are ordered first for exactly this."""
    text = "ERROR: unable to write; OSError: [Errno 28] No space left on device"
    assert classify_failure(text) == CAUSE_DISK_FULL


def test_bot_check_matches_regardless_of_apostrophe():
    """yt-dlp has changed the quoting of this message between releases, so the
    pattern deliberately stops before the apostrophe."""
    for variant in ("you're not a bot", "you’re not a bot", "you are not a bot"):
        assert classify_failure(f"Sign in to confirm {variant}.") == "source-blocked"


def test_classify_is_case_insensitive():
    assert classify_failure("CUDA OUT OF MEMORY") == CAUSE_OUT_OF_MEMORY


def test_separation_error_carries_evidence():
    err = SeparationError("demucs failed: boom", tail=["line1", "boom"], device="mps")
    assert isinstance(err, RuntimeError)
    assert err.tail == ["line1", "boom"]
    assert err.device == "mps"


def test_separation_error_defaults():
    err = SeparationError("plain")
    assert err.tail == []
    assert err.device is None
