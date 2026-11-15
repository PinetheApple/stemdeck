"""Which encoder a render gets, the CPU fallback and the session switch-off.
GPU paths are mocked: the sandbox the agents run in hides /dev/nvidia* and
/dev/dri, so real NVENC and VAAPI runs are the owner's device check."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from app.core.video_config import NVENC, QSV, VAAPI, VIDEO_CPU_ENCODER
from app.pipeline import video_encoder
from app.pipeline.video_encoder import Choice, EncodeError, EncodeJob, choose, encode
from app.pipeline.video_encoder_args import libx264_args
from app.pipeline.video_probe import ProbeResult
from app.pipeline.video_validate import OutputInvalid
from tests._video_helpers import TINY_FPS, TINY_H, TINY_SEC, TINY_W, fresh_encoders, needs_libx264

__all__ = ["fresh_encoders"]

pytestmark = pytest.mark.usefixtures("fresh_encoders")

NODE_A = "/dev/dri/renderD128"
NODE_B = "/dev/dri/renderD129"


def _probes(monkeypatch, passing: set[tuple[str, str]]):
    """Mock probes: an (encoder, device) in `passing` passes, the rest fail."""
    asked: list[tuple[str, str]] = []

    def probe(encoder, width, height, fps, device="", force=False, cancelled=None):
        asked.append((encoder, device))
        ok = (encoder, device) in passing
        return ProbeResult(
            encoder,
            width,
            height,
            fps,
            ok=ok,
            reason="" if ok else "failed",
            device=device,
        )

    monkeypatch.setattr(video_encoder, "probe", probe)
    return asked


def test_cpu_setting_never_probes(monkeypatch):
    asked = _probes(monkeypatch, {(NVENC, "")})
    assert choose(1280, 720, 30, "cpu").encoder == VIDEO_CPU_ENCODER
    assert asked == []


def test_env_cpu_wins_over_a_picked_encoder(monkeypatch):
    asked = _probes(monkeypatch, {(NVENC, "")})
    monkeypatch.setenv("STEMDECK_VIDEO_ENCODER", "cpu")
    assert video_encoder.policy(NVENC) == ("cpu", "env")
    assert choose(1280, 720, 30, NVENC).encoder == VIDEO_CPU_ENCODER
    assert asked == []


def test_env_can_pick_an_encoder_and_a_bad_value_is_ignored(monkeypatch):
    monkeypatch.setenv("STEMDECK_VIDEO_ENCODER", "h264_nvenc")
    assert video_encoder.policy("cpu") == (NVENC, "env")
    monkeypatch.setenv("STEMDECK_VIDEO_ENCODER", "h264_vulkan")
    assert video_encoder.policy("cpu") == ("cpu", "setting")
    assert video_encoder.policy("bogus") == ("auto", "setting")


def test_auto_on_linux_stays_on_the_cpu(monkeypatch):
    asked = _probes(monkeypatch, {(NVENC, "")})
    assert choose(1280, 720, 30, "auto", platform="linux").encoder == VIDEO_CPU_ENCODER
    assert asked == []


def test_auto_on_windows_takes_nvenc_when_it_passes(monkeypatch):
    _probes(monkeypatch, {(NVENC, "")})
    assert choose(1280, 720, 30, "auto", platform="win32").encoder == NVENC


def test_a_picked_encoder_that_fails_its_probe_gives_the_cpu(monkeypatch):
    _probes(monkeypatch, set())
    picked = choose(1280, 720, 30, QSV)
    assert picked.encoder == VIDEO_CPU_ENCODER and picked.reason == "failed"


def test_vaapi_uses_the_first_node_that_passes(monkeypatch):
    monkeypatch.setattr(video_encoder, "render_nodes", lambda platform=None: [NODE_A, NODE_B])
    asked = _probes(monkeypatch, {(VAAPI, NODE_B)})
    picked = choose(1280, 720, 30, VAAPI, platform="linux")
    assert (picked.encoder, picked.device) == (VAAPI, NODE_B)
    assert asked == [(VAAPI, NODE_A), (VAAPI, NODE_B)]


def test_vaapi_without_a_node_gives_the_cpu(monkeypatch):
    monkeypatch.setattr(video_encoder, "render_nodes", lambda platform=None: [])
    _probes(monkeypatch, {(VAAPI, NODE_A)})
    picked = choose(1280, 720, 30, VAAPI, platform="linux")
    assert picked.encoder == VIDEO_CPU_ENCODER and picked.reason == "no-device"


def test_two_blamed_failures_switch_an_encoder_off(monkeypatch):
    asked = _probes(monkeypatch, {(NVENC, "")})
    assert not video_encoder.record_failure(NVENC, "exit")
    assert choose(1280, 720, 30, NVENC).encoder == NVENC
    assert video_encoder.record_failure(NVENC, "stall")
    assert video_encoder.disabled() == [NVENC]
    asked.clear()
    picked = choose(1280, 720, 30, NVENC)
    assert picked.encoder == VIDEO_CPU_ENCODER and picked.reason == "disabled"
    assert asked == []


def test_vaapi_failures_count_per_node(monkeypatch):
    monkeypatch.setattr(video_encoder, "render_nodes", lambda platform=None: [NODE_A, NODE_B])
    _probes(monkeypatch, {(VAAPI, NODE_A), (VAAPI, NODE_B)})
    video_encoder.record_failure(VAAPI, "exit", NODE_A)
    video_encoder.record_failure(VAAPI, "exit", NODE_A)
    assert choose(1280, 720, 30, VAAPI, platform="linux").device == NODE_B
    assert video_encoder.disabled() == []
    video_encoder.record_failure(VAAPI, "exit", NODE_B)
    video_encoder.record_failure(VAAPI, "exit", NODE_B)
    assert video_encoder.disabled() == [VAAPI]


def test_a_failure_drops_the_cached_pass(monkeypatch):
    dropped: list[tuple[str, str]] = []
    monkeypatch.setattr(video_encoder, "drop_passes", lambda e, d="": dropped.append((e, d)))
    video_encoder.record_failure(VAAPI, "exit", NODE_A)
    assert dropped == [(VAAPI, NODE_A)]


class _FakeRuns:
    """A render runner: GPU commands fail as told, CPU commands write a file."""

    def __init__(self, dest: Path, gpu_error: EncodeError | None = None):
        self.dest = dest
        self.gpu_error = gpu_error
        self.encoders: list[str] = []
        self.stalls: list[float | None] = []

    def build(self, encoder: str, variant: int, device: str) -> list[str]:
        return [encoder, str(variant), device]

    def run(self, cmd: list[str], timeout: float, stall: float | None) -> None:
        self.encoders.append(cmd[0])
        self.stalls.append(stall)
        self.dest.write_bytes(b"x")
        if cmd[0] != VIDEO_CPU_ENCODER and self.gpu_error is not None:
            raise self.gpu_error


def _job(runs: _FakeRuns) -> EncodeJob:
    return EncodeJob(runs.dest, 1280, 720, 30, 60.0, runs.build, runs.run)


def _gpu_chosen(monkeypatch, encoder=NVENC, device=""):
    monkeypatch.setattr(video_encoder, "choose", lambda *a, **k: Choice(encoder, device=device))


def _checks(monkeypatch, error: OutputInvalid | None = None):
    def check(path, width, height, fps, duration_sec, cancelled):
        if error is not None:
            raise error

    monkeypatch.setattr(video_encoder, "validate_output", check)


def test_a_gpu_render_that_passes_its_check_is_kept(monkeypatch, tmp_path):
    _gpu_chosen(monkeypatch)
    _checks(monkeypatch)
    runs = _FakeRuns(tmp_path / "out.mp4")
    outcome = encode(_job(runs))
    assert (outcome.encoder, outcome.family, outcome.fallback_reason) == (NVENC, "nvidia", None)
    assert runs.encoders == [NVENC] and runs.stalls[0] is not None


def test_a_gpu_render_that_fails_its_check_is_redone_on_the_cpu(monkeypatch, tmp_path):
    _gpu_chosen(monkeypatch)
    _checks(monkeypatch, OutputInvalid("decode"))
    runs = _FakeRuns(tmp_path / "out.mp4")
    outcome = encode(_job(runs))
    assert outcome.encoder == VIDEO_CPU_ENCODER and outcome.fallback_reason == "invalid-decode"
    assert runs.encoders == [NVENC, VIDEO_CPU_ENCODER] and runs.stalls[1] is None
    assert video_encoder.failure_count(NVENC) == 1


def test_a_gpu_stall_falls_back_and_counts(monkeypatch, tmp_path):
    _gpu_chosen(monkeypatch, VAAPI, NODE_B)
    runs = _FakeRuns(tmp_path / "out.mp4", EncodeError("stall"))
    outcome = encode(_job(runs))
    assert outcome.encoder == VIDEO_CPU_ENCODER and outcome.fallback_reason == "stall"
    assert video_encoder.failure_count(VAAPI, NODE_B) == 1


def test_a_full_disk_falls_back_without_counting(monkeypatch, tmp_path):
    _gpu_chosen(monkeypatch)
    runs = _FakeRuns(tmp_path / "out.mp4", EncodeError("exit", "Error: No space left on device"))
    assert encode(_job(runs)).fallback_reason == "exit"
    assert video_encoder.failure_count(NVENC) == 0


def test_the_encoders_own_error_counts(monkeypatch, tmp_path):
    _gpu_chosen(monkeypatch)
    stderr = "[h264_nvenc @ 0x1] EncodePicture failed!"
    for _ in range(2):
        encode(_job(_FakeRuns(tmp_path / "out.mp4", EncodeError("exit", stderr))))
    assert video_encoder.disabled() == [NVENC]


def test_a_cancel_never_falls_back(monkeypatch, tmp_path):
    _gpu_chosen(monkeypatch)
    runs = _FakeRuns(tmp_path / "out.mp4", EncodeError("cancelled"))
    with pytest.raises(EncodeError):
        encode(_job(runs))
    assert runs.encoders == [NVENC] and video_encoder.failure_count(NVENC) == 0


def test_test_all_reports_every_candidate_and_the_cpu(monkeypatch):
    monkeypatch.setattr(video_encoder, "render_nodes", lambda platform=None: [NODE_B])
    _probes(monkeypatch, {(VAAPI, NODE_B)})
    monkeypatch.setattr(
        video_encoder,
        "run_probe",
        lambda e, w, h, f, device="", cancelled=None: ProbeResult(e, w, h, f, ok=True),
    )
    rows = video_encoder.test_all(platform="linux")
    assert [r["encoder"] for r in rows] == [NVENC, VAAPI, QSV, VIDEO_CPU_ENCODER]
    vaapi = rows[1]["results"]
    assert set(vaapi) == {"720p30", "1080p60"} and vaapi["720p30"]["device"] == "renderD129"
    assert rows[0]["results"]["720p30"]["ok"] is False


def test_test_all_stops_at_its_budget(monkeypatch):
    _probes(monkeypatch, set())
    rows = video_encoder.test_all(budget_sec=0, platform="linux")
    assert all(r["reason"] == "budget" for row in rows for r in row["results"].values())


@needs_libx264
def test_a_real_cpu_render_through_encode(tmp_path):
    dest = tmp_path / "real.mp4"

    def build(encoder: str, variant: int, device: str) -> list[str]:
        src = ["-f", "lavfi", "-i", f"testsrc2=s={TINY_W}x{TINY_H}:r={TINY_FPS}:d={TINY_SEC}"]
        src += ["-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo:d={TINY_SEC}"]
        return [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            *src,
            *libx264_args(),
            "-c:a",
            "aac",
            str(dest),
        ]

    def run(cmd: list[str], timeout: float, stall: float | None) -> None:
        subprocess.run(cmd, check=True, timeout=timeout)

    outcome = encode(EncodeJob(dest, TINY_W, TINY_H, TINY_FPS, TINY_SEC, build, run), "cpu")
    assert outcome.encoder == VIDEO_CPU_ENCODER and dest.stat().st_size > 0
    video_encoder.validate_output(dest, TINY_W, TINY_H, TINY_FPS, TINY_SEC, lambda: False)


@pytest.mark.skipif(
    not os.environ.get("STEMDECK_TEST_GPU"),
    reason="real NVENC/VAAPI: unverifiable in the agent sandbox, owner's device check",
)
@pytest.mark.parametrize("encoder", [NVENC, VAAPI])
def test_real_gpu_probe(encoder):
    picked = choose(1280, 720, 30, encoder, platform="linux")
    assert picked.encoder == encoder, picked.reason
