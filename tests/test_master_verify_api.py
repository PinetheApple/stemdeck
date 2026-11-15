"""The decode-and-verify loop of mastered lossy exports (app/api/export_fx.py).

- A render reaches the cache only once it is verified, with its decoded
  measurement written beside it first; a cache hit without one is decoded and
  measured again, and an entry over its ceiling is rendered again.
- Every pass's temp file is removed: on success, failure, a client that left
  (499) and a cancelled request. Notes are pruned with their cache entry.
- A region corrects only its ceiling, keeping the whole song's gain, and its
  Target-Reached follows the plan, as a lossless region's does.
"""

from __future__ import annotations

import asyncio
import json
import os

import pytest
from fastapi import HTTPException

from app.api import export_fx
from app.api import stems as stems_mod
from app.pipeline.mastering import Loudness, MasterPlan, MeasureError, plan_chain
from tests import test_master_export_api as base
from tests.test_master_export_api import JOB, LIMIT_RE, SR, STREAMING, Q, _fake_plan, _graph, _job

# The shared fixtures, bound here so pytest finds them in this module.
_isolate, client, jobs_dir, renders = base._isolate, base.client, base.jobs_dir, base.renders

MP3 = f"/api/jobs/{JOB}/mixdown.mp3?{Q}&master={STREAMING}"
UNDER = Loudness(-14.0, -2.0, 5.0)
OVER = Loudness(-14.0, -0.5, 5.0)
REGION = "&start=0.1&end=0.4"
PLAN_POST = "i=-14.00;tp=-2.00"
WORK = "work"


def _decoded_sequence(monkeypatch, results, seen: list | None = None):
    pending = iter(results)

    async def measure(path, rate):
        if seen is not None:
            seen.append(path)
        return next(pending)

    monkeypatch.setattr(export_fx, "measure_file", measure)


def _entries() -> list:
    return sorted(stems_mod._MIXDOWN_CACHE_DIR.glob("*.mp3"))


def _note(entry):
    return entry.with_name(entry.name + export_fx.OUTPUT_NOTE_SUFFIX)


async def test_a_lossy_render_is_published_only_once_verified(
    jobs_dir, client, monkeypatch, renders, tmp_path
):
    _job(jobs_dir, seconds=0.5)
    _fake_plan(monkeypatch, [])
    published: list[list] = []

    async def measure(path, rate):
        published.append(_entries())
        return OVER if len(published) == 1 else UNDER

    monkeypatch.setattr(export_fx, "measure_file", measure)
    async with client as c:
        r = await c.get(MP3)
    assert r.status_code == 200
    assert published == [[], []]
    [entry] = _entries()
    assert json.loads(_note(entry).read_text())["tp"] == UNDER.tp
    leftovers = [p for p in stems_mod._MIXDOWN_CACHE_DIR.iterdir() if p.name.startswith(".")]
    assert leftovers == [] and list(tmp_path.glob("render*")) == []


async def test_a_cache_hit_without_its_note_is_measured_again(
    jobs_dir, client, monkeypatch, renders
):
    _job(jobs_dir, seconds=0.5)
    _fake_plan(monkeypatch, [])
    async with client as c:
        assert (await c.get(MP3)).status_code == 200
        [entry] = _entries()
        _note(entry).unlink()
        seen: list = []
        _decoded_sequence(monkeypatch, [Loudness(-14.2, -1.9, 5.0)], seen)
        r = await c.get(MP3)
    assert len(renders) == 1 and seen == [str(entry)]
    assert r.headers["x-stemdeck-loudness-post"] == "i=-14.20;tp=-1.90"
    assert json.loads(_note(entry).read_text())["i"] == -14.2


async def test_a_cache_hit_over_its_ceiling_is_rendered_again(
    jobs_dir, client, monkeypatch, renders
):
    _job(jobs_dir, seconds=0.5)
    _fake_plan(monkeypatch, [])
    async with client as c:
        assert (await c.get(MP3)).status_code == 200
        _note(_entries()[0]).unlink()
        _decoded_sequence(monkeypatch, [OVER, UNDER])
        r = await c.get(MP3)
    assert r.status_code == 200 and len(renders) == 2
    assert r.headers["x-stemdeck-loudness-post"] == PLAN_POST


