# StemDeck functional inventory: Library and getting songs in

Scope: the library sidebar, the composer bar, Up Next, setlists, versions, rename and every import flow. All labels are the English strings from `i18n.js` (they replace any fallback text in the markup). Anything marked (inferred) I did not confirm in code or tests.

---

## 1. Composer bar (top bar)

### 1.1 Brand
- **StemDeck logo**, tooltip "Open stemdeck.app". Opens the website in the system browser.

### 1.2 Import box
- **Placeholder:** "Search, paste links, or drop files…". While files are dragged over the window it changes to "Drop files or a folder" and the box lights up.
- **What you can type:**
  - Text of 2 or more characters that is not a link opens the online search dropdown (§1.3).
  - A single link plus **Extract stems** imports it straight away, with no review.
  - A playlist link (a YouTube `list=` link or a SoundCloud `/sets/` link) plus Extract stems opens the batch review (§1.6) and does not import yet.
  - A YouTube link with both `v=` and `list=` imports that one song only, with no folder.
  - YouTube "RD…" radio mixes are treated as a single song.
- **Paste rule (easy to get wrong):** pasting text with more than one non-blank line, at least one of them a link, opens the batch review immediately, before any submit. Plain multi-line text stays a search.
- **Inline drop error** (inside the box). It clears on typing, on the next valid drop, or after 6 s. Messages:
  - "Only MP3, WAV, FLAC, MP4, M4A, OGG, and Opus files are supported."
  - "File is too large ({size}). Maximum is {max}." The limit is 400 MB.
  - "That folder has no files in it."
  - "That folder couldn't be read."
- **Import chip** (replaces the box text once something is staged). It shows one of:
  - one file: its name and size
  - several files: "N files" and the total size
  - pasted links: "N links" and "N songs"
  - a folder: the folder's name and "N files"

  The **×** button ("Remove file") clears the chip and forgets the batch.
- **Track chip** (no clear button). Shown when the open song is a finished upload. It names the song that Extract stems will re-split.
  - Rule: with an empty box and no chip, Extract stems re-splits that upload with the current stem chips.
  - A typed link or a staged file always wins over it.
  - For a song imported from a link the box stays empty, and anything you had typed is kept when you open a song.
- **Add files** button (upload icon, tooltip "Add files"). Opens a multi-file picker.
  - One file goes into the chip.
  - Two or more open the batch review.
- **Add a folder** button (tooltip "Add a folder"). Hidden where the browser cannot pick folders. On Linux desktop it opens the shell's own folder chooser. If that chooser fails, the box shows a "picker failed" message.
- **Drop anywhere in the window** (not only on the box): files or a folder are treated as a drop on the box.
  - Dragging library rows never triggers this.
  - Subfolders are included.
  - On the Linux desktop app the drop arrives through the shell, and files are not read until they are sent.

### 1.3 Online search dropdown (the "global" search)
- **When it fires:** after a word boundary or a pause, never on every keystroke.
  - At least 2 characters.
  - Anything that looks like a link is ignored.
  - Up to 8 results.
- **Tabs:** "YouTube songs" (default), "YouTube playlists", "SoundCloud songs". Switching tab asks the same question again.
- **States:**
  - "Searching…"
  - "No results"
  - "Search failed. Check your connection." Retyping retries.
- **Each result row:** thumbnail, title, uploader · duration.
  - Optional warning chip "Over {mins} min", tooltip "Longer than your {mins} minute limit. Change it in Settings." Such rows cannot be picked.
  - A **Preview** pill on every row except on the Playlists tab.
- **Preview:** opens an inline player inside the row with Play/Pause, a Seek bar and a clock. If loading fails it shows "Preview unavailable".
  - Only one preview plays at a time.
  - Closing the dropdown stops it.
  - Previewing does not pick the result.
- **Picking a result** (click, or Enter on the highlighted row): fills the box with the link and **starts nothing**. You still press Extract stems.
- **Keyboard:** Up/Down highlight, Enter picks, Escape closes. Clicking outside closes.

### 1.4 Extract row ("Extract" label)
- **Chips:**
  - **All**
  - **Vocals** group: the Vocals chip plus a mode toggle **Combined** | **Lead + Backing**
  - **Drums**, **Bass**, **Guitar**, **Piano**, **Other**
