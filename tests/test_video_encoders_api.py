"""GET /api/video-encoders and POST /api/video-encoders/test, through the real
app. Probes are mocked: nothing here opens a GPU."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.api import video_encoders as api
from app.core.video_config import ENCODER_ENV, NVENC, QSV, VIDEO_CPU_ENCODER
from app.pipeline import video_encoder
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
