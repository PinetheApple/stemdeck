// PROTOTYPE - throwaway. The notification panel, the Something failed dialog and the New release dialog.
import { S, act } from './store.js';
import { registerPop, registerDialog } from './slots.js';
import { icon, esc } from './ui.js';
import { dlgHead, protoBar, proto, later, VERSION } from './dialogs.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MAX_CARDS = 20;
const DETAILS_MS = 900;
const FETCH_MS = 1100;
const DOWNLOAD_MS = 2200;
const RELEASE = 'v0.10.0';
const RELEASES_URL = 'https://github.com/stemdeckapp/stemdeck/releases';

const seedCards = () => [
  { id: 'n1', kind: 'Import failed', msg: "There wasn't enough memory to finish. Close other apps, then retry.", detail: 'rehearsal-take-3.wav', at: Date.now() - 2 * MIN },
  { id: 'n2', kind: 'Stems not extracted', msg: 'The link no longer works. The song is unchanged.', detail: 'Way Maker · + Guitar, Piano', at: Date.now() - 40 * MIN },
  { id: 'n3', kind: 'Playback failed', msg: "This track's audio could not be loaded.", detail: 'Playback is disabled for this track. Other tracks are not affected.', at: Date.now() - 3 * HOUR },
  { id: 'n4', kind: 'Export failed', msg: 'Could not export the logs.', detail: '', at: Date.now() - 20 * HOUR },
  { id: 'n5', kind: 'Settings not saved', msg: 'The setting could not be saved. Try again.', detail: '', at: Date.now() - 3 * DAY },
];
S.ui.notices = { cards: seedCards(), releaseHidden: false, report: {}, logs: 'none', update: 'idle' };
const N = S.ui.notices;

/** Posts a failure card; the same message within a few seconds is shown once. */
export function pushAlert(kind, msg, detail = '') {
  const dup = N.cards.find(c => c.kind === kind && c.msg === msg && Date.now() - c.at < 5000);
  if (dup) return;
  N.cards = [{ id: 'n' + Date.now(), kind, msg, detail, at: Date.now() }, ...N.cards].slice(0, MAX_CARDS);
}

