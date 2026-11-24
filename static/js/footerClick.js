// The footer's Click and Count-in. The Tempo tab's click controls keep the state;
// these drive them and repaint from them, so the two places never disagree.

import { HIDDEN_CLASS, ON_CLASS } from "./footerClasses.js";
import { wirePopover } from "./footerPopover.js";
import { onLanguageChange, plural, t } from "./i18n.js";
import {
  metroBarCustomEl,
  metroBarEl,
  metroBtn,
  metroCountInEl,
  metroGroupEl,
  metroNoteEl,
  metroSoundEl,
  metroVolEl,
  metroVolLabel,
  metronomeCountInBars,
} from "./state.js";
import { $ } from "./utils.js";

/** Fired by transport.js when the click's on state, availability or count-in changes. */
export const CLICK_STATE_EVENT = "clickstate";

const WARN_CLASS = "warn";
const CUSTOM_ACCENT = "custom";
const COUNT_IN_ITEM = "[data-bars]";
const MENU_KEY_STEPS = { ArrowDown: 1, ArrowUp: -1 };

// Each footer control, the Tempo tab control it stands in for, and the event that one listens to.
const proxyPairs = () => [
  [$("t-click-vol"), metroVolEl, "input"],
  [$("t-click-accent"), metroBarEl, "change"],
  [$("t-click-custom"), metroBarCustomEl, "change"],
  [$("t-click-groups"), metroGroupEl, "change"],
  [$("t-click-sound"), metroSoundEl, "change"],
];

function mirrorControl(proxy, source) {
  if (proxy.tagName === "SELECT") proxy.replaceChildren(...[...source.options].map((o) => o.cloneNode(true)));
  proxy.value = source.value;
  proxy.disabled = source.disabled;
  if (source.placeholder) proxy.placeholder = source.placeholder;
  proxy.closest("label").hidden = source.classList.contains(HIDDEN_CLASS);
}

function syncClickOptions() {
  for (const [proxy, source] of proxyPairs()) mirrorControl(proxy, source);
  $("t-click-vol-label").textContent = metroVolLabel?.textContent ?? "";
  const note = $("t-click-note");
  note.textContent = metroNoteEl?.textContent ?? "";
  note.title = metroNoteEl?.title ?? "";
  note.classList.toggle(WARN_CLASS, Boolean(metroNoteEl?.classList.contains(WARN_CLASS)));
}

function forwardTo(source, type) {
  return function onClickOptionChange(e) {
    source.value = e.target.value;
    source.dispatchEvent(new Event(type));
    syncClickOptions();
    if (e.target.value === CUSTOM_ACCENT && source === metroBarEl) $("t-click-custom").focus();
  };
}

function paintCountIn() {
  const bars = metronomeCountInBars;
  $("t-countin-label").textContent = bars ? plural("studio.footer.countInBars", bars) : t("click.countIn");
  $("footerCountIn").classList.toggle(ON_CLASS, bars > 0);
  for (const item of $("t-countin-menu").querySelectorAll(COUNT_IN_ITEM)) {
    item.setAttribute("aria-checked", String(Number(item.dataset.bars) === bars));
  }
}

function paintClick() {
  const button = $("t-click");
  const on = metroBtn.getAttribute("aria-pressed") === "true";
  button.disabled = metroBtn.disabled;
  button.title = metroBtn.title;
  button.setAttribute("aria-pressed", String(on));
  $("footerClick").classList.toggle(ON_CLASS, on);
  paintCountIn();
}

function wireCountInMenu() {
  const menu = $("t-countin-menu");
  const items = () => [...menu.querySelectorAll(COUNT_IN_ITEM)];
  const popover = wirePopover($("t-countin"), menu, {
    onOpen: () => requestAnimationFrame(() => menu.querySelector('[aria-checked="true"]')?.focus()),
  });
  menu.addEventListener("click", function onCountInPick(e) {
    const item = e.target.closest(COUNT_IN_ITEM);
    if (!item) return;
    metroCountInEl.value = item.dataset.bars;
    metroCountInEl.dispatchEvent(new Event("change"));
    popover.close();
    $("t-countin").focus();
  });
  menu.addEventListener("keydown", function onCountInMenuKeydown(e) {
    const step = MENU_KEY_STEPS[e.key];
    if (!step) return;
    e.preventDefault();
    const all = items();
    all[(all.indexOf(document.activeElement) + step + all.length) % all.length]?.focus();
  });
}

/** `toggleMetronome` comes from transport.js, which imports this module and so cannot be imported back. */
export function initFooterClick({ toggleMetronome }) {
  if (!metroBtn) return;
  $("t-click").addEventListener("click", function onFooterClickToggle() {
    toggleMetronome();
  });
  wirePopover($("t-click-more"), $("t-click-panel"), { onOpen: syncClickOptions });
  for (const [proxy, source, type] of proxyPairs()) {
    proxy.addEventListener(proxy.type === "range" ? "input" : "change", forwardTo(source, type));
  }
  wireCountInMenu();
  document.addEventListener(CLICK_STATE_EVENT, paintClick);
  onLanguageChange(paintClick);
  paintClick();
}
