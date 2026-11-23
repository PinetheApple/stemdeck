// PROTOTYPE - throwaway. The Settings dialog: nine tabs down the left, fields that save on change.
import { S, act, actions, update, library } from './store.js';
import { registerDialog, registerMenu } from './slots.js';
import { icon, esc, toggle, field, select } from './ui.js';
import { dlgHead, protoBar, proto, later, aboutBody } from './dialogs.js';
import { pushAlert } from './alerts.js';

const TABS = [
  ['appearance', 'Appearance', 'palette', 'Theme, font and the cover colour wash.'],
  ['general', 'General', 'settings', 'Language, Max track length, Playlist import limit, YouTube cookies, StemData location, Exports folder, Automatically delete, Compute device, Separation quality, Free memory when idle, Reset app data.'],
  ['song', 'Song details', 'music', 'Song identification, Discogs and Transcribe lyrics: how StemDeck names songs and finds their lyrics and band details.'],
  ['network', 'Network', 'wifi', 'Make available: open StemDeck from your phone on the same network. On desktop, turning it on or off restarts StemDeck. Port: the port StemDeck runs on.'],
  ['export', 'Export', 'upload', 'Sample rate and MP4 video quality of what you export.'],
  ['recording', 'Recording', 'mic', 'Input device, latency test and Hear yourself for recording takes.'],
  ['logs', 'Logs', 'file', 'Where StemDeck writes its logs, and what they say. Export logs puts every log in one zip for a bug report.'],
  ['library', 'Library', 'library', 'Your saved songs, and Out of sync tracks whose audio is missing from this computer.'],
  ['about', 'About', 'info', 'Links to the website, GitHub and Discord, and the credits.'],
];
const TAB_IDS = TABS.map(t => t[0]);
const LIMITS = { maxLen: [1, 60, 20], playlist: [1, 200, 50], delDays: [1, 365, 30], idle: [0, 1440, 10], port: [1024, 65535, 8000] };
const ARM_AUTO_MS = 10000;
const BUSY_MS = 1500;
const CLICKS = 8;
const CLICK_MS = 380;
const MEASURED_MS = 23;
const HOME = '/home/you';

S.ui.settingsTab = 'appearance';
S.ui.settings = {
  lang: 'en', maxLen: 20, playlist: 50, cookies: '', dataPath: '~/StemData', exportsPath: '~/Music/StemDeck exports', autoDel: false, autoArmed: false, delDays: 30,
  device: 'auto', quality: 'standard', format: 'wav', bitrate: '128', idle: 10, keys: { acoustid: '', discogs: '' }, drafts: { acoustid: '', discogs: '' }, transcribe: 'auto',
  network: true, qrOpen: [], port: 8000, rate: '44.1', mp4: '720', input: 'default', latency: null, lat: null, hear: false, logTab: 'location', logBusy: false, exporting: false, syncing: false, msg: {},
};
const V = S.ui.settings;
const rocm = () => proto('build', 'nvidia') === 'rocm';
const server = () => proto('setup', 'desktop') === 'server';
const refused = () => proto('saves', 'ok') === 'refused';
const card = () => (rocm() ? 'AMD' : 'NVIDIA');

// ── Selects ──
const LANGS = [['en', 'English', 'EN'], ['pl', 'Polski', 'PL'], ['ja', '日本語', 'JA'], ['ko', '한국어', 'KO'], ['zh', '简体中文', 'ZH'], ['de', 'Deutsch', 'DE'], ['fr', 'Français', 'FR'], ['es', 'Español', 'ES'], ['pt-BR', 'Português (Brasil)', 'BR'], ['pt-PT', 'Português (Portugal)', 'PT'], ['id', 'Bahasa Indonesia', 'ID']];
const OPTIONS = {
  lang: () => LANGS,
  device: () => [['auto', 'Auto'], ['cuda', rocm() ? 'ROCm (AMD)' : 'CUDA (NVIDIA)', '', proto('gpu', 'ok') !== 'ok'], ['mps', 'MPS (Apple Silicon)', '', true], ['cpu', 'CPU']],
  quality: () => [['standard', 'Standard'], ['best', 'Best (2× slower)']],
  format: () => [['wav', 'WAV'], ['mp3', 'MP3']],
  bitrate: () => [['128', '128 kbps'], ['192', '192 kbps'], ['256', '256 kbps']],
  transcribe: () => [['auto', rocm() ? 'Auto (NVIDIA/AMD GPU only)' : 'Auto (NVIDIA GPU only)'], ['on', 'On'], ['off', 'Off']],
  rate: () => [['22.05', '22.05 kHz'], ['32', '32 kHz'], ['44.1', '44.1 kHz'], ['48', '48 kHz']],
  mp4: () => [['360', '360p'], ['480', '480p'], ['720', '720p'], ['1080', '1080p']],
  input: () => [['default', 'Default input'], ['usb', 'USB Audio Interface'], ['builtin', 'Built-in Microphone'], ['in3', 'Input 3']],
};
const optLabel = key => (OPTIONS[key]().find(o => o[0] === V[key]) || OPTIONS[key]()[0])[1];
registerMenu('stgSelect', key => OPTIONS[key]().map(([v, label, hint, off]) => ({ label: off ? label + ' — not available' : label, hint, checked: V[key] === v, disabled: off, act: 'stgPick:' + key + ':' + v })));
const sel = (key, off = false) => '<span class="' + (off ? 'is-off' : '') + '">' + select(esc(optLabel(key)), 'menu:stgSelect:' + key) + '</span>';
const notSaved = () => pushAlert('Settings not saved', 'The setting could not be saved. Try again.');
act('stgPick', (ctx, key, value) => { if (refused() && key !== 'lang') notSaved(); else V[key] = value; });

