// PROTOTYPE - throwaway. Details tab: figures, presence, lead/backing split, file and source.
import { S, STEMS, act, update, playSong, keyName } from './store.js';
import { registerTab, registerMenu } from './slots.js';
import { icon, esc, fmt, emptyState, select } from './ui.js';
import { runProgress } from './panel-lyrics.js';

const COPIED_MS = 1500;
const WAIT_SHARE = 0.15;
const HIGHLIGHT_STABILITY = 80;
const KEY_CONFIDENCE = 82;
const PRESENCE_NAMES = { vocals: 'Global Vocals', drums: 'Drum Intensity', bass: 'Bass Depth', guitar: 'Guitar Presence', piano: 'Piano Presence', other: 'Other' };
const FALLBACK_PRESENCE = { vocals: 100, drums: 84, bass: 61, guitar: 47, piano: 0, other: 22 };
const SPLIT_PRESENCE = { lead: 100, backing: 38 };
const DYNAMICS = [[7, 'Compressed'], [10, 'Moderate'], [14, 'High'], [Infinity, 'Wide']];
const STABILITY = [[90, 'Very Stable'], [70, 'Stable'], [50, 'Moderate'], [0, 'Variable']];
const SPLIT_ERRORS = {
  model: "The vocal split model couldn't be loaded. Try again.",
  memory: 'There was not enough memory to split the vocals. Close other apps, then try again.',
  gpu: "This computer's graphics chip cannot run the vocal split.",
  disk: 'The disk is full. Free up some space, then try again.',
  stalled: 'The vocal split stopped responding. Try again.',
  missing: "This song's vocals are missing. Extract its stems again, then try again.",
  empty: 'The vocal split finished without lead and backing vocals. Try again.',
  other: 'The vocals could not be split. Try again.',
};

const D = (S.ui.details ??= { split: {}, job: null, outcome: 'done', copied: false });
const split = () => D.split[S.playId];

function figures(s) {
  const dr = 8.6;
  const stab = 93;
  const card = (label, value, sub, tip, cls = '') => '<div class="fig ' + cls + '" tabindex="0" title="' + tip + '"><span class="lbl">' + label + '</span><b>' + value + '</b>' + (sub ? '<span class="fig__s">' + sub + '</span>' : '') + '</div>';
  const ring = '<span class="ring" style="--v:' + KEY_CONFIDENCE + '" aria-hidden="true"></span>';
  return '<div class="figs">' +
    card('Key', ring + esc(keyName(s, 0) || 'B minor').replace('maj', 'major').replace('min', 'minor'), '', 'How sure the analysis is of this key: ' + KEY_CONFIDENCE + '%') +
    card('BPM', s.bpm, '', 'The detected tempo') +
    card('LUFS', '−9.8', 'Peak −0.6 dB', 'How loud the song is overall') +
    card('Duration', fmt(s.dur), '', 'Length of the song') +
    card('Dynamic Range', dr, DYNAMICS.find(([max]) => dr < max)[1], 'The gap between the loud and quiet parts, in dB') +
    card('Tempo Stability', stab + '%', STABILITY.find(([min]) => stab >= min)[1], 'How steady the tempo is across the song', stab >= HIGHLIGHT_STABILITY ? 'is-hi' : '') + '</div>';
}
function presence(s) {
  const values = { ...FALLBACK_PRESENCE, ...(s.presence || {}) };
  const rows = STEMS.flatMap(st => (st.id === 'vocals' && split() === 'done'
    ? [['Lead Vocals', SPLIT_PRESENCE.lead, 'vocals'], ['Backing Vocals', SPLIT_PRESENCE.backing, 'vocals']]
    : [[PRESENCE_NAMES[st.id], values[st.id], st.id]]));
  return '<div class="pcard"><div class="pcard__h"><span class="lbl">Presence</span><span class="sp"></span><span class="hint">of the loudest instrument</span></div>' + rows.map(([name, v, id]) =>
    '<div class="pres"><span class="ell">' + name + '</span><span class="pmeter" style="--c:var(--' + id + ')"><i style="width:' + (v || 0) + '%"></i></span><b class="mono">' + (v ? Math.round(v) + '%' : '—') + '</b></div>').join('') + '</div>';
}
function splitCard() {
  const state = split();
  if (state === 'done') return '';
  if (D.job) {
    const waiting = D.job.pct < WAIT_SHARE;
    return '<div class="pcard"><div class="pcard__h"><b>Lead and backing vocals</b></div><div class="pjob"><div class="pjob__t"><span>' + (waiting ? 'Waiting for an import to finish…' : 'Splitting lead and backing vocals…') + '</span><b class="mono">' + Math.round(D.job.pct * 100) + '%</b></div><div class="pbar"><i style="width:' + D.job.pct * 100 + '%"></i></div><button class="btn btn--quiet pbtn" data-act="splitCancel">Cancel</button></div></div>';
  }
  const error = SPLIT_ERRORS[state];
  return '<div class="pcard"><div class="pcard__h"><b>Lead and backing vocals</b></div><p class="hint">Split the vocals into a lead lane and a backing lane.</p>' + (error ? '<p class="perr">' + error + '</p>' : '') +
    '<div class="prow"><button class="btn pbtn" data-act="splitStart">' + icon('audio-waveform', 14) + (error ? 'Try again' : 'Split lead/backing') + '</button><span class="sp"></span><span class="pselect pselect--sm" title="Prototype: how the split ends">' + select('Prototype: ' + (D.outcome === 'done' ? 'finishes' : D.outcome + ' error'), 'menu:splitOutcome') + '</span></div></div>';
}
registerMenu('splitOutcome', () => [{ heading: 'Prototype: how the split ends' }, { label: 'Finishes', checked: D.outcome === 'done', act: 'splitOutcome:done' }, 'sep', ...Object.keys(SPLIT_ERRORS).map(k => ({ label: SPLIT_ERRORS[k], checked: D.outcome === k, act: 'splitOutcome:' + k }))]);