- **Chip rules (easy to get wrong):**
  - When all six stems are selected, clicking one chip selects **only that stem**. It does not deselect that one stem.
  - Otherwise a chip toggles its own stem. The last lit chip can still be turned off.
  - **All** is lit only when all six are selected. Clicking it when all are lit empties the row; otherwise it fills it.
  - An empty row disables Extract stems.
- **Vocals mode rules:**
  - Turning Vocals on from its own chip always sets Combined.
  - Pressing a mode button turns Vocals on in that mode.
  - Pressing the mode that is already lit turns Vocals **off**.
  - With Vocals off, neither mode is lit, but the last mode is remembered.
  - Lead + Backing runs the lead/backing split automatically after the import finishes. The choice survives a reload and a re-import.
- **Overflow:** chips that don't fit fold, from the end, into a **⋯** button (tooltip "Choose stems"). Its popover works like the row and closes on Escape or a click outside. The row never wraps.
- The selection is remembered between sessions.

### 1.5 Detect structure and Extract stems
- **Detect structure** toggle, with a small "Experimental" note.
  - Tooltip: "Experimental. Labels intro, verse and chorus while a track is imported. Applies to the next import, not to a track that is already open. To hide the sections bar, use Collapse > Sections."
  - It is saved on the server and **forced off at every app start**.
  - Disabled while saving. Reverts if the save fails.
