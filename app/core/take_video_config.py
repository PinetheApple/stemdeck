"""Names and tunable numbers of filmed takes (#102): the camera upload, the
"I play" stems, the export range, and the take's MP4 render. Contracts with
the Film view's recorder; the layout is in docs/takes.md."""

from __future__ import annotations

from app.core.config import EXTRA_STEM_NAMES, STEM_NAMES

TRACK_KIND_AUDIO = "audio"
TRACK_KIND_VIDEO = "video"
TRACK_KINDS = (TRACK_KIND_AUDIO, TRACK_KIND_VIDEO)
# What a player can say they play: a stem the backing can leave out.
I_PLAY_STEMS = (*STEM_NAMES, *EXTRA_STEM_NAMES)
VOCALS = "vocals"
VOCAL_HALVES = EXTRA_STEM_NAMES
ORIGINAL = "original"

CAMERA_PART_FILE = "camera.part"
CAMERA_STEM = "camera"
CAMERA_WEBM = "camera.webm"
CAMERA_MP4 = "camera.mp4"
CAMERA_FILES = (CAMERA_WEBM, CAMERA_MP4)
CAMERA_MIMES = ("video/webm", "video/mp4")
CAMERA_MIME_MAX = 100
CAMERA_DIM_MAX = 7680
CAMERA_FPS_MAX = 240
CAMERA_OFFSET_MAX_MS = 2000.0
# The recorder asks for 8 Mbit/s; this allows 2.5 times that.
TAKE_CAMERA_MAX_BYTES_PER_SEC = 2_500_000
FIRST_FRAME_OFFSET_MAX_MS = 10_000.0
FIRST_FRAME_CLOCKS = ("capture", "recorder-start")
EBML_MAGIC = b"\x1a\x45\xdf\xa3"
MP4_FTYP = b"ftyp"
MP4_FTYP_AT = 4
SNIFF_BYTES = 12

# Why a take kept its sound but not its picture.
DROP_NO_TIMING = "no-timing"
DROP_PARTS_MISSING = "parts-missing"
DROP_NOT_VIDEO = "not-video"

TRIM_MIN_SEC = 1.0
# Song seconds are compared at this grain, so a handle dragged to the edge fits.
SPAN_EPSILON_SEC = 1e-3

RENDER_FILE = "render.mp4"
RENDER_SIDECAR = "render.json"
RENDER_SIDECAR_VERSION = 1
RENDER_TMP_TEMPLATE = ".render.mp4.{token}.tmp"
RENDER_SIZES = {"720": (1280, 720), "1080": (1920, 1080)}
RENDER_SIZE_DEFAULT = "1080"
RENDER_FPS = (24, 30, 60)
RENDER_FPS_DEFAULT = 30
TAKE_GAIN_MAX = 4.0
AUDIO_BITRATE = "192k"
# Bounded wait for a cancelled render to let go of its files.
RENDER_STOP_WAIT_SEC = 10.0
RENDER_DOWNLOAD_SUFFIX = ".mp4"
RENDER_MEDIA_TYPE = "video/mp4"

STATUS_NONE = "none"
STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_ERROR = "error"
STATUS_CANCELLED = "cancelled"
