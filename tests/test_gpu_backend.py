"""Which kind of GPU drives torch's "cuda" device.

A ROCm build of torch serves an AMD GPU through torch.cuda, so the device is
"cuda" for NVIDIA and AMD alike, and every device setting, job record and
worker stays as it is. Only what the user is shown needs to tell them apart.
These swap in a stand-in torch, so they run whether the real torch here is a
CPU, CUDA or ROCm build, or absent.
"""

from __future__ import annotations

import sys
import types

import pytest
from fastapi.testclient import TestClient

from app.core import config

ROCM_HIP = "6.4.43482-0f2d60242"
CUDA_VERSION = "12.4"


def _fake_torch(*, cuda: bool, hip: str | None) -> types.ModuleType:
    torch = types.ModuleType("torch")
    torch.version = types.SimpleNamespace(cuda=None if hip else CUDA_VERSION, hip=hip)
    torch.cuda = types.SimpleNamespace(
        is_available=lambda: cuda,
        # The card is never asked: GPU work belongs to the worker processes.
        get_device_name=pytest.fail,
    )
    torch.backends = types.SimpleNamespace()
    return torch


@pytest.mark.parametrize(
    ("cuda", "hip", "expected"),
    [
        (True, ROCM_HIP, config.GPU_BACKEND_ROCM),
        (True, None, config.GPU_BACKEND_CUDA),
        (False, None, None),
        # A ROCm build on a machine whose GPU it cannot reach (no /dev/kfd).
        (False, ROCM_HIP, None),
    ],
)
def test_the_backend_is_read_off_the_build(monkeypatch, cuda, hip, expected):
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(cuda=cuda, hip=hip))
    assert config.torch_gpu_backend(config.available_torch_devices()) == expected


def _settings_with(monkeypatch, *, cuda: bool, hip: str | None) -> dict:
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(cuda=cuda, hip=hip))
    from app.main import app

    with TestClient(app) as c:
        return c.get("/api/settings").json()


def test_settings_say_an_amd_gpu_runs_cuda(monkeypatch):
    body = _settings_with(monkeypatch, cuda=True, hip=ROCM_HIP)
    assert body["demucs_devices_available"] == ["cuda", "cpu"]
    assert body["gpu_backend"] == config.GPU_BACKEND_ROCM


def test_settings_say_an_nvidia_gpu_runs_cuda(monkeypatch):
    body = _settings_with(monkeypatch, cuda=True, hip=None)
    assert body["gpu_backend"] == config.GPU_BACKEND_CUDA


def test_settings_carry_no_backend_without_a_gpu(monkeypatch):
    body = _settings_with(monkeypatch, cuda=False, hip=None)
    assert body["demucs_devices_available"] == ["cpu"]
    assert body["gpu_backend"] is None
