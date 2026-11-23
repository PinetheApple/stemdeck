# StemDeck functional inventory: app chrome and everything not tied to one song

Everything below was read from source unless marked (inferred). File names appear only where a rule is surprising. "Desktop" means the desktop app; "server mode" means StemDeck opened in a plain browser.

---

## 1. Window-level layout (desktop)

- **Top bar.** From left to right: the brand logo, then the composer. The composer holds the link/search box, Add files, Add a folder, the Extract chips, Detect structure and Extract stems.
- **Body.** From left to right: the left icon rail, the library body (which can collapse), the library resize handle, the main area (song head, error box, empty state or tracks), the inspector, and the footer transport.
- **Overlays sit at body level:**
  - About, About the song, New release and Something failed (these four share one card style).
  - Settings.
  - The shared confirm card.
  - The boot-failure banner.
  - The Guide layers: tooltip, ring, intro rings and pill.
  - The custom select list.
- **Window title:** "StemDeck — split any track into stems".

## 2. Brand (top-left, above the rail)

- **Logo.** Waveform symbol, alt "StemDeck". It is a link to https://stemdeck.app with tooltip and label "Open stemdeck.app".
- On desktop every external link opens in the system browser, not in the app window. In a browser it opens a new tab. Downloads from a stem's download link are saved through a native save on desktop.
- No version number shows in the brand. The code looks for a brand version element, but index.html has none.

## 3. Top-bar composer (chrome-adjacent; the import flow itself is another area)

- **Link icon and text box.**
  - Placeholder: "Search, paste links, or drop files…". While files are dragged over it: "Drop files or a folder".
  - It takes a search query or links. Picking a search result fills the box but does not start an import.
- **Drop-refusal message.** Shown inside the box, which hides the text while it shows. It clears on typing, on the next valid drop, or after 6 s. Wording:
  - "Only MP3, WAV, FLAC, MP4, M4A, OGG, and Opus files are supported."
  - "File is too large ({size}). Maximum is {max}."
  - "Could not read {name}. It may have been moved or deleted."
  - "That folder has no files in it."
  - "That folder couldn't be read."
- **File pill.** Shows the file name and size, with a "Remove file" × button.
- **Track pill.** No clear button. It shows the open upload that the Extract button will act on.
- **Add files.** Upload icon, tooltip "Add files". Accepts .mp3, .wav, .flac, .mp4, .m4a, .ogg and .opus, and several files at once.
- **Add a folder.** Tooltip "Add a folder". It is hidden when the browser cannot pick folders. On Linux desktop it opens the desktop app's own folder chooser instead. If that chooser fails: "Could not open the folder picker."
- **Extract chips.**
  - Label "Extract", then the chips All, Vocals [Combined | Lead + Backing], Drums, Bass, Guitar, Piano and Other.
  - When the chips don't fit, a "…" button ("Choose stems") holds the ones that overflow. The row never wraps, and this re-measures on a language change.
- **Detect structure.**
  - A toggle with the note "Experimental".
  - Tooltip: "Experimental. Labels intro, verse and chorus while a track is imported. Applies to the next import, not to a track that is already open. To hide the sections bar, use Collapse > Sections."
- **Extract stems.** The submit button.

## 4. Left icon rail (top to bottom, in real order)

| # | Control | Tooltip / label | Behaviour and states |
|---|---|---|---|
| 1 | Collapse library | "Toggle library" | Collapses the library to the rail width (`aria-expanded`). The state is saved in localStorage. |
| 2 | Favorites | "Favorites" | Switches the library to the Favorites view. Pressed state shows while active. Re-opens a collapsed library. |
| 3 | Library | "Library" (active by default) | Shows all songs. Never collapses the library. If the library is collapsed, it re-opens it. From Trash or Favorites it goes back to Library. It is also a drop target: a song dragged here from Trash is restored. |
| 4 | Lyrics | "Lyrics" | Replaces the list with the Lyrics panel for the open track (the lyrics module owns the panel). |
| 5 | Queue | "Queue" | **Hidden** unless imports are queued or a batch is in progress. Badge shows the count (99+ above 99). When the queue empties while it is shown, the view falls back to Library. |
| 6 | Trash | Tooltip and label become "Trash ({count})" when it holds songs | Count badge (99+), hidden at 0. Shows the Trash view and an "Empty trash" bar. |
| 7 | Guide | Tooltip "Explain the screen", label "Guide" | Toggles help mode (see section 9). |
| — | spacer | | |
| 8 | Offline indicator | "Can't reach StemDeck"; visible text "Offline" | Not a button; it is a status. Hidden unless the server is unreachable (see section 12). |
| 9 | Alerts | Tooltip "Alerts: failures and new releases", label "Alerts" | Opens the notification panel (section 7). The badge is a 7-px dot, not a count. |
| 10 | Settings | "Settings" | Opens the Settings dialog (section 5). |
| 11 | About | Tooltip "About StemDeck: website, community and credits", label "About" | Opens the About dialog (section 6). |

