"""GET /api/video-encoders and POST /api/video-encoders/test, through the real
app. Probes are mocked: nothing here opens a GPU."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.api import video_encoders as api
from app.core.video_config import ENCODER_ENV, NVENC, QSV, VIDEO_CPU_ENCODER
from app.pipeline import video_encoder, video_probe_store
from app.pipeline.video_probe_store import ProbeTarget, cache_key
from tests._video_helpers import fresh_encoders

__all__ = ["fresh_encoders"]

pytestmark = pytest.mark.usefixtures("fresh_encoders")

URL = "/api/video-encoders"


@pytest.fixture
def client():
    from app.main import app

    with TestClient(app) as c:
        yield c


def test_status_reports_the_policy_and_nothing_cached(client):
    body = client.get(URL).json()
    assert body["policy"] == "auto" and body["setting"] == "auto" and body["env"] is None
    assert body["disabled"] == [] and body["results"] == []
    assert VIDEO_CPU_ENCODER not in body["candidates"]


def test_status_reports_the_env_override(client, monkeypatch):
    monkeypatch.setenv(ENCODER_ENV, "cpu")
    body = client.get(URL).json()
    assert (body["policy"], body["env"], body["setting"]) == ("cpu", "cpu", "auto")


def test_status_lists_cached_results_and_switched_off_encoders(client, monkeypatch):
    monkeypatch.setattr(video_probe_store, "ffmpeg_identity", lambda: "ident-a")
    target = ProbeTarget(NVENC, 1920, 1080, 30)
    video_probe_store.fresh_hit(cache_key(target))
    video_probe_store.store(cache_key(target), target.result(True, speed=9.5))
    video_encoder.record_failure(QSV, "stall")
    video_encoder.record_failure(QSV, "stall")
    body = client.get(URL).json()
    assert body["disabled"] == [QSV]
    assert [(r["encoder"], r["ok"], r["speed"]) for r in body["results"]] == [(NVENC, True, 9.5)]


def test_the_test_returns_one_row_per_encoder(client, monkeypatch):
    rows = [{"encoder": NVENC, "family": "nvidia", "disabled": False, "results": {}}]
    monkeypatch.setattr(api, "test_all", lambda: rows)
    r = client.post(f"{URL}/test")
    assert r.status_code == 200 and r.json() == {"rows": rows}


def test_the_test_is_refused_while_another_runs(client, monkeypatch):
    monkeypatch.setattr(api, "test_all", lambda: [])
    with api._test_lock:
        assert client.post(f"{URL}/test").status_code == 409
    assert client.post(f"{URL}/test").status_code == 200


def test_the_test_is_refused_while_a_render_runs(client, monkeypatch):
    monkeypatch.setattr(api, "test_all", lambda: [])
    monkeypatch.setattr(api, "encode_running", lambda: True)
    assert client.post(f"{URL}/test").status_code == 409
