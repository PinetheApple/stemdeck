# Recorded takes

<sub>[Back to the HTTP API](api.md)</sub>

Record yourself playing or singing over a song. Each recording track is one mixer lane. It owns takes and plays its active one, in step with the song. Takes are kept per song on the server and survive a restart.

The routes are in `app/api/takes.py` and `app/api/takes_tracks.py`. The files they keep are described in `app/core/takes.py`. Takes are not part of the [song bundle](song-bundle.md).

## Storage

```
jobs/<job_id>/takes/
  tracks.json        {"v": 1, "tracks": [track, ...]}
  <take_id>/         t + 8 hex digits
    parts.json       upload state and the start sidecar, while the take is open
    audio.part       float32 little-endian interleaved PCM received so far
    audio.raw.wav    exactly what was captured, made when the take finishes
    audio.wav        the playable lane: 16-bit PCM, 44.1 kHz, stereo, song length
    peaks.json       {"<take_id>": [[min, max], ...]}, the shape of stems/peaks.json
    take.json        the sidecar
```

The files are the record: nothing about takes is stored on the job. A take is finished once it has `take.json` and `audio.wav`. Until then it is open. Every JSON file is written to a temp file, fsynced and renamed into place; `take.json` is written before `parts.json` records the take as finished. An audio part is appended only up to the size `parts.json` records, so a retry after a crash never doubles a part.

Takes stay out of `stems/`. Stem storage as MP3, the bundle and the stem routes never see them. Deleting a song deletes its takes, the Trash keeps them, and a library move carries them. A song that holds a finished take, an open take with audio, or a take cut off mid-finish is never removed by automatic deletion (`app.core.takes.has_takes`).

A track: `{"id": "k…", "name", "order", "created_at", "active_take_id", "input": {"device_id", "device_label", "channels": [0] | [0, 1]} | null}`.

`take.json`, version 1:

```json
{"v": 1, "id": "t1a2b3c4d", "track_id": "k9f8e7d6c", "label": "Take 2", "created_at": 1763221000.4,
 "timeline": {"frame0_song_sec": 12.4031, "tempo": 1.0, "count_in_sec": 2.0, "end_song_sec": 95.2},
 "latency": {"round_trip_ms": 23.4, "source": "calibrated", "output_latency_ms": 10.7,
             "base_latency_ms": 5.3, "user_nudge_ms": 0.0},
 "capture": {"rate": 48000, "channels": 1, "device_label": "USB Audio", "dropped_quanta": 0},
 "placement_sec": 12.3797, "duration_sec": 82.8}
```

## Timing

The recorder captures in the playback AudioContext, so capture and playback share one clock. It sends `frame0_song_sec`, the song position leaving the audio graph when the first captured frame was taken, with no device latency folded in. It also sends the round trip it measured with a loopback test (`source: "calibrated"`) or estimated from the context's reported latencies (`"estimated"`). The server places the take:

```
placement_sec = frame0_song_sec - round_trip_ms / 1000 - user_nudge_ms / 1000
```

A positive latency or nudge means the sound arrived late. The render resamples the capture to 44.1 kHz, then trims it (a placement before song 0) or delays it (after), pads it and cuts it to the song's frame count. The placement is rounded once, at 44.1 kHz. Playback and exports read `audio.wav`, so no engine applies an offset. A new round trip or nudge re-renders the lane from `audio.raw.wav`. Takes are recorded at normal speed only.

## Endpoints

