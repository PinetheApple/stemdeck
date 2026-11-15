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