- Easy to get wrong: Favorites, Trash, Lyrics and Queue each force the library open. The Library button only ever opens it.
- **Library resize handle** (sits between the library and the main area).
  - Tooltip "Drag to resize. Double-click to reset.", label "Resize library".
  - Width runs from 232 to 560 px, and never below what leaves the timeline 360 px plus the track-label column.
  - Arrow Left/Right moves it 16 px. Enter or double-click resets it to the default width.
  - The width is saved. The handle is hidden while the library is collapsed.
- **Automatic collapse.** Once the first song is open, the library collapses itself when the window has no room. It re-opens when room returns, unless the user chose otherwise: a user who re-opens it in a narrow window keeps it open, and a user who shuts it keeps it shut. (libraryResize.js)
- **Ctrl+K / ⌘K** focuses library search (hint "⌘K" in the box).
  - Opens a collapsed library and leaves the Lyrics view first.
  - Does nothing in Stage mode or while a modal is open.
  - Works even while another input has focus.
  - The ⌘K hint hides while the search box has text.

## 5. Settings dialog

**Opened by** the rail Settings button. Also opened directly on the Song details tab by "Open Song details settings" in the artist box, and on the Recording tab from a recording track's menu (the latency test then measures that track's input).

**Shell:**
- Title "Settings", a close ×, and a "Done" button in the footer.
- Closes on Esc (from anywhere), on ×, on Done, or on a mouse press on the backdrop. Focus returns to the button that opened it.
- One fixed size for every tab: at least 600×540, at most 600 tall. Long tabs scroll inside, with a fade at whichever edge has more content. Done stays reachable.
- **Tabs, in order:** General, Song details, Network, Export, Recording, Logs, Library.
  - Left/Right arrows move between tabs and wrap; Home and End jump to the ends. Only the selected tab is a Tab stop. Logs sub-tabs work the same way.
- **Saving rule:** every field saves on change, with no Save button, except the AcoustID and Discogs keys, which have their own Save button.
  - If the server refuses a save, the field returns to the value the server holds.
  - That refusal also posts an alert: kind "Settings not saved", message "The setting could not be saved. Try again."
- Every select in the app uses the custom themed list described in section 16.

### 5.1 General

1. **Language** (select). The flag and native name for each of 11 languages:
   - 🇬🇧 English, 🇵🇱 Polski, 🇯🇵 日本語, 🇰🇷 한국어, 🇨🇳 简体中文, 🇩🇪 Deutsch, 🇫🇷 Français, 🇪🇸 Español, 🇧🇷 Português (Brasil), 🇵🇹 Português (Portugal), 🇮🇩 Bahasa Indonesia.
   - It applies instantly and is stored on this device only (stemdeck.language).
   - The default comes from the browser language, otherwise English.
2. **Max track length** (digits only, 2 characters).
   - Hint: "Longest track accepted for processing, in minutes (max {max})." The maximum (60) comes from the server.
   - Default 20. An empty or invalid entry posts 20. The server limits it to 1–60 and the field shows what was kept.
3. **Playlist import limit** (digits only, 3 characters).
   - Hint: "Most tracks one playlist import will queue (max 200)."
   - Default 50, limited to 1–200.
4. **YouTube cookies** (text input, stacked row).
   - Hint: "Optional. Path to a cookies.txt file, used only when YouTube asks StemDeck to confirm it is not a bot. Leave this empty unless imports are failing."
   - Placeholder "Path to cookies.txt". Saves on change, and an empty value clears it.
   - Errors under the field: "File not found, or not readable." / "This file is inside the StemData folder. Pick a cookies file outside it."
   - The second message also shows on open if a saved file now sits inside StemData.
5. **StemData location** (shown only when the server says it can be edited; hidden in server or Docker setups).
   - Shows the path shortened from the left (home folder shown as "~"; full path on hover), the folder size, and a "Change…" button.
   - Change opens the native folder picker on desktop. In development without the desktop app it opens a plain English browser prompt.
   - While moving: "Moving stems… this can take a while for a large library."
   - Success: "Moved {count} item(s). Restart StemDeck to finish switching over." The restart note shows again when Settings is reopened before the restart.
   - Errors:
     - "Finish or cancel the imports in the queue, then try again."
     - "StemDeck can't use this folder. Pick an empty folder you can write to, outside the current stems folder."
     - "StemDeck is still working on a song or an import. Let it finish or cancel it, then try again."
     - "Could not move the stems folder. Pick another empty folder and try again."
     - "Could not reach the server."
     - "Could not open the folder picker."
     - The moved-but-not-saved warning ("…Restarting now would revert to the old location. Try setting it again.").
6. **Exports folder** (desktop only; the row is removed elsewhere).
   - Hint: "Where stems and loops you drag out of StemDeck go. Nothing here is deleted automatically."
   - Path plus "Change…". Error: "The folder picker could not be opened."
7. **Automatically delete finished tracks** (switch).
   - Hint: "Deletes finished tracks after the days set below. This cannot be undone."
   - Default **off**.
   - **Turning it on takes two clicks.** The first click leaves it off and replaces the hint with "Deletes for good; favorites and setlist songs are kept. Click again to turn it on." for **10 s**. Turning it off needs one click.
