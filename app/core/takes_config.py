"""Tunable numbers and names for recorded takes (#98, docs/takes.md).

Kept beside app/core/config.py rather than in it until the takes routes are
mounted; every value here is a contract with the recording frontend or a
bound on what one client can make the server store.
"""

from __future__ import annotations

import re

# Ids. Neither pattern can match a stem name, so a take or track id can share
# the export lane list with the stems.
TAKE_ID_RE = re.compile(r"^t[0-9a-f]{8}$")
TRACK_ID_RE = re.compile(r"^k[0-9a-f]{8}$")
TAKE_ID_PREFIX = "t"
TRACK_ID_PREFIX = "k"
ID_HEX_BYTES = 4

# Layout: jobs/<job_id>/takes/{tracks.json, <take_id>/...}.
TAKES_DIRNAME = "takes"
TRACKS_FILE = "tracks.json"
PARTS_FILE = "parts.json"
SIDECAR_FILE = "take.json"
AUDIO_PART_FILE = "audio.part"
RAW_WAV_FILE = "audio.raw.wav"
TAKE_WAV_FILE = "audio.wav"
TAKE_PEAKS_FILE = "peaks.json"
TRACKS_FILE_VERSION = 1
SIDECAR_VERSION = 1

# Bounds on disk use by a client that creates in a loop, not musical limits.
TAKE_MAX_PER_JOB = 50
TRACK_MAX_PER_JOB = 32

# A part is capped at the JSON body middleware's 4 MB (app/main.py), which
# also covers octet-stream bodies; the route re-checks while it streams.
TAKE_PART_MAX_BYTES = 4 * 1024 * 1024
TAKE_MAX_SEQ = 100_000
# Captured audio is float32, interleaved.
TAKE_SAMPLE_BYTES = 4
# A take may run this far past the song: count-in, pickup notes, a late Stop.
TAKE_SLACK_SEC = 120
# Song length assumed for the size cap when the job never recorded one.
TAKE_UNKNOWN_SONG_SEC = 3600.0

# An open take untouched this long is listed as recoverable: its recorder is
# gone (page closed, crash) and the user can keep or delete what arrived.
TAKE_OPEN_STALE_SEC = 60.0

CAPTURE_RATE_MIN = 8000
CAPTURE_RATE_MAX = 192_000
TAKE_LABEL_MAX = 80
TRACK_INPUT_LABEL_MAX = 200
TRACK_INPUT_ID_MAX = 256
TRACK_INPUT_CHANNEL_MAX = 63
TAKE_NUDGE_MAX_MS = 2000.0
TAKE_ROUND_TRIP_MAX_MS = 1000.0
# Where the first captured frame may sit on the song timeline, in seconds.
TAKE_FRAME0_MIN_SEC = -600.0
TAKE_FRAME0_MAX_SEC = 86_400.0
TAKE_COUNT_IN_MAX_SEC = 600.0
# Only takes recorded at normal speed line up without a time map.
TAKE_TEMPO = 1.0

LATENCY_CALIBRATED = "calibrated"
LATENCY_ESTIMATED = "estimated"
LATENCY_SOURCES = (LATENCY_CALIBRATED, LATENCY_ESTIMATED)
TRACK_KIND_AUDIO = "audio"
# Reserved for video takes (#102): accepted and stored, not acted on yet.
TRACK_KIND_VIDEO = "video"
TRACK_KINDS = (TRACK_KIND_AUDIO, TRACK_KIND_VIDEO)

# The playable take is in the stems' own format (pcm_s16le, 44.1 kHz,
# stereo), so every engine, the peaks and the mixdown read it like a stem.
TAKE_RATE = 44100
TAKE_CHANNELS = 2
# Same point count as the stems' peaks.json (_PEAK_POINTS in
# app/pipeline/collect.py), so a take lane draws at the same zoom.
TAKE_PEAK_POINTS = 3000

# Ceiling of the limiter on any export that sums a take with the stems:
# -1 dBFS leaves room for the overshoot a lossy encoder adds on top.
EXPORT_LIMIT_DBFS = -1.0

# A write during a library move is refused with this Retry-After.
TAKE_RELOCATING_RETRY_SEC = 2