- **Extract stems** (lightning icon, the form's only submit button). Its label changes:
  - "Processing" while a submit is in flight (disabled).
  - "Review N" while a batch is held. Pressing it reopens the review.
- **Disabled** when no stems are chosen or a submit is running.
- **Queueing:** imports join a server queue in the background and never take over the studio. If the studio is empty, and nothing has been opened since the submit, the first finished import opens itself, paused.
- **Re-importing a link already in the library** replaces that song's row in place, in the same folder. If the old copy is still importing you get "This song is still importing. Try again when it finishes."
- **Errors** appear in an error box with the message, **Try again** and **×** ("Dismiss"). Escape closes it. Examples: "Failed to start job: {message}", "Could not reach StemDeck. Check the connection and try again."

### 1.6 Batch review panel
A modal panel under the bar, over a dimmed backdrop.
- **Header:**
  - Title: "N links" while looking up, then "{N songs} from {N links}". For files, "N files" or "{N files} in {folder}".
  - Subtitle: "Pasted list" or "Includes subfolders".
  - **×** "Close".
- **Notes:**
  - "Only 100 links at a time. N more lines were left out."
  - "Only 500 files at a time. N more files were left out."
  - "Couldn't look these up: {message}" with a **Try again** button.
- **Item row:**
  - A tick box (accessible name "Import {title}").
  - An icon: file, link, music, alert, or a spinner while looking up.
  - Title.
  - Sub-line: artist · length, or "Looking up…", "Not checked", "Line N", or the reason it was not queued.
  - A flag chip:

    | Flag | Tick box | Tooltip |
    |---|---|---|
    | "In library" | starts unticked, can be ticked to re-import (replaces the old copy) | "Already in your library. Tick to import it again." |
    | "Over N min" | cannot be ticked | "Longer than your N minute limit. Change it in Settings." |
    | "Not audio" | cannot be ticked | |
    | "Not a link" | cannot be ticked | |
    | "Unavailable" | cannot be ticked | |
    | "Too large" | cannot be ticked | |
    | "Not queued" | ticked | |

  - **Retry** (only on "Not queued" rows).
  - **×** "Remove".
- **Folder separator rows** show the path joined with " / ".
- **Playlist group row:**
  - A tick-all box, indeterminate when partly ticked.
  - The playlist name.
  - "Playlist · N songs", plus "· N unavailable" and "· rest of the list left out" when they apply.
  - **Show songs / Hide songs**, and **×**.
  - The first 3 songs show, then a "Show N more" button.
- **Footer:**
  - "For all: N stems · Detect structure on/off". This follows the bar live until the batch is first queued.
  - "Only N fit in the queue now" when the queue is short of room.
  - **Cancel**, and **Queue N**. Queue N is disabled while looking up, while sending, or when nothing is ticked.
- **Closing:** Escape, a backdrop click, Close or Cancel close the panel but **keep the batch**. The chip stays and the button reads "Review N".
- **Focus:** Tab is trapped inside the panel. Focus returns to whatever opened it.
- **After Queue N:**
  - Rows that were not queued stay with a reason and Retry.
  - The panel closes when nothing is left.
  - A playlist's songs are filed in a new folder named after the playlist.

### 1.7 Empty main area (no song open)
- Heading "Start with a song".
- Text "Paste links, or drop files or a folder in the bar above."
- Buttons:
  - **Choose files**: same as Add files.
  - **Choose a folder**: same as Add a folder; hidden where unsupported.
  - **Paste links**: focuses the import box.

### 1.8 Foreground import box (in the waveform area)
- Used only when "Sync again" or the re-import of an unavailable song holds the studio.
- Shows the title, rotating stage phrases, a progress bar and a detail line.
- **Cancel** (shows "Cancelling…" while the request runs).

---

## 2. Library sidebar: rail buttons in this area

- **Toggle library**: collapses or expands the library panel; only the rail remains when collapsed.
- **Favorites**: switches to the Favorites view. It opens a collapsed library.
- **Library**:
  - Switches back from Trash or Favorites.
  - Opens a collapsed library.
  - **Never collapses it.**
  - Drop target for restoring songs, in the Trash view only.
- **Queue** ("Queue"):
  - **Hidden unless** imports are queued or running, or a batch is still being tracked.
  - Its badge shows the count, capped at "99+".
- **Trash**:
  - Badge shows the count ("99+" cap), hidden at 0.
  - Name and tooltip read "Trash ({count})" when there are songs in it, otherwise "Trash".
  - Drop target: dropping a song row on it moves the song to the Trash.
- Switching to any view other than Library opens a collapsed library. Lyrics, Guide, Alerts, Settings and About are outside this area.

---

## 3. Library sidebar: header

### 3.1 Library search (local)
- Accessible name "Search library". Placeholder by view: "Search library…", "Search favorites…", "Search trash…". The markup's "Search or #tag…" is replaced.
- **Matches** the title, source link, stem names and tags, case-insensitive substring.
- **"#tag"** matches tags only. Typing "#" opens tag suggestions (up to 8, as "#tag"):
  - Up/Down move, Enter picks, Escape closes.
  - A mouse press picks.
- **Ctrl+K / ⌘K** focuses this box and selects its text.
  - Works from anywhere, even while another input has focus.
  - Opens a collapsed library and leaves the Lyrics view.
  - Does nothing in Stage mode or behind a modal.
  - Plain K is still the click-track toggle.
- A "⌘K" hint shows inside the box and hides while it has text.
- Typing in it switches the Setlists tab back to Songs.
- Clicking the search area while the library is collapsed expands it and focuses the input.
- **How it differs from §1.3:** this filters songs already in the library. The top bar searches YouTube and SoundCloud for new songs to import.

### 3.2 Tabs: Songs | Setlists
- **Songs**, with a count of the songs the search leaves, Trash excluded.
- **Setlists**, with the number of setlists; this count ignores the search.
- Left/Right switches tabs.
- The tabs are hidden in the Trash, Favorites, Queue and Lyrics views. Entering those views resets to Songs.

### 3.3 "Empty trash" bar
Shown only in the Trash view (see §7).

---

## 4. Songs tab: the folder tree

### 4.1 Sections
- **"Stem Collections"**, with a **New folder** button in its header. New folder adds a folder and opens the folder editor titled "New folder".
- **"Tags"**: shown only when the open song has tags.
  - One chip per tag of the **open song**, with the library-wide count.
  - Clicking a chip sets the search to "#tag" (the chip lights up). Clicking it again clears the search.

### 4.2 Folder header row
Contents, left to right:
- Grip, tooltip "Drag to reorder". Not on Unsorted.
- Chevron, folder icon in the folder's colour, name, count. The count is the songs in that folder that match the search; subfolders are not counted.
- **⋯** button, tooltip "More". Not on Unsorted.

Behaviour:
- **Single click** toggles collapse, after a short delay so that a double-click can win.
- **Double-click** opens the folder editor titled "Rename folder". On Unsorted it opens "Edit folder" with colour only.
- **Enter** toggles collapse. **F2** opens the rename editor; nothing on Unsorted.
- **Unsorted** is a system folder: it has no grip and no menu, does not highlight on hover, and cannot be deleted. New imports land in it.
- Empty folder text: "Nothing in this folder yet."
- During a search, folders with no matches and no subfolders are hidden. If nothing matches at all: "No tracks match your search" plus "Try another word, or start with # to search by tag."

### 4.3 Folder ⋯ menu, in order
1. **Rename…** opens the editor.
2. **New subfolder** adds a child folder, expands the parent and opens the editor titled "New subfolder".
3. **Make a setlist**: disabled when the folder and its subfolders have no songs.
   - Creates a setlist under the folder's name. A taken name gets " (n)"; letter case is ignored when comparing.
   - Songs go in as the folder's own songs, then each subfolder's, at any depth.
   - The folder itself stays.
   - Switches to the Setlists tab with the new setlist focused.
   - Over 1000 songs: the error "Too many songs for a setlist (max 1000)." appears under the folder row and nothing is made.
4. (separator)
5. **Delete folder** (red). It does **not** delete immediately:
   - It arms the ⋯ button, which then reads "Delete?" for 4 s.
   - A second click or Enter on the button confirms.
   - The songs in the folder and all its subfolders go to the **Trash**; they are not destroyed.

Menu keys: Up/Down cycle the items, Escape closes and returns focus to ⋯. The menu also closes on an outside click, a window resize or a list scroll.

### 4.4 Folder editor dialog
- Title: "New folder", "New subfolder", "Rename folder" or "Edit folder". Close button "×".
- **Name**: up to 100 characters. Errors:
  - "Enter a folder name."
  - "Folder name is too long (max 100)."
  - "Use letters, numbers, spaces, or - _ ' & ( ) . ,"
- **Color**: 5 swatches (coral, rose, green, blue, violet).
- **Cancel** / **Save**. Enter saves; Escape or a backdrop click cancels. Focus returns to the folder row.

### 4.5 Folder drag and drop
- **Dragging a folder by its grip** onto another folder:
  - top quarter: placed before it
  - bottom quarter: placed after it
  - middle: nested inside it as a subfolder

  On Unsorted, a drop can only go before or after it; Unsorted cannot hold subfolders. A drop that would put a folder inside its own descendant is ignored.
- **Dragging a song row onto a folder** moves the song there.

---

## 5. Song row (Songs tab, Favorites, search results)

### 5.1 Contents
- **Cover:** thumbnail, or a file-format badge (MP3, WAV and so on, each with its own colour) for uploads without art, or a note icon.
  - A **Play overlay** ("Play {title}") appears on hover and on the selected row.
  - It never appears on the row of the song that is playing.
- **Title.** A link with no title yet reads "YouTube link", "SoundCloud link" or "{host} link". No title at all reads "Unknown track".
- **Sub-line**, by state:

  | State | Sub-line |
  |---|---|
  | Done | artist · duration. A small red heart sits in front when favourited. With 2+ versions, the duration is replaced by the "N versions" toggle. |
  | Importing | "Processing", then the live queue text: "Queued - #N in line", "Paused", or the stage text with a % and a progress bar |
  | Failed | "Import failed" in red |
  | Stopped | "Stopped" |
  | Unavailable | "Track unavailable - click to reimport", or for uploads "Track unavailable - re-upload to restore" |

- **Status dot**: hidden when the song is settled. Shown (pulsing) while processing, when unavailable, and while waiting in the queue.
- **Hover/focus actions**, overlaid at the right edge. They stay visible on the selected row. In order:
  1. **Extract** (only on Stopped songs, visible at rest; name "Extract {title} again"). Re-queues the song.
  2. **Add to Up Next** (name "Add {title} to Up Next"). Only on finished songs.
  3. **⋯ More** ("More for {title}"). Only on finished songs.
  4. **Heart**: tooltip "Add to Favorites" or "Remove from Favorites". Synced to the server; a refused save is rolled back with the notice "Could not save the favorite. Try again."
  5. **Trash can**: tooltip "Move to Trash" ("Move {title} to Trash"). Moves the song to the Trash at once, with no confirmation. *Not present on rows in the Favorites view.*

### 5.2 Click, double-click, Enter and Play: exact semantics (`openSong.js`)

| Gesture | Nothing playing | Another song playing | The playing song's own row |
|---|---|---|---|
| **Single click** | Selects the row and loads the song **paused** | Selects the row and **shows** it over the player: song head, Details and a preview of its waveform lanes. **The playing song keeps playing**; the player itself is not changed. | Closes any shown song and goes back to the playing one, with no reload |
| **Double-click** | Opens and plays | Switches the player to this song and plays it | Resumes or keeps playing |
| **Enter** (focused row) | Same as double-click | Same as double-click | Same as double-click |
| **Cover Play overlay** | Same as double-click (the row is focused, Delete is not armed) | Same as double-click | Not shown |

Other rules:
- Arrow keys move the selection and open nothing.
- A click on a song that is already loading is ignored. While a recording take is counting in or recording, a click only selects the row.
- Clicking an unavailable song first asks the server again:
  - If the song is back, it plays.
  - If it is gone and came from a link, the dialog "Import this song again?" appears: "Its files are no longer on this computer. Importing downloads it again and stops what's playing." Buttons Cancel (focused) and **Import again**.
  - If it was an upload, the error "This track's audio is no longer available. Re-upload to restore it."
  - If the server can't be reached, an offline error.

### 5.3 Selected vs open vs playing (visual states)
- **Selected** (`is-selected`): a neutral frame. Actions are visible and the Play overlay shows.
- **Playing / in the player** (`active`): a coral fill with a coral title. No Play overlay.
- **Shown over the player**: wears the selected frame only.
- When the song's versions are expanded, the coral fill moves to the open version's row and the song row only colours its title.
- Hover: a light background.

### 5.4 Footer "Playing" group
- Label "Playing", an animated mark, and a title button with tooltip "Show the playing song". It names the playing song and follows renames.
- **Only visible while another song is shown over the playing one.**
- Click or Enter: closes the shown song, returns the studio to the playing song (which keeps playing) and scrolls its library row into view.

### 5.5 Related player behaviour while a song is shown over the playing one
- The song head shows a round **Play** button "Play this song", which switches to the shown song and plays it.
- The footer Play/Pause and Space pause the *playing* song. The next Play starts the *shown* song.
- When the playing song ends:
  - If Up Next has songs, Up Next wins and the shown song goes away.
  - Otherwise the shown song loads paused at the start.
- Stage mode, Up Next "Now playing", Lyrics and Tempo all stay with the playing song.

### 5.6 Row ⋯ menu, in order
The menu opens beside the row, or above or below it when there is no room.
1. **Rename…**: in-row title and artist editor (§9).
2. **Extract more stems…** if the open version lacks stems; or **Stop extracting** while a run is going. Absent otherwise.
3. Label **Add to setlist**:
   - One item per setlist. A setlist that already holds the song shows a check and is disabled.
   - Adding briefly flashes the Setlists tab.
4. **New setlist with this song**: creates "Setlist N" holding the song, switches to the Setlists tab with the name field open for typing.
5. Label **Move to folder**:
   - Every folder and subfolder, indented in tree order.
   - The current folder is checked and disabled.
   - Picking one moves the song and focuses it; Delete is not armed by this.
6. **New folder…**: creates a folder holding the song and opens the editor.

- **There is no right-click or context menu** on library rows; I found no row `contextmenu` handler. Favourite, Up Next, Trash and export are **not** in this menu.
- **The open song's ⋯** (song head "More", and Stage's More, which acts on the playing song) is the same menu **without Rename**.
- **The song head also has:** **Add to Up Next**, a pencil "Rename this song" that appears on hover, the heart ("Toggle favorite"), and "About this song".
  - Up Next and More are disabled when the open song is trashed, unfinished or unavailable.