8. **Delete after** (digits only, 3 characters).
   - Dimmed and disabled while automatic deletion is off; it still shows the number.
   - Hint: "Days a finished track is kept before it is deleted (max {max})."
   - Default 30. The minimum is 1; the server caps it at 365 and the field shows what was kept.
9. **Compute device** (select): Auto, CUDA (NVIDIA), MPS (Apple Silicon), CPU.
   - The CUDA option is relabelled "ROCm (AMD)" on an AMD (ROCm) build.
   - Devices this machine lacks are greyed and suffixed " — not available". Auto and CPU are always available.
   - Default Auto. It shows the saved choice, not the device Auto resolved to.
   - Hint: "Device used for stem separation. Applies to the next track."
   - If the separation engine cannot load, the hint is replaced by: "The separation engine could not start on this computer, so tracks cannot be separated on any device. Reinstalling StemDeck repairs it. The reason is in the log."
   - **GPU-unused line** under it (hidden when the engine is broken), with {card} = NVIDIA or AMD:
     - "Your {card} graphics card isn't supported, so separation uses the processor."
     - "StemDeck can't reach your {card} graphics card, so separation uses the processor."
     - "Setting up your {card} graphics card didn't finish, so separation uses the processor."
     - "Your {card} graphics card didn't pass StemDeck's check, so separation uses the processor."
   - If the server refuses a device, the error box shows the server's reason (fallback text "Could not change the compute device.") and the select reverts.
10. **Separation quality**: Standard / "Best (2× slower)". Hint: "Cleaner stems, twice as slow." Default Standard.
11. **Stem format**: WAV / MP3. Hint: "MP3 takes less disk space. Applies to the next track." Default WAV.
12. **MP3 bitrate**: 128 / 192 / 256 kbps. Hint: "Higher sounds better and takes more space." Default 128. Dimmed and disabled unless MP3 is chosen.
13. **Free memory when idle** (digits only, 4 characters).
    - Hint: "Minutes with no track being separated or analyzed before StemDeck unloads its separation models to free memory, at most {max}. The next track loads them again and starts a few seconds later. 0 keeps them loaded."
    - Default 10, maximum 1440.
    - Messages under it: "The most is {max} minutes, so {max} was saved." / "Could not save this setting. The field shows the value still in use."
    - This field reports refusals itself, not through an alert.
14. **Danger zone** (subhead) → **Reset app data**.
    - Hint: "Permanently deletes every track, job, and library entry. On a shared server this affects everyone who uses it. Cannot be undone."
    - Button "Reset app data…" opens the typed confirmation (section 11).

### 5.2 Song details

1. **Song identification** (AcoustID).
   - Hint: "Optional. A free key identifies imports by their sound."
   - Masked input, placeholder "AcoustID API key", at most 64 characters. Buttons Save and Clear. Link "Register a free key at acoustid.org".
   - Save is disabled while the field is empty; Clear is disabled when no key is saved. Enter also saves.
   - The field is never filled back in. The line under it reads "No key saved." or "A key ending in {tail} is saved."
   - Errors: "That does not look like an AcoustID key." / "AcoustID does not accept this key. Use the key of an application you register at acoustid.org, not the user key on your profile." / "Could not save the key. Check the connection and try again."
2. **Discogs.**
   - Hint: "Band profiles, members and releases for bands Wikipedia does not cover, from Discogs. Optional."
   - Masked input, placeholder "Discogs personal access token", at most 80 characters. Save and Clear behave as above. Link "Get a free token at discogs.com".
   - Status lines: "No token saved." / "A token ending in {tail} is saved."
   - Errors: "That does not look like a Discogs token." / "Discogs does not accept this token. Create a personal access token in your Discogs account settings, under Developers." / "Could not save the token. Check the connection and try again."
3. **Transcribe lyrics**: "Auto (NVIDIA GPU only)" / On / Off. Default Auto.
   - Hint: "When no lyrics are found, they are transcribed from the vocals on this computer. The first run downloads a speech model (1.6 GB for an NVIDIA GPU, 0.5 GB otherwise). Applies to the next track."
   - On ROCm the wording becomes "NVIDIA/AMD".

### 5.3 Network (the phone link)

1. **Make StemDeck available on your network** (switch).
   - Hint: "Let other devices (like your phone) open StemDeck at the address below."
   - It shows **on** only when the choice is both saved and the server is actually listening on the network.
   - Changing it on desktop opens the restart dialog (section 11). The switch stays disabled while that dialog is open and only moves once the change has been applied.
   - **Server mode:** the switch shows on, is disabled and is styled as not switchable. The Port field is disabled. The tab starts with the note: "These settings come from how StemDeck was set up on this server. To change them, change that setup and restart StemDeck."
2. **Address area** (shown only while the switch is on):
   - **Phone key-change warning**, in its own box, styled as a note rather than an error. Shown only when there are addresses. Exactly one of:
     - Plain http: "Changing the key will not work on your phone at this address. Phones only allow that over a secure connection (https)."
     - All addresses https: "If your phone warns that this connection is not private, tap Advanced, then Continue, once on each device. Changing the key will not work until you do."
   - Hint "Tap to reveal." above the codes.
   - **One QR card per address.** The QR opens <address>/mobile/.
     - Cards start **blurred**. A single click toggles the blur (tooltip "Tap to unblur").
     - Caption is host:port on one line, with the full URL on hover. A VPN address carries a "VPN" tag.
     - QR image alt text: "QR code for {url}".
   - No addresses: "No local network connection detected."
