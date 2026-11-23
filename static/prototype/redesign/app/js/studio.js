// PROTOTYPE - throwaway. The open song: header, sections, lyric line and the stem lanes.
import { S, STEMS, BARS, viewSong, playSong, viewingOther, dataOf, keyName, activePreset, audible, canViewBack, canViewForward } from './store.js';
import { registerMenu, hooks } from './slots.js';
import { icon, esc, fmt, coverStyle, emptyState } from './ui.js';

const WAVE_BARS = 220;
function wave(env, id) {
  const rects = Array.from({ length: WAVE_BARS }, (_, i) => {
    const h = Math.max(2, env[Math.floor((i / WAVE_BARS) * BARS)] * 96);
    return `<rect x="${i + 0.2}" y="${(50 - h / 2).toFixed(1)}" width="0.6" height="${h.toFixed(1)}" rx="0.3"/>`;
  }).join('');
  const svg = cls => `<svg class="${cls}" viewBox="0 0 ${WAVE_BARS} 100" preserveAspectRatio="none" fill="currentColor">${rects}</svg>`;
  return `<div class="wave" style="--c:var(--${id})">${svg('wave__base')}${svg('wave__played')}</div>`;
}

const db = vol => (vol <= 0 ? '-∞' : (20 * Math.log10(vol / 0.8)).toFixed(1));

const lane = (s, env) => {
  const st = S.stems[s.id];
  const drums = s.id === 'drums';
  return `<div class="lane ${audible(s.id) ? '' : 'is-off'} ${st.mute ? 'is-m' : ''} ${st.solo ? 'is-solo' : ''} ${S.mine === s.id ? 'is-mine' : ''}" data-stem="${s.id}" style="--c:var(--${s.id});--vol:${st.vol / 1.6}">
  <div class="lane__h">
    <div class="lane__main">
      <button class="lane__name" data-act="mute:${s.id}" title="Mute or unmute ${s.name}">${s.name}<small>My part</small></button>
      <button class="ms ms--m" data-act="mute:${s.id}" title="Mute ${s.name}" aria-pressed="${st.mute}">M</button>
      <button class="ms ms--s" data-act="solo:${s.id}" title="Solo ${s.name}" aria-pressed="${st.solo}">S</button>
      <input class="vol" type="range" min="0" max="1.6" step="0.01" value="${st.vol}" data-vol="${s.id}" aria-label="${s.name} volume" title="Drag to set. Double-click to reset.">
      <span class="lane__db mono">${db(st.vol)}</span>
      <button class="iconbtn iconbtn--sm lane__more" data-act="menu:lane:${s.id}" title="More for ${s.name}">${icon('ellipsis', 14)}</button>
    </div>
    <div class="lane__x">
      <button class="xbtn ${S.ui.tab === 'eq' && S.ui.tabArg === s.id && S.ui.panel ? 'is-on' : ''}" data-act="tab:eq:${s.id}" title="${s.name} EQ">${icon('sliders-horizontal', 12)} EQ</button>
      <span class="kstep ${st.key ? 'is-on' : ''} ${drums ? 'is-disabled' : ''}" title="${drums ? 'Drums are never transposed' : 'Transpose this lane: ' + st.key + ' semitones'}"><span class="kstep__l">Key</span><button ${drums ? 'disabled' : ''} data-act="lanekey:${s.id}:-1" aria-label="Transpose ${s.name} down one semitone">${icon('minus', 12)}</button><b class="mono">${st.key > 0 ? '+' + st.key : st.key}</b><button ${drums ? 'disabled' : ''} data-act="lanekey:${s.id}:1" aria-label="Transpose ${s.name} up one semitone">${icon('plus', 12)}</button></span>
      <button class="xbtn" data-act="download:${s.id}" title="Download ${s.name}">${icon('download', 12)} Stem</button>
    </div>
    <div class="meter"><i></i></div>
  </div>
  <div class="lane__w">${wave(env[s.id], s.id)}</div>
</div>`;
};