### 5.7 Keyboard in the list
- The whole list is **one Tab stop**.
- Up/Down/Home/End move between rows. Folder headers and expanded version rows count as rows.
- Right/Left step into and back out of the row's own buttons. Those buttons are out of the Tab order, and the cover Play overlay is never among them.
- **Delete or Backspace** moves the focused song to the Trash. Focus then moves to the next song. Rules:
  - Only when the row was reached **by keyboard**. After a click, a tap, a Play-button open or a menu opened and closed by mouse, it does nothing until you arrow to a row.
  - Not in text fields or dialogs, and not in Stage mode.
  - Not on version rows, setlist rows or Trash rows.

### 5.8 Failed import row
- The cover is a link or file icon, and the sub-line reads "Import failed" in red.
- A **Retry** icon is always visible. For a file that was not kept it is **Pick the file again**.
- **Selecting** the row opens a panel. Its buttons are reachable with the arrow keys; Tab does not stop on them.
  - The reason, for example "There wasn't enough memory to finish. Close other apps, then retry." (8 reasons in total).
  - A **Source** box: for links, **Copy link** (tooltip briefly reads "Link copied") and **Open link**; for files, the file name.
  - **Retry** or **Pick the file again**, and **Trash**.
- Retry rules:
  - It retries as the same job, with no new row.
  - A link the server forgot is imported again in place of the failed row.
  - A file that is gone switches the row to "Pick the file again", which uploads the replacement in place.
  - Repeated presses send nothing more.
  - A failed import that is in the Trash says "Restore it from the Trash first."
  - A full queue says "The queue is full. Wait for it to drain, or cancel something first."

