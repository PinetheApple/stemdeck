"""Versions of a song (#96): named choices of stems over the song's one set of
stem files, kept on the job record and in its metadata.json.

A song made before versions existed reads as one implicit "Original" and
nothing is written for it until a version is created, renamed, deleted or
opened as a different one. No route reads, writes or deletes a stem file.
"""

from __future__ import annotations

import json
import os
import re
import subprocess

import pytest
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.api.jobs import RESTORE_FROM_TRASH_FIRST
from app.core.config import MAX_VERSIONS_PER_SONG, STEM_NAMES, VERSION_NAME_MAX_CHARS
from app.core.models import Job
from app.core.registry import _jobs, register, registry_path
from app.core.versions import DEFAULT_VERSION_ID
from app.main import app
from app.pipeline.runner import _write_metadata

JOB_ID = "aaaaaaaaaaaa"
BASE = f"/api/jobs/{JOB_ID}/versions"
SELECTED = ["vocals", "drums"]
NEW_ID_RE = re.compile(r"^[0-9a-f]{8}$")
# A song with three versions, the second one open, as other suites record it.
THREE_VERSIONS = [
    {"id": DEFAULT_VERSION_ID, "name": None, "stems": ["vocals", "drums"], "created_at": 1.0},
    {"id": "abc12345", "name": "Practice", "stems": ["drums", "bass"], "created_at": 2.0},
    {"id": "def67890", "name": "+ Guitar", "stems": ["drums", "guitar"], "created_at": 3.0},
]
THREE_OPEN = "abc12345"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _stems_dir():
    return cfg.JOBS_DIR / JOB_ID / "stems"


def _done(status: str = "done", **fields) -> Job:
    job = Job(id=JOB_ID, status=status, title="Song", selected_stems=SELECTED, **fields)
    register(job)
    _stems_dir().mkdir(parents=True, exist_ok=True)
    for name in STEM_NAMES:
        (_stems_dir() / f"{name}.wav").write_bytes(b"RIFF")
    _write_metadata(job, cfg.JOBS_DIR / JOB_ID)
    return job


def _meta_path():
    return cfg.JOBS_DIR / JOB_ID / "metadata.json"


def _meta() -> dict:
    return json.loads(_meta_path().read_text(encoding="utf-8"))


def _listing() -> list[tuple[str, int]]:
    return sorted((p.name, p.stat().st_size) for p in _stems_dir().iterdir())


def _create(client, name="Version 2", stems=SELECTED, **extra):
    return client.post(BASE, json={"name": name, "stems": stems, **extra})


def _extract(client, source=DEFAULT_VERSION_ID, stems=("guitar",), name="+ Guitar"):
    return client.post(f"{BASE}/extract", json={"from": source, "stems": list(stems), "name": name})


# ── reading ──


def test_a_legacy_song_reads_as_one_original_and_reading_writes_nothing(client):
    _done()
    before = (_meta_path().read_bytes(), _listing())

    body = client.get(BASE).json()
    state = client.get(f"/api/jobs/{JOB_ID}").json()

    assert body["job_id"] == JOB_ID
    assert [(v["id"], v["name"], v["stems"]) for v in body["versions"]] == [
        (DEFAULT_VERSION_ID, None, SELECTED)
    ]
    assert body["open_version"] == DEFAULT_VERSION_ID
    assert state["versions"] == body["versions"]
    assert state["open_version"] == DEFAULT_VERSION_ID
    assert state["selected_stems"] == SELECTED
    assert (_meta_path().read_bytes(), _listing()) == before
    assert not registry_path(cfg.JOBS_DIR).exists()


def test_a_song_in_any_status_can_be_listed(client):
    _done(status="separating")
    assert client.get(BASE).status_code == 200


# ── open ──


def test_open_sets_the_open_version_in_the_registry_and_the_folder(client):
    _done()
    vid = _create(client).json()["version"]["id"]

    r = client.post(f"{BASE}/{vid}/open")

    assert r.status_code == 200
    assert r.json()["open_version"] == vid
    assert _jobs[JOB_ID].open_version == vid
    assert _meta()["open_version"] == vid
    persisted = json.loads(registry_path(cfg.JOBS_DIR).read_text(encoding="utf-8"))
    assert persisted["jobs"][0]["open_version"] == vid


def test_opening_the_open_version_writes_nothing(client):
    _done()
    stamp = 1_000_000_000
    os.utime(_meta_path(), (stamp, stamp))
    before = _meta_path().read_bytes()

    r = client.post(f"{BASE}/{DEFAULT_VERSION_ID}/open")

    assert r.status_code == 200
    assert _meta_path().stat().st_mtime == stamp
    assert _meta_path().read_bytes() == before
    assert not registry_path(cfg.JOBS_DIR).exists()


# ── rename ──


