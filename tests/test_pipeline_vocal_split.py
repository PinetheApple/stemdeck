"""Tests for the on-demand lead/backing vocal split (#275, #43).

Mirrors test_separate_fallback.py's approach: the real subprocess machinery
(Popen, stderr streaming, watchdog, cleanup) runs end-to-end against a stub
worker script swapped in via the _spawn_cmd seam, so no real ML model or
GPU is needed. split_now, which records how a split ended on the job, runs
against a stubbed split_vocals.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

import pytest

from app.core.models import (
    VOCAL_SPLIT_CANCELLED,
    VOCAL_SPLIT_CHOICE_SPLIT,
    VOCAL_SPLIT_DONE,
    VOCAL_SPLIT_ERROR,
    VOCAL_SPLIT_FAILED_MODEL_MISSING,
    VOCAL_SPLIT_FAILED_NO_OUTPUT,
    VOCAL_SPLIT_FAILED_NO_VOCALS,
    VOCAL_SPLIT_FAILED_OUT_OF_MEMORY,
    VOCAL_SPLIT_FAILED_STALLED,
    VOCAL_SPLIT_FAILED_WORKER,
    VOCAL_SPLIT_RUNNING,
    Job,
    JobCancelled,
)
from app.pipeline import vocal_split as vs_mod
from app.pipeline import vocal_split_worker as worker_mod
from app.pipeline.errors import SeparationError

_SUCCESS_WORKER = """
import sys, os
out_dir = sys.argv[3]
open(os.path.join(out_dir, "lead_vocals.wav"), "wb").write(b"RIFF")
open(os.path.join(out_dir, "backing_vocals.wav"), "wb").write(b"RIFF")
sys.stderr.write("@@DONE@@\\n")
sys.stderr.flush()
"""

# audio-separator's tqdm bar: carriage-return separated, one newline at the end.
_PROGRESS_WORKER = """
import sys, os
out_dir = sys.argv[3]
sys.stderr.write("  0%|          | 0/4\\r 50%|#####     | 2/4\\r100%|##########| 4/4\\n")
sys.stderr.flush()
open(os.path.join(out_dir, "lead_vocals.wav"), "wb").write(b"RIFF")
open(os.path.join(out_dir, "backing_vocals.wav"), "wb").write(b"RIFF")
sys.stderr.write("@@DONE@@\\n")
sys.stderr.flush()
"""

_FAILING_WORKER = """
import sys, json
sys.stderr.write("@@ERROR@@" + json.dumps("model download failed: connection reset") + "\\n")
sys.stderr.flush()
sys.exit(1)
"""

_MODEL_MISSING_WORKER = """
import sys, json
msg = {"message": "model download failed", "code": "model_missing"}
sys.stderr.write("@@ERROR@@" + json.dumps(msg) + "\\n")
sys.stderr.flush()
sys.exit(1)
"""

_OOM_WORKER = """
import sys, json
sys.stderr.write("@@ERROR@@" + json.dumps("CUDA out of memory. Tried to allocate 2 GiB") + "\\n")
sys.stderr.flush()
sys.exit(1)
"""

# Exits 0 / prints @@DONE@@ but never actually writes the two output files --
# a worker-side bug this should still catch rather than trust blindly.
_LIAR_WORKER = """
import sys
sys.stderr.write("@@DONE@@\\n")
sys.stderr.flush()
"""

# Says nothing for longer than any test waits: only a cancel ends it.
_SILENT_WORKER = """
import time
time.sleep(60)
"""


def _stub(code: str):
    def fake_spawn(device: str, vocals_path: Path, out_dir: Path) -> list[str]:
        return [sys.executable, "-c", code, device, str(vocals_path), str(out_dir)]

    return fake_spawn


def _never() -> bool:
    return False


def _ignore(pct: int) -> None:
    pass


@pytest.fixture()
def stems_dir(tmp_path: Path) -> Path:
    d = tmp_path / "stems"
    d.mkdir()
    (d / "vocals.wav").write_bytes(b"RIFF")
    return d


@pytest.fixture()
def job() -> Job:
    return Job(id="abcdefabc275", status="done", vocal_split=VOCAL_SPLIT_RUNNING)


@pytest.fixture(autouse=True)
def _cpu(monkeypatch):
    monkeypatch.setattr(vs_mod, "get_demucs_device", lambda: "cpu")


def _split(job: Job, stems_dir: Path, **kwargs) -> list[str]:
    kwargs.setdefault("cancelled", _never)
    kwargs.setdefault("report", _ignore)
    return vs_mod.split_vocals(job, stems_dir, **kwargs)


# --- split_vocals: the worker ------------------------------------------------


def test_split_vocals_success(job, stems_dir, monkeypatch):
    monkeypatch.setattr(vs_mod, "_spawn_cmd", _stub(_SUCCESS_WORKER))

    result = _split(job, stems_dir)

    assert result == ["lead_vocals", "backing_vocals"]
    assert (stems_dir / "lead_vocals.wav").is_file()
    assert (stems_dir / "backing_vocals.wav").is_file()
    # vocals.wav itself must never be touched by the split.
    assert (stems_dir / "vocals.wav").read_bytes() == b"RIFF"


def test_split_vocals_reports_the_workers_progress(job, stems_dir, monkeypatch):
    monkeypatch.setattr(vs_mod, "_spawn_cmd", _stub(_PROGRESS_WORKER))
    heard: list[int] = []

    _split(job, stems_dir, report=heard.append)

    assert heard == [0, 50, 100]


def test_split_vocals_subprocess_failure_raises_with_tail(job, stems_dir, monkeypatch):
    monkeypatch.setattr(vs_mod, "_spawn_cmd", _stub(_FAILING_WORKER))

    with pytest.raises(SeparationError) as exc_info:
        _split(job, stems_dir)

    assert "connection reset" in "\n".join(exc_info.value.tail)
    assert exc_info.value.code == VOCAL_SPLIT_FAILED_WORKER
    assert not (stems_dir / "lead_vocals.wav").exists()


@pytest.mark.parametrize(
    ("worker", "code"),
    [
        (_MODEL_MISSING_WORKER, VOCAL_SPLIT_FAILED_MODEL_MISSING),
        (_OOM_WORKER, VOCAL_SPLIT_FAILED_OUT_OF_MEMORY),
        (_LIAR_WORKER, VOCAL_SPLIT_FAILED_NO_OUTPUT),
    ],
)
def test_split_vocals_names_why_it_failed(job, stems_dir, monkeypatch, worker, code):
    monkeypatch.setattr(vs_mod, "_spawn_cmd", _stub(worker))

    with pytest.raises(vs_mod.VocalSplitFailed) as exc_info:
        _split(job, stems_dir)

    assert exc_info.value.code == code


def test_split_vocals_stopped_for_silence_is_stalled(job, stems_dir, monkeypatch):
    monkeypatch.setattr(vs_mod, "_spawn_cmd", _stub(_SILENT_WORKER))
    monkeypatch.setattr(vs_mod, "TIMEOUT_VOCAL_SPLIT", 0.2)

    with pytest.raises(vs_mod.VocalSplitFailed) as exc_info:
        _split(job, stems_dir)

    assert exc_info.value.code == VOCAL_SPLIT_FAILED_STALLED


def test_split_vocals_missing_output_raises(job, stems_dir, monkeypatch):
    """A worker that reports success but didn't actually write the files is a
    bug we catch rather than silently report a successful split."""
    monkeypatch.setattr(vs_mod, "_spawn_cmd", _stub(_LIAR_WORKER))

    with pytest.raises(SeparationError):
        _split(job, stems_dir)


def test_split_vocals_requires_vocals_stem(job, tmp_path):
    empty_stems_dir = tmp_path / "no-vocals-stems"
    empty_stems_dir.mkdir()

    with pytest.raises(SeparationError, match="vocals.wav") as exc_info:
        _split(job, empty_stems_dir)
    assert exc_info.value.code == VOCAL_SPLIT_FAILED_NO_VOCALS


def test_the_worker_names_a_model_it_cannot_load(monkeypatch, capsys):
    def unavailable(out_dir):
        raise worker_mod._ModelUnavailable("checkpoint download failed")

    monkeypatch.setattr(worker_mod, "_load_separator", unavailable)
    monkeypatch.setattr(sys, "argv", ["vocal_split_worker", "cpu", "in.wav", "out"])

    with pytest.raises(SystemExit):
        worker_mod.main()

    payload = capsys.readouterr().err.strip().removeprefix("@@ERROR@@")
    assert json.loads(payload)["code"] == VOCAL_SPLIT_FAILED_MODEL_MISSING


def test_split_vocals_stops_the_worker_when_cancelled(job, stems_dir, monkeypatch):
    """The worker reads nothing and says nothing mid-inference, so only the
    parent watching the cancel can end it."""
    monkeypatch.setattr(vs_mod, "_spawn_cmd", _stub(_SILENT_WORKER))
    asked = threading.Event()
    threading.Timer(0.3, asked.set).start()
    started = time.monotonic()

    with pytest.raises(JobCancelled):
        _split(job, stems_dir, cancelled=asked.is_set)

    assert time.monotonic() - started < 10, "the cancel waited for the worker to finish"


# --- split_now: how a split ended, on the job ---------------------------------


def _write_partial(stems_dir: Path) -> None:
    (stems_dir / "lead_vocals.wav").write_bytes(b"RIFF-partial")


def _split_now(job: Job, stems_dir: Path) -> None:
    vs_mod.split_now(job, stems_dir, cancelled=_never, report=_ignore)


def test_a_split_that_worked_adds_the_two_stems(job, stems_dir, monkeypatch):
    (stems_dir / vs_mod.VOCAL_SPLIT_ERROR_FILE).write_text("cause: unknown\n", encoding="utf-8")
    job.vocal_split_error = VOCAL_SPLIT_FAILED_WORKER

    def worked(job_arg, stems_dir_arg, **kwargs):
        for name in ("lead_vocals", "backing_vocals"):
            (stems_dir_arg / f"{name}.wav").write_bytes(b"RIFF")
        return ["lead_vocals", "backing_vocals"]

    monkeypatch.setattr(vs_mod, "split_vocals", worked)

    _split_now(job, stems_dir)

    assert job.vocal_split == VOCAL_SPLIT_DONE
    assert {"lead_vocals", "backing_vocals"} <= {s["name"] for s in job.stems}
    assert job.vocal_split_error is None
    assert not (stems_dir / vs_mod.VOCAL_SPLIT_ERROR_FILE).exists()


def test_a_failed_split_says_why_on_the_job_and_on_disk(job, stems_dir, monkeypatch):
    def failed(job_arg, stems_dir_arg, **kwargs):
        _write_partial(stems_dir_arg)
        raise vs_mod.VocalSplitFailed(
            "vocal split failed: CUDA out of memory",
            code=VOCAL_SPLIT_FAILED_OUT_OF_MEMORY,
            tail=["loading model", "CUDA out of memory. Tried to allocate 2 GiB"],
        )

    monkeypatch.setattr(vs_mod, "split_vocals", failed)

    _split_now(job, stems_dir)

    assert job.status == "done"
    assert job.vocal_split == VOCAL_SPLIT_ERROR
    assert job.vocal_split_error == VOCAL_SPLIT_FAILED_OUT_OF_MEMORY
    assert vs_mod.read_error_code(stems_dir) == VOCAL_SPLIT_FAILED_OUT_OF_MEMORY
    # The worker's words are kept on disk, never on the job.
    record = (stems_dir / vs_mod.VOCAL_SPLIT_ERROR_FILE).read_text(encoding="utf-8")
    assert "Tried to allocate 2 GiB" in record
    assert not (stems_dir / "lead_vocals.wav").exists(), "a half-written stem was kept"
    assert (stems_dir / "vocals.wav").read_bytes() == b"RIFF"


def test_an_unexpected_error_is_a_failed_worker(job, stems_dir, monkeypatch):
    def broke(job_arg, stems_dir_arg, **kwargs):
        raise RuntimeError("something nobody planned for")

    monkeypatch.setattr(vs_mod, "split_vocals", broke)

    _split_now(job, stems_dir)

    assert job.vocal_split_error == VOCAL_SPLIT_FAILED_WORKER


def test_a_cancelled_split_keeps_nothing_and_says_so(job, stems_dir, monkeypatch):
    def cancelled(job_arg, stems_dir_arg, **kwargs):
        _write_partial(stems_dir_arg)
        raise JobCancelled()

    monkeypatch.setattr(vs_mod, "split_vocals", cancelled)

    with pytest.raises(JobCancelled):
        _split_now(job, stems_dir)

    assert job.vocal_split == VOCAL_SPLIT_CANCELLED
    assert job.vocal_split_error is None
    assert not (stems_dir / "lead_vocals.wav").exists()
    assert not (stems_dir / vs_mod.VOCAL_SPLIT_ERROR_FILE).exists()


def test_begin_split_records_the_choice_and_forgets_the_last_failure():
    job = Job(id="abcdefabc275", status="done", vocal_split=VOCAL_SPLIT_ERROR)
    job.vocal_split_error = VOCAL_SPLIT_FAILED_WORKER

    vs_mod.begin_split(job)

    assert job.vocal_split == VOCAL_SPLIT_RUNNING
    assert job.vocal_split_choice == VOCAL_SPLIT_CHOICE_SPLIT
    assert job.vocal_split_error is None


# --- the error file -----------------------------------------------------------


def test_an_older_error_file_without_a_code_is_a_failed_worker(stems_dir):
    """Files written before codes carried only the cause."""
    (stems_dir / vs_mod.VOCAL_SPLIT_ERROR_FILE).write_text(
        "cause: disk-full\n\n--- stderr tail ---\nno space left on device\n",
        encoding="utf-8",
    )

    assert vs_mod.read_error_code(stems_dir) == VOCAL_SPLIT_FAILED_WORKER


def test_an_unknown_code_in_the_error_file_is_not_passed_on(stems_dir):
    (stems_dir / vs_mod.VOCAL_SPLIT_ERROR_FILE).write_text(
        "cause: unknown\ncode: /home/someone/secret\n",
        encoding="utf-8",
    )

    assert vs_mod.read_error_code(stems_dir) == VOCAL_SPLIT_FAILED_WORKER


def test_read_error_code_without_a_file_is_none(stems_dir):
    assert vs_mod.read_error_code(stems_dir) is None
