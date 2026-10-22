# Song bundle

<sub>[Back to the README](../README.md)</sub>

A song bundle is one finished song, packed into a single file, so another player can open it without StemDeck running. It carries the stems and everything StemDeck worked out about the song: the beat grid, sections, lyrics, key and tempo, and the mix you had set. It does not carry the source audio or video.

Bundles go one way: StemDeck writes them, a player reads them. Nothing a player changes comes back.

This page is the format's definition. It is versioned; a reader must check `version` before trusting anything else.

## The file

A ZIP archive named `<title-slug>.stemdeck.zip` (`<job-id>.stemdeck.zip` when the song has no usable title). Members are `ZIP_STORED`: FLAC does not compress further, and stored members can be read without inflating.

| Member | Required | What it is |
|---|---|---|
| `manifest.json` | yes | What is in the bundle. Read this first. |
| `stems/<name>.flac` | at least one | One file per stem, lossless. |
| `metadata.json` | yes | Title, key, tempo, loudness, tags, sections. |
| `beats.json` | no | The beat grid, with your grid edits applied. |
| `peaks.json` | no | Waveform overview per stem. |
| `lyrics.json` | no | Lyrics, synced when StemDeck has timings. |
| `vocal_envelope.json` | no | Vocal loudness over time. |
| `mix.json` | no | The mix as you last set it. |

A reader ignores members it does not know. A missing optional member means StemDeck had nothing for it, not that the bundle is broken.

## manifest.json

```json
{
  "format": "stemdeck-song-bundle",
  "version": 1,
  "exported_at": "2026-10-22T21:40:00Z",
  "stemdeck_version": "0.20.0",
  "job_id": "0297074f4836",
  "title": "Song title",
  "duration_sec": 377.4,
  "sample_rate": 44100,
  "channels": 2,
  "stems": [
    { "name": "vocals", "file": "stems/vocals.flac", "frames": 16643340 }
  ],
  "files": ["metadata.json", "beats.json", "peaks.json"]
}
```

- `format` is always `stemdeck-song-bundle`. Anything else is not a bundle.
- `version` is an integer. It goes up only when a version 1 reader would misread the new file; adding an optional member or field does not bump it.
- `stems` is in StemDeck's lane order. `name` is a StemDeck stem name (`vocals`, `drums`, `bass`, `guitar`, `piano`, `other`, `lead_vocals`, `backing_vocals`); a reader should still show an unknown name rather than drop it. `frames` is the stem's length in sample frames at `sample_rate`.
- `mix` is a stem like the others: the full mix as separated, useful as a reference lane. It is included when the job has one.
- `vocals` never appears together with `lead_vocals` or `backing_vocals`; they are the same signal split two ways, and playing both doubles the voice.
- `files` lists the optional JSON members that are present.

## stems/*.flac

FLAC at the song's own sample rate and channel count, as given in the manifest. Every stem starts at time zero and the stems are sample-aligned; play them from the same frame and they stay together.

## metadata.json

StemDeck's `metadata.json` for the job, as written. The fields a player is most likely to want:

| Field | Type | Meaning |
|---|---|---|
| `title` | string | Song title |
| `duration_sec` | number | Length in seconds |
| `bpm` | number | Tempo |
| `key`, `scale` | string | Key, for example `A` and `minor` |
| `key_confidence` | integer | 0 to 100 |
| `lufs`, `peak_db`, `dynamic_range` | number | Loudness figures |
| `tempo_stability` | integer | 0 to 100; low means the tempo drifts |
| `tags` | string[] | Library tags |
| `sections` | object[] | See below |

Each section is `{ "id", "name", "start", "end", "color", "kind" }`. `start` and `end` are seconds. `kind` is one of `intro`, `outro`, `break`, `bridge`, `inst`, `solo`, `verse`, `chorus`, `part`, or absent. `sections_source` says whether they were detected or set by hand.

Fields not listed here may appear and may change between StemDeck releases. Do not depend on them.

## beats.json

The grid an export clicks to: the detected grid, with the beats and bar lines replaced by your edits when you made any.

| Field | Type | Meaning |
|---|---|---|
| `beats` | number[] | Beat times in seconds, strictly increasing |
| `bars` | object[] | Bar lines: `{ "beat": index into beats, "beats_per_bar": n }`. Each bar length runs until the next mark. May be empty. |

The other fields describe how the grid was found and are for diagnostics only.

## peaks.json

`{ "<stem name>": [[min, max], ...] }` per stem: an evenly spaced overview of the waveform across the whole song, for drawing. Values are in -1 to 1.

## lyrics.json

| Field | Type | Meaning |
|---|---|---|
| `synced` | string or null | LRC text, one `[mm:ss.xx]` timestamp per line |
| `plain` | string or null | Lyrics without timings |
| `instrumental` | boolean | The song has no lyrics |
| `offset_sec` | number | Shift to add to every LRC timestamp; may be absent |
| `source` | string | Where they came from |

When `synced` is present, use it, shifted by `offset_sec`. StemDeck's other candidate lyrics (`others`) are left out of the bundle.

## vocal_envelope.json

`{ "hop": seconds, "db": [ ... ] }`: vocal loudness in whole dBFS from -90 to 0, one value every `hop` seconds from time zero.

## mix.json

The mix as you left it in the studio, sent by the app that asked for the export. Absent when the export did not send one.

```json
{
  "stems": {
    "vocals": { "volume": 1, "muted": false, "soloed": false, "pitch": 0 }
  }
}
```

`volume` is linear gain from 0 to 2; 1 is unchanged. `pitch` is semitones from the recording's own key, for that lane alone.

## Making one

**Bundle for another player** in a song's export menu, or `POST /api/jobs/{id}/bundle` with an optional `mix.json` body as above. The song must be finished extracting.
