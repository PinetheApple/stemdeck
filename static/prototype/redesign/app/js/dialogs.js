// PROTOTYPE - throwaway. Shared confirm card, About, About the song, Extract more stems and the start-up failure banner.
import { S, act, actions, update, song, viewSong, playSong, STEMS } from './store.js';
import { registerDialog, registerHook, registerIcons } from './slots.js';
import { icon, esc, logo } from './ui.js';

registerIcons({
  palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z"/>',
  wifi: '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.86a10 10 0 0 1 14 0"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/>',
  star: '<path d="M11.53 2.3a.53.53 0 0 1 .95 0l2.31 4.68a2.12 2.12 0 0 0 1.6 1.16l5.17.76a.53.53 0 0 1 .29.9l-3.74 3.64a2.12 2.12 0 0 0-.61 1.88l.88 5.14a.53.53 0 0 1-.77.56l-4.62-2.43a2.12 2.12 0 0 0-1.97 0L6.4 21.01a.53.53 0 0 1-.77-.56l.88-5.14a2.12 2.12 0 0 0-.61-1.88L2.16 9.8a.53.53 0 0 1 .29-.91l5.17-.75a2.12 2.12 0 0 0 1.6-1.16z"/>',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  'message-circle': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  instagram: '<rect width="20" height="20" x="2" y="2" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><path d="M17.5 6.5h.01"/>',
  'x-logo': '<path d="M4 4l16 16"/><path d="M20 4 4 20"/>',
  type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  'hard-drive': '<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01"/><path d="M10 16h.01"/>',
});

S.ui.dlgx = { proto: {}, about: { saved: false, more: false, query: '' }, extract: null, dataOpen: false, confirm: { typed: '', busy: false, err: '' }, restart: 'ask' };
S.ui.bootFail = false;
const X = S.ui.dlgx;
const LOOKUP_MS = 1200;
const STEP_MS = 350;
const PCT_STEP = 20;
export const VERSION = 'v0.9.4';

// ── Helpers shared by alerts.js and settings.js ──
export const later = (ms, fn) => setTimeout(() => { fn(); update(); }, ms);
export const proto = (key, fallback) => X.proto[key] ?? fallback;
export const dlgHead = (title, extra = '') => '<div class="dlg__head"><h3>' + title + '</h3>' + extra + '<button class="iconbtn" data-act="closeDialog" title="Close (Esc)">' + icon('x', 18) + '</button></div>';
/** A discreet row of switches that only exists to show states a real backend would produce. */
export const protoBar = rows => '<div class="protobar"><b>Prototype</b>' + rows.map(([key, label, opts]) => {
  const cur = proto(key, opts[0][0]);
  return '<span class="protobar__it"><span>' + label + '</span><div class="seg">' + opts.map(([v, l]) => '<button class="' + (cur === v ? 'is-on' : '') + '" aria-pressed="' + (cur === v) + '" data-act="dxProto:' + key + ':' + v + '">' + l + '</button>').join('') + '</div></span>';
}).join('') + '</div>';
act('dxProto', (ctx, key, value) => { X.proto[key] = value; });
/** Opens a dialog over the current one; Cancel, Esc and the scrim go back to it. */
export const openOver = dialog => { S.ui.dialog = { ...dialog, back: S.ui.dialog }; };
act('over', (ctx, id, arg, then) => { openOver({ id, arg, then }); X.confirm = { typed: '', busy: false, err: '' }; X.restart = 'ask'; });
act('closeDialog', () => { S.ui.dialog = S.ui.dialog?.back || null; });
const runThen = d => { if (d.then) { const [name, ...args] = d.then.split('.'); actions[name]?.({}, ...args); } };

function onKeyCapture(e) {
  const d = S.ui.dialog;
  if (!d || S.ui.menu || S.ui.pop || S.ui.error) return;
  if (e.key === 'Escape' && d.back) {
    e.stopPropagation(); e.preventDefault();
    if (d.arg === 'restart' && X.restart === 'busy') return;
    S.ui.dialog = d.back; update();
  } else if (e.key === 'Enter' && e.target.dataset?.enter) {
    e.stopPropagation(); e.preventDefault();
    const [name, ...args] = e.target.dataset.enter.split(':');
    if (actions[name]?.({ el: e.target, event: e }, ...args) !== false) update();
  }
}
addEventListener('keydown', onKeyCapture, true);