3. **Port** (digits only, 5 characters). Hint: "Port StemDeck runs on. Restart to apply." Limited to 1024–65535; default 8000.

### 5.4 Export

1. **Sample rate**: 22.05 / 32 / 44.1 / 48 kHz. Hint: "44.1 kHz suits most DAWs and samplers." Default 44.1 kHz.
2. **MP4 video quality**: 360p / 480p / 720p / 1080p. Hint: "Max resolution for MP4 export and YouTube video." Default 720p.

### 5.5 Recording (built when Settings opens)

1. **Input device** (select). "Default input", then each device by its label, or "Input {n}" when it has none. Saved as a recorder preference.
2. **Latency.** Hint: "Lines takes up with the song. Test once per input." It shows "{ms} ms" or "Not tested", plus a "Test latency" button.
   - The test runs inline in four steps:
     - **Start:** "Turn the volume up. Hold the microphone near the speaker or a headphone cup, then start. {clicks} clicks play." Buttons [Start] [Cancel].
     - **Listening:** "Listening…", with one dot per click that lights when heard. Button [Cancel].
     - **Saved:** "Saved. Takes on {input} now line up with the song." Button [Test again].
     - **Failed:** "No clicks were heard. Turn the volume up or move the microphone closer, then try again." Button [Try again].
3. **Hear yourself** (switch). Hint: "Use headphones, or the song bleeds into the take."

### 5.6 Logs (sub-tabs: Location, Application log, Backend log, Setup log)

- **Location.**
  - "Log location" with the hint "Open the logs in a file manager, or use Export logs." and a [Refresh] button.
  - The folder path is shown relative to the home folder.
  - A list of the log files that exist: name, size · modified time, and a description. Descriptions are translated; untranslated ones fall back to the server's English text.
  - Empty state: "No log files yet{ (the folder has not been created)}. Logging starts on the first message after launch."
  - Error: the path reads "unavailable" and the list reads "Failed to load log information."
  - **Export logs.** Hint: "Every log in one zip, to attach to a bug report." The button shows "Preparing…" while busy and downloads stemdeck-logs-<timestamp>.zip.
    - On failure: the error box "Could not export the logs." with no Try again, plus an "Export failed" alert.
    - On success: clears earlier export-failure alerts that aren't tied to a track.
- **Application, Backend and Setup log.** Each is a read-only text area showing the last 60 minutes, with [Refresh] and auto-scroll to the end.
  - The loading and error texts here are hard-coded English: "Loading…", "Failed to load the log (status N).", "Failed to load the log — check your connection."

### 5.7 Library

1. **Saved songs**: a count, loaded when the tab opens. Error: "Could not load the library."
2. **Out of sync tracks** (subhead).
   - A table with Name (plus an "unavailable" badge) / Source / Location, listing only songs whose audio is missing. Hidden when there are none.
   - Footer status: "All tracks in sync", or "{count} track(s) is/are out of sync" in red.
   - **Resync out of sync tracks** (hidden when none are out of sync).
     - Shows "Syncing…" while running; on failure "Sync failed — check your connection."
     - It **closes Settings** and re-imports, one at a time, each link-sourced song the server confirms is gone. Uploads stay flagged.
3. **Library file.** Hint: "The list of saved songs, to attach to a bug report." [Download] saves stemdeck-library-<timestamp>.json. Error: "Could not download the library file."

---

## 6. About dialog

**Opened by** the rail About button; Enter on it works. Closes on Esc, on ×, or on a backdrop press. Focus returns to the button.

Contents, in order:
1. Close ×, labelled "Close about dialog".
2. Logo.
3. "StemDeck".
4. Tagline "Open source. No subscriptions."
5. **Version badge** "v…". It shows "…" until the server answers, and its fallback is v0.1.0.
6. Buttons **Website** (stemdeck.app) and **GitHub** (github.com/PinetheApple/stemdeck).
7. Icon links: Discord, Reddit (r/StemDeckApp), Instagram, X.
8. Credits: "Wikipedia (CC BY-SA), MusicBrainz and Wikidata (CC0), Whisper (MIT)."
9. Licence line: "StemDeck is free software under the GNU AGPL-3.0." plus a "Source code" link (same GitHub URL).
10. **"Where your data goes"**: a collapsible section, closed by default, with 9 points, all of which must be kept:
    1. "Separation, analysis and transcription run on the computer running StemDeck, and your audio is never uploaded."
    2. "MusicBrainz, Wikidata, Wikipedia and LRCLIB get the artist, song and album or show names when a track is imported or opened."
    3. "Wikidata and Wikipedia get a band name you search for in About this song."
    4. "AcoustID gets an audio fingerprint on import, only if you saved an AcoustID key."
    5. "Discogs gets the same names, or a name you type, when Wikipedia lacks the band's details, only if you saved a Discogs token."
    6. "Wikimedia Commons gets a photo's file name and your IP when About this song shows a band or work photo."
    7. "YouTube, or the site you import from, gets the link or search text you enter."
    8. "GitHub gets your IP when StemDeck checks for updates as it opens."
    9. "Model files download once, at desktop setup or on first use, sending only your IP."
