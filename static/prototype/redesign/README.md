# Desktop redesign prototype

Throwaway, clickable prototype of the desktop redesign (direction "B · Lanes"). Nothing here ships.

- `app/index.html`: the full-UI prototype. With the dev server running, open `/prototype/redesign/app/index.html`.
  Playback is faked; the library is read from `/api/jobs` when the server has songs, otherwise demo data is used.
  The strip at the top switches between states (song open, viewing another song, imports running, no song, error, offline).
  Dashed "Prototype" rows inside views switch states a real backend would produce; they are not part of the design.
- `index.html`, `a.html`, `b.html`, `c.html`, `stage.html`: the first-round layout mockups. B was chosen.
- `docs/inventory-*.md`: every control, label, state and rule of the current app, so that nothing is dropped.
- `docs/CONTRACT.md`: how the prototype's files fit together.

The font choices in Settings › Appearance need their font files in `fonts/` (not tracked); without them the
prototype falls back to the system font for those choices.