// ── Shared confirm card ──
const BUSY_TEXT = 'StemDeck is still working on a song or an import. Let it finish or cancel it, then try again.';
const RESET_ERRORS = { failed: 'Reset failed.', offline: 'Reset failed — check your connection.', busy: BUSY_TEXT };
const CONFIRMS = {
  reset: { title: 'Reset app data?', body: 'This permanently deletes every track, job, and library entry. On a shared server this affects everyone who uses it. This cannot be undone.', ok: 'Reset app data', danger: true, typed: 'RESET' },
  reimport: { title: 'Import this song again?', body: "Its files are no longer on this computer. Importing downloads it again and stops what's playing.", ok: 'Import again', focusCancel: true },
  deleteTrack: { title: 'Delete this track?', body: 'Its takes are deleted too. This cannot be undone.', ok: 'Delete track', danger: true, focusCancel: true },
};
const focusOnce = d => { if (d.focused) return; d.focused = true; setTimeout(() => document.querySelector('.dlg [data-autofocus]')?.focus(), 0); };
const subjectName = d => d.name || song(d.then?.split('.')[1])?.title || (d.arg === 'deleteTrack' ? 'Guitar take 2' : viewSong()?.title || 'This song');

function typedBox(c) {
  return '<p class="hint">Type <b>' + c.typed + '</b> to confirm.</p><input class="input" data-input="dxTyped" data-enter="dxConfirm" value="' + esc(X.confirm.typed) + '" autocomplete="off" spellcheck="false" aria-label="Type ' + c.typed + ' to confirm">'
    + protoBar([['resetOutcome', 'Outcome', [['ok', 'Works'], ['failed', 'Fails'], ['offline', 'Offline'], ['busy', 'Busy']]]]);
}
function confirmCard(d) {
  if (d.arg === 'restart') return restartCard(d);
  const c = CONFIRMS[d.arg] || CONFIRMS.reimport;
  if (c.focusCancel) focusOnce(d);
  const ready = !c.typed || X.confirm.typed.trim() === c.typed;
  const label = X.confirm.busy ? 'Resetting…' : c.ok;
  return dlgHead(c.title) + '<div class="dlg__body">' + (c.typed ? '' : '<b class="cf__name">' + esc(subjectName(d)) + '</b>') + '<p class="cf__body">' + c.body + '</p>'
    + (c.typed ? typedBox(c) : '') + (X.confirm.err ? '<p class="fmsg is-bad">' + X.confirm.err + '</p>' : '') + '</div>'
    + '<div class="dlg__foot"><button class="btn" data-act="closeDialog" ' + (c.focusCancel ? 'data-autofocus' : '') + '>Cancel</button><button class="btn ' + (c.danger ? 'btn--danger' : 'btn--accent') + '" data-act="dxConfirm" ' + (ready && !X.confirm.busy ? '' : 'disabled') + '>' + label + '</button></div>';
}
registerDialog('confirm', confirmCard);
act('dxTyped', (ctx, value) => { X.confirm.typed = value; X.confirm.err = ''; return ['overlays']; });
act('dxConfirm', () => {
  const d = S.ui.dialog;
  if (d.arg !== 'reset') { runThen(d); S.ui.dialog = d.back || null; return; }
  if (X.confirm.typed.trim() !== 'RESET') return false;
  X.confirm.busy = true;
  later(LOOKUP_MS, () => {
    X.confirm.busy = false;
    const outcome = proto('resetOutcome', 'ok');
    if (outcome === 'ok') S.ui.dialog = null; else X.confirm.err = RESET_ERRORS[outcome];
  });
});

