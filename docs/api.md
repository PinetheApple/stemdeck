# HTTP API

<sub>[Back to the README](../README.md)</sub>

The endpoints the web app itself uses. They are not a stable public interface and can change between releases.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Server health and version info |
| POST | `/api/jobs` | JSON `{url, stems?, replaces?}` or multipart `file + stems + replaces?` → `{job_id}`; see [Re-imports](#re-imports) |
| GET | `/api/jobs` | List completed (library) jobs |
| GET | `/api/jobs/{id}` | Job state snapshot |
| PATCH | `/api/jobs/{id}` | Rename a song: `{title?, artist?}`, a string sets it, `null` restores the detected value → job state |
| GET | `/api/jobs/{id}/versions` | The song's [versions](#versions) → `{job_id, versions, open_version, missing_files}`, in any status; writes nothing. `missing_files` lists the base stems with no file on disk, which extracting them would separate |
| POST | `/api/jobs/{id}/versions/{vid}/open` | Make `vid` the version the song opens with → `{job_id, versions, open_version}`; opening the open one writes nothing |
| PATCH | `/api/jobs/{id}/versions/{vid}` | Rename a version: `{name}` → `{job_id, versions, open_version}` |
| POST | `/api/jobs/{id}/versions` | Save as new: `{name, stems, open?}` → 201 `{version, job_id, versions, open_version}` |
| POST | `/api/jobs/{id}/versions/extract` | Extract more stems: `{from, stems, name}` → `{version, created, job_id, versions, open_version}`, 201 when made, 200 when a version with those stems is opened instead; 202 `{extracting, job_id, versions, open_version}` when stem files are missing and are extracted first, see [Versions](#versions) |
| GET | `/api/jobs/{id}/versions/extract` | Extraction state `{state, phase, progress, stems, error, version_id}`, or `{state: "idle"}` when there is none |
| POST | `/api/jobs/{id}/versions/extract/cancel` | Stop the song's extraction, nothing else running on it → the extraction state |
| DELETE | `/api/jobs/{id}/versions/{vid}` | Delete a version → `{job_id, versions, open_version}`; 409 for the song's last one |
| GET | `/api/jobs/{id}/events` | SSE stream of job state |
| POST | `/api/jobs/{id}/cancel` | Terminate active subprocess and cancel job |
| PATCH | `/api/jobs/{id}/sections` | Save waveform section markers for a job |
| POST | `/api/jobs/{id}/audio-tags` | Look up what a finished song is missing (tags, band, identity, work, lyrics) → `{audio_tags, artist, has_lyrics, identity, work}`. Stores only what it newly found, so a repeat call that finds nothing new writes nothing; a failed lookup is a 200 with what is stored. The first call that finds no lyrics writes a not-found stamp (`lyrics_candidates.json` with `searched_at`), rewritten by a call after the retry window; a repeat call inside the window writes nothing. 404 for an unknown job, 409 for a job that is not done or while a lookup for it is under way |
| POST | `/api/jobs/{id}/vocal-split` | Split a done song's vocals into `lead_vocals` and `backing_vocals` in the background → 202 with the split state (the existing result once done); 409 without a vocals stem or while a split runs. The job's cancel stops it |
| GET | `/api/jobs/{id}/vocal-split` | Split state `{state, choice, error}`: `state` is `none`, `running`, `done`, `error` or `cancelled`, `error` a failure code; adds `phase` (`queued` or `splitting`) and `progress` (0 to 1) while running |
| PUT | `/api/jobs/{id}/vocal-split/choice` | `{choice: "combined" or "split"}` → job state; stores the song's Combined / Lead + Backing pick without splitting |
| GET | `/api/jobs/{id}/stems/{name}.wav` | Stream a single stem as the song stores it: WAV (`audio/wav`), or for a song stored as MP3 its MP3 (`audio/mpeg`, named `.mp3`). `?start=&end=` trims to a region, always WAV |
| GET | `/api/jobs/{id}/stems/{name}.mp3` | A stem as MP3: a song stored as MP3 serves its own file; a WAV song gets a cached transcode |
| GET | `/api/jobs/{id}/bundle.zip` | Pack a finished song as a [song bundle](song-bundle.md) for another player |
| GET | `/api/jobs/{id}/mixdown.{ext}` | The current mix as one `wav`, `mp3`, `flac` or `ogg` file: `stems` and `gains`, optional `pitches`, `start`/`end`, the click, and the optional `fx` and `master` of [Export EQ and mastering](#export-eq-and-mastering) |
| GET | `/api/jobs/{id}/mixdown/loudness` | The measured master of a mix: `stems`, `gains`, `pitches`, `fx` as for the mixdown, `master` required, `lossy=1` for a lossy export's ceiling; see [Export EQ and mastering](#export-eq-and-mastering) |
| GET | `/api/jobs/{id}/video.mp4` | Mux the current mix with the source video (MP4 upload or YouTube) into an MP4; takes `fx` and `master` like the mixdown |
| DELETE | `/api/jobs/{id}` | Remove job dir from disk (terminal jobs only); also takes the song out of every setlist. A 500 means the job left the library but its files stayed; repeating the DELETE retries removing them (200 or 500 again, not 404) |
| GET | `/api/setlists` | All setlists, oldest first: `[{id, name, song_ids, updated_at}]` |
| POST | `/api/setlists` | `{name, song_ids?}` → the created setlist (201) |
| PATCH | `/api/setlists/{id}` | `{name?, song_ids?}` → the updated setlist |
| DELETE | `/api/setlists/{id}` | Delete a setlist → `{id, status: "deleted"}` |

### Song names

Job state carries `title` (what to show: the user's title, else the detected one), `detected_title`, `user_title`, `user_artist` and `display_artist` (what to show: `user_artist`, else `artist.name`, else `audio_tags.artist`, else `identity.artist` when the identity's `source` is `acoustid`, `musicbrainz` or `lrclib`; null when none is known). A rename is kept apart from the detected values, so re-running detection never undoes it. Exports (file names, the song bundle) use the same names. So do the identity, band, work and lyrics lookups: once a song is renamed it is identified by its names, not by an AcoustID fingerprint. A rename that changes a name clears `identity` and `work` (and `artist`, the band, when the artist changed), forgets LRCLIB's last answer, and drops kept LRCLIB lyrics that are not the renamed song, unless the user timed or moved them; a client wanting them back by the new names calls `POST /api/jobs/{id}/audio-tags`.

### Export EQ and mastering

`fx` and `master` are optional on `mixdown.{ext}` and `video.mp4`. Absent or empty, they change nothing: the render and its cache entry are exactly those of an export without them, and so is an EQ whose bands change nothing. Both are JSON in unpadded base64url.

- `fx`, at most 8192 characters: `{"v": 1, "lanes": {"<lane>": [eq]}, "master": [eq]}`, where `eq` is `{"id": "eq", "out": dB, "b": [[type, f, g, q, slope], ...]}`. `type` is `bell`, `lowshelf`, `highshelf`, `lowcut`, `highcut`, `notch`, `bandpass` or `tilt`; `f` is 10 to 20000 Hz, `g` -30 to 30 dB, `q` 0.025 to 40, `slope` 12, 24, 36 or 48 (cuts only), `out` -24 to 24 dB. At most one EQ per lane and one on the master, 12 bands per EQ, 32 lanes and 160 filter sections per export. Lanes not in `stems` are ignored. A lane's EQ runs before its pitch shift, with the live engine's coefficients; each part of a transposed `original` rebuilt from its stems gets the `original` EQ, and the click gets none. The master EQ runs on the sum.
- `master`, at most 256 characters: `{"v": 1, "target": LUFS or null, "ceiling": dBTP, "comp": 0..1}`. `target` is -24 to -6, or null for the limiter alone; `ceiling` is -3 to -0.1; `comp`, the glue compressor amount, is optional. The whole song is measured without the click, summed as the export sums it (a take's limiter included), so a region export gets the full master's gain. The true peak stays under the ceiling: a peak the limiter lets through lowers its limit by the overshoot, with the gain following the target again, and only when that still overshoots does a level trim after the limiter take the rest. `mp3`, `ogg` and the AAC audio of `video.mp4` use a ceiling of at most -1.5 dBTP, checked on the decoded file, which is rendered again with a lower limit while it is over (a region keeps the song's gain and corrects only its peak); only a file that passes is cached. A mastered export carries `X-StemDeck-Loudness-Pre` and `X-StemDeck-Loudness-Post` (`i=<LUFS>;tp=<dBTP>`, `none` for silence), `X-StemDeck-Master-Gain` (dB) and `X-StemDeck-Target-Reached` (`1` when the loudness is on target and the true peak under the ceiling, else `0`); for a lossy file the values are its decoded measurement, and for a region the song's plan. Single stems, the stems zip and the song bundle never take a master.

`GET /api/jobs/{id}/mixdown/loudness` answers the plan the mastered export renders, measured once per mix and then served from a cache:

```json
{ "target": -14.0, "ceiling": -1.0, "comp": 0.0, "comp_ratio": null,
  "pre":  { "i": -17.2, "tp": -0.4, "lra": 6.1 },
  "comp_threshold_db": null, "comp_i": null, "gain_db": 3.2,
  "post": { "i": -14.03, "tp": -1.02, "lra": 5.8 }, "reached": true,
  "limit_offset_db": 0.0, "trim_db": 0.0 }
```

A bad `fx` or `master` is a 422 whose detail names it: `fx: malformed`, `fx: unsupported version`, `fx: unknown lane`, `fx: <field> out of range`, `fx: too many EQ bands for one export`, `master: malformed`, `master: unsupported version`, `master: <field> out of range`, `master: target and ceiling are required`, and on the loudness route `master: required`. A failed measurement is a 500 `mastering measurement failed`. A loudness request, or a lossy mastered export between its passes, whose client leaves is stopped with a 499.

### Re-imports

`replaces` names the job a new import re-imports. A malformed id is a 422; an id the server does not know is ignored, and the job is created as if none were given. Replacing a job that is still waiting or running, or one another import is already replacing, is a 409 and creates nothing. Job state reports it as `replaces` (null when none) only while the replacement is pending. When the new job finishes `done`, the server settles the old copy: deleted outright when its files are gone (the job state said `unavailable`), otherwise moved to the Trash. A new job that fails, is cancelled or is trashed leaves the old copy as it was, and so does an old copy already trashed or deleted. Once the old copy is settled, whatever the outcome, `replaces` goes back to null, so restoring the old copy from the Trash later keeps it. A replacement left pending when the server stopped, or whose settling failed, is settled on the next start.

### Versions

A version is a named choice of the song's stems: `{id, name, stems, created_at}`. Every version shares the song's one set of stem files, so no route here reads, writes or deletes a stem file, except that extracting more stems adds the files a song is missing. `stems` lists base stems in the order vocals, drums, bass, guitar, piano, other; a version with `vocals` also shows the lead and backing split. `name` is null for the untouched default, which the page shows as "Original"; any other name is the text the user gave, trimmed, 1 to 60 characters (anything else is a 422). A song has 1 to 32 versions. Job state carries the same `versions` and `open_version`.

A song saved before versions existed has one implicit version, `main`, showing its import selection, and nothing is stored for it until a version is created, renamed, deleted or opened as a different one. Every write is refused with a 409 while the song is in the Trash (`restore it from the Trash first`) or not done (`the song is not ready`); an unknown song or version is a 404.

Save as new needs at least one known stem (else a 422) and room for one more version (else a 409). Extract more stems makes the version showing `from`'s stems plus `stems` and opens it. `stems` must all be new to `from` (else a 422). When a version already shows exactly those stems, that one is opened under its own name instead. When every stem it shows has its file, it never separates anything. When some are missing, the song's kept audio is separated again in the background. A song imported from a link keeps no audio: its audio is downloaded again from the link, into a temporary folder that goes when the extraction ends, so nothing new is kept and the answer is a 202 with the extraction state in `extracting`; the versions are unchanged until it ends. Only the missing stem files are added; no file the song has is replaced. When it ends `done`, the version is made or opened as above and `version_id` names it; the song's `stems` carry the new files' URLs. `failed` or `cancelled` leave the song as it was. The state is `running`, `done`, `failed` or `cancelled`; `phase` is `queued` (behind an import or another run), `downloading` (a link song's audio, never for a song with kept audio), `separating` or `finishing`; `progress` is 0 to 1 within the phase; `stems` lists the stems being extracted; `error` is the failure's cause (`out-of-memory`, `disk-full`, `unsupported-device`, `bad-input` when the kept audio cannot be read, `source-unavailable` when the linked video is removed, private or unavailable, `source-blocked` when YouTube's bot check or rate limit refused the download, `no-output` for a model without that stem, `too-many-versions` when the song reached its version limit meanwhile, else `unknown`, which includes a network error or any other failed download). It is kept in memory only: after a restart the state is `idle` and the song is as it was. The song's status stays `done` throughout. A 409 refuses it when the song's original audio is not kept (`this song's original audio is not kept; import it again to get these stems`; uploads from before the audio was kept) or while an extraction runs on the song (`more stems are already being extracted for this song`). The Trash and a delete stop it. Deleting the open version opens the first one left. The last version cannot be deleted: the song goes to the Trash instead. Versions stay with the song through rename, Trash and restore, a library move and a rebuilt registry. A re-import makes a new song with only `main`. A song bundle never carries them.

### Setlists

A setlist's `name` is trimmed, 1 to 100 characters. `song_ids` is an ordered list of job ids, at most 1000, each a job the server knows and each once. Anything else is a 422; an unknown setlist id is a 404. `updated_at` is Unix seconds. Deleting a song takes it out of every setlist, and the retention sweep never removes a song that is in one (nor a favourite); a song gone any other way (its folder removed by hand) is left out of what `GET` returns.