// ── Fields ──
const msg = (key, bad = true) => (V.msg[key] ? '<p class="fmsg ' + (bad ? 'is-bad' : '') + '">' + V.msg[key] + '</p>' : '');
const num = (key, len, off = false) => '<input class="input input--num" inputmode="numeric" maxlength="' + len + '" style="width:' + (len + 3) + 'ch" data-input="stgDigits" data-clamp="' + key + '" value="' + V[key] + '" ' + (off ? 'disabled' : '') + ' aria-label="' + key + '">';
const stack = (label, hint, control, extra = '') => '<div class="frow frow--stack"><div class="frow__l"><b>' + label + '</b>' + (hint ? '<span>' + hint + '</span>' : '') + '</div>' + control + extra + '</div>';
const sub = text => '<h4 class="set__sub">' + text + '</h4>';
const pathRow = (path, act, size = '') => '<div class="pathrow"><span class="mono ell" title="' + esc(path.replace('~', HOME)) + '">' + esc(path) + '</span>' + (size ? '<span class="dim">' + size + '</span>' : '') + '<div class="sp"></div><button class="btn" data-act="' + act + '">Change…</button></div>';
act('stgDigits', ctx => { ctx.el.value = ctx.el.value.replace(/\D/g, ''); return false; });

function clampField(key, raw) {
  const [lo, hi, def] = LIMITS[key];
  const n = parseInt(raw, 10);
  const kept = Number.isNaN(n) ? def : Math.min(hi, Math.max(lo, n));
  if (refused()) { if (key === 'idle') V.msg.idle = 'Could not save this setting. The field shows the value still in use.'; else notSaved(); return; }
  V.msg[key] = key === 'idle' && n > hi ? 'The most is ' + hi + ' minutes, so ' + hi + ' was saved.' : '';
  V[key] = kept;
}
function checkCookies(value) {
  const path = value.trim();
  V.cookies = path;
  V.msg.cookies = !path ? '' : /stemdata/i.test(path) ? 'This file is inside the StemData folder. Pick a cookies file outside it.' : path.endsWith('.txt') ? '' : 'File not found, or not readable.';
}
function onFieldChange(e) {
  const el = e.target;
  if (el.dataset.clamp) clampField(el.dataset.clamp, el.value);
  else if (el.dataset.text === 'cookies') checkCookies(el.value);
  else return;
  update('overlays');
}
document.addEventListener('change', onFieldChange);

// ── Appearance ──
const THEMES = [['coral', 'Ink & coral', '#0f1011', '#1e1f22', '#ff6f59'], ['ice', 'Ink & ice', '#0f1011', '#1e1f22', '#eef1f4'], ['dusk', 'Dusk & coral', '#131018', '#231e2c', '#ff7d68']];
const FONTS = [['manrope', 'Manrope'], ['inter', 'Inter'], ['geist', 'Geist'], ['figtree', 'Figtree'], ['dm-sans', 'DM Sans'], ['plus-jakarta-sans', 'Plus Jakarta Sans'], ['bricolage-grotesque', 'Bricolage Grotesque']];
function appearanceTab() {
  const d = document.documentElement.dataset;
  const themes = THEMES.map(([id, label, bg, surface, accent]) => '<button class="themecard ' + (d.palette === id ? 'is-on' : '') + '" aria-pressed="' + (d.palette === id) + '" data-act="pref:palette:' + id + '">'
    + '<span class="themecard__pv" style="background:' + bg + '"><i style="background:' + surface + '"></i><i style="background:' + surface + '"></i><b style="background:' + accent + '"></b></span><span>' + label + '</span></button>').join('');
  const fonts = FONTS.map(([id, label]) => '<button class="fontcard ' + (d.font === id ? 'is-on' : '') + '" aria-pressed="' + (d.font === id) + '" data-act="pref:font:' + id + '" style="font-family:\'' + label + '\', sans-serif"><b>Aa</b><span>' + label + '</span></button>').join('');
  const wash = d.wash !== 'off';
  return stack('Theme', 'Colours of the whole app.', '<div class="themegrid">' + themes + '</div>') + stack('Font', 'The typeface of every label and lyric.', '<div class="fontgrid">' + fonts + '</div>')
    + field('Cover colour wash', "Tints the studio with the colours of the song's cover.", toggle(wash, 'pref:wash:' + (wash ? 'off' : 'on'), 'Cover colour wash'));
}

