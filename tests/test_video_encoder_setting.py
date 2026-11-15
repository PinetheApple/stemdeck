"""The video_encoder setting: stored like export_sample_rate, served and saved
through /api/settings, with STEMDECK_VIDEO_ENCODER reported beside it."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core import settings
from app.core.video_config import ENCODER_ENV, NVENC, POLICY_AUTO, POLICY_CPU


@pytest.fixture
def client(monkeypatch):
    from app.main import app

    monkeypatch.delenv(ENCODER_ENV, raising=False)
    with TestClient(app) as c:
        yield c


def test_the_setting_defaults_to_auto_and_round_trips():
    assert settings.get_video_encoder() == POLICY_AUTO
    assert settings.set_video_encoder(NVENC) == NVENC
    settings._state = None
    assert settings.get_video_encoder() == NVENC


def test_an_unknown_value_is_refused_and_a_stored_one_ignored():
    with pytest.raises(ValueError):
        settings.set_video_encoder("h264_vulkan")
    settings._ensure()["video_encoder"] = "h264_vulkan"
    assert settings.get_video_encoder() == POLICY_AUTO


def test_settings_serve_the_choice_and_this_oss_options(client):
    body = client.get("/api/settings").json()
    assert body["video_encoder"] == POLICY_AUTO and body["video_encoder_env"] is None
    assert body["video_encoder_choices"][:2] == [POLICY_AUTO, POLICY_CPU]


def test_settings_save_the_choice(client):
    assert client.post("/api/settings", json={"video_encoder": POLICY_CPU}).status_code == 200
    assert client.get("/api/settings").json()["video_encoder"] == POLICY_CPU


def test_a_bad_value_is_a_422_and_changes_nothing(client):
    r = client.post("/api/settings", json={"video_encoder": "h264_vulkan"})
    assert r.status_code == 422
    assert client.get("/api/settings").json()["video_encoder"] == POLICY_AUTO


def test_the_env_override_is_reported(client, monkeypatch):
    monkeypatch.setenv(ENCODER_ENV, "cpu")
    assert client.get("/api/settings").json()["video_encoder_env"] == POLICY_CPU