- The dialog must stay inside a 1024×768 window with the section open.
- There is **no "check for updates" button** in About. The check runs automatically at start-up (section 8).

## 7. Alerts (notification centre)

- **Panel.**
  - Opens beside the rail, level with the bell, 10 px clear of the rail. In a short window it is pulled up so it still fits.
  - The bell toggles it. The × ("Close notifications") or a click outside closes it. **Esc does not close it** (nothing listens for it).
- **Header:** "Notifications", a **Clear all** button (clears failure cards only), and ×.
- **Empty state:** "No new notifications".
- **Badge:** a dot on the bell, shown when there is any failure card or a pending release card.
- **Release card** (always first when present).
  - Star icon, "New release available", and "v{version}".
  - Clicking the card opens the release dialog.
  - Its dismiss × hides it **for that version only**; the choice is stored on this device.
- **Failure cards.**
  - Warning icon. Title is the kind label. Text is "{cause or message} · {just now | N min ago | N h ago | date}".
  - Per-card × labelled "Dismiss notification".
  - Click, Enter or Space opens the Something failed dialog.
  - At most 20 are kept, newest first, and they survive a reload.
  - The same failure is shown once (same job, or same message within 5 s).
  - Cards clear themselves when the thing they were about is resolved: a successful retry, the song deleted, a successful update check, or a successful log export.
- **Kinds and their titles:**
  - Import failed
  - Playback failed
  - Export failed
  - Update check failed
  - Band not saved
  - Settings not saved
  - Favorite not saved
  - Library not saved
  - Trash not emptied
  - Cancel failed
  - Lyrics not saved
  - Sections not saved
  - Beat grid not saved
  - Tempo not saved
  - Vocal split failed
  - Stems not extracted
  - Any other kind: "Something failed"
- Benign validation messages, such as nothing to export, go to the error box and never become alerts.

### 7.1 Something failed dialog

- Opened from a failure card. Closes on Esc, ×, or a backdrop press; focus returns to the card.
- Contents:
  - Title: the kind label.
  - Badge: date and time.
  - Message, plus the detail line.
  - Hint: "Add the track title and source link if they help. Reporting copies these details to your clipboard."
  - Technical block: it reads "Collecting details…" until the job's failure detail and diagnostics arrive.
- **Include recent logs** (opt-in): the button goes "Fetching logs…" → "Logs included", then disables. It adds the application, backend and setup logs from around the time of the failure.
- **Report on GitHub**: opens a pre-filled bug-report issue and copies the full report to the clipboard. The URL is kept short (≤1800 characters); the rest is on the clipboard.
- **Report on Discord**: opens the Discord invite and copies the same report.

### 7.2 New release dialog

- Shows the star, "New release available", the version badge, and release notes from GitHub as limited, safe markdown. With no notes, it shows hard-coded English: "No release notes provided. See the full release on GitHub."
- **Server mode:**
  - "Update your server" / "Pull the new image and restart the container:"
  - A `docker pull ghcr.io/stemdeckapp/stemdeck:<tag>` command.
  - "On Unraid, update via the Community Applications template instead."
  - The Download link is hidden.
- **Desktop:**
  - **Download**: the matching asset for this OS, architecture and GPU. With no match, it reads "View download" and links to the release page.
  - Windows/Linux, when the release can update in place: an added **Update now** button. It shows "Downloading update…" (indeterminate bar), then becomes **Restart to update**, which shows "Applying update…" and restarts the app.
    - Failure: "Update failed: {reason}". Download stays available as a fallback.
  - When the release needs a new runtime: "Press Download, unzip it, and run it. Your library stays as it is."
- **All releases** link.

## 8. Update check (no UI control)

- Runs once at start-up against GitHub's "latest release".
- It never offers an update when:
  - the release is a pre-release or a draft,
  - the release is published as neither latest nor pre-release,
  - it is the version already running (0.7.0-alpha.9 and 0.7.0a9 count as the same),
  - this is a dev build (version containing "dev" or "+"),
  - the user dismissed that version.
- Offline fails silently. Any other failure posts "Update check failed" with the message "Could not check for updates."

## 9. Guide (help mode)

- **On:** the rail Guide button (pressed state). **Off:** Guide again, or Esc.
- **When it turns on:**
  - Every control it can explain glows once and fades over 1.6 s. Large areas (over 4% of the window), partly hidden controls, and controls nested inside an already-ringed control don't glow.
  - A **pill** appears: "Help mode: point at anything to see what it does. Esc to leave." It sits just above the transport, centred over the waveforms (or the window), and never covers a control.