// ── Restart after a network change (desktop) ──
const RESTART_ASK = {
  on: 'A separation is running. Restarting stops it, and the song waits in the queue, paused.',
  off: 'Other devices are refused from now on. A separation is running: restarting stops it, and the song waits in the queue, paused. With Not now, this applies at the next start.',
};
const RESTART_FAIL = {
  failSave: 'StemDeck could not save this setting: permission denied',
  failRestart: 'StemDeck could not restart: the desktop app did not answer. The setting is saved and applies at the next start.',
};
const NEW_PORT = 8001;
function restartBody(d) {
  if (X.restart === 'busy') return '<p class="cf__body cf__busy">' + icon('refresh-cw', 16, 'spin') + ' Restarting StemDeck…</p>';
  if (X.restart === 'port') return '<p class="cf__body">The old port was busy, so StemDeck now uses port ' + NEW_PORT + '. What this window saved for the old port is not carried over.</p>';
  if (RESTART_FAIL[X.restart]) return '<p class="fmsg is-bad">' + RESTART_FAIL[X.restart] + '</p>';
  return '<p class="cf__body">' + RESTART_ASK[d.then?.split('.')[1] || 'on'] + '</p>' + protoBar([['restartOutcome', 'Outcome', [['ok', 'Restarts'], ['failSave', 'Save fails'], ['failRestart', 'Restart fails'], ['port', 'Port changed']]]]);
}
function restartFoot() {
  if (X.restart === 'busy') return '';
  if (X.restart === 'port') return '<button class="btn btn--accent" data-act="dxRestartDone">Continue</button>';
  if (RESTART_FAIL[X.restart]) return '<button class="btn" data-act="closeDialog">Not now</button><button class="btn btn--accent" data-act="dxRestart">Try again</button>';
  return '<button class="btn" data-act="closeDialog">Not now</button><button class="btn btn--accent" data-act="dxRestart">Restart now</button>';
}
const restartCard = d => dlgHead('Restart StemDeck now?') + '<div class="dlg__body">' + restartBody(d) + '</div><div class="dlg__foot">' + restartFoot() + '</div>';
act('dxRestart', () => {
  X.restart = 'busy';
  later(LOOKUP_MS, () => { const out = proto('restartOutcome', 'ok'); if (out === 'ok') actions.dxRestartDone(); else X.restart = out; });
});
act('dxRestartDone', () => { const d = S.ui.dialog; runThen(d); S.ui.dialog = d.back || null; X.restart = 'ask'; });

// ── About (also the last Settings tab) ──
const GITHUB = 'https://github.com/PinetheApple/stemdeck';
const DATA_POINTS = [
  'Separation, analysis and transcription run on the computer running StemDeck, and your audio is never uploaded.',
  'MusicBrainz, Wikidata, Wikipedia and LRCLIB get the artist, song and album or show names when a track is imported or opened.',
  'Wikidata and Wikipedia get a band name you search for in About this song.',
  'AcoustID gets an audio fingerprint on import, only if you saved an AcoustID key.',
  "Discogs gets the same names, or a name you type, when Wikipedia lacks the band's details, only if you saved a Discogs token.",
  "Wikimedia Commons gets a photo's file name and your IP when About this song shows a band or work photo.",
  'YouTube, or the site you import from, gets the link or search text you enter.',
  'GitHub gets your IP when StemDeck checks for updates as it opens.',
  'Model files download once, at desktop setup or on first use, sending only your IP.',
];
const ext = (href, html, cls, title = '') => '<a class="' + cls + '" href="' + href + '" target="_blank" rel="noopener"' + (title ? ' title="' + title + '"' : '') + '>' + html + '</a>';
const social = (ic, title) => '<button class="iconbtn" data-act="noop" title="' + title + '">' + icon(ic, 18) + '</button>';
export const aboutBody = () => '<div class="about" data-help="Links to the website, GitHub and Discord, and the credits.">'
  + '<div class="about__logo">' + logo + '</div><h2>StemDeck</h2><p class="about__tag">Open source. No subscriptions.</p><span class="badge about__ver">' + VERSION + '</span>'
  + '<div class="about__btns">' + ext('https://stemdeck.app', icon('globe') + ' Website', 'btn') + ext(GITHUB, icon('github') + ' GitHub', 'btn') + '</div>'
  + '<div class="about__social">' + social('message-circle', 'Discord') + ext('https://www.reddit.com/r/StemDeckApp', icon('message-square', 18), 'iconbtn', 'Reddit (r/StemDeckApp)') + social('instagram', 'Instagram') + social('x-logo', 'X') + '</div>'
  + '<p class="about__small">Wikipedia (CC BY-SA), MusicBrainz and Wikidata (CC0), Whisper (MIT).</p>'
  + '<p class="about__small">StemDeck is free software under the GNU AGPL-3.0. ' + ext(GITHUB, 'Source code', 'about__link') + '</p>'
  + '<div class="about__data"><button class="about__toggle" aria-expanded="' + X.dataOpen + '" data-act="dxData">' + icon('shield', 15) + '<span>Where your data goes</span>' + icon(X.dataOpen ? 'chevron-up' : 'chevron-down', 15) + '</button>'
  + (X.dataOpen ? '<ol>' + DATA_POINTS.map(p => '<li>' + esc(p) + '</li>').join('') + '</ol>' : '') + '</div></div>';
