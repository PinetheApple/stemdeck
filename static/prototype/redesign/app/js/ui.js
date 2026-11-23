// PROTOTYPE - throwaway. Small HTML helpers shared by every view of the full-UI prototype.
import { ICONS } from '/prototype/icons.js';

const EXTRA = {
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  minus: '<path d="M5 12h14"/>',
  'panel-left': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  'panel-right': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  mic: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  square: '<rect width="16" height="16" x="4" y="4" rx="2"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  text: '<path d="M15 12H3"/><path d="M17 18H3"/><path d="M21 6H3"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  'external-link': '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
};

export const registerIcons = paths => Object.assign(EXTRA, paths);
export const icon = (name, size = 16, cls = '') =>
  `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || EXTRA[name] || ''}</svg>`;

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ENTITIES[ch]);
export const fmt = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const logo = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M3 10v4M7.5 6v12M12 3v18M16.5 7v10M21 10v4"/></svg>';

const THUMB = { sm: 'default', md: 'mqdefault', lg: 'maxresdefault' };
export const coverStyle = (song, size = 'md') => (song && song.cover ? `background-image:url('${song.cover.replace('maxresdefault', THUMB[size])}')` : '');
export const cover = (song, px, size = 'md', extra = '') => `<div class="cover" style="width:${px}px;height:${px}px;${coverStyle(song, size)}">${extra}</div>`;

/** A switch that shows its state; act is the data-act string to run on click. */
export const toggle = (on, act, label = '') => `<button class="switch ${on ? 'is-on' : ''}" role="switch" aria-checked="${!!on}" data-act="${act}" ${label ? `aria-label="${esc(label)}"` : ''}><i></i></button>`;
export const check = (on, act, label) => `<button class="checkrow" role="checkbox" aria-checked="${!!on}" data-act="${act}"><span class="checkbox ${on ? 'is-on' : ''}">${on ? icon('check', 12) : ''}</span>${label}</button>`;
export const emptyState = (ic, title, text = '', extra = '') => `<div class="emptystate">${icon(ic, 28)}<b>${title}</b>${text ? `<span>${text}</span>` : ''}${extra}</div>`;
export const kbd = keys => `<kbd class="kbd">${keys}</kbd>`;
/** A settings-style row: label and hint on the left, a control on the right. */
export const field = (label, hint, control) => `<div class="frow"><div class="frow__l"><b>${label}</b>${hint ? `<span>${hint}</span>` : ''}</div><div class="frow__c">${control}</div></div>`;
export const select = (value, act = 'noop') => `<button class="select" data-act="${act}"><span class="ell">${value}</span>${icon('chevron-down', 14)}</button>`;

/** Menu items: {label, icon, act, checked, disabled, danger, hint} | {heading} | 'sep'. */
export const menuHtml = items => items.map(it => {
  if (it === 'sep') return '<hr>';
  if (it.heading) return `<div class="menu__h">${esc(it.heading)}</div>`;
  return `<button class="${it.danger ? 'is-danger' : ''}" ${it.keep ? 'data-keep' : ''} ${it.disabled ? 'disabled' : ''} data-act="${it.act || 'noop'}" style="${it.indent ? `padding-left:${10 + it.indent * 14}px` : ''}">
    ${it.color ? `<span class="dot" style="background:${it.color}"></span>` : icon(it.checked ? 'check' : it.icon || '', 15)}<span class="ell">${esc(it.label)}</span>${it.hint ? `<span class="menu__hint">${esc(it.hint)}</span>` : ''}</button>`;
}).join('');
