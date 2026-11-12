# Troubleshooting

<sub>[Back to the README](../README.md)</sub>

**`ffmpeg: command not found`:** install ffmpeg and restart with `./run.sh restart`.

**`WARNING: [youtube] No supported JavaScript runtime`:** install deno (`brew install deno` on macOS) and restart. Downloads still work without it but may pick suboptimal formats.

**First separation is very slow:** Demucs downloads `htdemucs_6s` weights (~170 MB) on first run; cached afterwards.

**Demucs runs on CPU only:** check the startup log for `device=mps` or `device=cuda`. If you see `cpu`, your torch install may be CPU-only.

**Transpose is greyed out on another machine:** the pitch stage is built on `AudioWorklet`, which browsers only expose on a *secure context*. `https://` and `localhost` count. A plain `http://192.168.x.x` does not, so a client opening StemDeck over the network is never given the API and transpose cannot work there. Changing the speed still works on such a client, but it resamples instead, so the key moves with it.

Three ways to get a secure context, in order of least effort:

- **Tunnel to localhost.** On the client: `ssh -N -L 8000:localhost:8000 user@host`, then open `http://localhost:8000`. The origin is now localhost, so everything works, including transpose.
- **Tailscale Serve.** `tailscale serve 8000` on the host publishes StemDeck on your tailnet over real HTTPS with a genuine certificate, no warnings and nothing to install on the client beyond Tailscale itself. Note the plain Tailscale IP (`100.x.y.z`) is *not* a secure context; it has to go through `serve`.
- **Any HTTPS reverse proxy** in front of StemDeck: Caddy, nginx, or a tunnel like Cloudflare Tunnel.

**Page reloaded mid-job:** the job keeps running server-side. Wait for it to finish, then resubmit.

**`./run.sh: Permission denied`:** run `chmod +x run.sh`.

## Desktop library list

The desktop app keeps the library list, folders, mixes and takes in `user-data.json` inside the jobs folder. Songs and stems are in the song folders beside it, and nothing below touches them.

A save writes `user-data.json.tmp` first, then keeps the file it replaces as `user-data.json.bak`. You may see these next to `user-data.json`:

- `user-data.json.bak`: the library as it was one save earlier.
- `user-data.json.tmp`: a save that was interrupted. It is gone after the next save.
- `user-data.json.corrupt-<number>`: a `user-data.json` that was empty or damaged when the app started, kept so it can be inspected. The two newest are kept.

**The library list came back one change older after a crash:** on start, a `user-data.json` that is missing, empty or not valid JSON is restored from the `.tmp` (when that save was complete) or the `.bak`. `logs/setup.log` in the data directory names the file it restored from. If neither copy can be read, the app starts with an empty library list and `setup.log` says `starting with an empty library list`.

**"StemDeck can't open your library list right now", with Try again:** `user-data.json` is there but could not be read for ten seconds, often because a virus scanner or a sync client (OneDrive, Dropbox) is holding it, or the jobs folder is on a drive that is not connected. Nothing is restored from a copy and nothing is saved over the file. `setup.log` has the reason, after `user-data-unavailable`. Let the sync finish or connect the drive, then press Try again.

**Going back to a build without these copies:** it reads and saves `user-data.json` as before but never updates the copies, so they go stale. Delete `user-data.json.bak`, `user-data.json.tmp` and any `user-data.json.corrupt-*` by hand before returning to a newer build, or a later recovery could restore the older library.

## Layout on disk

```
jobs/<job_id>/
└── stems/
    ├── vocals.wav      # the 6 Demucs stems (always present)
    ├── drums.wav
    ├── bass.wav
    ├── guitar.wav
    ├── piano.wav
    ├── other.wav
    ├── original.wav    # sum of un-selected stems (subset only)
    ├── mix.wav         # ffmpeg amix of selected stems (subset only)
    └── .complete       # written last: the separation finished
```

The library itself is one file, `jobs/registry.json`, so it survives a restart. If that file is lost or damaged, the next start rebuilds each song whose separation finished from its folder (an upload never separated comes back as a stopped song, ready to Extract), and the song's `metadata.json` keeps its favourite, Trash state, stem selection, source and date added for that. A damaged registry record is kept aside as `registry.json.bad-<time>`. A song's folder is only removed when you empty the Trash, or by the opt-in **Automatically delete finished tracks** setting, which is off unless you turn it on.
