# HTTP API

<sub>[Back to the README](../README.md)</sub>

The endpoints the web app itself uses. They are not a stable public interface and can change between releases.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Server health and version info |
| POST | `/api/jobs` | JSON `{url, stems?}` or multipart `file + stems` → `{job_id}` |
| GET | `/api/jobs` | List completed (library) jobs |
| GET | `/api/jobs/{id}` | Job state snapshot |
| PATCH | `/api/jobs/{id}` | Rename a song: `{title?, artist?}`, a string sets it, `null` restores the detected value → job state |
| GET | `/api/jobs/{id}/events` | SSE stream of job state |
| POST | `/api/jobs/{id}/cancel` | Terminate active subprocess and cancel job |
| PATCH | `/api/jobs/{id}/sections` | Save waveform section markers for a job |
| GET | `/api/jobs/{id}/stems/{name}.wav` | Stream a single stem WAV file |
| GET | `/api/jobs/{id}/stems/{name}.mp3` | Transcode and stream a stem as MP3 |
| GET | `/api/jobs/{id}/bundle.zip` | Pack a finished song as a [song bundle](song-bundle.md) for another player |
| GET | `/api/jobs/{id}/video.mp4` | Mux the current mix with the source video (MP4 upload or YouTube) into an MP4 |
| DELETE | `/api/jobs/{id}` | Remove job dir from disk (terminal jobs only); also takes the song out of every setlist |
| GET | `/api/setlists` | All setlists, oldest first: `[{id, name, song_ids, updated_at}]` |
| POST | `/api/setlists` | `{name, song_ids?}` → the created setlist (201) |
| PATCH | `/api/setlists/{id}` | `{name?, song_ids?}` → the updated setlist |
| DELETE | `/api/setlists/{id}` | Delete a setlist → `{id, status: "deleted"}` |

### Song names

Job state carries `title` (what to show: the user's title, else the detected one), `detected_title`, `user_title`, `user_artist` and `display_artist` (what to show: `user_artist`, else `artist.name`, else `audio_tags.artist`, else `identity.artist` when the identity's `source` is `acoustid`, `musicbrainz` or `lrclib`; null when none is known). A rename is kept apart from the detected values, so re-running detection never undoes it. Exports (file names, the song bundle) use the same names. So do the identity, band, work and lyrics lookups: once a song is renamed it is identified by its names, not by an AcoustID fingerprint. A rename that changes a name clears `identity` and `work` (and `artist`, the band, when the artist changed), forgets LRCLIB's last answer, and drops kept LRCLIB lyrics that are not the renamed song, unless the user timed or moved them; a client wanting them back by the new names calls `POST /api/jobs/{id}/audio-tags`.

### Setlists

A setlist's `name` is trimmed, 1 to 100 characters. `song_ids` is an ordered list of job ids, at most 1000, each a job the server knows and each once. Anything else is a 422; an unknown setlist id is a 404. `updated_at` is Unix seconds. Deleting a song and the retention sweep both take it out of every setlist; a song gone any other way (its folder removed by hand) is left out of what `GET` returns.