// ── General ──
const MOVE_RESULTS = {
  ok: 'Moved 214 items. Restart StemDeck to finish switching over.',
  queue: 'Finish or cancel the imports in the queue, then try again.',
  folder: "StemDeck can't use this folder. Pick an empty folder you can write to, outside the current stems folder.",
  busy: 'StemDeck is still working on a song or an import. Let it finish or cancel it, then try again.',
  failed: 'Could not move the stems folder. Pick another empty folder and try again.',
  offline: 'Could not reach the server.',
  notsaved: 'The stems moved, but the new location was not saved. Restarting now would revert to the old location. Try setting it again.',
};
const GPU_LINES = {
  unsupported: c => 'Your ' + c + " graphics card isn't supported, so separation uses the processor.",
  unreachable: c => "StemDeck can't reach your " + c + ' graphics card, so separation uses the processor.',
  setup: c => 'Setting up your ' + c + " graphics card didn't finish, so separation uses the processor.",
  check: c => 'Your ' + c + " graphics card didn't pass StemDeck's check, so separation uses the processor.",
};
const ENGINE_BROKEN = 'The separation engine could not start on this computer, so tracks cannot be separated on any device. Reinstalling StemDeck repairs it. The reason is in the log.';
const AUTO_HINT = 'Deletes finished tracks after the days set below. This cannot be undone.';
const AUTO_ARMED = 'Deletes for good; favorites and setlist songs are kept. Click again to turn it on.';