- **While on:**
  - Hovering over, focusing or clicking a listed control draws a ring around it (around the icon itself when that is much smaller than the button) and a tooltip beside it, on whichever side has room.
  - The tooltip title is the control's own label. One- or two-letter labels such as M, S or + use the full label instead.
  - **Every press is swallowed except Guide itself**: click, double-click, pointer, drag and right-click. Exploring never acts. A click is how it works on touch.
  - Scrolling or resizing hides the tooltip.
  - Esc in an open select list closes only the list and Guide stays on.
- **Chrome entries** (the tooltip text):
  - Guide: "Help mode is on. Point at anything, or click it, to see what it does. Press Esc or this button to leave."
  - Brand: "Opens stemdeck.app in your browser."
  - Add files: "Pick an audio file from your computer to split into its instruments."
  - Link/search box: "Type a song name to search for it online, or paste a link. You can also drop an audio file here."
  - Collapse library: "Hides the song list to give the studio more room, or brings it back."
  - Favorites: "Shows only the songs you gave a heart."
  - Library: "Shows all your songs in the list."
  - Lyrics: "Shows the words of the song, lit up line by line as it plays."
  - Trash: "Deleted songs wait here until you empty the Trash. The number shows how many there are."
  - Queue: "The songs waiting to be split, in the order they will be done."
  - Alerts: "Messages from StemDeck, such as a new release or an import that failed."
  - About: "Links to the website, GitHub and Discord, and the credits."
  - Library search: "Type part of a song's name to find it. Start with # to find songs by tag."
  - Many studio controls are listed too; they belong to other areas.
- **Settings entry** is a long tooltip listing each tab with each option and a one-line description:
  - **General:** Language, Max track length, Playlist import limit, YouTube cookies, StemData location, Exports folder, Automatically delete, Compute device, Separation quality, Free memory when idle, Reset app data.
  - **Song details:** Song identification, Discogs, Transcribe lyrics.
  - **Network:** Make available, Port. The Network description says that on desktop turning it on or off restarts StemDeck.
  - **Export:** Sample rate, MP4 video quality.
  - **Logs:** a general line, plus Export logs.
  - **Library:** a general line, plus Out of sync tracks.
  - Gap: Stem format, MP3 bitrate and the whole Recording tab are **not** in this list.

## 10. Error box (main area, top)

- A single box; a new error replaces the old one rather than stacking.
- Contents: warning icon, message, an optional muted detail line, an optional **Try again** button, and a **×** ("Dismiss").
- Try again goes back to the link field by default.
- **Esc closes only this box**, even when a dialog is open underneath. It never covers controls, and leaves Exit and the transport clear in Stage mode.
- Store messages that use it:
  - "StemDeck can't open your library list right now, so nothing was loaded or changed. Wait a moment, then press Try again." Try again reloads the page.
  - "Your saved library list couldn't be recovered, so the library starts empty. The damaged file is kept in the stems folder." No retry.

## 11. Confirmations (every one found, with wording)

| Where | Pattern | Wording |
|---|---|---|
| Settings › Reset app data… | Typed confirmation card | Title "Reset app data?" Body "This permanently deletes every track, job, and library entry. On a shared server this affects everyone who uses it. This cannot be undone." Hint "Type **RESET** to confirm." Buttons [Cancel] [Reset app data]. The confirm button stays disabled until the box holds exactly RESET (spaces trimmed, case-sensitive). While running: "Resetting…". Errors: "Reset failed." / "Reset failed — check your connection." / the job-busy text. Esc closes only this card, not Settings. Success clears this device's data too and reloads the page. |
| Network switch (desktop) | Restart dialog | Title "Restart StemDeck now?" Asked only when a separation is running, or when that can't be checked. Turning on: "A separation is running. Restarting stops it, and the song waits in the queue, paused." Turning off: "Other devices are refused from now on. A separation is running: restarting stops it, and the song waits in the queue, paused. With Not now, this applies at the next start." Buttons [Not now] [Restart now]. Then "Restarting StemDeck…". Failures: "StemDeck could not save this setting: {error}" or "StemDeck could not restart: {error}. The setting is saved and applies at the next start.", each with [Try again]. If the port changed: "The old port was busy, so StemDeck now uses port {port}. What this window saved for the old port is not carried over." with [Continue]. Turning **off** saves first, even before asking. Esc closes only the dialog, and only while Not now is shown. |
| Re-import an unavailable song | Shared confirm card; Cancel is focused | "Import this song again?" / **{song name}** / "Its files are no longer on this computer. Importing downloads it again and stops what's playing." [Cancel] [Import again] |
| Delete a recording track | Shared confirm card; Cancel is focused | "Delete this track?" / **{name}** / "Its takes are deleted too. This cannot be undone." [Cancel] [Delete track] |
| Empty trash | Click twice (armed for 4 s) | The label becomes "Delete permanently?" |
| Delete folder | Click twice | "Delete?" |
| Cancel an upload in the queue (link imports cancel at once) | Click twice | "Delete upload?" |
| Delete version / setlist | Click twice | "Delete?" (setlist: "Click again to delete {name}") |
| Sections clear | Click twice | "Confirm?" |
| Turn on automatic deletion | Click twice (10 s) | Described in Settings. |

