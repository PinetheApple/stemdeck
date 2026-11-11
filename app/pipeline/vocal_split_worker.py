"""On-demand lead/backing vocal split worker (#275).

Run as its own process: `python -m app.pipeline.vocal_split_worker <device>
<vocals_wav> <out_dir>`. Unlike demucs_worker.py, this is **not** persistent --
the split is an occasional, user-triggered action on an already-done job, not
the hot path every job takes, so there is no repeat-model-load cost worth
amortizing (see ml-pipeline.md / #309 for why that reasoning does not apply
here the way it does to Demucs).

Runs UVR-MDX-NET Karaoke 2 (or STEMDECK_KARAOKE_MODEL's override) via the
`audio-separator` package on an already-isolated vocals stem, producing
lead_vocals.wav + backing_vocals.wav in out_dir.

Protocol, matching demucs_worker.py's contract so the parent's stderr reader
can be reused: writes progress/log lines to stderr, then exactly one of:
  "@@DONE@@"                        -- success, both files written
  "@@ERROR@@<json-encoded message>" -- failure; process exits(1)
  "@@ERROR@@<json {"message", "code"}>" -- a failure with a VOCAL_SPLIT_FAILED_*
                                    code, when the worker knows which it is
"""

from __future__ import annotations

import json
import os
import sys

from app.core.config import VOCAL_SPLIT_MODEL
from app.core.models import VOCAL_SPLIT_FAILED_MODEL_MISSING
from app.core.process import arm_parent_watchdog


class _ModelUnavailable(Exception):
    """The karaoke model could not be loaded: not installed, not downloaded,
    or broken on disk past what load_or_heal can repair."""


def _load_separator(out_dir: str):
    try:
        from audio_separator.separator import Separator

        from app.core.config import MODELS_DIR
        from app.core.model_cache import load_or_heal, vocal_split_artifacts

        separator = Separator(
            log_level=40,  # logging.ERROR -- only the lines we emit ourselves matter
            model_file_dir=str(MODELS_DIR / "audio-separator"),
            output_dir=out_dir,
            output_format="WAV",
        )
        # This is the only path Docker ever takes: there is no warmup step there, so
        # the model is fetched here on first use. A download cut short leaves a file
        # that audio-separator will keep accepting as present and keep failing to
        # load, which is #502 with no setup step to have caught it earlier.
        load_or_heal(
            lambda: separator.load_model(model_filename=VOCAL_SPLIT_MODEL),
            lambda: vocal_split_artifacts(MODELS_DIR, VOCAL_SPLIT_MODEL),
        )
    except Exception as e:
        raise _ModelUnavailable(str(e)) from e
    return separator


def _run(device: str, vocals_path: str, out_dir: str) -> None:
    if device == "cpu":
        # audio-separator/onnxruntime pick their execution provider mostly on
        # their own; hiding CUDA devices is the reliable way to force the CPU
        # provider when the caller explicitly resolved to "cpu" (matches the
        # separation stage's own device policy in app.core.settings).
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

    separator = _load_separator(out_dir)
    # Karaoke-family models label their two outputs "Vocals" (the lead vocal
    # that survived a second isolation pass) and "Instrumental" (everything in
    # the input that wasn't lead vocal -- since the input here is already an
    # isolated vocals stem, that's the backing vocals/harmonies). Renaming at
    # the library boundary avoids depending on its default filename format.
    separator.separate(
        vocals_path,
        {"Vocals": "lead_vocals", "Instrumental": "backing_vocals"},
    )


def _fail(payload: str) -> None:
    sys.stderr.write(f"@@ERROR@@{payload}\n")
    sys.stderr.flush()
    sys.exit(1)


def main() -> None:
    # A Force-Quit of the app otherwise orphans this process holding the GPU:
    # onnxruntime reads nothing from stdin mid-inference, so EOF never arrives
    # and nothing else bounds it (#519).
    arm_parent_watchdog()
    if len(sys.argv) < 4:
        sys.stderr.write("@@ERROR@@usage: vocal_split_worker <device> <vocals_wav> <out_dir>\n")
        sys.stderr.flush()
        sys.exit(1)
    device, vocals_path, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        _run(device, vocals_path, out_dir)
    except _ModelUnavailable as e:
        _fail(json.dumps({"message": str(e), "code": VOCAL_SPLIT_FAILED_MODEL_MISSING}))
    except Exception as e:
        _fail(json.dumps(str(e)))
    sys.stderr.write("@@DONE@@\n")
    sys.stderr.flush()


if __name__ == "__main__":
    main()