function storageRows() {
  if (server()) return '';
  const moving = V.msg.move === 'moving' ? '<p class="fmsg">Moving stems… this can take a while for a large library.</p>' : msg('move', V.moveBad);
  return stack('StemData location', '', pathRow(V.dataPath, 'stgMove', '18.4 GB'), moving)
    + stack('Exports folder', 'Where stems and loops you drag out of StemDeck go. Nothing here is deleted automatically.', pathRow(V.exportsPath, 'stgExports'), msg('exports'));
}
function deviceRow() {
  const gpu = proto('gpu', 'ok');
  const hint = gpu === 'broken' ? '<span class="is-bad">' + ENGINE_BROKEN + '</span>' : 'Device used for stem separation. Applies to the next track.';
  const line = GPU_LINES[gpu] ? '<p class="fmsg is-warn">' + GPU_LINES[gpu](card()) + '</p>' : '';
  return '<div class="frow frow--wrap"><div class="frow__l"><b>Compute device</b><span>' + hint + '</span></div><div class="frow__c">' + sel('device') + '</div>' + line + '</div>';
}
function generalTab() {
  const autoHint = V.autoArmed ? '<span class="is-warn">' + AUTO_ARMED + '</span>' : AUTO_HINT;
  return field('Language', 'Applies at once, on this device only.', sel('lang'))
    + field('Max track length', 'Longest track accepted for processing, in minutes (max 60).', num('maxLen', 2))
    + field('Playlist import limit', 'Most tracks one playlist import will queue (max 200).', num('playlist', 3))
    + stack('YouTube cookies', 'Optional. Path to a cookies.txt file, used only when YouTube asks StemDeck to confirm it is not a bot. Leave this empty unless imports are failing.',
      '<input class="input" data-text="cookies" value="' + esc(V.cookies) + '" placeholder="Path to cookies.txt" autocomplete="off" spellcheck="false">', msg('cookies'))
    + storageRows()
    + '<div class="frow"><div class="frow__l"><b>Automatically delete finished tracks</b><span>' + autoHint + '</span></div><div class="frow__c">' + toggle(V.autoDel, 'stgAutoDel', 'Automatically delete finished tracks') + '</div></div>'
    + '<div class="' + (V.autoDel ? '' : 'is-dim') + '">' + field('Delete after', 'Days a finished track is kept before it is deleted (max 365).', num('delDays', 3, !V.autoDel)) + '</div>'
    + deviceRow()
    + field('Separation quality', 'Cleaner stems, twice as slow.', sel('quality'))
    + field('Stem format', 'MP3 takes less disk space. Applies to the next track.', sel('format'))
    + '<div class="' + (V.format === 'mp3' ? '' : 'is-dim') + '">' + field('MP3 bitrate', 'Higher sounds better and takes more space.', sel('bitrate', V.format !== 'mp3')) + '</div>'
    + stack('Free memory when idle', 'Minutes with no track being separated or analyzed before StemDeck unloads its separation models to free memory, at most 1440. The next track loads them again and starts a few seconds later. 0 keeps them loaded.', num('idle', 4), msg('idle', !!V.msg.idle && V.msg.idle.startsWith('Could')))
    + sub('Danger zone') + field('Reset app data', 'Permanently deletes every track, job, and library entry. On a shared server this affects everyone who uses it. Cannot be undone.', '<button class="btn is-danger" data-act="over:confirm:reset">Reset app data…</button>')
    + protoBar([['gpu', 'GPU', [['ok', 'Works'], ['unsupported', 'Unsupported'], ['unreachable', 'Unreachable'], ['setup', 'Setup'], ['check', 'Check'], ['broken', 'Engine broken']]], ['build', 'Build', [['nvidia', 'NVIDIA'], ['rocm', 'ROCm']]],
      ['moveOutcome', 'Move', [['ok', 'Works'], ['queue', 'Queue'], ['folder', 'Bad folder'], ['busy', 'Busy'], ['failed', 'Fails'], ['offline', 'Offline'], ['notsaved', 'Not saved']]], ['picker', 'Folder picker', [['ok', 'Opens'], ['fail', 'Fails']]]]);
}
act('stgMove', () => {
  if (proto('picker', 'ok') === 'fail') { V.msg.move = 'Could not open the folder picker.'; V.moveBad = true; return; }
  V.msg.move = 'moving';
  later(BUSY_MS, () => { const out = proto('moveOutcome', 'ok'); V.msg.move = MOVE_RESULTS[out]; V.moveBad = out !== 'ok'; if (out === 'ok') V.dataPath = '~/Music/StemData'; });
});
act('stgExports', () => {
  if (proto('picker', 'ok') === 'fail') { V.msg.exports = 'The folder picker could not be opened.'; return; }
  V.msg.exports = ''; V.exportsPath = V.exportsPath.includes('Desktop') ? '~/Music/StemDeck exports' : '~/Desktop/Exports';
});
act('stgAutoDel', () => {
  if (V.autoDel || V.autoArmed) { V.autoDel = !V.autoDel && V.autoArmed; V.autoArmed = false; return; }
  V.autoArmed = true;
  setTimeout(() => { if (V.autoArmed) { V.autoArmed = false; update('overlays'); } }, ARM_AUTO_MS);
});

// ── Song details ──
const KEYS = {
  acoustid: { label: 'Song identification', hint: 'Optional. A free key identifies imports by their sound.', ph: 'AcoustID API key', max: 64, tail: 2, noun: 'key', min: 8,
    link: ['https://acoustid.org/new-application', 'Register a free key at acoustid.org'], bad: 'That does not look like an AcoustID key.',
    refused: 'AcoustID does not accept this key. Use the key of an application you register at acoustid.org, not the user key on your profile.', offline: 'Could not save the key. Check the connection and try again.' },
  discogs: { label: 'Discogs', hint: 'Band profiles, members and releases for bands Wikipedia does not cover, from Discogs. Optional.', ph: 'Discogs personal access token', max: 80, tail: 4, noun: 'token', min: 12,
    link: ['https://www.discogs.com/settings/developers', 'Get a free token at discogs.com'], bad: 'That does not look like a Discogs token.',
    refused: 'Discogs does not accept this token. Create a personal access token in your Discogs account settings, under Developers.', offline: 'Could not save the token. Check the connection and try again.' },
};
function keyBlock(id) {
  const k = KEYS[id];
  const saved = V.keys[id];
  const status = saved ? 'A ' + k.noun + ' ending in ' + esc(saved.slice(-k.tail)) + ' is saved.' : 'No ' + k.noun + ' saved.';
  const control = '<div class="keyrow"><input class="input" type="password" maxlength="' + k.max + '" data-keyfield="' + id + '" data-input="stgDraft:' + id + '" data-enter="stgSaveKey:' + id + '" value="' + esc(V.drafts[id]) + '" placeholder="' + k.ph + '" autocomplete="off">'
    + '<button class="btn" data-act="stgSaveKey:' + id + '" ' + (V.drafts[id] ? '' : 'disabled') + '>Save</button><button class="btn" data-act="stgClearKey:' + id + '" ' + (saved ? '' : 'disabled') + '>Clear</button></div>';
  return stack(k.label, k.hint, control, '<p class="hint">' + status + ' <a class="about__link" href="' + k.link[0] + '" target="_blank" rel="noopener">' + k.link[1] + '</a></p>' + msg('key-' + id));
}
const songTab = () => keyBlock('acoustid') + keyBlock('discogs')
  + field('Transcribe lyrics', 'When no lyrics are found, they are transcribed from the vocals on this computer. The first run downloads a speech model (1.6 GB for an NVIDIA GPU, 0.5 GB otherwise). Applies to the next track.', sel('transcribe'));