- **Shared confirm card rules.** Esc, Cancel or a backdrop press means no. Focus starts on Confirm unless the caller asks for Cancel. Focus returns to whatever opened it.
- **Click-twice rule.** The first click only changes the label (and accessible name) to the warning. A second click within 4 s, or 10 s for automatic deletion, does the action. Otherwise it reverts.

## 12. Connection lost and server restart

- **Detection.**
  - After 3 unanswered app requests in a row, the rail shows **Offline** ("Can't reach StemDeck").
  - While requests are failing, the server is checked every 3 s.
  - An answer from the server, even an error answer, clears the indicator and triggers a "connection restored" event. That retries pending section, beat-grid and tempo saves.
  - An error answer does **not** count as a lost server.
- **Unsaved-edit messages** (as alerts):
  - "Section changes aren't saved yet. They'll save when StemDeck reconnects."
  - "Beat grid changes aren't saved yet. They'll save when StemDeck reconnects."
  - "The tempo change isn't saved yet. It'll save when StemDeck reconnects."
  - Refused versions: "…weren't saved." / "The beat grid wasn't reset. Try again."
- **Page closing.** Edits still waiting to save are sent when the page closes. A save that fails because the page was closing is not reported as a failure.
- **Restart after a network change** is the dialog in section 11. After it, the page reloads at the address the desktop app gives.

## 13. GPU and device notices

- The only places are the Compute device row in Settings (section 5.1) and the ROCm wording in Transcribe lyrics.
- There is no start-up toast or banner about the GPU.
- Failure messages from other areas mention device limits, e.g. "This computer's graphics card can't run the separation."
- A bug report notes when the GPU fell back to CPU ("(fell back to CPU)").

## 14. About the song (artist box)

