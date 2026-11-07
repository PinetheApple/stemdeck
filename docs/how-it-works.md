# How it works

<sub>[Back to the README](../README.md)</sub>

The app keeps its screens short. This page has the detail behind them.

## Where your data goes

Separation, analysis and transcription run on the computer running StemDeck, and your audio is
never uploaded. These are the only things it sends, and where:

| Sent to | What | When |
|---|---|---|
| MusicBrainz, Wikidata, Wikipedia, LRCLIB | Names from the track: artist, song, album or show | When a track is imported or opened |
| Wikidata, Wikipedia | A band or artist name you type | When you search in About this song |
| AcoustID | An audio fingerprint, never the audio itself | On import, only with an AcoustID key saved |
| Discogs | The artist, song and album or show names | When About this song opens for a band Wikipedia has no history, members or albums for, only with a Discogs token saved |
| Discogs | A band or artist name you type | When you search for a name Wikipedia does not have, only with a Discogs token saved |
| Wikimedia Commons | A photo's file name and your IP | When About this song shows a band or work photo |
| YouTube, or the site you import from | The link or search text you enter | When you import from a link or a search |
| GitHub | Your IP | When StemDeck checks for updates as it opens |
| Model downloads | Only your IP | Once per model, at desktop setup or on first use |

Nothing else is sent. The page never talks to Discogs itself: your token stays on the server,
which makes the request.

**Licences.** Text from Wikipedia is CC BY-SA. Data from MusicBrainz and Wikidata is CC0.
Lyric transcription uses OpenAI Whisper, which is MIT licensed; see [Model licenses](models.md)
for the other models.

## Song identification

With a free AcoustID key (Settings, Song details), each import is identified by its audio
fingerprint. Only the fingerprint goes to AcoustID. Without a key, tracks are identified by
their tags on MusicBrainz.

## Lyrics

Lyrics come from the file's own tags first. Failing that, they are looked up on LRCLIB by the
song the track was identified as. If neither has any and **Transcribe lyrics** allows it, they
are transcribed from the separated vocals on your computer with Whisper. **Auto** does this only
on an NVIDIA GPU.

## Separation quality

**Best** runs the separator twice with randomized shifts and averages the two results. The
stems come out cleaner, and separation takes twice as long.

## Click track

The note under the click controls changes colour when fewer than 60% of the beats land on a
drum hit. A high score does not prove the tempo is right: a half-time grid can land on a drum hit
nearly every time and still be musically wrong. That is what the ÷2 and ×2 controls in the
Tempo tab are for.

## Files on disk

**Exports folder.** Stems and loops you drag out of StemDeck land here. Nothing in it is
deleted automatically, because a DAW project that references a dragged file needs that file to
stay put.

**Automatically delete finished tracks** is off unless you turn it on, so separated tracks are
kept until you delete them.

**Registry.** The library is one file, `registry.json`: the list of finished jobs on disk.
Settings, Registry shows it read-only. See [Troubleshooting](troubleshooting.md#layout-on-disk)
for the folder layout.

**Logs.** Settings, Logs shows where the log files are and the last hour of each, read-only:

- `stemdeck.log`: separation, API and job activity.
- `backend.log` (desktop app only): the raw output of the bundled Python process, including
  anything that crashed it before `stemdeck.log` could record it.
- `setup.log` (desktop app only): first-run setup and the GPU runtime installation.

**Export logs** puts every log file in one zip, to attach to a bug report.

## Reporting a failure

The details shown in a failure box are what goes in the report. Your track title and source
link are left out, so add them yourself if they help. Pressing a report button also copies the
details to your clipboard.

## Updates

On the Windows desktop app most releases update in place. A release that changes the bundled
runtime is a full download instead: download it, unzip it and run it. Your library stays as it
is.

## Phones and the "not private" warning

Over https, a phone shows a "connection is not private" warning the first time, because the
certificate is made on your own computer rather than by an authority the phone knows. That is
normal on a home network. See [Configuration](configuration.md#serving-other-devices-why-https-is-not-optional)
for why https is needed and how the certificate is made.