act('stgDraft', (ctx, id, value) => { V.drafts[id] = value; V.msg['key-' + id] = ''; return ['overlays']; });
act('stgClearKey', (ctx, id) => { V.keys[id] = ''; });
act('stgSaveKey', (ctx, id) => {
  const k = KEYS[id];
  const draft = V.drafts[id].trim();
  if (!draft) return false;
  const err = draft.length < k.min || /\s/.test(draft) ? k.bad : /^user/i.test(draft) ? k.refused : S.ui.offline ? k.offline : '';
  V.msg['key-' + id] = err;
  if (!err) { V.keys[id] = draft; V.drafts[id] = ''; }
});

// ── Network ──
const ADDRESSES = [{ host: '192.168.1.24' }, { host: '10.8.0.3', vpn: true }];
const SERVER_NOTE = 'These settings come from how StemDeck was set up on this server. To change them, change that setup and restart StemDeck.';
const QR_SIZE = 21;
const FINDER = 7;
const inFinder = (r, c) => [[0, 0], [0, QR_SIZE - FINDER], [QR_SIZE - FINDER, 0]].some(([fr, fc]) => r >= fr && r < fr + FINDER && c >= fc && c < fc + FINDER);
const finderOn = (r, c) => { const y = r % (QR_SIZE - FINDER); const x = c % (QR_SIZE - FINDER); const d = Math.max(Math.abs(y - 3), Math.abs(x - 3)); return d !== 2; };
function qrCells(url) {
  let seed = [...url].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7);
  const bit = () => { seed = (seed * 1103515245 + 12345) | 0; return (seed >>> 16) & 1; };
  let out = '';
  for (let r = 0; r < QR_SIZE; r += 1) for (let c = 0; c < QR_SIZE; c += 1) out += '<i' + ((inFinder(r, c) ? finderOn(r, c) : bit()) ? ' class="k"' : '') + '></i>';
  return out;
}
function qrCard(a) {
  const scheme = proto('addr', 'http') === 'https' ? 'https' : 'http';
  const host = a.host + ':' + V.port;
  const url = scheme + '://' + host + '/mobile/';
  const open = V.qrOpen.includes(a.host);
  return '<button class="qrcard ' + (open ? '' : 'is-blur') + '" data-act="stgQr:' + a.host + '" title="' + (open ? url : 'Tap to unblur') + '"><span class="qr" role="img" aria-label="QR code for ' + url + '">' + qrCells(url) + '</span>'
    + '<span class="qrcard__cap"><span class="mono ell" title="' + url + '">' + host + '</span>' + (a.vpn ? '<span class="tag">VPN</span>' : '') + '</span></button>';
}
function addressArea() {
  const mode = proto('addr', 'http');
  if (mode === 'none') return '<p class="hint">No local network connection detected.</p>';
  const warn = mode === 'https' ? 'If your phone warns that this connection is not private, tap Advanced, then Continue, once on each device. Changing the key will not work until you do.'
    : 'Changing the key will not work on your phone at this address. Phones only allow that over a secure connection (https).';
  return '<div class="note">' + icon('info', 16) + '<span>' + warn + '</span></div><p class="hint">Tap to reveal.</p><div class="qrgrid">' + ADDRESSES.map(qrCard).join('') + '</div>';
}
function networkTab() {
  const on = server() || V.network;
  const sw = server() ? '<button class="switch is-on is-locked" role="switch" aria-checked="true" disabled aria-label="Make StemDeck available on your network"><i></i></button>'
    : toggle(on, 'over:confirm:restart:stgNetApply.' + (on ? 'off' : 'on'), 'Make StemDeck available on your network');
  return (server() ? '<div class="note">' + icon('lock', 16) + '<span>' + SERVER_NOTE + '</span></div>' : '')
    + field('Make StemDeck available on your network', 'Let other devices (like your phone) open StemDeck at the address below.', sw) + (on ? addressArea() : '')
    + field('Port', 'Port StemDeck runs on. Restart to apply.', num('port', 5, server()))
    + protoBar([['addr', 'Addresses', [['http', 'http'], ['https', 'https'], ['none', 'None']]]]);
}
act('stgNetApply', (ctx, v) => { V.network = v === 'on'; });
act('stgQr', (ctx, host) => { V.qrOpen = V.qrOpen.includes(host) ? V.qrOpen.filter(h => h !== host) : [...V.qrOpen, host]; return ['overlays']; });