- **Opened by** the "About this song" button on the now-playing card, by click or keyboard. With no track open it does nothing and looks muted.
- Clicking the heart or the rest of the card does **not** open it.
- Closes on Esc, ×, or a backdrop press; focus returns to the opener.
- **Contents, top to bottom:**
  - Title "About the song".
  - A search row: placeholder "Search for a band or artist" and [Search]. The row is hidden when there is already an answer to show.
  - The song header, when known: title, "From the musical/film/series/show {name}", "Performed by", and "Album" ({album}, {year}).
  - The work section ("From the musical", etc.): photo, name and year, description, official links, synopsis, then "Music", "Lyrics" and "Book" credits, and "Read more about {name} on Wikipedia".
  - The band or performer:
    - Photo, name (plus the name in the artist's own language), description or "Real name: {name}".
    - **Save for this track** / "Saved for this track" (disabled once saved).
    - Official links: Website, Instagram, Spotify, Apple Music, Bandcamp, Facebook, YouTube.
    - "Not this band? Search" / "Not this performer? Search".
    - Sections History, Members, Former members, "Member of", and "Studio albums" ("Albums" or "Releases" in some cases).
    - "From the {language} Wikipedia" when the article comes from another language's Wikipedia.
    - Under a show, the performer is compact, behind "More about {name}".
  - Footer: "From Wikipedia (CC BY-SA) and Wikidata (CC0)", "From Discogs", "Data provided by Discogs".
- **What it opens on:** the band saved on the track; otherwise the artist from the file's tags; otherwise an empty search.
- **States:**
  - Loading: "Looking up "{name}" on Wikipedia…" / "…on Discogs…".
  - Waiting for the track's tags: "Finding this track's artist…" with "Search by name instead".
  - Nothing found: "Nothing on Wikipedia matches "{name}" as a band or artist." / "Nothing on Wikipedia or Discogs matches…".
  - Offline: "Could not reach Wikipedia. Check your connection and try again." / "Could not reach Discogs…".
  - Discogs pick list: "Found on Discogs" / "Pick the one you mean."
- **No Discogs token:** "Add a free Discogs token to search smaller bands too." with [Open Song details settings]. This closes the box and opens Settings › Song details with the token field focused. The note never shows under a band Wikipedia covers in full.
- Changing the language while the box is open repeats the lookup in the new language.
- Lookups time out after 12 s.
- **Background behaviour (no UI):** 800 ms after a tagged track opens, the band is looked up from the tags. It is saved only if the name found matches the tag.

## 15. Empty and placeholder states (chrome-level)

- **"Start with a song"** card: shown in the main area while no song is open, and hidden while an import or a waveform is loading.
  - Text: "Paste links, or drop files or a folder in the bar above."
  - Buttons:
    - **Choose files** opens the Add files picker.
    - **Choose a folder** opens the folder picker; it is hidden when folders can't be picked.
    - **Paste links** focuses the link box. It does not paste.
- **"Ready to import a track"**: the now-playing title while no track is open. The rest of the card shows "— BPM", "— —" and 00:00 / 00:00.
- **Library views** (owned by the library area; listed for completeness):
  - "No favorites yet" / "Click ♥ on a song to keep it here."
  - "Trash is empty" / "Songs you delete wait here, so you can restore them."
  - "No tracks match your search", "No setlists yet.", "Nothing in this folder yet."
- **Alerts panel:** "No new notifications".

## 16. Drag and drop

- A file dropped **anywhere in the window** is treated as a drop on the link box.
  - One file arms the import.
  - Several files, or a folder, open the batch review.
  - The browser never navigates to the dropped file.
- While dragging over the window, the link box highlights and shows "Drop files or a folder". Drags inside the library (songs, folders) are ignored by this.
- Linux desktop: the desktop app receives the drop itself and passes it to the page. Files are checked before they are read.
- Dragging audio out to a DAW or folder works on desktop only (owned by the studio area).

## 17. Global keyboard and focus

- **Global shortcuts.** These work only when no modifier is held and focus is not in a text field, select or editable element:
  - Space: play/pause.
  - [ and ]: seek back or forward.
  - L: loop.
  - K: click track.
  - R: record (ignored if the key is held down).
  - I and O: set loop start or end, only while the loop is on.
  - F: Stage mode (not while a modal is open).
  - Delete or Backspace: moves the focused library row to the Trash (not while a dialog is open).
- **Ctrl+K / ⌘K:** library search (section 4).
- **Space rule:** a button or checkbox reached with Tab takes Space as its own press. After a mouse click on it, Space plays instead.
- **Esc order:** the error box first, then a select list, then a confirm or restart card, then the dialog under it. Each Esc closes only the topmost one.
- **Dialogs** (About, release, failure, artist, Settings, confirm cards) all hand focus back to whatever opened them.
- **Custom select list** (replaces every system select popup):
  - Opens on click, Enter, Space, F4 or Alt+↓.
  - Arrow keys move; PageUp/PageDown move 10; Home/End jump; letters type ahead (ignoring a leading flag); Enter, Space or Tab picks; F4 or Alt+↑ picks and closes; Esc closes.
  - On a closed select, the arrows change the value directly.
  - Disabled options are skipped. The list opens upward near the bottom of the window.
  - It closes when the select is scrolled out of view, removed, or clicked away from.
- **Settings tabs:** keys as in section 5.
- **Library resizer:** keys as in section 4.

## 18. Responsive behaviour (desktop)

- **responsive.css is not loaded by index.html.** Its rules (1100/900/640/480 px, touch targets) target older class names, so they do not apply. Treat it as dead.
- **What actually adapts:**
  - The library collapses automatically when there is no room (section 4).
  - The Extract chips overflow into "…" instead of wrapping.
  - The footer clusters wrap into rows when one row doesn't fit; this re-measures on a language change.
  - The now-playing card gives way in steps as it narrows: first the artwork and meta line, then the title, until only the heart and About this song remain.
  - The notification panel is pulled up in short windows.
  - Settings is a fixed size with scrolling panes.
  - Other narrow rules: at ≤900 px the info row becomes 3 columns; at ≤560 px the artist albums become one column.
- **Smallest supported window:** 1024×720 for Settings and 1024×768 for About.

## 19. Start-up failure banner (boot-diagnostics.js)

- A full-width red banner at the top, in English only (on purpose, since translation may be what failed):
  - "StemDeck did not finish starting up."
  - "Part of the interface never loaded, so buttons and file drop will not respond. Hovering and typing still work because the browser handles those itself. The cause is below. Please include it if you report this."
  - The error text, which can be selected.
  - "The full backend log is at /api/logs.zip, and the raw backend output at /api/logs/backend. Both help identify whether a file failed to load."
  - A [Dismiss] button.
- Only the first failure is shown.

## 20. Other chrome bits

- **Format icon:** an uploaded track with no artwork shows a file icon with a coloured format band (MP3/WAV/FLAC/MP4/M4A/OGG/OPUS), both in library rows and in the now-playing square. Link imports keep the music-note icon.
- **Language detection:** pl, ja, ko, zh (Simplified Chinese), de, fr, es, pt-PT (Portugal only), other pt (Brazilian), id; anything else is English.
- **Toasts:** none exist. Feedback comes through the error box, Alerts, messages under fields, or click-twice labels.
- **Collapse row** in the song head (Collapse › Sections): ui-chrome.js wires it and saves its state per panel. It belongs to the studio area.

---

## Could not determine

- Whether a playlist confirmation still exists. The strings ("Import this playlist?", "Queues **{count}** tracks…") are in the translations, but nothing in static/js uses them. It is either removed or built somewhere not searched (inferred: removed).
- The AcoustID key hint length. The server code keeps the last **2** characters, but one test title says "last four".
- Whether the version badge can briefly show "v0.1.0" before the real version arrives. It depends on start-up order, which I didn't trace.
- Two different GitHub owners are used: About and Source code point to github.com/PinetheApple/stemdeck, while update checks, All releases and bug reports point to github.com/stemdeckapp/stemdeck. I can't tell which is intended.
- Exact visual details of the rail badges, the help ring and the Settings fade beyond the CSS values quoted. I didn't render the app.
- Which "connection restored" consumers exist beyond the section, beat-grid and tempo save retries.
- Mobile (/mobile/) UI behaviour beyond the QR code linking to it: out of scope and not read.
- The whole Lyrics panel, Queue view, Setlists, library rows, batch review and studio panels: other areas, only touched where the chrome opens them.