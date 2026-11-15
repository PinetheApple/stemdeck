"""Tunable numbers and names for recorded takes: contracts with the recording
frontend, and bounds on what one client can make the server store."""

from __future__ import annotations

import re

LOGGER_NAME = "stemdeck.takes"

# Neither pattern can match a stem name, so take and track ids can share the
# export lane list with the stems.
TAKE_ID_PREFIX = "t"
TRACK_ID_PREFIX = "k"
ID_HEX_BYTES = 4
ID_MAX_CHARS = len(TAKE_ID_PREFIX) + 2 * ID_HEX_BYTES
TAKE_ID_RE = re.compile(r"^t[0-9a-f]{8}$")
TRACK_ID_RE = re.compile(r"^k[0-9a-f]{8}$")

STEMS_DIRNAME = "stems"
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

TAKE_LABEL_TEMPLATE = "Take {n}"
TRACK_NAME_TEMPLATE = "Track {n}"
TAKE_DOWNLOAD_FALLBACK = "take"

TAKE_MAX_PER_JOB = 50
TRACK_MAX_PER_JOB = 32

# The same 4 MB as the JSON body middleware in app/main.py, which also sees
# these octet-stream bodies; the route re-checks while the body streams.
TAKE_PART_MAX_BYTES = 4 * 1024 * 1024
# Upload counters of a stream no part of which has arrived; copy before use.
EMPTY_PART_STATE = {"next_seq": 0, "bytes": 0}
TAKE_MAX_SEQ = 100_000
TAKE_SAMPLE_BYTES = 4
# Room past the song's end for a count-in, pickup notes or a late Stop.
TAKE_SLACK_SEC = 120
TAKE_UNKNOWN_SONG_SEC = 3600.0

# An open take idle this long has lost its recorder (page closed, crash).
TAKE_OPEN_STALE_SEC = 60.0

CAPTURE_RATE_MIN = 8000
CAPTURE_RATE_MAX = 192_000
TAKE_LABEL_MAX = 80
TRACK_INPUT_LABEL_MAX = 200
TRACK_INPUT_ID_MAX = 256
TRACK_INPUT_CHANNEL_MAX = 63
TAKE_NUDGE_MAX_MS = 2000.0
TAKE_ROUND_TRIP_MAX_MS = 1000.0
MS_PER_SEC = 1000.0
TAKE_FRAME0_MIN_SEC = -600.0
TAKE_FRAME0_MAX_SEC = 86_400.0
TAKE_COUNT_IN_MAX_SEC = 600.0
# Only a take recorded at normal speed lines up without a time map.
TAKE_TEMPO = 1.0

LATENCY_SOURCES = ("calibrated", "estimated")

# The stems' own format, so every engine, the peaks and the mixdown read a
# take like a stem.
TAKE_RATE = 44100
TAKE_CHANNELS = 2
TAKE_PEAK_POINTS = 3000

TAKE_RELOCATING_RETRY_SEC = 2
FFMPEG_STDERR_TAIL_BYTES = 2000