// ── Export ──
const exportTab = () => field('Sample rate', '44.1 kHz suits most DAWs and samplers.', sel('rate')) + field('MP4 video quality', 'Max resolution for MP4 export and YouTube video.', sel('mp4'));

// ── Recording ──
const dots = heard => '<span class="latdots">' + Array.from({ length: CLICKS }, (_, i) => '<i class="' + (i < heard ? 'is-on' : '') + '"></i>').join('') + '</span>';
const LAT_STEPS = {
  start: () => '<p>Turn the volume up. Hold the microphone near the speaker or a headphone cup, then start. ' + CLICKS + ' clicks play.</p><div class="lattest__btns"><button class="btn" data-act="stgLatCancel">Cancel</button><button class="btn" data-act="stgLatRun">Start</button></div>',
  listening: () => '<p>Listening…</p>' + dots(V.lat.heard) + '<div class="lattest__btns"><button class="btn" data-act="stgLatCancel">Cancel</button></div>',
  saved: () => '<p>Saved. Takes on ' + esc(optLabel('input')) + ' now line up with the song.</p><div class="lattest__btns"><button class="btn" data-act="stgLatStart">Test again</button></div>',
  failed: () => '<p class="is-bad">No clicks were heard. Turn the volume up or move the microphone closer, then try again.</p><div class="lattest__btns"><button class="btn" data-act="stgLatRun">Try again</button></div>',
};
function recordingTab() {
  const latency = '<span class="mono dim">' + (V.latency == null ? 'Not tested' : V.latency + ' ms') + '</span>' + (V.lat ? '' : '<button class="btn" data-act="stgLatStart">Test latency</button>');
  return field('Input device', '', sel('input')) + field('Latency', 'Lines takes up with the song. Test once per input.', latency)
    + (V.lat ? '<div class="lattest">' + LAT_STEPS[V.lat.step]() + '</div>' : '')
    + field('Hear yourself', 'Use headphones, or the song bleeds into the take.', toggle(V.hear, 'stgHear', 'Hear yourself'))
    + protoBar([['latOutcome', 'Latency test', [['ok', 'Hears clicks'], ['fail', 'Hears nothing']]]]);
}
act('stgLatStart', () => { V.lat = { step: 'start', heard: 0 }; return ['overlays']; });
act('stgLatCancel', () => { V.lat = null; return ['overlays']; });
act('stgHear', () => { V.hear = !V.hear; return ['overlays']; });
act('stgLatRun', () => { V.lat = { step: 'listening', heard: 0 }; setTimeout(latClick, CLICK_MS); return ['overlays']; });
function latClick() {
  const lat = V.lat;
  if (!lat || lat.step !== 'listening') return;
  const hears = proto('latOutcome', 'ok') === 'ok';
  if (hears && lat.heard < CLICKS) { lat.heard += 1; update('overlays'); setTimeout(latClick, CLICK_MS); return; }
  if (hears) { lat.step = 'saved'; V.latency = MEASURED_MS; } else lat.step = 'failed';
  update('overlays');
}