registerMenu('lane', id => {
  const name = STEMS.find(s => s.id === id).name;
  return [
    { label: name + ' EQ', icon: 'sliders-horizontal', act: 'tab:eq:' + id },
    { label: 'Transpose up a semitone', icon: 'plus', act: 'lanekey:' + id + ':1', disabled: id === 'drums', keep: true },
    { label: 'Transpose down a semitone', icon: 'minus', act: 'lanekey:' + id + ':-1', disabled: id === 'drums', keep: true },
    { label: 'Make this my part', icon: 'user', act: 'mine:' + id },
    'sep',
    { label: 'Download ' + name, icon: 'download', act: 'download:' + id },
  ];
});
registerMenu('view', () => [
  { label: 'Auto-scroll', hint: 'when zoomed in', act: 'flip:autoScroll', checked: S.ui.autoScroll, keep: true },
  { label: 'Sections bar', act: 'flip:sectionsShown', checked: S.ui.sectionsShown, keep: true },
  { label: 'Beat grid', hint: 'with the click on', act: 'toggle:click', checked: S.click, keep: true },
]);
registerMenu('mine', () => STEMS.map(s => ({ label: s.name, color: 'var(--' + s.id + ')', act: 'mine:' + s.id, checked: S.mine === s.id })));

const preset = (id, label) => `<button class="${activePreset() === id ? 'is-on' : ''}" aria-pressed="${activePreset() === id}" data-act="preset:${id}">${label}</button>`;

function sections(d, live) {
  if (!S.ui.sectionsShown) return `<button class="linkbtn" data-act="flip:sectionsShown">${icon('chevron-down', 13)} Show sections</button>`;
  return `<div class="secs">${d.sections.map((sec, i) => `<div class="sec ${live && i === S.secIdx ? 'is-current' : ''} ${live && S.loopOn && S.loop && S.loop.i === i ? 'is-looped' : ''}" role="button" data-sec="${i}" ${live ? `data-act="sec:${i}" data-dbl="renameSection:${i}"` : ''} style="--w:${sec.share * 100}" title="Jump to ${esc(sec.name)}">
    <span class="ell">${esc(sec.name)}</span>${sec.locked ? icon('lock', 11) : ''}<span class="sec__t mono">${fmt(sec.a)}</span>${live ? `<button class="sec__loop" data-act="loopsec:${i}" title="Loop ${esc(sec.name)}">${icon('repeat', 13)}</button>` : ''}</div>`).join('')}</div>`;
}

function head(s, preview) {
  const many = s.versions.length > 1;
  return `<div class="head">
    <div class="navpair"><button class="iconbtn iconbtn--sm" ${canViewBack() ? '' : 'disabled'} data-act="viewBack" title="Back to the song you looked at before (Alt ←)">${icon('chevron-left', 18)}</button><button class="iconbtn iconbtn--sm" ${canViewForward() ? '' : 'disabled'} data-act="viewForward" title="Forward (Alt →)">${icon('chevron-right', 18)}</button></div>
    <div class="cover" style="width:56px;height:56px;border-radius:12px;${coverStyle(s, 'md')}"></div>
    ${preview ? `<button class="playbtn playbtn--sm" data-act="open:${s.id}" title="Play this song">${icon('play', 18, 'ic--fill')}</button>` : ''}
    <div class="head__txt"><button class="head__title ell" data-act="dialog:rename:${s.id}" title="Rename this song">${esc(s.title)}</button>
      <div class="head__meta"><span class="ell">${esc(s.artist)}</span>
        ${many ? `<button class="tag tag--btn" data-act="pop:versions" title="Version: ${esc(s.versions.find(v => v.id === s.version).name)}">${esc(s.versions.find(v => v.id === s.version).name)} ${icon('chevron-down', 11)}</button>` : ''}
        <span class="tag" title="Key">${esc(keyName(s, preview ? 0 : S.key))}</span><span class="tag" title="Tempo">${Math.round(s.bpm * (preview ? 1 : S.speed))} BPM</span><span class="tag" title="Length">${fmt(s.dur)}</span></div></div>
    <button class="iconbtn ${s.fav ? 'is-fav' : ''}" aria-pressed="${s.fav}" data-act="fav:${s.id}" title="${s.fav ? 'Remove from Favorites' : 'Add to Favorites'}">${icon('heart', 18, s.fav ? 'ic--fill' : '')}</button>
    <button class="iconbtn" data-act="dialog:aboutSong:${s.id}" title="About this song">${icon('info', 18)}</button>
    <button class="iconbtn" ${S.upNext.includes(s.id) || s.id === S.playId ? 'disabled' : ''} data-act="upnext:${s.id}" title="Add to Up Next">${icon('list-plus', 18)}</button>
    <button class="iconbtn" data-act="menu:song:${s.id}:head" title="More">${icon('ellipsis', 18)}</button>
    <button class="btn" data-act="pop:export" title="Export the mix or the stems">${icon('download')} Export</button>
    <button class="btn" data-act="flip:stage" title="Full-screen view to play along from (F)">${icon('maximize-2')} Stage mode</button>
  </div>`;
}

