"""A deleted song must not come back (#521).

restore() adopts any job-shaped directory it finds, which is the right
behaviour for a library whose registry was lost and the wrong behaviour for a
job the user deleted whose files outlived the delete. Reported on macOS via
Settings -> "Reset app data", where the frontend also wipes its own tombstone
on the strength of an unconditional {"ok": true}.
"""

from __future__ import annotations

import json

import pytest

import app.api.jobs as jobs_mod
from app.core import registry as _registry
from app.core.registry import registry_path


@pytest.fixture(autouse=True)
def _clean_registry():
    _registry._jobs.clear()
    _registry._deleted.clear()
    yield
    _registry._jobs.clear()
    _registry._deleted.clear()


def _simulate_restart():
    """Drop in-memory state the way a process restart does; restore() then
    reads everything back from disk."""
    _registry._jobs.clear()
    _registry._deleted.clear()


@pytest.fixture
def jobs_dir(tmp_path):
    """A jobs root of our own. conftest puts _jobs_root next to tmp_path, and
    reset_all iterates whatever it is handed."""
    d = tmp_path / "library"
    d.mkdir()
    return d


def _done_job_dir(jobs_dir, job_id="a1b2c3d4e5f6"):
    """A directory shaped like a finished job, which is what restore() adopts."""
    stems = jobs_dir / job_id / "stems"
    stems.mkdir(parents=True)
    (stems / "vocals.wav").write_bytes(b"RIFF")
    return jobs_dir / job_id


def test_an_orphan_directory_is_adopted_when_it_was_not_deleted(jobs_dir):
    # The behaviour we must not break: a library whose registry was lost is
    # rebuilt from the directories on disk.
    _done_job_dir(jobs_dir)

    _registry.restore(jobs_dir)

    assert "a1b2c3d4e5f6" in _registry.all_jobs()


def test_a_deleted_job_is_not_re_adopted(jobs_dir):
    # The bug: files outlive the delete, and the next start brings the song back.
    _done_job_dir(jobs_dir)
    _registry.mark_deleted("a1b2c3d4e5f6")
    _registry.persist(jobs_dir)

    _simulate_restart()
    _registry.restore(jobs_dir)

    assert _registry.all_jobs() == {}, "a deleted song came back from disk"


def test_the_deletion_record_survives_a_restart(jobs_dir):
    _done_job_dir(jobs_dir)
    _registry.mark_deleted("a1b2c3d4e5f6")
    _registry.persist(jobs_dir)

    assert "a1b2c3d4e5f6" in json.loads(registry_path(jobs_dir).read_text())["deleted"]


def test_the_record_is_forgotten_once_the_directory_is_gone(jobs_dir):
    # Otherwise the set grows for the life of the install. A record only has to
    # outlive the directory it refers to.
    job_dir = _done_job_dir(jobs_dir)
    _registry.mark_deleted("a1b2c3d4e5f6")
    _registry.persist(jobs_dir)

    import shutil

    shutil.rmtree(job_dir)
    _registry.persist(jobs_dir)

    assert json.loads(registry_path(jobs_dir).read_text())["deleted"] == []


def test_reset_reports_what_it_could_not_remove(jobs_dir, monkeypatch):
    _done_job_dir(jobs_dir)

    def _boom(path, *a, **kw):
        raise OSError("Directory not empty")

    monkeypatch.setattr("shutil.rmtree", _boom)

    undeleted = _registry.reset_all(jobs_dir)

    assert undeleted == ["a1b2c3d4e5f6"], "reset must not claim success it did not have"


def test_reset_records_survivors_so_they_cannot_come_back(jobs_dir, monkeypatch):
    # This is the reported path: reset "succeeds", the frontend wipes its
    # tombstone, and the surviving directory is adopted on the next start.
    _done_job_dir(jobs_dir)

    def _boom(path, *a, **kw):
        raise OSError("Directory not empty")

    monkeypatch.setattr("shutil.rmtree", _boom)
    _registry.reset_all(jobs_dir)
    monkeypatch.undo()

    _simulate_restart()
    _registry.restore(jobs_dir)

    assert _registry.all_jobs() == {}, "a reset that half-worked refilled the library"


def test_a_clean_reset_reports_nothing_undeleted(jobs_dir):
    _done_job_dir(jobs_dir)

    assert _registry.reset_all(jobs_dir) == []


# ── a failed DELETE can be retried ──

JOB_ID = "a1b2c3d4e5f6"


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


@pytest.fixture
def library_job():
    import app.core.config as cfg
    from app.core.models import Job

    _registry.register(Job(id=JOB_ID, status="done"))
    return _done_job_dir(cfg.JOBS_DIR, JOB_ID)


@pytest.fixture
def rmtree_fails(monkeypatch):
    """Set to False to let removal work again. monkeypatch.undo() is no way
    back: it would also undo conftest's JOBS_DIR isolation."""
    import shutil

    real_rmtree = shutil.rmtree
    failing = {"on": True}

    def _rmtree(path, *a, **kw):
        if failing["on"]:
            raise OSError("Directory not empty")
        return real_rmtree(path, *a, **kw)

    monkeypatch.setattr("shutil.rmtree", _rmtree)
    return failing


def test_a_failed_delete_succeeds_on_retry(client, library_job, rmtree_fails):
    assert client.delete(f"/api/jobs/{JOB_ID}").status_code == 500
    rmtree_fails["on"] = False

    assert client.delete(f"/api/jobs/{JOB_ID}").status_code == 200
    assert not library_job.exists()


def test_a_retry_that_fails_again_is_500_not_404(client, library_job, rmtree_fails):
    assert client.delete(f"/api/jobs/{JOB_ID}").status_code == 500

    assert client.delete(f"/api/jobs/{JOB_ID}").status_code == 500
    assert library_job.is_dir()


def test_a_retry_releases_the_source_before_removing(
    client, library_job, rmtree_fails, monkeypatch
):
    assert client.delete(f"/api/jobs/{JOB_ID}").status_code == 500
    rmtree_fails["on"] = False
    order = []
    monkeypatch.setattr(jobs_mod, "release_source", lambda job_id: order.append("released"))
    real_rmtree = jobs_mod._rmtree_job

    def _rmtree(job_id):
        order.append("removed")
        return real_rmtree(job_id)

    monkeypatch.setattr(jobs_mod, "_rmtree_job", _rmtree)

    assert client.delete(f"/api/jobs/{JOB_ID}").status_code == 200
    assert order == ["released", "removed"]


def test_an_unknown_job_with_no_directory_is_404(client):
    assert client.delete(f"/api/jobs/{JOB_ID}").status_code == 404


def test_a_directory_nobody_deleted_is_not_removed_by_delete(client):
    import app.core.config as cfg

    orphan = _done_job_dir(cfg.JOBS_DIR, JOB_ID)

    assert client.delete(f"/api/jobs/{JOB_ID}").status_code == 404
    assert orphan.is_dir()