// ── Logs ──
const LOG_TABS = [['location', 'Location'], ['app', 'Application log'], ['backend', 'Backend log'], ['setup', 'Setup log']];
const LOG_FILES = [['app.log', '84 KB', '2 min ago', 'What the interface did and any errors it hit.'], ['backend.log', '1.2 MB', 'just now', 'The server: imports, separation and analysis.'], ['setup.log', '12 KB', '3 days ago', 'First-run setup and model downloads.']];
const LOG_LINES = { app: ['14:02:11 INFO  opened Morning Light', '14:02:12 INFO  lyrics found (LRCLIB)', '14:05:40 WARN  playback stalled, rebuffering', '14:06:02 INFO  tempo saved'], backend: ['14:01:55 INFO  job 7f3c9a2e queued', '14:01:56 INFO  separate: htdemucs_6s on cuda', '14:03:31 INFO  separate: done in 95 s', '14:03:32 INFO  analyse: 72 bpm, C major'], setup: ['09:12:01 INFO  checking GPU: NVIDIA GeForce RTX 3060', '09:12:04 INFO  model htdemucs_6s present', '09:12:05 INFO  setup finished'] };
const LOG_ERRORS = { status: 'Failed to load the log (status 500).', offline: 'Failed to load the log — check your connection.' };
const logText = id => Array.from({ length: 6 }, () => LOG_LINES[id]).flat().join('\n');
function logLocation() {
  const state = proto('logsState', 'ok');
  const list = state === 'error' ? '<p class="fmsg is-bad">Failed to load log information.</p>' : state === 'empty' ? '<p class="hint">No log files yet. Logging starts on the first message after launch.</p>'
    : '<div class="logfiles">' + LOG_FILES.map(([n, size, when, d]) => '<div class="logfile"><b class="mono">' + n + '</b><span class="dim">' + size + ' · ' + when + '</span><span>' + d + '</span></div>').join('') + '</div>';
  return '<div class="frow"><div class="frow__l"><b>Log location</b><span>Open the logs in a file manager, or use Export logs.</span></div><div class="frow__c"><button class="btn" data-act="stgLogRefresh">' + icon('refresh-cw', 14) + 'Refresh</button></div></div>'
    + '<p class="mono pathline">' + (state === 'error' ? 'unavailable' : '~/.local/share/StemDeck/logs') + '</p>' + list
    + field('Export logs', 'Every log in one zip, to attach to a bug report.', '<button class="btn" data-act="stgExportLogs" ' + (V.exporting ? 'disabled' : '') + '>' + (V.exporting ? 'Preparing…' : 'Export logs') + '</button>')
    + protoBar([['logsState', 'Location', [['ok', 'Files'], ['empty', 'Empty'], ['error', 'Error']]], ['exportOutcome', 'Export', [['ok', 'Works'], ['fail', 'Fails']]]])
    + '<button class="linkbtn protolink" data-act="stgBootFail">Prototype: show start-up failure</button>';
}
function logView(id) {
  const state = proto('logLoad', 'ok');
  const text = V.logBusy ? 'Loading…' : LOG_ERRORS[state] || logText(id);
  return '<div class="logbar"><span class="hint">The last 60 minutes.</span><div class="sp"></div><button class="btn" data-act="stgLogRefresh">' + icon('refresh-cw', 14) + 'Refresh</button></div>'
    + '<textarea class="logview mono" readonly aria-label="' + id + ' log">' + esc(text) + '</textarea>' + protoBar([['logLoad', 'Loading', [['ok', 'Works'], ['status', 'Status error'], ['offline', 'Offline']]]]);
}
const logsTab = () => '<div class="seg set__subtabs" role="tablist">' + LOG_TABS.map(([id, label]) => '<button role="tab" aria-selected="' + (V.logTab === id) + '" tabindex="' + (V.logTab === id ? 0 : -1) + '" class="' + (V.logTab === id ? 'is-on' : '') + '" data-act="stgLogTab:' + id + '">' + label + '</button>').join('') + '</div>'
  + (V.logTab === 'location' ? logLocation() : logView(V.logTab));
const scrollLogEnd = () => requestAnimationFrame(() => { const el = document.querySelector('.logview'); if (el) el.scrollTop = el.scrollHeight; });
act('stgLogTab', (ctx, id) => { V.logTab = id; scrollLogEnd(); return ['overlays']; });
act('stgLogRefresh', () => { V.logBusy = true; later(BUSY_MS / 2, () => { V.logBusy = false; scrollLogEnd(); }); return ['overlays']; });
act('stgBootFail', () => { S.ui.bootFail = true; S.ui.dialog = null; });
act('stgExportLogs', () => {
  V.exporting = true;
  later(BUSY_MS, () => {
    V.exporting = false;
    if (proto('exportOutcome', 'ok') === 'ok') { S.ui.notices.cards = S.ui.notices.cards.filter(c => c.kind !== 'Export failed'); return; }
    S.ui.error = { message: 'Could not export the logs.' }; pushAlert('Export failed', 'Could not export the logs.');
  });
});

