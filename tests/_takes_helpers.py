"""Shared setup for the takes and tracks API tests: the takes router on its
own app, a finished song with one stem, and the recorder's calls."""

from __future__ import annotations

import numpy as np
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.takes import router as takes_router
from app.core.models import Job
from app.core.registry import _jobs
from app.core.takes_config import TAKE_RATE

JOB = "abcdefabcdef"
SONG_SEC = 4
CAPTURE_RATE = 48000
OCTET = {"Content-Type": "application/octet-stream"}


def make_client() -> TestClient:
    app = FastAPI()
    app.include_router(takes_router, prefix="/api/jobs")
    return TestClient(app)


def add_done_job(jobs_dir, job_id: str = JOB) -> Job:
    job = Job(id=job_id)
    job.status = "done"
    job.duration_sec = float(SONG_SEC)
    _jobs[job.id] = job
    stems = jobs_dir / job_id / "stems"
    stems.mkdir(parents=True)
    silence = np.zeros((TAKE_RATE * SONG_SEC, 2), dtype=np.float32)
    sf.write(str(stems / "drums.wav"), silence, TAKE_RATE, subtype="PCM_16")
    return job


def start_body(track_id: str, frame0: float = 0.5, round_trip_ms: float = 20.0, **over) -> dict:
    body = {
        "track_id": track_id,
        "timeline": {"frame0_song_sec": frame0, "tempo": 1.0},
        "latency": {"round_trip_ms": round_trip_ms, "source": "calibrated"},
        "capture": {"rate": CAPTURE_RATE, "channels": 1},
    }
    body.update(over)
    return body


def pcm(frames: int = CAPTURE_RATE // 2, impulse: int | None = None) -> bytes:
    samples = np.zeros(frames, dtype=np.float32)
    if impulse is not None:
        samples[impulse] = 0.9
    return samples.tobytes()


def new_track(client: TestClient, job_id: str = JOB, **body) -> str:
    r = client.post(f"/api/jobs/{job_id}/tracks", json=body)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def new_take(client: TestClient, track_id: str, job_id: str = JOB, **over) -> str:
    r = client.post(f"/api/jobs/{job_id}/takes", json=start_body(track_id, **over))
    assert r.status_code == 201, r.text
    return r.json()["take_id"]


def put_part(client: TestClient, take_id: str, seq: int, data: bytes, job_id: str = JOB):
    return client.put(
        f"/api/jobs/{job_id}/takes/{take_id}/parts?seq={seq}",
        content=data,
        headers=OCTET,
    )


def recorded_take(
    client: TestClient,
    track_id: str,
    job_id: str = JOB,
    impulse: int | None = None,
    **over,
) -> dict:
    """A take created, given one part and finished: its entry."""
    take_id = new_take(client, track_id, job_id, **over)
    assert put_part(client, take_id, 0, pcm(impulse=impulse), job_id).status_code == 200
    r = client.post(f"/api/jobs/{job_id}/takes/{take_id}/finish", json={})
    assert r.status_code == 200, r.text
    return r.json()
