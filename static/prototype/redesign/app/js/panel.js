// PROTOTYPE - throwaway. The right panel: tabs registered by the panel-*.js files; tabs that do not fit move into More.
import { S } from './store.js';
import { tabs, registerMenu } from './slots.js';
import { icon } from './ui.js';

const label = t => (typeof t.label === 'function' ? t.label() : t.label);
const plain = t => label(t).replace(/<[^>]*>/g, '').trim();
let hidden = [];
registerMenu('tabsMore', () => hidden.map(t => ({ label: plain(t), act: 'tab:' + t.id })));

export function panel() {
  const tab = tabs.find(t => t.id === S.ui.tab) || tabs[0];
  return `<div class="tabs" role="tablist">${tabs.map(t => `<button role="tab" data-tab="${t.id}" aria-selected="${t === tab}" class="${t === tab ? 'is-on' : ''}" data-act="tab:${t.id}">${label(t)}</button>`).join('')}
    <button class="tabs__more" hidden data-act="menu:tabsMore" title="More song tools">More ${icon('chevron-down', 12)}</button></div>
  <div class="panel" data-scroll="panel-${tab.id}">${tab.render()}</div>`;
}

/** Measures the drawn tabs and moves the ones that do not fit into More; the open tab always stays. */
export function fitTabs() {
  const bar = document.querySelector('.side .tabs');
  if (!bar || !bar.clientWidth) return;
  const more = bar.querySelector('.tabs__more');
  const els = [...bar.querySelectorAll('[data-tab]')];
  els.forEach(el => { el.hidden = false; });
  more.hidden = true;
  const style = getComputedStyle(bar);
  const gap = parseFloat(style.columnGap) || 0;
  const avail = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const width = el => el.offsetWidth + gap;
  hidden = [];
  if (els.reduce((sum, el) => sum + width(el), 0) - gap <= avail) return;
  more.hidden = false;
  const active = els.find(el => el.classList.contains('is-on'));
  let used = width(more) + width(active);
  els.forEach(el => {
    if (el === active) return;
    if (used + width(el) <= avail + gap) used += width(el); else { el.hidden = true; hidden.push(tabs.find(t => t.id === el.dataset.tab)); }
  });
  more.title = 'More song tools: ' + hidden.map(plain).join(', ');
}