function fileCard() {
  const stems = STEMS.length + (split() === 'done' ? 1 : 0);
  return '<div class="pcard"><div class="pcard__h"><span class="lbl">File</span></div><p class="pfile">' + stems + ' stems · <span class="dim">Format</span> WAV · <span class="dim">Extracted</span> 12 min ago</p></div>';
}
function sourceCard(s) {
  if (!s.source) return '<div class="pcard"><div class="pcard__h"><span class="lbl">Source</span></div><p class="pfile ell">' + esc(s.title) + '.wav</p></div>';
  return '<div class="pcard"><div class="pcard__h"><span class="lbl">Source</span></div><p class="pfile ell mono" title="' + esc(s.source) + '">' + esc(s.source) + '</p>' +
    '<div class="prow"><button class="btn pbtn" data-act="copyLink" title="' + (D.copied ? 'Link copied' : 'Copy link') + '">' + icon(D.copied ? 'check' : 'copy', 14) + (D.copied ? 'Link copied' : 'Copy link') + '</button>' +
    '<a class="btn pbtn" href="' + esc(s.source) + '" target="_blank" rel="noopener" title="Open link">' + icon('external-link', 14) + 'Open link</a></div></div>';
}

registerTab('details', 'Details', () => {
  const s = playSong();
  if (!s) return emptyState('info', 'Open a track to see its details.');
  return figures(s) + presence(s) + splitCard() + fileCard() + sourceCard(s);
});

act('splitOutcome', (ctx, o) => { D.outcome = o; S.ui.menu = null; });
act('splitStart', () => {
  const id = S.playId;
  D.split[id] = 'running';
  D.job = { pct: 0 };
  runProgress(D.job, () => { D.job = null; D.split[id] = D.outcome; update(); }, 0.015);
  return ['panel'];
});
act('splitCancel', () => { D.job.cancelled = true; D.job = null; D.split[S.playId] = 'cancelled'; return ['panel']; });
act('copyLink', () => {
  navigator.clipboard?.writeText(playSong().source).catch(err => console.warn('Copy link failed', err));
  D.copied = true;
  setTimeout(() => { D.copied = false; update('panel'); }, COPIED_MS);
  return ['panel'];
});