async def test_a_failed_measurement_leaves_no_file(
    jobs_dir, client, monkeypatch, renders, tmp_path
):
    _job(jobs_dir, seconds=0.5)
    _fake_plan(monkeypatch, [])

    async def broken(path, rate):
        raise MeasureError("ffmpeg exit 1")

    monkeypatch.setattr(export_fx, "measure_file", broken)
    async with client as c:
        r = await c.get(MP3)
    assert r.status_code == 500
    assert _entries() == [] and list(tmp_path.glob("render*")) == []


def _export() -> export_fx.ExportFx:
    plan = MasterPlan(-14.0, -1.5, 0.0, UNDER, None, None, 0.0, UNDER, True)
    return export_fx.ExportFx(export_fx.RenderFx([""], ""), plan, plan_chain(plan, SR), SR)


def _job_in(work, gone) -> export_fx.VerifyJob:
    work.mkdir()

    async def render(cmd, suffix, context):
        path = work / f".render{len(list(work.iterdir()))}{suffix}"
        path.write_bytes(b"ID3")
        return path

    graph = f"[0:a]volume=1.000000[a0];[a0]{_export().chain}[mix]"
    return export_fx.VerifyJob(["ffmpeg", "-filter_complex", graph], ".mp3", "test", render, gone)


async def test_a_client_that_left_stops_the_passes(tmp_path, monkeypatch):
    _decoded_sequence(monkeypatch, [OVER, OVER])

    async def gone():
        return True

    with pytest.raises(HTTPException) as err:
        await export_fx.render_verified(_export(), _job_in(tmp_path / WORK, gone))
    assert err.value.status_code == 499
    assert os.listdir(tmp_path / WORK) == []


async def test_a_cancelled_request_leaves_no_file(tmp_path, monkeypatch):
    started = asyncio.Event()

    async def slow(path, rate):
        started.set()
        await asyncio.sleep(30)

    async def present():
        return False

    monkeypatch.setattr(export_fx, "measure_file", slow)
    job = _job_in(tmp_path / WORK, present)
    task = asyncio.create_task(export_fx.render_verified(_export(), job))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert os.listdir(tmp_path / WORK) == []


def test_notes_are_pruned_with_their_entry_and_never_counted(tmp_path, monkeypatch):
    monkeypatch.setattr(stems_mod, "_MIXDOWN_CACHE_MAX_FILES", 1)
    tmp_path = tmp_path / WORK
    tmp_path.mkdir()
    for age, name in enumerate(("new", "old")):
        entry = tmp_path / f"{name}.mp3"
        entry.write_bytes(b"ID3")
        _note(entry).write_text("{}")
        for path in (entry, _note(entry)):
            os.utime(path, (1000 - age, 1000 - age))
    stems_mod._prune_mixdown_cache(tmp_path)
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "new.mp3",
        f"new.mp3{export_fx.OUTPUT_NOTE_SUFFIX}",
    ]


async def test_a_lossy_region_corrects_only_its_ceiling(jobs_dir, client, monkeypatch, renders):
    _job(jobs_dir, seconds=0.5)
    _fake_plan(monkeypatch, [])
    _decoded_sequence(monkeypatch, [Loudness(-16.0, -0.5, 5.0), Loudness(-16.2, -2.0, 5.0)])
    async with client as c:
        r = await c.get(f"{MP3}{REGION}")
    assert r.status_code == 200 and len(renders) == 2
    tails = [_graph(cmd).split(";")[-1] for cmd in renders]
    gains = [t.split("volume=")[1].split(",")[0] for t in tails]
    limits = [float(LIMIT_RE.search(t).group(1)) for t in tails]
    assert gains[0] == gains[1] and limits[1] < limits[0]
    assert r.headers["x-stemdeck-target-reached"] == "1"
    assert r.headers["x-stemdeck-loudness-post"] == PLAN_POST