### 5.9 Dragging a song row
- Onto a folder: moves it there.
- Onto the rail **Trash**: moves it to the Trash.
- Onto the studio/lanes area: loads the song, paused, like opening it.
- Onto the rail **Library**: only from the Trash view; restores the song.
- **Rows cannot be dragged out of the app.** The only drag-out to other apps is the loop-region grip and the stem-lane handles in the desktop app ("Drag this region into a DAW or folder"). Those are outside the library.

---

## 6. Favorites view
- Lists every favourited song that is not in the Trash, **newest first**, with no folders.
- Rows are like song rows but have **no Trash button**.
- Click, double-click, Enter and Play behave as in §5.2.
- Empty: "No favorites yet" / "Click ♥ on a song to keep it here."
- No match: "No favorites match your search" plus the tag hint.

## 7. Trash view
- **Rows** look like library rows. They have no Play overlay and no version rows. The sub-line ends with "Removed"; on hover or focus it becomes "Hold left click for 1 second to restore".
- **Selecting:**
  - A click selects only; it **never opens** the song.
  - Ctrl or Cmd+click adds or removes a row.
  - Shift+click selects a range from the last row picked.
- **Restoring:**
  - **Hold the left button for 1 s** to restore. A coral fill sweeps across the row during the hold, and letting go early cancels it.
  - Holding a selected row restores the **whole selection**, and every selected row fills during the hold. Holding a row outside the selection restores only that row.
  - Holding Enter or Space on a focused row does the same.
  - Dragging a row onto the rail Library button restores it (or the selection it belongs to) and switches to the library.
