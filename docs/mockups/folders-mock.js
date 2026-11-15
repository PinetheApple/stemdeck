// Shared drawing for the folder mockups (#208, #209): the library pane's real
// markup (catalog.js renderFolder/renderTrackItem, setlists.js setlistGroup,
// trackMenu.js menus), filled from fixed sample data. A classic script so the
// pages also open straight from disk.
(function folderMock() {
  const PATHS = {
    play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    trash: '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    listPlus: '<path d="M16 5H3"/><path d="M11 12H3"/><path d="M16 19H3"/><path d="M18 9v6"/><path d="M21 12h-6"/>',
    listMusic: '<path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    folderPlus: '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  };
  const NOTE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
  const FOLDER_SVG = '<svg class="f-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
  const CHEVRON_SVG = '<svg class="f-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"></polyline></svg>';
  const GRIP = '<span class="f-grip" title="Drag to reorder"><svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg></span>';
  const SUBFOLDER_BTN = '<button class="f-subfolder" type="button" aria-label="New subfolder" title="New subfolder"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14h6"/></svg></button>';
  const DELETE_BTN = '<button class="f-del" type="button" aria-label="Delete folder" title="Delete folder"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg></button>';

  /** Which hover controls a folder row carries, per design under review. */
  const ROW_TOOLS = {
    current: () => SUBFOLDER_BTN + DELETE_BTN,
    menu: (f) => `<button class="f-more" type="button" aria-haspopup="menu" title="More" aria-label="More for ${esc(f.name)}">${icon("more")}</button>`,
    pencil: (f) => SUBFOLDER_BTN + `<button class="f-rename" type="button" title="Rename" aria-label="Rename ${esc(f.name)}">${icon("pencil")}</button>` + DELETE_BTN,
    setlist: (f) => SUBFOLDER_BTN + `<button class="f-setlist" type="button" title="Make a setlist" aria-label="Make a setlist from ${esc(f.name)}">${icon("listPlus")}</button>` + DELETE_BTN,
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  function icon(name, { filled = false } = {}) {
    const cls = filled ? "ic ic-fill" : "ic";
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
  }

  function songRow(song, { playing = false, selected = false } = {}) {
    const classes = ["cat-item", playing && "active", selected && "is-selected"].filter(Boolean).join(" ");
    return `<div class="${classes}" data-id="${song.id}" role="listitem" tabindex="-1">
      <div class="cat-thumb">${NOTE_SVG}<button class="row-play" type="button" tabindex="-1" title="Play ${esc(song.title)}">${icon("play", { filled: true })}</button></div>
      <div class="cat-meta">
        <div class="cat-title">${esc(song.title)}</div>
        <div class="cat-sub"><span>${esc(song.artist)}</span> <span class="dot">·</span> <span>${song.time}</span></div>
      </div>
      <div class="cat-status"></div>
      <div class="cat-actions"><button class="cat-upnext" type="button" title="Up next">${icon("listPlus")}</button><button class="cat-more" type="button" title="More">${icon("more")}</button></div>
    </div>`;
  }

  /** f: { id, name, color, songs, children, system, collapsed, tools, hover, focus, selected, inline, playing } */
  function folderEl(f) {
    const headClass = ["folder-head", f.system && "system", f.hover && "mock-hover", f.focus && "mock-focus", f.selected && "mock-selected"]
      .filter(Boolean).join(" ");
    const name = f.inline
      ? `<input class="rename-input f-name-input" type="text" maxlength="100" value="${esc(f.inline)}" aria-label="Folder name" autocomplete="off" spellcheck="false">`
      : `<span class="f-name">${esc(f.name)}</span>`;
    const tools = f.system || f.inline ? "" : ROW_TOOLS[f.tools || "current"](f);
    const body = f.songs.length || f.children?.length
      ? f.songs.map((s) => songRow(s, { playing: s.id === f.playing })).join("") + (f.children || []).map(folderEl).join("")
      : '<span class="folder-empty">Empty folder</span>';
    return `<div class="folder${f.collapsed ? " collapsed" : ""}${f.subfolder ? " subfolder" : ""}" data-id="${f.id}">
      <div class="${headClass}" style="--folder-color: ${f.color};" tabindex="-1">
        ${f.system ? "" : GRIP}${CHEVRON_SVG}${FOLDER_SVG}${name}<span class="f-count">${f.count ?? f.songs.length}</span>${tools}
      </div>
      ${f.error ? `<p class="setlists-error mock-row-error" role="alert">${esc(f.error)}</p>` : ""}
      <div class="folder-body">${body}</div>
    </div>`;
  }

  function songsView(folderList) {
    return `<div class="lib-section"><div class="lib-section-head">Stem Collections<button id="newFolderBtn" class="new-folder-btn" type="button"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v6 M9 14h6"/></svg>New Folder</button></div>
      ${folderList.map(folderEl).join("")}</div>`;
  }

  function setlistSong(song, index, last) {
    const sub = song.trashed ? "In the Trash" : song.artist;
    return `<li class="setlist-song${song.trashed ? " in-trash" : ""}" data-id="${song.id}" tabindex="-1">
      <span class="setlist-song-open"><span class="setlist-song-index num">${index + 1}</span>
        <span class="setlist-song-thumb"><span aria-hidden="true">${esc(song.title.charAt(0))}</span><button class="row-play" type="button" tabindex="-1">${icon("play", { filled: true })}</button></span>
        <span class="setlist-song-text"><span class="setlist-song-title">${esc(song.title)}</span><span class="setlist-song-sub">${esc(sub)}</span></span></span>
      <span class="setlist-song-actions">
        <button type="button" class="setlist-icon-btn setlist-song-up"${index === 0 ? " disabled" : ""}>${icon("up")}</button>
        <button type="button" class="setlist-icon-btn setlist-song-down"${last ? " disabled" : ""}>${icon("down")}</button>
        <button type="button" class="setlist-icon-btn setlist-song-remove">${icon("x")}</button>
      </span></li>`;
  }

  /** s: { id, name, songs, makeFolder, selected } */
  function setlistGroup(s) {
    const count = `${s.songs.length} ${s.songs.length === 1 ? "song" : "songs"}`;
    const makeFolder = s.makeFolder
      ? `<button type="button" class="setlist-icon-btn setlist-make-folder" title="Make a folder" aria-label="Make a folder from ${esc(s.name)}">${icon("folderPlus")}</button>`
      : "";
    const songs = s.songs.length
      ? `<ol class="setlist-songs">${s.songs.map((song, i) => setlistSong(song, i, i === s.songs.length - 1)).join("")}</ol>`
      : '<p class="setlist-empty">No songs yet. Add them from a song\'s … menu.</p>';
    return `<section class="setlist${s.selected ? " mock-selected" : ""}" data-id="${s.id}">
      <div class="setlist-head${s.selected ? " mock-selected" : ""}" tabindex="-1">
        <span class="setlist-name" title="${esc(s.name)}">${esc(s.name)}</span>
        <button type="button" class="setlist-play" title="Play ${esc(s.name)} from the top">${icon("play", { filled: true })}<span>Play</span></button>
        <span class="setlist-count num">${count}</span>
        <span class="setlist-tools"><button type="button" class="setlist-icon-btn setlist-rename" title="Rename ${esc(s.name)}">${icon("pencil")}</button>${makeFolder}<button type="button" class="setlist-icon-btn setlist-delete" title="Delete ${esc(s.name)}">${icon("trash")}</button></span>
      </div>${songs}</section>`;
  }

  function railButton(cls, label, path, active = false) {
    return `<button class="rail-btn ${cls}${active ? " active" : ""}" type="button" title="${label}" aria-label="${label}"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg><span>${label}</span></button>`;
  }

  /** index.html's app shell, reduced to the rail, the library pane and an empty studio. */
  function mountShell() {
    const rail = [
      railButton("rail-collapse", "Toggle library", '<rect width="18" height="18" x="3" y="3" rx="2" /> <path d="M9 3v18" />').replace("<span>Toggle library</span>", ""),
      railButton("rail-favorites", "Favorites", '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" />'),
      railButton("rail-library", "Library", '<path d="m16 6 4 14" /> <path d="M12 6v14" /> <path d="M8 8v12" /> <path d="M4 4v16" />', true),
      railButton("rail-lyrics", "Lyrics", '<path d="m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12" /> <path d="M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5" /> <circle cx="16" cy="7" r="5" />'),
      railButton("rail-trash", "Trash", PATHS.trash),
      '<div style="flex:1"></div>',
      railButton("", "Settings", '<circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />'),
    ].join("");
    document.getElementById("mockRoot").innerHTML = `<div class="app daw" id="app"><div class="daw-body"><div class="daw-panes">
      <aside class="sidebar" id="catalogPanel">
        <nav class="sidebar-rail" aria-label="Library navigation">${rail}</nav>
        <div class="sidebar-body">
          <div class="daw-search" id="catalogToggle" role="button" tabindex="0"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="catalogSearch" type="search" placeholder="Search or #tag…" autocomplete="off" spellcheck="false"><span class="search-kbd" aria-hidden="true">⌘K</span></div>
          <div class="lib-tabs" role="tablist" aria-label="Library">
            <button class="lib-tab" id="libTabSongs" type="button" role="tab" aria-selected="true"><span>Songs</span><span class="lib-tab-count num" id="libSongsCount">0</span></button>
            <button class="lib-tab" id="libTabSetlists" type="button" role="tab" aria-selected="false"><span>Setlists</span><span class="lib-tab-count num" id="setlistsCount">0</span></button>
          </div>
          <div id="catalogList" class="daw-lib-list" role="list"></div>
          <section class="lib-setlists" id="setlistsPanel" role="tabpanel">
            <div class="setlists-list" id="setlistsList"></div>
            <div class="lib-setlists-empty lib-empty" id="setlistsEmpty"><strong>No setlists yet.</strong></div>
            <button class="setlist-new-btn" id="setlistNewBtn" type="button">${icon("listPlus")}<span>New setlist</span></button>
          </section>
        </div>
      </aside>
      <div class="library-resizer" id="libraryResizer" role="separator"></div>
      <div class="daw-main-col"><div class="daw-main mock-studio"></div></div>
    </div></div></div>`;
  }

  /** Draw the pane: `view` is "songs" or "setlists". */
  function drawLibrary({ view = "songs", folders = [], setlists = [], songCount }) {
    const panel = document.getElementById("catalogPanel");
    panel.classList.toggle("setlists-view", view === "setlists");
    document.getElementById("libTabSongs").setAttribute("aria-selected", String(view === "songs"));
    document.getElementById("libTabSetlists").setAttribute("aria-selected", String(view === "setlists"));
    document.getElementById("libSongsCount").textContent = String(songCount);
    document.getElementById("setlistsCount").textContent = String(setlists.length);
    document.getElementById("catalogList").innerHTML = songsView(folders);
    document.getElementById("setlistsList").innerHTML = setlists.map(setlistGroup).join("");
    document.getElementById("setlistsEmpty").hidden = setlists.length > 0;
  }

  /** item: { text, icon, danger, separator }. Placed beside the row, as trackMenu.js placeMenu does. */
  function openMenu(anchorRow, items, label) {
    const menu = document.createElement("div");
    menu.className = "lib-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", label);
    menu.innerHTML = items.map((item) => (item.separator
      ? '<div class="lib-menu-sep" role="separator"></div>'
      : `<button type="button" class="lib-menu-item${item.danger ? " is-danger" : ""}" role="menuitem">${icon(item.icon)}<span>${esc(item.text)}</span></button>`)).join("");
    document.body.append(menu);
    const row = anchorRow.getBoundingClientRect();
    const gap = 4;
    menu.style.left = `${row.right + gap}px`;
    menu.style.top = `${row.top}px`;
    anchorRow.querySelector(".f-more")?.setAttribute("aria-expanded", "true");
    return menu;
  }

  /** The folder editor dialog as catalog.js openFolderEditor draws it, plus optional extra fields. */
  function openDialog({ title, name, color, colors, message = "", extraHtml = "", saveText = "Save", showColors = true }) {
    const dots = colors.map((c, i) => `<button class="folder-color-dot${c === color ? " active" : ""}" type="button" style="--folder-color: ${c};" aria-label="Set folder color ${i + 1}" aria-pressed="${c === color}"></button>`).join("");
    const overlay = document.createElement("div");
    overlay.className = "folder-editor-backdrop";
    overlay.innerHTML = `<form class="folder-editor" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="folder-editor-head"><span>${esc(title)}</span><button class="folder-editor-close" type="button" aria-label="Close"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg></button></div>
      <label class="folder-editor-field"><span>Name</span><input class="folder-editor-name" type="text" maxlength="100" autocomplete="off" spellcheck="false"></label>
      ${showColors ? `<div class="folder-editor-field"><span>Color</span><div class="folder-editor-colors" role="group" aria-label="Folder color">${dots}</div></div>` : ""}
      ${extraHtml}
      <div class="folder-editor-msg" role="alert" aria-live="polite">${esc(message)}</div>
      <div class="folder-editor-actions"><button class="folder-editor-cancel" type="button">Cancel</button><button class="folder-editor-save" type="submit">${esc(saveText)}</button></div>
    </form>`;
    document.body.append(overlay);
    const input = overlay.querySelector(".folder-editor-name");
    input.value = name;
    input.focus();
    input.select();
    return overlay;
  }

  /** The ?state= link bar; marks the current one. */
  function stateBar(states, current) {
    const bar = document.querySelector(".mock-states");
    bar.innerHTML = states.map(([id, label]) => `<a href="?state=${id}"${id === current ? ' aria-current="page"' : ""}>${esc(label)}</a>`).join("");
  }

  function currentState(fallback) {
    return new URLSearchParams(location.search).get("state") || fallback;
  }

  const FOLDER_COLORS = ["#ff6f59", "#e85f6f", "#64c86f", "#4f9de8", "#a985f4"];
  const song = (id, title, artist, time, extra = {}) => ({ id, title, artist, time, ...extra });
  const SONGS = {
    neon: song("neon", "Neon Rivers", "Kalla Moss", "04:12"),
    paper: song("paper", "Paper Lanterns", "The Quiet Hours", "03:27"),
    hold: song("hold", "Hold the Line", "Marlow Grey", "03:58"),
    glass: song("glass", "Glass Harbour", "June Okafor", "04:41"),
    burn: song("burn", "Slow Burn", "Tide & Timber", "05:06"),
    north: song("north", "Northbound", "The Quiet Hours", "03:33"),
    still: song("still", "Still Water", "Marlow Grey", "04:20"),
    last: song("last", "Last Light", "June Okafor", "03:49"),
    demo: song("demo", "Old Demo", "Kalla Moss", "02:58", { trashed: true }),
  };
  const PLAYING_ID = "glass";

  /** A fresh copy of the sample library each call, so a state can change it freely. */
  function sampleLibrary() {
    const S = SONGS;
    const ballads = { id: "f-ballads", name: "Ballads", color: FOLDER_COLORS[4], songs: [S.still, S.last], subfolder: true, playing: PLAYING_ID };
    return {
      songCount: 13,
      folders: [
        { id: "f-unsorted", name: "Unsorted", color: FOLDER_COLORS[0], songs: [S.neon, S.paper], system: true },
        { id: "f-rehearsal", name: "Rehearsal", color: FOLDER_COLORS[3], songs: [S.hold, S.glass, S.burn, S.north], children: [ballads], playing: PLAYING_ID, count: 4 },
        { id: "f-gig", name: "Gig 14 Nov", color: FOLDER_COLORS[2], songs: new Array(5).fill(S.neon), collapsed: true },
      ],
      setlists: [
        { id: "s-friday", name: "Friday set", songs: [S.north, S.neon, S.demo, S.still] },
      ],
    };
  }

  window.FolderMock = { FOLDER_COLORS, SONGS, sampleLibrary, mountShell, drawLibrary, openMenu, openDialog, stateBar, currentState, icon, esc };
})();