def test_rename_materialises_the_default_with_the_new_name(client):
    _done()
    r = client.patch(f"{BASE}/{DEFAULT_VERSION_ID}", json={"name": "  Practice "})
    assert r.status_code == 200
    versions = r.json()["versions"]
    assert [(v["id"], v["name"], v["stems"]) for v in versions] == [
        (DEFAULT_VERSION_ID, "Practice", SELECTED)
    ]
    assert _jobs[JOB_ID].versions == versions
    assert _meta()["versions"] == versions


@pytest.mark.parametrize("name", ["", "   ", "x" * (VERSION_NAME_MAX_CHARS + 1)])
def test_an_empty_or_too_long_name_is_refused(client, name):
    _done()
    r = client.patch(f"{BASE}/{DEFAULT_VERSION_ID}", json={"name": name})
    assert r.status_code == 422
    assert _jobs[JOB_ID].versions is None


def test_rename_refuses_unknown_fields(client):
    _done()
    r = client.patch(f"{BASE}/{DEFAULT_VERSION_ID}", json={"name": "A", "stems": ["bass"]})
    assert r.status_code == 422


# ── save as new ──


def test_save_as_new_adds_a_version_and_leaves_the_open_one(client):
    _done()
    r = _create(client, stems=["drums", "vocals", "nope"])
    assert r.status_code == 201
    body = r.json()
    new = body["version"]
    assert NEW_ID_RE.match(new["id"])
    assert (new["name"], new["stems"]) == ("Version 2", SELECTED)
    assert [v["id"] for v in body["versions"]] == [DEFAULT_VERSION_ID, new["id"]]
    assert body["open_version"] == DEFAULT_VERSION_ID


def test_save_as_new_with_open_moves_the_open_version(client):
    _done()
    body = _create(client, open=True).json()
    assert body["open_version"] == body["version"]["id"]
    assert _meta()["open_version"] == body["version"]["id"]


@pytest.mark.parametrize("stems", [[], ["nope"], ["lead_vocals"]])
def test_save_as_new_needs_a_known_stem(client, stems):
    _done()
    r = _create(client, stems=stems)
    assert r.status_code == 422
    assert r.json()["detail"] == "choose at least one known stem"
    assert _jobs[JOB_ID].versions is None


def test_open_must_be_a_real_bool(client):
    _done()
    assert _create(client, open="true").status_code == 422


def test_a_song_has_at_most_so_many_versions(client):
    _done()
    for n in range(MAX_VERSIONS_PER_SONG - 1):
        assert _create(client, name=f"V{n}").status_code == 201
    r = _create(client, name="One too many")
    assert r.status_code == 409
    assert r.json()["detail"] == "this song has too many versions"
    assert len(_jobs[JOB_ID].versions) == MAX_VERSIONS_PER_SONG


# ── extract more stems ──


def test_extract_makes_and_opens_the_union(client):
    _done()
    r = _extract(client, stems=["piano", "guitar"], name="+ Guitar, Piano")
    assert r.status_code == 201
    body = r.json()
    assert body["created"] is True
    assert body["version"]["stems"] == ["vocals", "drums", "guitar", "piano"]
    assert body["version"]["name"] == "+ Guitar, Piano"
    assert body["open_version"] == body["version"]["id"]


def test_extracting_the_same_set_again_opens_the_existing_one(client):
    _done()
    first = _extract(client).json()["version"]
    client.post(f"{BASE}/{DEFAULT_VERSION_ID}/open")

    r = _extract(client, name="another name")

    assert r.status_code == 200
    body = r.json()
    assert body["created"] is False
    assert body["version"] == first
    assert body["open_version"] == first["id"]
    assert len(body["versions"]) == 2


def test_extract_refuses_stems_the_version_has(client):
    _done()
    r = _extract(client, stems=["guitar", "drums"])
    assert r.status_code == 422
    assert r.json()["detail"] == "those stems are already in this version"


def test_extract_from_an_unknown_version_is_a_404(client):
    _done()
    r = _extract(client, source="zzzz")
    assert r.status_code == 404
    assert r.json()["detail"] == "version not found"


def test_extract_with_a_stem_file_gone_creates_nothing(client):
    _done()
    (_stems_dir() / "guitar.wav").unlink()
    r = _extract(client)
    assert r.status_code == 409
    assert r.json()["detail"] == "this song is missing stem files; import it again"
    assert _jobs[JOB_ID].versions is None


def test_extract_counts_an_mp3_stem(client):
    _done()
    (_stems_dir() / "guitar.wav").unlink()
    (_stems_dir() / "guitar.mp3").write_bytes(b"ID3")
    (_stems_dir() / ".mp3-stems").write_text("", encoding="utf-8")
    assert _extract(client).status_code == 201