const errorBox = () => (S.ui.error ? `<div class="errbox" role="alert">${icon('alert', 18)}<div><b>${esc(S.ui.error.message)}</b>${S.ui.error.detail ? `<span>${esc(S.ui.error.detail)}</span>` : ''}</div><div class="sp"></div>
  ${S.ui.error.retry ? '<button class="btn" data-act="dismissError">Try again</button>' : ''}<button class="iconbtn" data-act="dismissError" title="Dismiss">${icon('x', 16)}</button></div>` : '');

const previewBar = () => `<div class="previewbar">${icon('info', 15)}<span>You are looking at this song. <b>${esc(playSong().title)}</b> keeps playing.</span><div class="sp"></div>
  <button class="btn btn--quiet" data-act="showPlaying">Back to the playing song</button><button class="btn btn--accent" data-act="open:${S.viewId}">${icon('play', 13, 'ic--fill')} Play this song</button></div>`;

const startCard = () => `<div class="startcard">${emptyState('music', 'Start with a song', 'Paste links, or drop files or a folder anywhere in the window.', `<div class="startcard__btns">
  <button class="btn" data-act="pop:add">${icon('upload')} Choose files</button><button class="btn" data-act="pop:add">${icon('folder')} Choose a folder</button><button class="btn" data-act="pop:add">${icon('link')} Paste links</button>
  <button class="btn btn--accent" data-act="browse:all">${icon('library')} Browse library</button></div>`)}</div>`;

export function studio() {
  const s = viewSong();
  if (!s) return errorBox() + startCard();
  const d = dataOf(s.id);
  const preview = viewingOther();
  return `<div class="wash" style="${coverStyle(s, 'md')}"></div>${errorBox()}${preview ? previewBar() : ''}${head(s, preview)}
  <div class="top">
    <div class="gut">
      <div class="gut__row"><button class="pill" data-act="menu:mine" title="Pick the part you play">${icon('user', 14)} <span class="gut__lbl">My part:</span> <b>${STEMS.find(x => x.id === S.mine).name}</b> ${icon('chevron-down', 13)}</button><div class="sp"></div>
        <button class="btn gutbtn" data-act="pop:sections" title="Add, clear or hide sections">Sections</button>
        <button class="btn gutbtn" data-act="menu:view" title="What the lanes show">View ${icon('chevron-down', 12)}</button></div>
      <div class="seg">${preset('full', 'Full band')}${preset('minus', 'Without me')}${preset('only', 'Only me')}</div>
    </div>
    <div class="tl">${sections(d, !preview)}<div class="ticker"><b data-b="ly-cur"></b><span data-b="ly-next"></span></div></div>
  </div>
  ${hooks('mainTop')}
  <div class="lanebox" data-scroll="lanes"><div class="lanebox__in">
    <div class="cols">${d.sections.map((sec, i) => `<div class="col ${!preview && i === S.secIdx ? 'is-current' : ''}" data-sec="${i}" style="--w:${sec.share * 100}"></div>`).join('')}</div>
    ${STEMS.map(st => lane(st, d.env)).join('')}${preview ? '' : hooks('lanes')}
    <div class="loopband"></div><div class="lanes__ph"></div>${preview ? '' : hooks('laneOverlay')}
    <div class="wavearea" data-wavearea title="Click to move the playhead. Drag to loop a region."></div>
  </div></div>`;
}