Every route answers 404 unless the song exists, has finished separating, and is not in the Trash. DELETE routes work on a trashed song too. A write during a library move is a 503 with `Retry-After`. Request bodies are JSON and refuse unknown fields.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/jobs/{id}/takes` | `{tracks, takes, open}`. `takes` are finished takes as lane entries, oldest first. `open` are takes still recording or left behind: `{id, track_id, label, created_at, updated_at, bytes, recoverable}`. `recoverable` is true once the take has been idle for 60 s; finish keeps what arrived |
| POST | `/api/jobs/{id}/tracks` | `{name?, input?}` → the track (201); "Track N" by default. 409 past 32 tracks |
| PATCH | `/api/jobs/{id}/tracks/{track_id}` | Any of `name`, `input` (null clears it), `active_take_id` (a finished take of this track, else 422), `order` → the track |
| DELETE | `/api/jobs/{id}/tracks/{track_id}` | The track and every take on it → `{track_id, status: "deleted", takes_deleted}` |
| POST | `/api/jobs/{id}/takes` | `{track_id, label?, timeline, latency, capture}` → `{take_id, label, track_id}` (201). 422 for an unknown track or a tempo other than 1. 409 past 50 takes |
| PUT | `/api/jobs/{id}/takes/{take_id}/parts?seq=n` | One part, `application/octet-stream`, whole sample frames, at most 4 MiB. `seq` starts at 0 and must be the next one (else 409); resending the last one is a no-op (`duplicate: true`). 413 for a part or take that is too large → `{take_id, seq, bytes, duplicate}` |
| GET | `/api/jobs/{id}/takes/{take_id}/parts` | `{audio: {next_seq, bytes}, finished}`, to resume after a 409 or a reload. A take with `take.json` reads finished |
| POST | `/api/jobs/{id}/takes/{take_id}/finish` | `{label?, end_song_sec?, dropped_quanta?}` → the lane entry; the take becomes its track's active take. 409 once finished or when its track was deleted; 422 without audio |
| PATCH | `/api/jobs/{id}/takes/{take_id}` | Any of `label`, `round_trip_ms`, `user_nudge_ms` → the lane entry. A timing change re-renders the lane. 409 for an open take |
| DELETE | `/api/jobs/{id}/takes/{take_id}` | Open or finished → `{take_id, status: "deleted"}`; the track falls back to its newest remaining take |
| GET, HEAD | `/api/jobs/{id}/takes/{take_id}/audio.wav` | The lane, with Range support, downloaded as `<song>_<label>.wav` |
| GET | `/api/jobs/{id}/takes/{take_id}/peaks` | The lane's waveform peaks |

A lane entry: `{id, track_id, label, created_at, duration_sec, placement_sec, round_trip_ms, latency_source, user_nudge_ms, url, peaks_url}`.

## Exports

`app/api/takes_lanes.py` resolves take lanes for the export routes. A take id, or a track id that plays its active take, stands in the lane list beside the stem names and is never transposed. When a take is in the mix, the summed output passes a limiter at -1 dBFS, so the lanes cannot clip. A mix of stems only renders exactly as before.

## Filmed takes

A track of `kind: "video"` films while it records. Tracks gain two fields: `kind` (`"audio"` or `"video"`; absent reads as audio) and `i_play`, the stems the player plays (`[]` by default; `vocals` stands for both its halves). The Film view leaves those stems out of what it plays while the track records, and a take copies the track's `i_play` when it opens, so it keeps what was left out even if the track changes later.

A filmed take sends `camera: {mime, width, height, fps_nominal, device_label?, mirror?, offset_ms?}` when it opens (422 on an audio track). The browser records the picture alone with MediaRecorder (`video/webm;codecs=vp8`, then `vp9`, then `video/mp4`) and sends each chunk to `PUT .../camera/parts?seq=n`, under the same rules as the audio parts. The camera upload may total `(song length + 120 s) × 2.5 MB/s`.

Finish sends `camera: {first_frame_offset_ms, first_frame_clock, parts}`. `first_frame_offset_ms` is the camera's first frame minus the first audio frame, on the playback clock, and may be negative. `first_frame_clock` is `"capture"` (from the frame's capture time) or `"recorder-start"`. The camera is kept when all `parts` arrived, the bytes are a webm or an mp4, and ffprobe finds a video stream. It is renamed to `camera.webm` or `camera.mp4` and never re-encoded. Otherwise the take keeps its sound, the picture is deleted, and the entry says why in `camera_dropped` (`no-timing`, `parts-missing` or `not-video`).

```
<take_id>/
  camera.part     MediaRecorder chunks while the take is open
  camera.webm     or camera.mp4, the camera as recorded
  render.mp4      the last finished export
  render.json     which encoder made it, from what
