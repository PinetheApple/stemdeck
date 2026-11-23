// PROTOTYPE - throwaway. Registries that let each view file plug itself into the shell.
export const tabs = [];
export const dialogs = {};
export const pops = {};
export const menus = {};
export const regions = {};
export const browseViews = {};
/** A right-panel tab: render() returns the tab body. */
export const registerTab = (id, label, render) => { const at = tabs.findIndex(t => t.id === id); if (at >= 0) tabs[at] = { id, label, render }; else tabs.push({ id, label, render }); };
/** A modal: render(params) returns the card's inner HTML; params is S.ui.dialog. */
export const registerDialog = (id, render) => { dialogs[id] = render; };
/** A popover anchored to the button that opened it with data-act="pop:<id>". */
export const registerPop = (id, render) => { pops[id] = render; };
/** A menu opened with data-act="menu:<id>:<args>"; items(...args) returns ui.menuHtml items. */
export const registerMenu = (id, items) => { menus[id] = items; };
/** An extra named region: an element with data-region="<name>" is refilled by render(). */
export const registerRegion = (name, render) => { regions[name] = render; };
/** A view of the Browse library overlay, opened with data-act="browse:<id>". */
export const registerBrowseView = (id, render) => { browseViews[id] = render; };

const hookFns = {};
/** Extra HTML at a named point of another view: 'mainTop' (above the lanes), 'lanes' (after the stem lanes), 'laneOverlay' (inside the lane box, over the waveforms), 'gutter' (left of the sections row). */
export const registerHook = (name, render) => { (hookFns[name] ||= []).push(render); };
export const hooks = name => (hookFns[name] || []).map(fn => fn()).join('');
export { registerIcons } from './ui.js';
