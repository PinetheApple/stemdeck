# StemDeck Studio: functional inventory (the open song)

Everything below comes from `static/index.html`, the English block of `i18n.js`, the studio JS modules and the e2e spec titles. I mark anything I could not confirm in code with **(inferred)**. Where the HTML label and the English i18n string differ, I give the i18n string, because that is what users see once the page translates itself. Those mismatches are listed in the last section.

---

## 0. Global studio states (apply across surfaces)

| State | What shows |
|---|---|
| **No song open** | The title reads "—", or "Ready to import a track". An empty-start card shows "Start with a song" / "Paste links, or drop files or a folder in the bar above." with three buttons: **Choose files**, **Choose a folder**, **Paste links**. The lanes show one flat placeholder line per stem: six lines, no Original. The footer time reads 00:00 / 00:00 and the loop fields are disabled. The click is disabled with the tooltip "Load a track to use the click". All Tempo tools are disabled. Up Next's Now playing reads "Nothing is open". |
| **Waveform loading** | An overlay with the aria label "Loading waveform", animated lines and a rotating phrase. The fallback phrase is "Still loading waveform…". |
| **Import / extract job running** | A box at the top of the wave panel: job title, a stage phrase (rotating), a progress bar, detail text, and a **Cancel** button. |
| **Audio failed** | "This track's audio could not be loaded." plus "Playback is disabled for this track. Other tracks are not affected." The click reason becomes "Playback unavailable for this track". |
| **Other click-unavailable reasons** | "No beat grid for this track", "Click track unavailable on this playback path", "Click track needs the Web Audio engine". |
| **Open vs playing** (`openSong.js`, `openPreview.js`) | A single click on a library song while another one plays only *shows* it. Its head, details and lanes (drawn from peaks) appear over the playing song, which keeps playing. The song head then shows a **Play this song** button. The footer shows a **Playing** group whose title button reads "Show the playing song". Clicking that button, or pressing Enter on it, drops the shown song and scrolls the library to the playing one. Space or footer Play while showing starts the *shown* song. Double-click, Enter, or a row's Play opens and plays. With nothing playing, a click opens the song paused. |
| **Song ends** | The first song in Up Next plays. With Up Next empty, a shown song loads paused at the start. |
| **Error banner** | A banner (`#error`) at the top of the lanes. Esc dismisses it. |

---

## 1. Song header (`#songHead`)

In order, left to right:

1. **Cover art**: the thumbnail, or a format-icon placeholder.
2. **Play this song** (tooltip and aria are the same text). Visible only while another song is shown over the playing one. It plays the shown song.
3. **Title**. Clicking it opens inline rename with focus on the title.
4. **Artist**. It sits on the title's line and is hidden when unknown. Clicking it opens rename with focus on the artist field.
5. **Rename this song** (pencil). Visible only on hover or focus of the head, and hidden with no track.
   - The rename form has a **Song title** field (placeholder: the detected title) and an **Artist** field.
   - Hint: "Enter saves · Esc cancels". Leaving the form (blur) also saves.
   - **Restore detected names** appears only when a user name is set. Its tooltip is "Go back to the detected title, “{title}”, and the detected artist".
   - An emptied field reverts to the detected name.
   - Errors: "Could not save the new name. Try again." / "This song is no longer in the library." / "Could not save the new name: {reason}".
   - After saving, the song's lyrics and artist info are looked up again.
6. **Version pill** (`#npVersionBtn`). Shown only when the song has 2+ versions. It shows the open version's name with a ▾; its aria and tooltip are "Version: {name}".
   - Menu, in order: each version as a radio item (check on the open one), a separator, then **Save as new version**.
   - Saving starts the new version as "Version N" in rename mode and keeps the mix.
7. **Extracting label** (`#npExtracting`). Appears after the artist while "Extract more stems" runs:
   - "Waiting to extract"
   - "Extracting {pct}%"
   - "Downloading {pct}%"
   - "Finishing…"
8. **Favourite heart**: aria "Toggle favorite", aria-pressed. Toggles Favorites and stays in step with the library row heart.
9. **About this song** (ⓘ). Opens the song/artist info box. That box is outside my area.
10. **Add to Up Next** (+). Queues the open song. Disabled when the open song is trashed, unfinished or unavailable. No duplicates are added.
11. **More** (…). Tooltip and aria: "More". Opens a menu for the open song, with **no Rename** item. In order:
    1. **Extract more stems…**, only if the song is done and has missing stems. While a run is active this item is replaced by **Stop extracting**.
    2. Label "Add to setlist", then one item per setlist (a check and disabled if the song is already in it).
    3. **New setlist with this song**.
    4. Label "Move to folder", then each folder (indented by depth; check and disabled on the current folder).
    5. **New folder…**.

    Menu behaviour: ↑/↓ cycles items, Esc closes and refocuses the button, clicking outside or resizing closes it. Extract more from here leaves Stage, opens the library, expands the song's folders and clears a search that hides its row.

The controls after the song card:

12. Label **Collapse**, followed by the toggle **Sections** (tooltip "Show or hide the sections bar", aria-pressed). It shows or hides the sections bar and persists per browser. Each toggle persists in localStorage under `stemdeck.panel.*`. (The Panel toggles spec says the row "is the panels it governs", and only Sections exists today.)
13. **Auto-scroll** (tooltip "Keep the playhead in view while playing when zoomed in", aria-pressed). On by default, persisted.
    - Page-turn behaviour: when the playhead reaches 90% of the view, the view jumps so the playhead sits at 10%.
    - A manual scroll pauses following until the playhead is back in view, or until a seek or Play.
    - Zoom, a song switch or a resize does not count as a manual scroll.
    - A loop wrap brings the view back.