act('dxData', () => { X.dataOpen = !X.dataOpen; return ['overlays']; });
registerDialog('about', () => dlgHead('', '') + '<div class="dlg__body" data-scroll="about">' + aboutBody() + '</div>');

// ── Start-up failure banner ──
const BOOT_ERROR = 'TypeError: Failed to fetch dynamically imported module: http://localhost:8000/static/js/studio.js';
registerHook('mainTop', () => (S.ui.bootFail ? '<div class="bootfail" role="alert"><div class="bootfail__txt"><b>StemDeck did not finish starting up.</b>'
  + '<p>Part of the interface never loaded, so buttons and file drop will not respond. Hovering and typing still work because the browser handles those itself. The cause is below. Please include it if you report this.</p>'
  + '<pre>' + esc(BOOT_ERROR) + '</pre><p>The full backend log is at /api/logs.zip, and the raw backend output at /api/logs/backend. Both help identify whether a file failed to load.</p></div>'
  + '<button class="btn" data-act="dxBootDismiss">Dismiss</button></div>' : ''));
act('dxBootDismiss', () => { S.ui.bootFail = false; });

// ── Extract more stems ──
const HAVE = ['vocals', 'drums', 'bass', 'other'];
const missingStems = () => STEMS.filter(s => !HAVE.includes(s.id));
const PHASES = [['wait', 'Waiting to extract'], ['down', 'Downloading'], ['extract', 'Extracting'], ['finish', 'Finishing…']];
function extractForm(s) {
  const picked = X.extractPick;
  const hint = s.source ? 'Saved as a new version. Takes a few minutes.' : 'Saved as a new version.';
  return '<div class="dlg__body"><p class="cf__body">' + esc(s.title) + '</p><div class="xchips">' + missingStems().map(st => '<button class="chip xchip ' + (picked.includes(st.id) ? 'is-on' : '') + '" style="--c:var(--' + st.id + ')" role="checkbox" aria-checked="' + picked.includes(st.id) + '" data-act="dxPick:' + st.id + '">' + (picked.includes(st.id) ? icon('check', 13) : '') + st.name + '</button>').join('') + '</div>'
    + '<p class="hint">' + hint + '</p>' + protoBar([['extractKept', 'Original audio', [['kept', 'Kept'], ['gone', 'Not kept']]]]) + '</div>'
    + '<div class="dlg__foot"><button class="btn" data-act="closeDialog">Cancel</button><button class="btn btn--accent" data-act="dxExtract:' + s.id + '" ' + (picked.length ? '' : 'disabled') + '>Extract</button></div>';
}
function extractRunning() {
  const run = X.extract;
  const [, label] = PHASES[run.phase];
  const text = run.phase === 1 || run.phase === 2 ? label + ' ' + run.pct + '%' : label;
  return '<div class="dlg__body"><div class="xrun"><span>' + text + '</span><span class="bar xrun__bar"><i style="width:' + (run.phase === 3 ? 100 : run.pct) + '%"></i></span></div><p class="hint">Saved as a new version named "+ ' + esc(run.names) + '".</p></div>'
    + '<div class="dlg__foot"><button class="btn" data-act="closeDialog">Close</button><button class="btn is-danger" data-act="dxStopExtract">Stop extracting</button></div>';
}
registerDialog('extract', d => {
  const s = song(d.arg) || viewSong() || playSong();
  X.extractPick ??= missingStems().map(st => st.id);
  const head = dlgHead('Extract more stems');
  if (X.extract && X.extract.songId === s.id) return head + extractRunning();
  if (proto('extractKept', 'kept') === 'gone') return head + '<div class="dlg__body"><p class="cf__body">This song\'s original audio wasn\'t kept. Import it again to get these stems.</p>' + protoBar([['extractKept', 'Original audio', [['kept', 'Kept'], ['gone', 'Not kept']]]]) + '</div><div class="dlg__foot"><button class="btn" data-act="closeDialog">Close</button></div>';
  return head + extractForm(s);
});
act('dxPick', (ctx, id) => { const p = X.extractPick; X.extractPick = p.includes(id) ? p.filter(x => x !== id) : [...p, id]; return ['overlays']; });
act('dxExtract', (ctx, id) => { X.extract = { songId: id, phase: 0, pct: 0, names: STEMS.filter(s => X.extractPick.includes(s.id)).map(s => s.name).join(', ') }; setTimeout(extractStep, STEP_MS); });
act('dxStopExtract', () => { X.extract = null; });
function extractStep() {
  const run = X.extract;
  if (!run) return;
  const counting = run.phase === 1 || run.phase === 2;
  if (counting && run.pct < 100) run.pct += PCT_STEP;
  else if (run.phase < PHASES.length - 1) { run.phase += 1; run.pct = 0; }
  else return finishExtract(run);
  update('overlays');
  setTimeout(extractStep, STEP_MS);
}
function finishExtract(run) {
  const s = song(run.songId);
  if (s) s.versions = [...(s.versions || []), { id: 'v' + Date.now(), name: '+ ' + run.names }];
  X.extract = null; X.extractPick = null;
  if (S.ui.dialog?.id === 'extract') S.ui.dialog = null;
  update();
}