function ago(at) {
  const ms = Date.now() - at;
  if (ms < MIN) return 'just now';
  if (ms < HOUR) return Math.floor(ms / MIN) + ' min ago';
  if (ms < DAY) return Math.floor(ms / HOUR) + ' h ago';
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
const dismissBtn = actName => '<button class="iconbtn iconbtn--sm nt__x" data-act="' + actName + '" title="Dismiss notification" aria-label="Dismiss notification">' + icon('x', 14) + '</button>';
const releaseCard = () => '<div class="nt__card nt__card--release" role="button" tabindex="0" data-act="dialog:release">' + icon('star', 18, 'nt__ic') + '<div class="nt__txt"><b>New release available</b><span class="mono">' + RELEASE + '</span></div>' + dismissBtn('ntHideRelease') + '</div>';
const failCard = c => '<div class="nt__card" role="button" tabindex="0" data-act="dialog:failure:' + c.id + '">' + icon('alert', 18, 'nt__ic nt__ic--warn') + '<div class="nt__txt"><b>' + esc(c.kind) + '</b><span>' + esc(c.msg) + ' · ' + ago(c.at) + '</span></div>' + dismissBtn('ntDismiss:' + c.id) + '</div>';

registerPop('alerts', () => {
  const showRelease = !N.releaseHidden;
  const empty = !showRelease && !N.cards.length;
  return '<div class="nt"><div class="nt__head" data-help="Messages from StemDeck, such as a new release or an import that failed."><h3>Notifications</h3><div class="sp"></div>'
    + (N.cards.length ? '<button class="linkbtn" data-act="ntClear">Clear all</button>' : '') + '<button class="iconbtn iconbtn--sm" data-act="closePop" title="Close notifications">' + icon('x', 15) + '</button></div>'
    + '<div class="nt__list" data-scroll="alerts">' + (showRelease ? releaseCard() : '') + N.cards.map(failCard).join('')
    + (empty ? '<div class="nt__empty">' + icon('bell', 24) + '<span>No new notifications</span><button class="linkbtn" data-act="ntRestore">Prototype: bring the cards back</button></div>' : '') + '</div></div>';
});
act('ntDismiss', (ctx, id) => { N.cards = N.cards.filter(c => c.id !== id); return ['overlays']; });
act('ntHideRelease', () => { N.releaseHidden = true; return ['overlays']; });
act('ntClear', () => { N.cards = []; return ['overlays']; });
act('ntRestore', () => { N.cards = seedCards(); N.releaseHidden = false; return ['overlays']; });

// ── Something failed ──
const stamp = at => new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const diagnostics = c => ['StemDeck ' + VERSION + ' · Linux x86_64 · desktop', 'Device: CUDA (NVIDIA GeForce RTX 3060)', 'Kind: ' + c.kind, 'Message: ' + c.msg, 'Job: 7f3c9a2e · stage separate · exit 137'].join('\n');
const LOGS_LABEL = { none: 'Include recent logs', busy: 'Fetching logs…', done: 'Logs included' };
const reportBtn = (id, label, accent) => '<button class="btn ' + (accent ? 'btn--accent' : '') + '" data-act="ntReport:' + id + '">' + (N.report[id] ? icon('check') : '') + label + '</button>';

registerDialog('failure', d => {
  const c = N.cards.find(x => x.id === d.arg) || seedCards()[0];
  if (!d.pending) { d.pending = true; N.logs = 'none'; N.report = {}; later(DETAILS_MS, () => { d.ready = true; }); }
  return dlgHead(esc(c.kind), '<span class="badge">' + stamp(c.at) + '</span>') + '<div class="dlg__body" data-scroll="failure"><p class="cf__body">' + esc(c.msg) + '</p>' + (c.detail ? '<p class="hint">' + esc(c.detail) + '</p>' : '')
    + '<p class="hint">Add the track title and source link if they help. Reporting copies these details to your clipboard.</p>'
    + '<pre class="techbox">' + (d.ready ? esc(diagnostics(c)) + (N.logs === 'done' ? '\n\n[app.log, backend.log, setup.log: 14:02 to 14:12]' : '') : 'Collecting details…') + '</pre>'
    + '<div><button class="btn" data-act="ntLogs" ' + (N.logs === 'none' ? '' : 'disabled') + '>' + (N.logs === 'done' ? icon('check') : '') + LOGS_LABEL[N.logs] + '</button></div></div>'
    + '<div class="dlg__foot">' + reportBtn('discord', 'Report on Discord') + reportBtn('github', 'Report on GitHub', true) + '</div>';
});
act('ntLogs', () => { N.logs = 'busy'; later(FETCH_MS, () => { N.logs = 'done'; }); return ['overlays']; });
act('ntReport', (ctx, id) => { N.report[id] = true; return ['overlays']; });

// ── New release ──
const VARIANTS = [['inplace', 'Desktop'], ['runtime', 'New runtime'], ['noasset', 'No download'], ['server', 'Server']];
const NOTES = '<h4>What\'s new</h4><ul><li>Setlists play straight through, with Up Next showing what comes after.</li><li>Stage mode keeps lyrics and the next section in view.</li><li>Fixed a crash when a playlist link had one song.</li></ul>';
const notes = () => '<div class="relnotes" data-scroll="relnotes">' + (proto('relNotes', 'some') === 'some' ? NOTES : '<p>No release notes provided. See the full release on GitHub.</p>') + '</div>';
const serverBlock = () => '<div class="relserver"><b>Update your server</b><p>Pull the new image and restart the container:</p><pre class="techbox">docker pull ghcr.io/stemdeckapp/stemdeck:' + RELEASE + '</pre><p class="hint">On Unraid, update via the Community Applications template instead.</p></div>';
const UPDATE_STATE = {
  idle: () => '<button class="btn btn--accent" data-act="ntUpdate">Update now</button>',
  downloading: () => '<span class="relbusy"><span class="bar bar--busy"><i></i></span>Downloading update…</span>',
  ready: () => '<button class="btn btn--accent" data-act="ntApply">Restart to update</button>',
  applying: () => '<span class="relbusy"><span class="bar bar--busy"><i></i></span>Applying update…</span>',
};
function releaseFoot(variant) {
  if (variant === 'server') return '<a class="linkbtn" href="' + RELEASES_URL + '" target="_blank" rel="noopener">All releases</a>';
  const download = '<a class="btn" href="' + RELEASES_URL + '" target="_blank" rel="noopener">' + icon('download') + (variant === 'noasset' ? 'View download' : 'Download') + '</a>';
  const inPlace = variant === 'inplace' ? UPDATE_STATE[N.update === 'failed' ? 'idle' : N.update]() : '';
  return '<a class="linkbtn" href="' + RELEASES_URL + '" target="_blank" rel="noopener">All releases</a><div class="sp"></div>' + download + inPlace;
}
registerDialog('release', () => {
  const variant = proto('relVariant', 'inplace');
  const fail = variant === 'inplace' && N.update === 'failed' ? '<p class="fmsg is-bad">Update failed: the download was interrupted.</p>' : '';
  const runtime = variant === 'runtime' ? '<p class="hint">Press Download, unzip it, and run it. Your library stays as it is.</p>' : '';
  return dlgHead(icon('star', 18, 'nt__ic') + ' New release available', '<span class="badge">' + RELEASE + '</span>') + '<div class="dlg__body">' + notes() + (variant === 'server' ? serverBlock() : '') + runtime + fail
    + protoBar([['relVariant', 'Variant', VARIANTS], ['relNotes', 'Notes', [['some', 'Notes'], ['none', 'None']]], ['relOutcome', 'Update', [['ok', 'Works'], ['fail', 'Fails']]]]) + '</div>'
    + '<div class="dlg__foot relfoot">' + releaseFoot(variant) + '</div>';
});
act('ntUpdate', () => { N.update = 'downloading'; later(DOWNLOAD_MS, () => { N.update = proto('relOutcome', 'ok') === 'ok' ? 'ready' : 'failed'; }); return ['overlays']; });
act('ntApply', () => { N.update = 'applying'; later(DOWNLOAD_MS, () => { N.update = 'idle'; N.releaseHidden = true; S.ui.dialog = null; }); return ['overlays']; });
