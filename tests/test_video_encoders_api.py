"""GET /api/video-encoders and POST /api/video-encoders/test, through the real
app. Probes are mocked: nothing here opens a GPU."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.api import video_encoders as api
from app.core import video_config
from app.core.video_config import ENCODER_ENV, NVENC, QSV, VAAPI, VIDEO_CPU_ENCODER, os_release_ids
from app.pipeline import video_encoder
from app.pipeline.video_probe import ProbeResult
from tests._video_helpers import fresh_encoders

__all__ = ["fresh_encoders"]

pytestmark = pytest.mark.usefixtures("fresh_encoders")

URL = "/api/video-encoders"
ROWS = [{"encoder": NVENC, "family": "nvidia", "disabled": False, "results": {}}]


@pytest.fixture
def client(monkeypatch):
    from app.main import app

    monkeypatch.setattr(api, "_last_test", None)
    with TestClient(app) as c:
        yield c


def test_status_has_the_contract_shape(client):
    body = client.get(URL).json()
    assert set(body) == {
        "policy",
        "choices",
        "candidates",
        "disabled",
        "render_available",
        "last_test",
        "os",
        "auto_pick",
    }
    assert body["policy"] == {"value": "auto", "source": "setting"}
    assert body["choices"][:2] == ["auto", "cpu"]
    assert VIDEO_CPU_ENCODER not in body["candidates"]
    assert body["disabled"] == [] and body["last_test"] is None


@pytest.mark.parametrize("tools", [True, False])
def test_render_available_follows_the_ffmpeg_tools(client, monkeypatch, tools):
    monkeypatch.setattr(api, "render_tools_available", lambda: tools)
    assert client.get(URL).json()["render_available"] is tools


def test_status_reports_the_env_override(client, monkeypatch):
    monkeypatch.setenv(ENCODER_ENV, "cpu")
    assert client.get(URL).json()["policy"] == {"value": "cpu", "source": "env"}


def test_status_lists_switched_off_encoders(client):
    video_encoder.record_failure(QSV, "stall")
    video_encoder.record_failure(QSV, "stall")
    assert client.get(URL).json()["disabled"] == [QSV]


def test_the_test_returns_its_rows_and_status_keeps_them(client, monkeypatch):
    monkeypatch.setattr(api, "test_all", lambda: ROWS)
    r = client.post(f"{URL}/test")
    assert r.status_code == 200 and r.json()["rows"] == ROWS
    last = client.get(URL).json()["last_test"]
    assert last["rows"] == ROWS and last["at"] == r.json()["at"] > 0


def test_the_test_is_refused_while_another_runs(client, monkeypatch):
    monkeypatch.setattr(api, "test_all", lambda: [])
    assert video_encoder.try_begin_test()
    try:
        assert client.post(f"{URL}/test").status_code == 409
    finally:
        video_encoder.end_test()
    assert client.post(f"{URL}/test").status_code == 200


def test_the_test_is_refused_while_an_export_encodes(client, monkeypatch):
    monkeypatch.setattr(api, "test_all", lambda: [])
    with video_encoder.encoding():
        assert client.post(f"{URL}/test").status_code == 409
    assert client.post(f"{URL}/test").status_code == 200


OS_RELEASE = 'NAME="Arch Linux"\nID=arch\nID_LIKE="manjaro endeavouros"\nVERSION_ID=2026.11\n'


def _fake_os_release(monkeypatch, tmp_path, text: str | None):
    path = tmp_path / "os-release"
    if text is not None:
        path.write_text(text, encoding="utf-8")
    monkeypatch.setattr(video_config, "OS_RELEASE_PATH", path)


def test_status_names_the_os_and_its_distro(client, monkeypatch, tmp_path):
    _fake_os_release(monkeypatch, tmp_path, OS_RELEASE)
    monkeypatch.setattr(video_config.sys, "platform", "linux")
    assert client.get(URL).json()["os"] == {
        "key": "linux",
        "distro": "arch",
        "distro_like": "manjaro endeavouros",
    }


def test_distro_is_null_when_os_release_is_missing_or_bare(monkeypatch, tmp_path):
    _fake_os_release(monkeypatch, tmp_path, None)
    assert os_release_ids("linux") == (None, None)
    _fake_os_release(monkeypatch, tmp_path, "NAME=Plain\nID=\n")
    assert os_release_ids("linux") == (None, None)


def test_distro_is_null_off_linux(monkeypatch, tmp_path):
    _fake_os_release(monkeypatch, tmp_path, OS_RELEASE)
    assert os_release_ids("win32") == (None, None)
    assert os_release_ids("darwin") == (None, None)


def _cached(monkeypatch, *results: ProbeResult):
    monkeypatch.setattr(video_encoder, "cached_results", lambda: list(results))

    def no_probe(*_args, **_kwargs):
        raise AssertionError("the status must not probe")

    monkeypatch.setattr(video_encoder, "probe", no_probe)


def _result(encoder: str, ok: bool) -> ProbeResult:
    return ProbeResult(encoder, 1920, 1080, 30, ok=ok, reason="" if ok else "failed")


def test_auto_pick_is_the_encoder_auto_would_use_from_the_cache(client, monkeypatch):
    monkeypatch.setattr(video_config.sys, "platform", "linux")
    _cached(monkeypatch, _result(NVENC, ok=True))
    assert client.get(URL).json()["auto_pick"] == NVENC


@pytest.mark.parametrize(
    "results",
    [(), (_result(NVENC, ok=False),), (_result(VAAPI, ok=True),)],
)
def test_auto_pick_is_null_when_auto_would_use_the_cpu(client, monkeypatch, results):
    monkeypatch.setattr(video_config.sys, "platform", "linux")
    _cached(monkeypatch, *results)
    assert client.get(URL).json()["auto_pick"] is None


def test_auto_pick_skips_an_encoder_switched_off(client, monkeypatch):
    monkeypatch.setattr(video_config.sys, "platform", "linux")
    _cached(monkeypatch, _result(NVENC, ok=True))
    video_encoder.record_failure(NVENC, "stall")
    video_encoder.record_failure(NVENC, "stall")
    assert client.get(URL).json()["auto_pick"] is None
