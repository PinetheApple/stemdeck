// PROTOTYPE - throwaway. Hand-offs between view files that were built separately.
import { S, act, actions, update } from './store.js';
import { tabs } from './slots.js';

/** Sync lines in the Lyrics tab shows the lyric lane over the waveforms, and leaving either leaves both. */
const lyMode = actions.lyMode;
if (lyMode) act('lyMode', (ctx, mode) => { const res = lyMode(ctx, mode); S.ui.lyricSync = S.ui.lyrics?.mode === 'sync'; return res === false ? false : undefined; });
const lySyncDone = actions.lySyncDone;
if (lySyncDone) act('lySyncDone', ctx => { lySyncDone(ctx); if (S.ui.lyrics) S.ui.lyrics.mode = null; });

document.addEventListener('keydown', e => {
  const tab = e.target.closest && e.target.closest('.side [role="tab"]');
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!tab || !step || e.altKey) return;
  e.preventDefault();
  const at = tabs.findIndex(t => t.id === S.ui.tab);
  S.ui.tab = tabs[(at + step + tabs.length) % tabs.length].id;
  update('panel', 'main', 'footer');
  document.querySelector('.side [role="tab"][aria-selected="true"]')?.focus();
});