// ── About the song (artist box) ──
const ABOUT_STATES = [['band', 'Band'], ['show', 'From a show'], ['loading', 'Loading'], ['waiting', 'Tags'], ['nothing', 'Nothing'], ['offline', 'Offline'], ['discogs', 'Discogs list'], ['notoken', 'No token']];
const BAND = {
  members: ['Ana Ruiz (vocals, guitar)', 'Tom Hale (drums)', 'Lee Park (bass)'], former: ['Sam Ode (keys, 2012 to 2016)'], memberOf: ['Northside Collective'],
  albums: [['First Light', 2014], ['Open Sky', 2017], ['Steady Ground', 2021]], links: ['Website', 'Instagram', 'Spotify', 'Apple Music', 'Bandcamp', 'Facebook', 'YouTube'],
};
const PICKS = [['Demo Band', 'Band · UK · 2009'], ['The Demo Band', 'Band · US · 1994'], ['Demo Band Collective', 'Group · Canada · 2015']];
const SHOW = 'Harbour Lights';
const aboutState = () => proto('aboutState', 'band');
const artistName = () => X.about.query || (viewSong() || playSong())?.artist || 'Demo Band';
const asList = (title, items) => '<h5>' + title + '</h5><ul>' + items.map(i => '<li>' + esc(i) + '</li>').join('') + '</ul>';
const searchRow = () => '<div class="as__search"><label class="search input">' + icon('search', 15) + '<input data-input="dxAboutQ" data-enter="dxAboutSearch" value="' + esc(X.about.query) + '" placeholder="Search for a band or artist" autocomplete="off"></label><button class="btn" data-act="dxAboutSearch">Search</button></div>';
const stateLine = (text, extra = '') => '<div class="as__state">' + text + extra + '</div>';