14. **Stage mode** (tooltip "Full-screen view to play along from (F)", aria-pressed). Toggles Stage.
15. **Inspector toggle** (tooltip and aria "Toggle song tools", aria-expanded). Hides or shows the inspector and persists. The lanes take the freed width. Stage mode leaves it as it was.

---

## 2. Sections lane (ribbon above the ruler)

**Header**
- Title "Sections".
- Save indicator: "Saving", then "Saved" (fades after 1.8 s). Notices appear in the same slot:
  - "Not saved" (stays until a save is answered)
  - "No room left. Shorten or delete a section."
  - "Loop too short for a section"
  - "Loop overlaps a section"
  - A server refusal notice
- **Clear** (aria "Clear all sections"). Hidden when there are no sections.
  - It is a two-click arm: the first click shows "Confirm?", the second click clears all.
  - The arm times out after 4 s.
  - Hide also disarms it.
  - Clearing cannot be undone.
- **Add** (aria "Add section").
  - If a loop is armed, the new section is built on the loop. It is refused if the loop is shorter than 0.5 s or overlaps a section.
  - Otherwise it goes in the first gap from the start, at 12% of the track length.
  - The new section is named "Section", scrolled into view, and its rename field opens.
  - With no song open, Add does nothing and says nothing.
- **Hide** (icon; aria "Hide the sections bar"; tooltip "Hide the sections bar. Collapse > Sections brings it back.").
  - Hides the bar and moves focus to the Collapse > Sections toggle.

**Section blocks**: each block is coloured and shows its label, then a padlock and a × button.
- **Labels** come from detection: Intro, Outro, Break, Bridge, Instrumental, Solo, Verse, Chorus, Part. Repeated kinds are numbered ("Chorus 1", "Chorus 2").
- **Single click** (a press without movement) sets the loop to the section and arms it. This works even when the section is locked.
- **Drag the body** to move the section, keeping its length. It cannot overlap other sections; it snaps to the nearest neighbour edge.
- **Drag a left or right edge handle** to resize. The minimum length is 0.5 s and the section is bounded by its neighbours.
- **Double-click** the block (not the handles, lock or ×) to open an inline rename. Enter or blur saves, Esc cancels. An empty or unchanged name is ignored. A renamed section loses its detected kind.
- **Padlock** (aria "Lock position" / "Unlock position"). A locked section shows a red padlock even without hover, and refuses drag, resize and rename. Click, loop and delete still work. The lock persists.
- **×** (aria "Delete section"). Deletes immediately.
- **Rule**: dragging a section does not also arm a loop.

**Other behaviour**
- Saving is debounced (600 ms) and per song.
- The ribbon follows the waveform's zoom and scroll exactly.
- **Detect structure** (tooltip "Experimental. Labels intro, verse and chorus while a track is imported…") lives in the import bar, not the studio. It applies to the next import only and does not show or hide the bar.

---

## 3. Mixer column (one row per lane, left of the waveforms)

**Header**: "Mixer" with the hint "Drag fader · M/S". Both are static labels only.

**Lane rows** follow the lane order: Original (only if present), then Vocals, Drums, Bass, Guitar, Piano, Other. After a lead/backing split, Vocals is replaced by **Lead Vocals** and **Backing Vocals**. Absent stems show as a greyed, disabled row (`unavailable`).

Each stem row, left to right:

1. **EQ mark** (top-left mini curve; aria and tooltip "{name} EQ"). Opens the inspector's EQ tab on this lane.
   - Its state is dim when flat, coral when active, and a third look when bypassed.
2. **Instrument icon**, then the **name** with a **VU meter** under it.
3. **Fader** (aria "{name} volume"). Range 0 to 2× (about +6 dB), step 0.01.
   - Drag to set.
   - Wheel steps 0.04, or 0.2 with Shift.
   - **Double-click resets to unity (1.0)**.
4. **Value**, in dB to one decimal: "-∞", "0.0", "+3.5".
5. **Key stepper "K"**: **+** above, the reading in the middle, **−** below. The aria labels are "Transpose {name} up one semitone" / "…down one semitone". The tooltip is "Transpose this lane: {n} semitones".
   - The reading is "K" at the original key and a signed number otherwise; it is lit when non-zero.
   - Range ±6 semitones.
   - **Drums**: the stepper is present but disabled, with the tooltip "Drums are never transposed".
   - Without transpose support it is disabled, with the tooltip "Transpose is not available for this track" or "…over a network connection".
6. **M** (aria "Mute {name}").
   - **The button's "active" (lit) state means audible**, not muted.
   - If every loaded lane is muted when a mix loads, all are unmuted.
7. **S** (aria "Solo {name}"). Lit when soloed.
8. **Download** (tooltip "Download {name}"). Saves the stem as a file named "{Song}_{stem}.wav".
   - In the desktop app it can also be dragged out to give the full stem.

**Rules**
- The mix (volume, mute, solo, key, EQ) is saved per song *and per version*.
- Mixer rows and waveform lanes scroll vertically in lockstep.
- The **drag handle** exists in the markup but is hidden in the studio (`display:none`), and I found no lane-reorder code.
- **Solo only** (the "monitor" button, aria "Solo only {name}") lives in the hidden stem list. Its logic exists: solo exclusively, and clicking again clears. In the studio it is not visible.
- There is no master fader: `t-master` is referenced in JS but absent from the markup.

**Recording tracks** (rows appended below the stems)
- Track row:
  - Takes folder toggle (▾, aria "Takes of {name}", aria-expanded). Shown only if the track has takes.
  - Name.
  - Input button (mic icon, the input name or "Default input", ▾; aria "Input for {name}"). Opens the input menu.
  - Input meter.
  - Fader (same rules as stems: dblclick resets to unity, wheel steps 0.04/0.2).
  - **Arm** (aria "Arm {name} for recording", pressed state). Only one track can be armed at a time; clicking again disarms.
  - **M**, **S**.
  - **…** (aria "Options for {name}").