- **Where restored songs go:** Unsorted (`catalog.js` `takeOutOfTrash`). They are not re-queued. A song stopped while importing comes back as "Stopped", with its **Extract** button.
- **Empty trash** bar button: the first click arms it ("Delete permanently?"), and a second click within 4 s deletes every song in the Trash permanently.
  - A song whose delete failed stays, with the notice "{count} song(s) could not be deleted and are still in the Trash. Try Empty trash again."
- **There is no per-song "Delete forever" control.** Only Empty trash, or the automatic-deletion setting in Settings.
- Empty: "Trash is empty" / "Songs you delete wait here, so you can restore them."
- No match: "No deleted tracks match your search".
- The Trash is shared with other devices through the server.
- Moving a song to the Trash also removes it from Up Next for good. It stays greyed in setlists until the Trash is emptied.

## 8. Queue view (rail Queue)
- **Header** "Import Queue".
- **Paused banner:** "Paused - N tracks from your last session." with **Start** ("Starting…" while it runs). A refusal gives the notice "The queue could not be started. Try again."
- **Batch header** (after a batch is queued):
  - "{done} of {total} done"
  - "N failed · N not queued · N waiting"
  - A two-colour progress bar
  - **Retry failed**
- **Failed batch rows:** the reason, **Retry**, and **×** "Remove".
- **Rows:**
  - A grip "Drag to reorder" on waiting rows only.
  - Cover and title.
  - A label: the stage with %, or "Queued - #N in line", or "Paused".
  - A progress bar on the running row.
  - **Extract this one next** (up arrow; only on waiting rows from position 3 on).
  - **Cancel this import** (×). A link import cancels at once. An upload first arms "Delete upload?" and needs a second click. A refused cancel gives "The import could not be cancelled. Try again."
- **Reordering:** drag waiting rows. The running row cannot move.
- Empty: "Nothing importing" / "Songs you queue for import show up here."
- The view returns to the Library by itself once nothing is left.
- Moving an importing song to the Trash (from the library) stops it on the server and refreshes the queue.