function songHeader(show) {
  const s = viewSong() || playSong();
  const rows = [['Performed by', artistName()], ['Album', (s?.title || 'Open Sky') + ' (2019)']];
  return '<div class="as__song"><b>' + esc(s?.title || 'Unknown song') + '</b>' + (show ? '<span>From the musical ' + SHOW + '</span>' : '')
    + '<dl>' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>').join('') + '</dl></div>';
}
function bandBlock(compact) {
  const name = artistName();
  const saveBtn = X.about.saved ? '<button class="btn" disabled>' + icon('check') + ' Saved for this track</button>' : '<button class="btn" data-act="dxAboutSave">Save for this track</button>';
  const head = '<div class="as__band"><div class="as__photo">' + icon('user', 30) + '</div><div class="as__who"><h4>' + esc(name) + '</h4><p>British worship band formed in 2009 in Leeds. Real name: ' + esc(name) + ' Collective.</p>'
    + '<div class="as__acts">' + saveBtn + '<button class="linkbtn" data-act="dxProto:aboutState:empty">Not this band? Search</button></div></div></div>';
  const links = '<div class="as__links">' + BAND.links.map(l => '<button class="tag" data-act="noop" title="Opens ' + l + ' in your browser">' + l + '</button>').join('') + '</div>';
  const more = '<h5>History</h5><p>Started as a church band, toured for ten years and released three studio albums.</p>' + asList('Members', BAND.members) + asList('Former members', BAND.former) + asList('Member of', BAND.memberOf) + asList('Studio albums', BAND.albums.map(([t, y]) => t + ' (' + y + ')'));
  return head + links + (compact ? '<p class="hint">From the Spanish Wikipedia</p>' : more);
}
function showBlock() {
  const work = '<div class="as__band"><div class="as__photo">' + icon('music', 30) + '</div><div class="as__who"><h4>' + SHOW + ' <span class="dim">2016</span></h4><p>Stage musical about a fishing town that keeps its lighthouse running.</p></div></div>'
    + '<div class="as__links"><button class="tag" data-act="noop" title="Opens Website in your browser">Website</button></div><h5>Synopsis</h5><p>A keeper\'s daughter returns home the winter the light is due to close.</p>'
    + '<dl class="as__credits"><dt>Music</dt><dd>J. Marlow</dd><dt>Lyrics</dt><dd>J. Marlow, R. Teague</dd><dt>Book</dt><dd>R. Teague</dd></dl><button class="linkbtn" data-act="noop">Read more about ' + SHOW + ' on Wikipedia</button>';
  const performer = '<button class="about__toggle" aria-expanded="' + X.about.more + '" data-act="dxAboutMore"><span>More about ' + esc(artistName()) + '</span>' + icon(X.about.more ? 'chevron-up' : 'chevron-down', 15) + '</button>';
  return work + performer + (X.about.more ? bandBlock(true) : '');
}
const NO_TOKEN = '<div class="note">Add a free Discogs token to search smaller bands too.<button class="btn" data-act="dxToToken">Open Song details settings</button></div>';
const ABOUT_VIEWS = {
  band: () => songHeader(false) + bandBlock(false) + '<p class="as__src">' + (X.about.discogs ? 'From Discogs · Data provided by Discogs' : 'From Wikipedia (CC BY-SA) and Wikidata (CC0)') + '</p>',
  show: () => songHeader(true) + showBlock() + '<p class="as__src">From Wikipedia (CC BY-SA) and Wikidata (CC0)</p>',
  loading: () => stateLine(icon('refresh-cw', 16, 'spin') + ' Looking up "' + esc(artistName()) + '" on Wikipedia…'),
  waiting: () => stateLine("Finding this track's artist…", '<button class="linkbtn" data-act="dxProto:aboutState:empty">Search by name instead</button>'),
  empty: () => searchRow(),
  nothing: () => searchRow() + stateLine('Nothing on Wikipedia matches "' + esc(artistName()) + '" as a band or artist.'),
  offline: () => searchRow() + stateLine('Could not reach Wikipedia. Check your connection and try again.'),
  notoken: () => searchRow() + stateLine('Nothing on Wikipedia matches "' + esc(artistName()) + '" as a band or artist.') + NO_TOKEN,
  discogs: () => '<h4 class="as__h">Found on Discogs</h4><p class="hint">Pick the one you mean.</p><div class="as__picks">' + PICKS.map(([n, m], i) => '<button class="srow" data-act="dxAboutPick:' + i + '"><div class="as__photo as__photo--sm">' + icon('user', 18) + '</div><div class="row__txt"><div class="row__t">' + n + '</div><div class="row__s">' + m + '</div></div></button>').join('') + '</div>',
};
registerDialog('aboutSong', () => dlgHead('About the song') + '<div class="dlg__body as" data-scroll="aboutSong">' + (ABOUT_VIEWS[aboutState()] || ABOUT_VIEWS.band)() + '</div><div class="dlg__foot as__foot">'
  + protoBar([['aboutState', 'State', ABOUT_STATES]]) + '</div>');
act('dxAboutQ', (ctx, value) => { X.about.query = value; return false; });
act('dxAboutSearch', () => { X.proto.aboutState = 'loading'; X.about.discogs = false; later(LOOKUP_MS, () => { X.proto.aboutState = 'band'; }); });
act('dxAboutSave', () => { X.about.saved = true; return ['overlays']; });
act('dxAboutMore', () => { X.about.more = !X.about.more; return ['overlays']; });
act('dxAboutPick', (ctx, i) => { X.about.query = PICKS[i][0]; X.about.discogs = true; X.proto.aboutState = 'band'; });
act('dxToToken', () => { S.ui.dialog = { id: 'settings', arg: 'song' }; setTimeout(() => document.querySelector('[data-keyfield="discogs"]')?.focus(), 0); });
