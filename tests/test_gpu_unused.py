"""Why a GPU the desktop app found is not separating, read off its setup record (#188)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.core import gpu_unused as gu
from app.core.config import GPU_BACKEND_CUDA, GPU_BACKEND_ROCM


def _write_setup(path, **entries) -> None:
    path.write_text(json.dumps(entries), encoding="utf-8")


@pytest.fixture
def setup_config(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    monkeypatch.setattr(gu, "SETUP_CONFIG_PATH", path)
    return path


@pytest.mark.parametrize(
    ("reason", "backend", "expected"),
    [
        ("cuda-unsupported-gpu", GPU_BACKEND_CUDA, gu.UNUSED_UNSUPPORTED),
        ("cuda-unsupported-gpu", GPU_BACKEND_ROCM, gu.UNUSED_UNSUPPORTED),
        ("rocm-unsupported-gpu", GPU_BACKEND_ROCM, gu.UNUSED_UNSUPPORTED),
        ("rocm-no-kfd-access", GPU_BACKEND_ROCM, gu.UNUSED_NO_ACCESS),
        ("cuda-install-failed", GPU_BACKEND_CUDA, gu.UNUSED_INSTALL_FAILED),
        ("cuda-install-failed-cpu-restore-failed", GPU_BACKEND_ROCM, gu.UNUSED_INSTALL_FAILED),
        ("cuda-verify-failed", GPU_BACKEND_ROCM, gu.UNUSED_CHECK_FAILED),
        ("cuda-verify-failed-cpu-restore-failed", GPU_BACKEND_CUDA, gu.UNUSED_CHECK_FAILED),
    ],
)
def test_a_found_but_unused_gpu_says_why_and_which_card(setup_config, reason, backend, expected):
    _write_setup(setup_config, torchDevice="cpu", torchDeviceReason=reason, gpuBackend=backend)
    assert gu.gpu_unused() == {"reason": expected, "backend": backend}


@pytest.mark.parametrize(
    "entries",
    [
        {"torchDevice": "cuda", "torchDeviceReason": "verified", "gpuBackend": GPU_BACKEND_CUDA},
        {"torchDevice": "cpu", "torchDeviceReason": "no-gpu-detected", "gpuBackend": None},
        {"torchDevice": "cpu", "torchDeviceReason": "cpu-only-package", "gpuBackend": None},
        {"torchDevice": "mps", "torchDeviceReason": "mps", "gpuBackend": None},
        {"torchDevice": "cpu", "torchDeviceReason": "mps-unavailable", "gpuBackend": None},
        # Recorded before the card type was: the card cannot be named, so nothing is said.
        {"torchDevice": "cpu", "torchDeviceReason": "cuda-verify-failed"},
        # Recorded before any reason was.
        {"torchDevice": "cpu"},
        {"torchDevice": "cpu", "torchDeviceReason": "some-future-reason", "gpuBackend": "cuda"},
        {"torchDevice": "cpu", "torchDeviceReason": "cuda-verify-failed", "gpuBackend": "metal"},
    ],
)
def test_nothing_is_said_unless_a_known_card_was_found_and_left_unused(setup_config, entries):
    _write_setup(setup_config, **entries)
    assert gu.gpu_unused() is None


def test_nothing_is_said_without_a_desktop_setup_record(setup_config):
    assert gu.gpu_unused() is None


@pytest.mark.parametrize("text", ["{not json", "[]", ""])
def test_an_unreadable_setup_record_says_nothing(setup_config, text):
    setup_config.write_text(text, encoding="utf-8")
    assert gu.gpu_unused() is None


def test_settings_carry_the_reason(setup_config):
    _write_setup(
        setup_config,
        torchDevice="cpu",
        torchDeviceReason="rocm-no-kfd-access",
        gpuBackend=GPU_BACKEND_ROCM,
    )
    from app.main import app

    with TestClient(app) as c:
        body = c.get("/api/settings").json()
    assert body["gpu_unused"] == {"reason": gu.UNUSED_NO_ACCESS, "backend": GPU_BACKEND_ROCM}


def test_settings_carry_null_when_the_gpu_is_in_use(setup_config):
    _write_setup(
        setup_config,
        torchDevice="cuda",
        torchDeviceReason="verified",
        gpuBackend=GPU_BACKEND_CUDA,
    )
    from app.main import app

    with TestClient(app) as c:
        body = c.get("/api/settings").json()
    assert body["gpu_unused"] is None