```

`take.json` gains `i_play`, and for a filmed take `camera: {file, mime, width, height, fps_nominal, device_label, mirror, offset_ms, duration_sec, first_frame_offset_ms, first_frame_clock}` and an optional `trim: {in_sec, out_sec}` in song seconds. A take without these is an audio take, as before.

The picture shares the sound's placement, so a nudge moves both:

```
camera_start_sec = placement_sec + first_frame_offset_ms / 1000 - camera_offset_ms / 1000
```

A positive camera offset (±2000 ms) means the picture ran late, and moves only the picture.

Lane entries gain `has_camera`, `camera_url`, `camera_offset_ms`, `camera_dropped`, `span: {start_sec, end_sec}` (the part of the song the take covers), `trim` and `i_play`.

| Method | Path | Purpose |
|---|---|---|
| PUT | `/api/jobs/{id}/takes/{take_id}/camera/parts?seq=n` | One camera chunk, at most 4 MiB → `{take_id, seq, bytes, duplicate}`. 404 for a take opened without a camera, 409 for a wrong seq or a finished take, 413 past the cap, 422 when empty |
| GET | `/api/jobs/{id}/takes/{take_id}/parts` | Adds `camera: {next_seq, bytes}` on a filmed take |
| PATCH | `/api/jobs/{id}/takes/{take_id}` | Adds `trim` (`null` clears it) and `camera_offset_ms`. Neither re-renders `audio.wav`. 422 for a trim outside the take's span or shorter than 1 s, or an offset on a take without a camera |
| GET, HEAD | `/api/jobs/{id}/takes/{take_id}/camera` | The camera file, with Range support |

## Video export

A filmed take exports as an MP4: its camera over the backing mix, 16:9 with the camera letterboxed, 720p or 1080p (default) at 24, 30 (default) or 60 fps. The range is the trim, or else the take's span, and is at least 1 s.

The sound is the export mix the client sends, without the take's `i_play` stems, plus the take at `take_gain`, through the -1 dBFS export limiter, as AAC 192 kbit/s at the export sample rate. A played stem's lane is dropped; a vocals lane with one half played keeps the other half; an original lane holding a played stem is rebuilt from its parts (422 when a part is missing). The take itself, or its track, may not be in `stems`.

The picture is moved onto the song clock first and cut after, then put on the nearest output frame. The H.264 encoder is chosen as in [the encoder settings](configuration.md): a GPU encoder that fails, stalls or writes a file that fails its check is redone on libx264 and `fallback_reason` says why.

A render waits behind a running separation, and only one runs at a time. It writes a temp file; a finished render replaces `render.mp4` and writes `render.json`, so the result and its encoder survive a restart. A cancel or a failure keeps the previous `render.mp4`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/jobs/{id}/takes/{take_id}/render` | `{stems, gains, pitches?, take_gain?, i_play?, size?, fps?, mirror?}` → the render view (202). 409 while this take renders, 422 for a take without a camera, the take in `stems` or an unknown lane, 503 when ffmpeg lacks libx264 or aac |
| GET | `/api/jobs/{id}/takes/{take_id}/render` | The render view; poll it about twice a second |
| POST | `/api/jobs/{id}/takes/{take_id}/render/cancel` | Stop the render → the view |
| GET, HEAD | `/api/jobs/{id}/takes/{take_id}/render.mp4` | The export, downloaded as `<song>_<label>.mp4` |

The render view: `{status: "none" | "queued" | "running" | "done" | "error" | "cancelled", progress, error, url, encoder, family, fallback_reason, size, fps, span, stale, made_at}`. `stale` is true once the take, its trim or camera offset, or the request changed since `render.mp4` was made.