// ── Library ──
const OUT_OF_SYNC = [['Goodness of God (Live)', 'youtube.com', '~/StemData/7f3c9a2e'], ['rehearsal-take-3.wav', 'Upload', '~/StemData/0b81d4c7']];
function syncTable() {
  if (proto('sync', 'some') === 'none') return '<p class="fmsg is-ok">All tracks in sync</p>';
  const rows = OUT_OF_SYNC.map(([n, src, loc]) => '<div class="ostable__r"><span class="ostable__name"><b class="ell" title="' + esc(n) + '">' + esc(n) + '</b><span class="tag">unavailable</span></span><span class="ell dim">' + src + '</span><span class="mono ell dim">' + loc + '</span></div>').join('');
  return '<div class="ostable"><div class="ostable__r ostable__h"><span>Name</span><span>Source</span><span>Location</span></div>' + rows + '</div><p class="fmsg is-bad">' + OUT_OF_SYNC.length + ' tracks are out of sync</p>'
    + '<div><button class="btn" data-act="stgResync" ' + (V.syncing ? 'disabled' : '') + '>' + (V.syncing ? 'Syncing…' : 'Resync out of sync tracks') + '</button></div>' + msg('sync');
}
const libraryTab = () => (proto('libState', 'ok') === 'error' ? '<p class="fmsg is-bad">Could not load the library.</p>' : field('Saved songs', '', '<b class="mono set__count">' + library().length + '</b>'))
  + sub('Out of sync tracks') + syncTable()
  + field('Library file', 'The list of saved songs, to attach to a bug report.', '<button class="btn" data-act="stgLibFile">' + icon('download', 14) + 'Download</button>') + msg('libfile')
  + protoBar([['libState', 'Count', [['ok', 'Loads'], ['error', 'Fails']]], ['sync', 'Out of sync', [['some', 'Two tracks'], ['none', 'None']]]]);
act('stgResync', () => {
  V.syncing = true; V.msg.sync = '';
  later(BUSY_MS, () => { V.syncing = false; if (S.ui.offline) V.msg.sync = 'Sync failed — check your connection.'; else S.ui.dialog = null; });
});
act('stgLibFile', () => { V.msg.libfile = S.ui.offline ? 'Could not download the library file.' : ''; return ['overlays']; });

// ── Shell ──
const RENDER = { appearance: appearanceTab, general: generalTab, song: songTab, network: networkTab, export: exportTab, recording: recordingTab, logs: logsTab, library: libraryTab, about: aboutBody };
// main.js focuses the first .dlg input after each render; this keeps that from scrolling the tab body.
const FOCUS_SINK = '<input class="focussink" tabindex="-1" aria-hidden="true" readonly>';
const navBtn = ([id, label, ic, help]) => '<button role="tab" aria-selected="' + (S.ui.settingsTab === id) + '" tabindex="' + (S.ui.settingsTab === id ? 0 : -1) + '" class="' + (S.ui.settingsTab === id ? 'is-on' : '') + '" data-act="stgTab:' + id + '" data-help="' + esc(help) + '">' + icon(ic, 16) + '<span>' + label + '</span></button>';
registerDialog('settings', d => {
  if (d.arg && !d.tabApplied) { d.tabApplied = true; if (TAB_IDS.includes(d.arg)) S.ui.settingsTab = d.arg; }
  const tab = S.ui.settingsTab;
  return FOCUS_SINK + dlgHead('Settings') + '<div class="set"><nav class="set__nav" role="tablist" aria-orientation="vertical">' + TABS.map(navBtn).join('') + '</nav>'
    + '<div class="set__body" role="tabpanel" data-scroll="settings-' + tab + '">' + RENDER[tab]() + '</div></div>'
    + '<div class="dlg__foot set__foot">' + protoBar([['setup', 'Setup', [['desktop', 'Desktop'], ['server', 'Server']]], ['saves', 'Saves', [['ok', 'Work'], ['refused', 'Refused']]]]) + '<div class="sp"></div><button class="btn btn--accent" data-act="closeDialog">Done</button></div>';
});
act('stgTab', (ctx, id) => { S.ui.settingsTab = id; return ['overlays']; });

const NAV_KEYS = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
function onTabKey(e) {
  const tab = e.target.closest?.('.set [role="tab"]');
  if (!tab) return;
  const list = [...tab.parentElement.querySelectorAll('[role="tab"]')];
  const at = list.indexOf(tab);
  const to = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : NAV_KEYS[e.key] ? (at + NAV_KEYS[e.key] + list.length) % list.length : -1;
  if (to < 0) return;
  e.preventDefault();
  const [name, ...args] = list[to].dataset.act.split(':');
  actions[name]({}, ...args);
  update('overlays');
  const nav = tab.parentElement.classList.contains('set__nav') ? '.set__nav' : '.set__subtabs';
  document.querySelectorAll(nav + ' [role="tab"]')[to]?.focus();
}
document.addEventListener('keydown', onTabKey);