## 9. Song rename (row and song head)
- Opened from the row menu **Rename…**, or by clicking the song head's title, its artist (that field gets focus) or the pencil.
- **Fields:** "Song title", whose placeholder is the detected title, and "Artist".
- Hint: "Enter saves · Esc cancels". **Leaving the form also saves.**
- **Restore detected names** appears only when the title or artist was changed by the user. Tooltip: "Go back to the detected title, "{title}", and the detected artist".
- Emptying a field goes back to the detected name.
- **Errors** appear inline:
  - "Could not save the new name. Try again."
  - "This song is no longer in the library."
  - "Could not save the new name: {reason}"
- After saving, the song's online details (band, lyrics and so on) are looked up again.

## 10. Versions
- They appear when a song has **2 or more versions**. The row's duration is replaced by a toggle "N versions", which shows or hides the version rows.
- **Version row:**
  - A Play overlay ("Play {title}, {name}").
  - The name: "Original" or a custom name.
  - Coloured dots for its stems; tooltip lists them, or reads "All stems".
  - **⋯** ("More for {name}").
- **Gestures:**
  - Single click: **selects only**.
  - Double-click, Enter or Play: opens that version and plays it. If the lanes are the same, only the mix switches and playback carries on.
- **Version ⋯ menu:**
  1. **Open**
  2. **Rename…**: inline field, "Enter saves · Esc cancels", leaving saves; up to 60 characters.
  3. **Save as new version**: copies the mix and starts as "Version 2" (the next free number) in rename mode.
  4. (separator)
  5. **Delete version** (red): arms the ⋯ button to "Delete?"; a second click deletes, together with the version's saved mix.
- Deleting the second-to-last version turns the row back into a plain row. A song's only version cannot be deleted: "This is the song's only version."
- **Studio pill** after the artist ("Version: {name}"): a menu of versions as radio items, then **Save as new version**. It belongs to the open song, even when another song is playing.
- **Extract more stems…** (row ⋯, song-head More, Stage More):
  - It brings the library into view: leaves Stage, expands the library, expands the folders and clears a search that would hide the row.
  - An inline form appears under the row: "Extract more stems", one chip per stem the version lacks (all pre-ticked), and the hint "Saved as a new version." or "Saved as a new version. Takes a few minutes."
  - **Cancel** / **Extract**. Extract is disabled when no chip is ticked. Escape closes the form.
  - If the original audio was not kept: "This song's original audio wasn't kept. Import it again to get these stems." with **Close**.
- **While extracting:**
  - The row and the song head show "Waiting to extract", "Downloading N%", "Extracting N%" or "Finishing…" with a bar.
  - The menu item becomes **Stop extracting**.
  - When done, the new version is named "+ {stems}" and opens if the song is in the player.
  - Failures go to the notifications, for example "The link no longer works. The song is unchanged." or "The stems could not be extracted. Try again."
- Setlists and Up Next play the version that was opened last.

## 11. Setlists tab
- **Setlist header:**
  - Name (full name in the tooltip).
  - **Play** ("Play {name} from the top"). Disabled when no song in it can be played.
  - "N songs".
  - Tools: rename (pencil, "Rename {name}"), make folder ("Make a folder from {name}", disabled when empty), delete ("Delete {name}").
- **Play rule:** stops the current song, loads the first playable song and plays it, and **replaces Up Next** with the rest. Trashed songs are skipped. If nothing can play: "None of this setlist's songs can be played right now."
- **Rename:** an inline field, up to 100 characters. Enter or leaving the field saves; Escape keeps the old name.
- **Delete:** the first click arms the button ("Delete?", tooltip "Click again to delete {name}", 4 s); the second deletes.
- **Make a folder:** creates a folder named after the setlist (a taken name gets " (n)"), **moves** the setlist's songs that are not in the Trash into it, in setlist order, and switches to the Songs tab with the folder focused. The setlist stays.
- **Song row:**
  - Position number, cover (or first letter) with a Play overlay, title, and artist, or "In the Trash" when trashed.
  - Hover actions: move up ("Move {title} up", disabled on the first row), move down (disabled on the last), remove ("Remove {title} from this setlist").
  - **Single click selects only.** Double-click, Enter or Play **load the song into the player paused**. Despite the "Play {title}" label, it does not start playback (`setlists.js` `openSetlistRow`).
  - The playing song's row has the coral fill.
  - Trashed songs are greyed, have no Play overlay and cannot be opened. They disappear when the Trash is emptied.