- **Input menu**: one entry per device. When the armed device is stereo, each device offers "{device} · Input 1", "… · Input 2" and "… · Inputs 1+2". The current choice is checked. With no device the menu shows the disabled entry "No microphone or audio input found…".
- **Track options menu**, in order: **Rename…**, **Recording settings…** (opens Settings > Recording with this track's input for the latency test), a separator, then **Delete track** (danger). Delete asks "Delete this track?" / "Its takes are deleted too. This cannot be undone." with focus on Cancel.
- **Take rows** (when the folder is open):
  - A radio-style pick button with the label ("Take N") and length. Tooltip "Play this take".
  - **Unfinished** takes show the flag "Unfinished" with the tooltip "Recording was cut off. Keep what arrived, or delete it."
  - **Recording elsewhere** takes show "Recording elsewhere" with the tooltip "This take is still being recorded in another window."
  - A finished take has a trash button (aria "Delete {name}").
  - A just-recorded or unfinished take shows chips **Keep** (primary) and **Delete** instead.
- **+ Track** row, at the end. Opens a menu with one item, **Audio track**, which creates "Track N". This row stays above the footer on short windows.
- **Lane for a recording track**:
  - Take waveform.
  - "Press Record to start" when empty.
  - An arm-problem box with an action button.
  - Latency hint "Timing is estimated." with **Test latency**.
- **Arm problems**:
  - "No microphone or audio input found…" / "Try again"
  - "StemDeck isn't allowed to use the microphone…" / "Try again"
  - "This window can't use a microphone…" / "Try again"
  - "No sound from the input…" / **Choose input**
  - "Couldn't start recording. Try again."
  - "This take couldn't be saved. Record it again." / OK

---

## 4. Waveform area

### Ruler (top)
- Time ticks get finer as you zoom. A playhead flag marks the position.
- The ruler is the same surface as the waveform for click, seek and loop (see the loop rules below).

### Lanes
- One per lane, drawn as bars. Unavailable stems are greyed.

### Seek and loop gestures (`transport.js`, `loopRegion.js`)
These rules are easy to get wrong:
- **Single click** on a lane or the ruler, outside the loop region:
  - seeks there;
  - **turns the loop off but keeps its bounds**, so L brings back the same loop.
- **Press and drag** of at least 0.2 s creates a loop over the dragged span (either direction) and arms Loop.
- **Inside the loop region**:
  - drag the **left or right handle** to move one edge;
  - drag the **body** to slide the whole loop, keeping its length;
  - a click without movement **seeks and keeps the loop on**.
- Edges cannot cross; the minimum loop is 0.2 s; the loop is clamped to the track.
- **Default loop bounds** on load are 25% to 50% of the track, with Loop off.

### Zoom
- **Plain vertical wheel zooms**, anchored on the pointer.
- **Shift+wheel or a horizontal swipe pans.**
- Range 1× (fitted) to 10×, at 1.18× per notch.
- Zooming adds detail, not fatter bars.
- At either limit, the wheel falls through to page scroll.
- Opening another song resets to the fitted view.
- There are no zoom buttons.

### Horizontal scroll
- The scrollbar appears when zoomed in, or when the window is narrower than a 720 px minimum wave width.

### Beat grid display
- While the **click track is on**, the grid lines are drawn over the lanes, thinned to bars and then every Nth bar as needed. They follow the ÷2/×2 click rate.

### Beat grid editor
Opened by **Grid** in the Tempo tab. The toolbar "GRID" sits over the wave panel:
- Tools (radio): **Move** ("Drag beats"), **Add** ("Click to add a beat"), **Delete** ("Click a beat to remove it"), **Bar line** ("Click a beat to mark it as a downbeat").
- **Ripple** (checkbox, on): a drag re-interpolates the region. Alt-drag inverts Ripple for that one drag.
- **Snap** (checkbox, on): snaps to detected onsets within 14 px / 60 ms. Onset ticks are shown.
- **Bar** number field (1–32, aria "Beats per bar in this region").
- **Undo** ("Undo (Cmd/Ctrl+Z)"), **Redo** ("Redo (Cmd/Ctrl+Shift+Z)").
- **Reset** ("Discard all edits and restore the detected grid").
- **Done**.
- Hint text that changes per tool, for example "Drag a beat to retime the region. Alt-drag moves one beat." / "Click a beat to remove it. Right-click works in any tool."
- Rules:
  - Right-click deletes a beat in any tool.
  - Esc closes the editor.
  - Opening the editor switches the click **on**; switching the click off (button or K) closes the editor.
  - Ripple and Snap preferences persist.

### Drag-out (desktop app only)
- A **loop grip** sits on the loop region (tooltip "Drag this region into a DAW or folder"). It carries the mix of audible lanes for the region, including click, count-in and EQ settings.
- **Per-lane nuggets** sit at the loop's right edge on each lane ("Drag {name} for this region into a DAW or folder"). Each carries that stem alone at unity, ignoring mute and solo.
- The file name includes the loop bounds.
- There is no drag without a loop, and none in a plain browser.

### Lyrics lane
Shown only while Sync lines is on in the Lyrics pane.
- Header: "Lyrics" / "Drag a line · ← → nudge" / **Done** (tooltip "Leave Sync lines. Changes are saved as you make them.").
- One marker per line, labelled with the line's first words or ♪ for a gap.
- Drag a marker to retime its line; a click (under 3 px of travel) selects the line.
- Alt while dragging places the line freely, without snapping to the voice.
- The current line is lit.
- The lane follows zoom and scroll.

### Open-preview lanes
- When a song is shown over the playing one, its lanes are drawn from peaks with name labels, as a static picture.

---

## 5. Footer transport (full width)

The clusters left to right are **Playing** (preview only) | **Transport** | **Position** | **Speed** | **Global key**, with Export pinned at the right. On narrow widths the strip wraps into two rows, with Speed and Global key going to the second row. In Stage mode the **Transport** cluster is hidden; the other clusters stay.

**Playing**
- Animated mark plus the title button "Show the playing song" (described in section 0).

**Transport**
- **Stop** (tooltip "Stop"). Pauses, returns to 0, or to the loop start if Loop is on, and cancels any count-in.
- **Play / Pause** (aria). Toggles.
  - If Loop is on, Play jumps to the loop start first.
  - A count-in, if set, plays before the audio.
  - If another song is being shown, Play starts the shown song instead.
- **Next** (tooltip "Play the next song in Up Next"). Disabled when Up Next is empty.
- **Record** (dot; elapsed time while recording). Disabled until recording is possible. Its tooltip changes with state:
  - "Add a recording track" (no tracks yet)
  - "Arm a track to record into"
  - "The armed track's input isn't ready"
  - "Recording needs the song loaded"
  - "Recording needs 1.00x speed" (disabled at any other speed)
  - "Record"
  - "Stop recording"
  - "Saving…"
  - after 10 s: "Still saving. Click to stop; what arrived stays as unfinished."

  Recording rules:
  - Starting from a stop counts in at least 1 bar, or the count-in setting if larger. The beats left show large over the lanes.
  - Stage mode shows a "REC {time}" mark.
  - A song switch mid-take finishes the take on its own song and shows a notice: "Recording stopped when you changed songs. {take} is saved in {song}." with the action "Open {song}".
  - Leaving the page mid-take asks for confirmation first.
  - A failed save shows "The take could not be saved. It is kept as unfinished."

**Position**
- **Time**: elapsed / total, in the format "00:00".
- **Loop** button (tooltip "Loop the selected position (L)", label "Loop"; active class when on).
- Static hint "Loop start/end · scroll".
- Two fields: **Loop start** and **Loop end** (group tooltip "Exact loop start / end (mm:ss.mmm or seconds)").
  - Type a time, then blur or press Enter to commit. Esc reverts.
  - Invalid input, or a span under 0.2 s, silently reverts.
  - **Wheel over a field nudges it.** Over the part *left of the decimal point* it steps 0.1 s; over the part *right of the point* it steps 10 ms. The wheel never zooms here.
  - A wheel nudge that would cross the other bound or the track edge is dropped, not clamped.
  - Any typed or wheeled change arms Loop.
  - Both fields are disabled with no track.

**Speed**
- **Fader** 0.50×–1.00×, with 11 notches; the major notches are 0.50, 0.75 and 1.00.
  - Tooltip: "Drag, scroll or use the arrow keys. Double-click to switch between 1x and your slow speed."
  - Without the pitch stage the tooltip becomes "Without the audio engine, changing the speed also changes the key."
  - Drag shows the value live and applies it 150 ms after the control is still.
  - The wheel jumps notch to notch (0.05).
  - Arrow keys step 0.01; with Shift, 0.05.
  - **Double-click toggles between 1× and the last slow speed** (default 0.75). The slow speed persists.
  - The cluster turns coral below 1×.
  - A song always opens at 1×.
- **Exact box** (aria "Exact playback speed", tooltip "Type a speed from 0.50 to 1.00").
  - Accepts "0.83", "0,83", "0.83x", "83" or "83%". A bare number of 10 or more is read as a percentage.
  - Values are clamped; non-numbers revert.

**Global key**
- **−** ("Transpose down a semitone"), the value readout (signed, "0" unlit, lit when non-zero), **+** ("Transpose up a semitone"). Range ±6.
  - The global key moves every lane *by the change*, so lanes keep their offsets from each other. Drums never move.
  - At either end the matching button disables.
- **Reset** ("Put every lane back in the original key"). Resets the global key and every lane key.
- All three are disabled when transpose is unavailable; the reason shows as a tooltip on the group.

**Export Mix** (split button with a menu)
- The button label becomes "Exporting…" while busy.
- Menu (aria "Export options"), in order:
  1. Format radio: **WAV | MP3 | FLAC | OGG | MP4**. MP4 is shown only for songs with a source video. Choosing MP4 hides every row except Export Mix.
  2. The video-failure message, shown only when the video could not be fetched: "MP4 export is unavailable: the video could not be fetched for this track. The audio stems are unaffected."
  3. ☐ **Include click track** (tooltip "Mix the click track into the exported file"). Disabled and unticked when there is no beat grid.
  4. ☐ **Add count-in (1 bar)** (tooltip "Prepend one bar of count-in click before the audio"). Despite the label, the length follows the count-in setting, with 1 bar when that setting is off. Audio formats only.
  5. ☐ **Master** plus a preset readout such as "−14 LUFS · −1 dBTP" (tooltip "Master the exported mix to this loudness"). Lossy formats are capped at a −1.5 dBTP ceiling. Ticking it toggles mastering on or off globally.
  6. **Export Mix**: "With the original video" is shown under it when MP4 is chosen. It exports the audible lanes with their gains, keys, EQ, master, click and count-in. If everything is muted: "All stems are muted - nothing to export."
  7. **Export All Stems** ("All stems as a .zip"). Exports the loaded stems in the chosen format, plus a click file if that box is ticked. Never EQ'd or mastered.
  8. **Export for Another Player** ("Stems, beats, lyrics and mix in one file"). Produces "{Song}.stemdeck.zip" and is format-independent.
  9. **Export Current Region**. aria-disabled unless Loop is on with a valid span.
- Menu behaviour:
  - Ticking a checkbox does not close the menu.
  - ↓ on the button opens the menu and focuses the first row; ↑/↓ cycles rows; Esc closes and refocuses the button.
  - The menu cannot be reopened mid-export.
  - On desktop the busy state starts only after the save dialog is confirmed; cancelling the dialog changes nothing.
  - A failure shows "Export failed." (or the server's message) and a notification.

**Footer timeline** (bottom strip)
- Tick labels, a whole-song waveform and a scrub bar (role slider, aria "Seek").
- Mouse-down and drag to seek.
- Its tick density stays the same when the lanes zoom.

---

## 6. Inspector (right panel)

Tabs: **Tempo | Up Next (count badge) | Details | EQ**. ←/→ move between tabs. The last tab is remembered; the default is Tempo.

### 6a. Tempo
**Tempo card**: the label "Tempo", a source chip ("Detected" / "Your tempo"), and the readout "{bpm} BPM". The readout shows the tempo actually being clicked.

**Tempo mode** radio: **Constant tempo** / **Follow the band**.
- Help text for Constant: "One tempo for the whole song…"
- Help text for Follow: "The click follows the band as it speeds up and slows down…"
- Switching to Constant fills in the BPM and beat 1 if they are missing.

**BPM row**
- **−** ("Slower by 0.1 BPM"), number field (30–300, step 0.1), **+** ("Faster by 0.1 BPM").
- A "Detected {value}" chip with a reset icon (tooltip "Back to the detected value"). Shown only when this field is user-set; clicking it resets the field.
- **Enabled only in Constant mode.**

**Tool grid**
- **Tap** ("Tap along to set the tempo").
  - Needs at least 2 taps; uses the last 8.
  - A gap of more than 2 s starts a new series.
  - The result commits 0.7 s after the last tap.
  - Constant mode only.
- **÷2 / ×2** ("Half time" / "Double time").
  - In Constant mode they halve or double the BPM, disabled if the result would leave the range.
  - **In Follow mode they change only the click rate**, toggle (aria-pressed) and save nothing.
- **−10 ms** ("Move the grid 10 ms earlier") / **+10 ms** ("…later"). Constant mode only. The shift wraps by a bar.
- **Beat 1 here** ("Make the playhead beat 1 of a bar"). Available in both modes.

**Beat 1 row**: the value, shown as "{n} s" with 3 decimals, plus its Detected chip.

**Beats per bar** (1–32) plus its Detected chip.
- Changing it also resets the click accent to Auto.
- **When bars were edited in the grid, the field is read-only** (tooltip "Bars were edited in the grid. Change them there, or reset the grid to use this field.") and is empty if bars have mixed lengths.

**Accent-override note**, shown when the click's accent differs from the grid:
- "Click accents every {accent} beats, grid has {bar}."
- "…from the first beat, which doesn't match the grid's bar lines."
- "Click accents are off, so they don't mark the grid's bar lines."

Each comes with a **Use Auto** button.

**Status line**: "The tempo could not be saved. Showing what is saved." or "Not saved yet".

**Reset to detected** (tooltip "Go back to the detected tempo, beat 1 and meter"). Disabled until something is edited.

**Click track block** (label "Click track")
- **Click toggle** (icon only; tooltip "Click track (K)", aria "Click track", pressed state).
- **Click volume** (button tooltip "Click volume: {pct}"). Opens a vertical fader popover, 0–100% in 5% steps, default 60%.
- **Count-in** select (tooltip "Bars of click before the song starts when you press play. Plays even with the click track off."). Options:
  - Count-in: off
  - Count-in: 1 bar
  - Count-in: 2 bars
  - Count-in: 3 bars
  - Count-in: 4 bars

  The caption "Plays even with the click track off" sits under it. The select is tinted when the count-in is on.
- **Accent** select (aria changes with state). Options:
  - **Auto** (label "Auto · {beats}" for a single meter, "Auto (none found)" disabled when the grid has no bars)
  - Off
  - 2/4, 3/4, 4/4, 5/4, 6/8, 7/8, 9/8, 12/8
  - Custom...

  The select is tinted when it overrides the grid.
- **Custom number** (1–32, "Beats between accents"). Shown only for Custom...; an invalid entry becomes 4.
- **Groups** field (placeholder such as "3+2+2"; tooltip "How the bar divides, e.g. 3+2+2. Blank uses the usual grouping for the meter.").
  - Shown only for meters of 5 or more.
  - A grouping that does not sum to the meter is refused, with the warning "A grouping has to add up to {beats}." for 2.6 s.
- **Grid** button ("Edit the beat grid", pressed state). Opens the beat grid editor.
- **Sound** select (tooltip "Click sound"): "Sound: Classic" (default), "Sound: Woodblock", "Sound: Rimshot", "Sound: Soft", "Sound: Cowbell".
- **Note line**, for example:
  - "Clicking {bpm} BPM, accenting every {n} beats."
  - "…accenting {beats}/4 from the detected downbeat."
  - "…accenting {count} detected meter regions."
  - "…counting {n} in {groups} (stress on …)."
  - "Clicking {bpm} BPM."

  A "… Beat unsure." suffix appears in warning colour when beat confidence is under 60%. The note's tooltip reads "Use ÷2 or ×2 in the Tempo tab if the click feels half or double speed."
- With no grid, every option is greyed and inert. All click settings persist.

### 6b. Up Next
- **Now playing**: thumbnail and title/duration, or "Nothing is open".
- **Up next** header with **Save as setlist** (shown when there is anything to save) and **Clear**. Clear has no confirmation and is hidden when the list is empty.
- **Rows**: index, thumbnail, title and duration in one button (tooltip "Play now"), plus **×** ("Remove from Up Next").
  - Clicking a row plays it and drops everything queued before it.
  - Rows are draggable to reorder.
  - **Alt+↑/↓** moves the focused row.
  - Rows use roving focus with the arrow keys.
- **Empty state**: "Up Next is empty" / "Press + on a song in the library to play it after this one."
- Trashed songs leave the list permanently.
- The tab badge shows the count.

### 6c. Details
**Figure cards**, each with a hover explanation and keyboard focus:
- **Key**: for example "B minor", plus a confidence ring. Its tooltip is "How sure the analysis is of this key: {value}%".
- **BPM**.
- **LUFS**, with a "Peak {value} dB" sub-line.
- **Duration**.
- **Dynamic Range**, with a sub-label: Compressed under 7, Moderate under 10, High under 14, otherwise Wide.
- **Tempo Stability** as a percentage, with a sub-label: Very Stable from 90, Stable from 70, Moderate from 50, otherwise Variable. 80 and above is highlighted.

**Presence cards**:
- Global Vocals, Drum Intensity, Bass Depth, Guitar Presence, Piano Presence, Other.
- Each shows a percentage of the loudest instrument, or "—" when the instrument is absent.
- After a split, Global Vocals is replaced by **Lead Vocals** and **Backing Vocals**.

**Lead and backing vocals card**
- Shown for a finished song with a vocals stem that has not been split yet, or after a cancel or error.
- Button **Split lead/backing**, which becomes **Try again** after an error.
- While running: "Waiting for an import to finish…" or "Splitting lead and backing vocals…", a progress bar with a percentage, and **Cancel**.
- When the split finishes, the song reloads with the new lanes.
- Errors:
  - "The vocal split model couldn't be loaded. Try again."
  - "There was not enough memory to split the vocals. Close other apps, then try again."
  - "This computer's graphics chip cannot run the vocal split."
  - "The disk is full. Free up some space, then try again."
  - "The vocal split stopped responding. Try again."
  - "This song's vocals are missing. Extract its stems again, then try again."
  - "The vocal split finished without lead and backing vocals. Try again."
  - "The vocals could not be split. Try again."

**File card**
- "{n} stems" · **Format** {WAV/MP3…} · **Extracted** {just now / N min ago / N h ago…}.
- Format is hidden when it is not read from the file: there is no guessed "High" or "MP3".

**Source** (link imports)
- The link text, with **Copy link** (tooltip changes to "Link copied" for 1.5 s) and **Open link** (opens a new tab).
- File imports show the file name only.

### 6d. EQ
**Scope radio**: [● {lane name}] | **Master**. ←/→/↑/↓ switch between them. Pick a lane with its EQ mark in the mixer.

**Lane view**
- Title by lane: Parametric EQ, Bass EQ, Guitar EQ or Keys EQ. Drums get the graph.
- **Power** ("EQ on" / "EQ off"). Bypass keeps the settings.
- **Graph** (vocals, drums, other, original):
  - drag a point to set frequency and gain;
  - wheel on a point sets its width (Q), finer with Shift;
  - **double-click empty space adds a band; double-clicking a band removes it**;
  - focused band: arrow keys step it, Delete or Backspace removes it.
  - Readout: band number, type (Bell, Low shelf, High shelf, Low cut, High cut, Notch, Band pass, Tilt), frequency, gain and Q.
- **Pedal knobs** (bass, guitar, piano): **Low**, **Mid**, **High**, **Presence**.
  - Drag up or down; Shift is finer.
  - Arrow keys step.
  - Double-click returns to 0 dB.
- **Suggest**: plays a fitted EQ immediately. While a suggestion is pending:
  - a "Suggested" bar shows **Undo** and **Apply**;
  - a legend shows "Target" and "Before";
  - the controls, knobs and power are locked;
  - Suggest and Flat are hidden.

  A suggestion is dropped if the lane or song changes. Errors: "Not enough sound here to suggest an EQ." / "Suggest didn't work. Try again." / "Couldn't suggest for this lane."
- **Flat**: resets the lane.

**Master view**
- **Master EQ** graph, with its own power button.
- **Glue** slider (0–100%) and a **GR** meter. Glue is disabled when mastering is off.
- **Export loudness** radio: **Streaming** (−14 LUFS) / **Loud** (−9 LUFS, glue at 50%) / **Off**.
- **Target** {value} LUFS.
- **Ceiling**: −/+ buttons ("Lower ceiling" / "Raise ceiling") in 0.1 dB steps, range −3 to −0.1 dBTP. Changing it makes the preset custom.
- Meters: **Now, LUFS** and **Gain at export** (show "…" while measuring).
- "Live preview is approximate" (shown when mastering is on).
- **Suggest** (Undo / Apply; also sets the preset) and **Flat**.
- Error: "Couldn't suggest for this mix."

---

## 7. Lyrics pane

The pane is in the **left sidebar's Lyrics view** (rail button), not the inspector. It has no search box.

**Statuses**
- "Open a track to find its lyrics."
- "This track has no artist or song tags. Save its band with the ⓘ button…"
- "Searching LRCLIB for “{song}”…"
- "No lyrics found for “{song}”."
- "Could not reach LRCLIB…", with a way to retry in place.
- "Could not look up lyrics right now…"
- "This version is marked instrumental…"
- "This song is on LRCLIB, but not in a version the same length… Pick the right one:", followed by a list of candidates.
- "Lyrics removed for this track.", with **Look up again**.
- "Could not keep these lyrics." / "Could not remove the lyrics."

**Match header**: the track, then artist · album · "From the file" / "Transcribed" / "Your lyrics".

**Toolbar** (aria "Lyrics actions"). Exactly one button is styled as primary, chosen in this priority: Sync lines (if enabled), Edit lines, Transcribe, Paste. Quiet buttons go last. The DOM order is **(inferred)** for the final visual order:
- **Other versions ({count})** / **Hide other versions** (quiet).
- **Sync lines** (tooltip "Set when each line starts…"; disabled with "Only lyrics with timing can be synced line by line. These are text only.").
- **Align** (tooltip "Align lyrics to track"; disabled with "Only synced lyrics can be aligned…").
- **Transcribe lyrics**: offered when there are no lyrics and the setting allows it.
  - Note: "Transcribing on the CPU can take a few minutes."
  - Phases: "Waiting for an import to finish…" / "Downloading the lyrics model…" / "Loading the lyrics model…" / "Transcribing lyrics…", with a bar and a **Cancel** button.
  - Outcomes: "There is too little singing in this track to transcribe." / "The lyrics could not be transcribed."
- **Edit lines** ("Correct the words: edit, add, delete or split lines"). Shown only when there are lines.
- **Paste or load lyrics** ("Use your own lyrics for this track: paste them or load an .lrc or .txt file").
- **Remove lyrics** (quiet). For the user's own lyrics this becomes **Back to original** ("Drop your lyrics and return to the ones they replaced"), or stays Remove lyrics if nothing was replaced.

**Lines**
- **Single click on a synced line seeks** there and releases focus, so Space goes back to Play/Pause.
- The sung line fills word by word, following the vocals envelope; the next line is raised.
- Untimed lines are flagged "needs timing", with a note "Lines needing timing: {n}" or "These lyrics have no timing yet." and a **Sync line by line** link.

**Align panel**
- Hint text.
- **Start lyrics here** ("Move the line named below to the playhead"). It moves the first line, or the line you clicked:
  - "Moves the first line: “…”"
  - "Moves the line you clicked: “…”"
- Offset readout "{offset} s", with nudge buttons ("Earlier by…" / "Later by…").
- **Auto-detect** ("Checking the vocals…" → "Moved to fit the vocals: {offset} s." / "Could not tell from the vocals…" / "Auto-detect is not available…").
- **Reset** ("Back to the lyrics' own timing").
- **Done** ("Close the panel. Changes are already saved.").
- **Sync line by line**.
- Esc closes the panel back onto Align.
- If the lines are timed per line, the offset does not apply and a note says so.

**Sync lines panel**
- Header "Sync lines", a kind chip ("Timed by you" / "Timed from the vocals" / "Their own timing" / "Estimated timing"), and a save state ("Saving…" / "Saved").
- "Next to tap · line {n} of {count}" or "All lines tapped / Undo, or click a line to go on from it."
- **Tap** (with the key hint "T / Enter").
- **Undo** ("Undo the last change (Backspace)").
- Checkboxes:
  - **Lead-in**: a line click puts the playhead 2 s before the line.
  - **Snap to voice**: Alt frees a drag.
  - **Move later lines too**.
- **Re-time from vocals** ("Listening to the vocals… {pct}%" → "Timed from the vocals: {m} of {n} lines matched." / unsure / failed).
- **Reset to detected**; if there is nothing to reset to: "There is no detected timing to go back to. Try Re-time from vocals."
- **Reset to original**, disabled for plain text.
- Key legend: "T or Enter: tap · Backspace: undo · ← →: nudge (Shift: more) · ↑ ↓: line · Esc: done".
- **Done**.
- **Per-line tools** under the selected line: −0.25, −0.05, +0.05, +0.25 s, and **Start at playhead**.
- Leaving the Lyrics view leaves Sync lines and hides the lane.

**Edit lines editor**
- One textarea per line ("Line {n}"), with row buttons: **Split this line at the cursor**, **Add a line below**, **Delete this line**.
- **Add line**, **Cancel**, **Save** ("Saving…").
- Enter splits a line at the cursor, except while an input method is composing.
- An unsaved draft is kept per track when you switch songs: "Your unsaved changes for this track were kept."

**Paste or load editor**
- "Your own lyrics" / "Paste the words, or load an .lrc or .txt file."
- A textarea "Paste lyrics here", **Load file**, Cancel, Save.
- Errors:
  - "Too long…"
  - "Only .lrc and .txt files can be loaded."
  - "…not UTF-8 text…"
  - "Could not read this file."
  - "This file is empty…"
  - a network error
  - "(error {status})"
- Status: "Loaded “{name}”. Save to use it."

---

## 8. Stage mode

Stage is a full-window overlay over the lanes. It hides the top bar, sidebar, inspector and the footer's Transport cluster. It always shows the **playing** song, not a song being shown over it. Focus goes to Play on entering and back to the Stage button on exit.

**Top bar**
- Title, artist, and the extracting label.
- REC mark "REC {time}".
- **Mix** (tooltip "Show or hide the mixer", pressed state; persisted).
- **Add to Up Next** (+).
- **More** (…): the same menu as the song head (no Rename), acting on the playing song. Stage stays open.
- **Stage view** radio: **Play along** / **Sing along**. Arrow keys switch. The choice persists.
- **Exit stage** (tooltip "Back to the studio (Esc)").

**Centre (Play along)**
- Current section name.
- Beat dots: one per beat of the bar, with the downbeat marked. No dots without a grid.
- Lyric line and next line, when there are timed lyrics.
- Facts: **Tempo** ("{bpm} BPM", the tempo being clicked) and **Next** ("{name} in {time}" / "Last section" / "—").

**Song overview**
- Section blocks (current one marked). **Click a block to seek** to its start (inferred from its `data-start`).
- Elapsed time, waveform with playhead (**click to seek**), total time.

**Transport**
- **Stop**, **Play/Pause**, **Next** (disabled when Up Next is empty).

**Mix panel**: one strip per loaded stem, each with name, dB value, a vertical fader, **M** and **S**. It is two-way bound to the studio mixer.

**Sing along**
- Hides the mixer and the overview.
- "Vocals in" countdown before the first line.
- Four lyric lines (past, now, near, far); the current line fills word by word.
- **Voice** switch (role switch, default off). Silences the vocals for this song without changing the saved mix. Remembered per song.
- **Backing** switch (default on when split). Disabled with the tooltip "Split the vocals in the studio first" when there is no split.
- **No lyrics**: "No lyrics for this song" / "These lyrics aren't timed", with **Transcribe lyrics** (only when there are no lyrics) and **Open lyrics** (leaves Stage for the Lyrics view).
- **Up Next chip** (count and next title). Opens a side panel that borrows the studio's Up Next list:
  - **Clear**, **Close Up Next**, **Save as setlist**;
  - hint "Alt ↑ ↓ Move".
- **Song-end handoff**: "Up next" with title and artist, a 5-second ring countdown "Starts in {time}", **Play now** and **Stay here**.
  - Esc means Stay here.
  - A seek cancels the countdown.
  - Switching to Play along mid-countdown advances to the next song.

**Keys**
- **F** toggles Stage.
- **Esc**, in order: dismisses the handoff, then closes the Up Next panel, then exits Stage.
- Keys are ignored while a text field is focused, the beat grid editor is open, or a modal is open.

---

## 9. Media session (OS controls)
- Shows title, artist, album and cover.
- **Play** / **Pause**. The play key during a count-in cancels it.
- **Stop**.
- **Seek to** (scrubbing from the OS).
- **Seek backward / forward**: 5 s **(inferred)** from the shared constant.
- **Previous** restarts the song, or goes to the loop start if Loop is on, keeping the play or pause state. Available only with a song open.
- **Next** plays the first song in Up Next. Available only when Up Next has songs.
- Closing the song clears the OS display.

---

## 10. Keyboard shortcuts (studio)

**Global keys** (`main.js`, `onStudioShortcutKey`). These are ignored while a modifier is held or a text field, select or editable element has focus.

| Key | Action |
|---|---|
| Space | Play/Pause (plays the shown song if one is shown) |
| `[` / `]` | Seek −5 s / +5 s |
| L | Loop on/off |
| K | Click on/off (also closes the grid editor) |
| R | Record start/stop (key repeat ignored) |
| I / O | Set loop start / end at the playhead (**only while Loop is on**; keeps ≥0.5 s) |
| F | Stage mode toggle (`stageMode.js`) |

**Context keys**

| Context | Keys |
|---|---|
| Stage | Esc: handoff → Up Next panel → exit |
| Beat grid editor | Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo, Esc close |
| Sync lines (captured before other handlers) | T/Enter tap, Backspace undo, Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y, ←/→ nudge 0.05 s (Shift 0.25 s), ↑/↓ line, Esc done |
| Inspector tabs | ←/→ |
| EQ | Scope: arrows. Band: arrows step, Delete/Backspace remove. Knob: arrows |
| Up Next | Alt+↑/↓ reorder; arrow-key roving rows |
| Export menu | ↓ open/enter, ↑/↓ cycle, Esc |
| … menu, input menu, track menu | ↑/↓, Esc |
| Click volume popover | Esc |
| Speed fader | arrows ±0.01, Shift+arrows ±0.05 |
| Loop fields, section rename, song rename | Enter commit, Esc cancel |

---

## Things I could not determine

1. The exact arrow-key mapping and step sizes for a focused EQ graph band (which arrow moves frequency and which moves gain; Shift = fine). I saw only `keyStep(band, key, fine)`.
2. How large the EQ pedal-knob keyboard step and drag sensitivity are (`KNOB_KEY_STEP_DB` value not read).
3. The complete phrase list for the wave-loading overlay and the job progress box (`job.js` `pickPhrase`), and the job box's full states. Those belong to the import area.
4. What the **About this song** (ⓘ) dialog contains (`artistInfo.js`); it was not read.
5. The visual order of the Lyrics toolbar buttons is partly inferred: CSS gives quiet buttons `order:1`, but the effect of the `.lyrics-tools-own` wrapper's display type on that ordering was not checked.
6. Whether the footer scrub bar has any keyboard control. It is `role="slider"` with `tabindex=0`, but I found only mouse handlers, so it looks keyboard-dead.
7. Whether the hidden lane **drag handle** and **Solo only** monitor buttons are reachable anywhere in the desktop studio. CSS hides them outside `.is-import`, and I found no lane-reorder logic.
8. The behaviour of the Stage overview's section-block click beyond seeking to its start (inferred from `data-start`; the handler body was not read).
9. The Transcribe availability rules beyond "a setting" and "no lyrics" (server-side `available` flag).
10. Whether MP4 shows for YouTube-imported songs: a CSS comment says "mp4 upload or YouTube", but `.has-video` is set by server data I did not trace.
11. Mobile/phone UI variants (`mobile-*` specs) were out of scope and not inventoried.

**Copy mismatches between `index.html` and English i18n.** The i18n string wins at runtime, so these may matter for the prototype's copy:
- Up Next empty hint: the HTML says "Choose Add to Up Next from a song's … menu in the library."; users see "Press + on a song in the library to play it after this one."
- Exit stage tooltip: the HTML says "Exit stage (Esc)"; users see "Back to the studio (Esc)".
- Accent Auto option: the HTML says "Auto (detected)"; users see "Auto" or "Auto · {n}".
- Meta labels are uppercase in the HTML ("KEY", "DYNAMIC RANGE") and title case in i18n ("Key", "Dynamic Range"). CSS probably uppercases them.
- The help text for the open song's More menu says "Add this song to a setlist, or move it to a folder" and does not mention Extract more stems / Stop extracting.