def test_extract_never_separates_or_runs_ffmpeg(client, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("extract must not run anything")

    _done()
    before = _listing()
    monkeypatch.setattr("app.pipeline.separate.separate", forbidden)
    monkeypatch.setattr(subprocess, "run", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)

    assert _extract(client).status_code == 201
    assert _listing() == before


# ── delete ──


def _two_more(client) -> tuple[str, str]:
    a = _create(client, name="A").json()["version"]["id"]
    b = _create(client, name="B").json()["version"]["id"]
    return a, b


def test_deleting_a_version_that_is_not_open_keeps_the_open_one(client):
    _done()
    a, b = _two_more(client)
    client.post(f"{BASE}/{b}/open")
    before = _listing()

    r = client.delete(f"{BASE}/{a}")

    assert r.status_code == 200
    assert [v["id"] for v in r.json()["versions"]] == [DEFAULT_VERSION_ID, b]
    assert r.json()["open_version"] == b
    assert _listing() == before


def test_deleting_the_open_version_opens_the_first_left(client):
    _done()
    a, b = _two_more(client)
    client.post(f"{BASE}/{a}/open")
    client.delete(f"{BASE}/{DEFAULT_VERSION_ID}")

    r = client.delete(f"{BASE}/{a}")

    assert r.json()["open_version"] == b
    assert _meta()["open_version"] == b


def test_the_last_version_is_never_deleted(client):
    _done()
    r = client.delete(f"{BASE}/{DEFAULT_VERSION_ID}")
    assert r.status_code == 409
    assert r.json()["detail"] == ("a song keeps at least one version; move it to the Trash instead")


# ── refusals shared by every route ──


def _writes(vid: str = DEFAULT_VERSION_ID):
    return [
        ("post", f"{BASE}/{vid}/open", None),
        ("patch", f"{BASE}/{vid}", {"name": "N"}),
        ("post", BASE, {"name": "N", "stems": SELECTED}),
        ("post", f"{BASE}/extract", {"from": vid, "stems": ["guitar"], "name": "N"}),
        ("delete", f"{BASE}/{vid}", None),
    ]


def _send(client, method, url, body):
    if body is None:
        return getattr(client, method)(url)
    return client.request(method.upper(), url, json=body)


@pytest.mark.parametrize(("method", "url", "body"), _writes())
def test_every_write_to_a_trashed_song_is_refused(client, method, url, body):
    _done(trashed_at=1.0)
    r = _send(client, method, url, body)
    assert r.status_code == 409
    assert r.json()["detail"] == RESTORE_FROM_TRASH_FIRST


@pytest.mark.parametrize(("method", "url", "body"), _writes())
def test_every_write_to_a_song_not_ready_is_refused(client, method, url, body):
    _done(status="queued")
    r = _send(client, method, url, body)
    assert r.status_code == 409
    assert r.json()["detail"] == "the song is not ready"


@pytest.mark.parametrize("job_id", ["bbbbbbbbbbbb", "abc", "ABCDEF012345"])
def test_an_unknown_or_bad_job_id_is_a_404(client, job_id):
    _done()
    assert client.get(f"/api/jobs/{job_id}/versions").status_code == 404
    r = client.post(f"/api/jobs/{job_id}/versions/{DEFAULT_VERSION_ID}/open")
    assert r.status_code == 404
    assert r.json()["detail"] == "job not found"


@pytest.mark.parametrize("vid", ["nope1234", "BAD", "x" * 17])
def test_an_unknown_version_is_a_404(client, vid):
    _done()
    for method, url, body in _writes(vid):
        if url.endswith("/extract") or url == BASE:
            continue
        r = _send(client, method, url, body)
        assert r.status_code == 404
        assert r.json()["detail"] == "version not found"


# ── records read back from disk ──


def test_junk_versions_in_a_record_keep_the_good_ones():
    good = {"id": "abc12345", "name": "Keep", "stems": ["bass", "drums"], "created_at": 5.0}
    job = Job.from_record(
        {
            "id": JOB_ID,
            "versions": [
                "junk",
                {"id": "BAD!"},
                good,
                dict(good, name="duplicate"),
                {"id": "def67890", "name": 7, "stems": "drums", "created_at": "x"},
            ],
            "open_version": "../../x",
        }
    )
    assert job.versions[0] == {**good, "stems": ["drums", "bass"]}
    assert [v["id"] for v in job.versions] == ["abc12345", "def67890"]
    assert job.open_version is None
    assert job.to_state()["open_version"] == "abc12345"


def test_an_open_version_that_is_gone_resolves_to_the_first():
    job = Job.from_record(
        {
            "id": JOB_ID,
            "versions": [{"id": "abc12345", "name": None, "stems": ["bass"], "created_at": 1}],
            "open_version": "def67890",
        }
    )
    assert job.to_state()["open_version"] == "abc12345"


def test_versions_that_are_not_a_list_read_as_the_original():
    job = Job.from_record({"id": JOB_ID, "versions": {"id": "x"}, "selected_stems": ["bass"]})
    assert job.versions is None
    assert [v["id"] for v in job.to_state()["versions"]] == [DEFAULT_VERSION_ID]