- **Keyboard:** each setlist is one Tab stop. Enter on a header does nothing; Right reaches its buttons. Delete does nothing.
- An empty setlist shows "No songs yet. Add them from a song's … menu."
- **New setlist** (bottom button): an inline name field. Enter or leaving saves; an empty name or Escape cancels.
- Empty tab: "No setlists yet." / "Make one here, or add a song to one from its … menu in Songs."
- **Error line** under the list:
  - "Could not save the setlist. Try again."
  - "Could not save the setlist: {reason}"
  - "That setlist or song no longer exists. Your setlists have been reloaded."
  - "Could not load your setlists."
- Setlists are stored on the server. Adding a song re-reads the list first, so changes from another window are kept.

## 12. Up Next (right-hand panel, "Up Next" tab, with a count badge)
- **"Now playing" block:** cover, title and duration of the playing song, or "Nothing is open".
- **"Up next" heading** with **Save as setlist** and **Clear**.
  - Save as setlist is visible when there is a playing song or anything queued. It creates "Setlist N" with the playing song first, then opens the Setlists tab with the name field ready.
  - Clear is visible when the list is not empty.
- **Rows:**
  - Number, cover, title and duration, all as one button with tooltip "Play now".
  - **A single click plays** the song and **drops every song above it** from the list.
  - **×** "Remove from Up Next".
- **Adding:** the row "Add to Up Next" button, the song head, or Stage. A song already in the list is ignored, with no message.
- **Reordering:** drag, or **Alt+Up / Alt+Down** on a focused row (focus stays on it). The order survives a reload.
- **Keyboard:** one Tab stop, Enter plays, Right reaches the buttons.
- **Autoplay:** when a song ends, the first Up Next song plays and leaves the list.
- **Footer Next** ("Play the next song in Up Next") is disabled when the list is empty.
- Empty: "Up Next is empty" / "Press + on a song in the library to play it after this one." The markup's fallback text differs ("Choose Add to Up Next from a song's … menu"); the translated text is what shows.
- Trashed songs leave Up Next for good, including songs trashed on another device.

## 13. Library width and collapse (`libraryResize.js`)
- **Handle** between the library and the studio. Tooltip "Drag to resize. Double-click to reset.", accessible name "Resize library".
  - Drag: width between 232 and 560 px, and never so wide that the stem area has less than its label column plus 360 px.
  - **Double-click** or **Enter** resets to the default width.
  - Reached with Tab; Left/Right change the width by 16 px.
  - The chosen width survives a reload. If the window is too small for it, the panel shrinks and grows back later.
- **Auto-collapse** (only after the first song has been opened):
  - If the window gets too narrow for a 232 px library, the library collapses by itself, and it reopens by itself when room returns.
  - If the user reopens it while there is still no room, it stays open.
- When collapsed, only the rail shows and the handle is hidden. Reopening restores the width.

## 14. Feedback and failure messages tied to this area
- **"Can't open the library" error** at start-up: "StemDeck can't open your library list right now, so nothing was loaded or changed. Wait a moment, then press Try again." with Try again.
- **Lost library notice:** "Your saved library list couldn't be recovered, so the library starts empty…"
- **Device save failure:** "Changes couldn't be saved on this device." (shown once).
- **While the stems folder is being moved**, renames, trash, restore, favourites, setlist saves and retries are refused with "Restart StemDeck to finish moving StemData, then try again."
- Notification categories for this area: "Import failed", "Favorite not saved", "Library not saved", "Trash not emptied".
- `saveFailures.js` itself covers section, beat-grid and tempo saves, which are outside this area.

---

## Could not determine
1. Whether the collapsed-library thumbnail strip is ever visible. It sits inside the panel body, which is hidden when collapsed, so it probably shows nothing (inferred). Its folder thumbnails have no click handler.
2. Whether the playlist confirm dialog strings ("Import this playlist?", "Import N tracks") and some upload strings ("Skipped N files…", "Added {queued} of {total} files…") are still used anywhere. They look superseded by the batch review (inferred).
3. Exactly how the status dot looks for a waiting queue row; it is only asserted to be visible.
4. Whether the library search applies inside the Queue view (inferred: it does not).
5. Rejection wording for the folder and setlist name fallback: a test says "New Folder", while the English string is "New folder".
6. The exact live stage texts on the running queue row; they come from the server.
7. The pixel offsets of the row ⋯ menu; only the beside / above / below rules were read.