// The desktop network switch. The desktop backend listens on loopback only
// while "Make StemDeck available on your network" is off, so a change applies
// only once the shell has restarted it on the new address. The page saves the
// choice, which the shell reads before spawning, asks for the restart, then
// reloads on the URL the shell answers with: the same port, so nothing kept
// per origin is lost.
//
// Turning it off is saved first, so other devices are refused at once even if
// the restart waits. Turning it on is saved only once the restart goes ahead.
// A restart stops a running separation, which then waits in the queue,
// paused, so that is asked first.

import { t as i18nT, applyTranslations } from "./i18n.js";

const SETTINGS_URL = "/api/settings";
const QUEUE_URL = "/api/queue";
const RESTART_COMMAND = "restart_backend";
const ESCAPE_KEY = "Escape";

const DIALOG_HTML = `
  <div class="reset-confirm-card" role="dialog" aria-modal="true" tabindex="-1" aria-label="Restart StemDeck now?" data-i18n-aria-label="settings.network.restartTitle">
    <div class="reset-confirm-title" data-i18n="settings.network.restartTitle">Restart StemDeck now?</div>
    <p class="reset-confirm-body net-restart-body" role="status" aria-live="polite"></p>
    <div class="reset-confirm-msg" role="alert" aria-live="polite"></div>
    <div class="reset-confirm-actions">
      <button class="reset-confirm-cancel net-restart-cancel" type="button" data-i18n="settings.network.restartCancel">Not now</button>
      <button class="reset-confirm-go net-restart-go" type="button" data-i18n="settings.network.restartNow">Restart now</button>
      <button class="reset-confirm-go net-restart-retry" type="button" data-i18n="settings.network.tryAgain">Try again</button>
    </div>
  </div>
`;

/** On only when the choice is both saved and listening, so a restart that has
 *  not happened yet never shows as applied. A server reports null. */
export function networkSwitchOn(settings) {
  return settings.allow_network === true && settings.network_listening !== false;
}

/** Whether a separation is running. Unknown counts as running, so a restart
 *  never stops one without asking. */
async function separationRunning() {
  try {
    const r = await fetch(QUEUE_URL, { cache: "no-store" });
    if (r.ok) return (await r.json()).running != null;
    console.warn("queue check failed:", r.status);
  } catch (err) {
    console.warn("queue check failed:", err);
  }
  return true;
}

function errorText(err) {
  return String(err?.message || err);
}

class NetworkRestartDialog {
  constructor(want, resolve) {
    this.want = want;
    this.resolve = resolve;
    this.saved = false;
    this.confirmed = false;
    this.overlay = document.createElement("div");
    this.overlay.className = "reset-confirm-backdrop";
    this.overlay.innerHTML = DIALOG_HTML;
    applyTranslations(this.overlay);
    const find = (selector) => this.overlay.querySelector(selector);
    this.card = find(".reset-confirm-card");
    this.title = find(".reset-confirm-title");
    this.body = find(".net-restart-body");
    this.msg = find(".reset-confirm-msg");
    this.cancelBtn = find(".net-restart-cancel");
    this.goBtn = find(".net-restart-go");
    this.retryBtn = find(".net-restart-retry");
    this.onKeydown = this.onKeydown.bind(this);
    this.close = this.close.bind(this);
    this.onGo = this.onGo.bind(this);
    this.onRetry = this.onRetry.bind(this);
  }

  open() {
    this.cancelBtn.addEventListener("click", this.close);
    this.goBtn.addEventListener("click", this.onGo);
    this.retryBtn.addEventListener("click", this.onRetry);
    // Captured, so it is heard before Settings' own Esc closes everything behind it.
    document.addEventListener("keydown", this.onKeydown, true);
    document.body.appendChild(this.overlay);
    this.begin();
  }

  // The attribute, not the class: .hidden only applies inside .daw, and this
  // dialog sits on body, above Settings.
  show({ text = "", error = "", ask = false, retry = false }) {
    this.title.hidden = !ask;
    this.goBtn.hidden = !ask;
    this.retryBtn.hidden = !retry;
    this.cancelBtn.hidden = !ask && !retry;
    this.body.textContent = text;
    this.msg.textContent = error;
    (ask ? this.goBtn : retry ? this.retryBtn : this.card).focus();
  }

  close() {
    document.removeEventListener("keydown", this.onKeydown, true);
    this.overlay.remove();
    this.resolve(this.saved);
  }

  onKeydown(e) {
    if (e.key !== ESCAPE_KEY) return;
    e.preventDefault();
    e.stopPropagation();
    if (!this.cancelBtn.hidden) this.close();
  }

  onGo() {
    this.confirmed = true;
    this.restart();
  }

  onRetry() {
    if (this.confirmed) this.restart();
    else this.begin();
  }

  async save() {
    try {
      const r = await fetch(SETTINGS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allow_network: this.want }),
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
      this.saved = true;
    } catch (err) {
      console.warn("network setting save failed:", err);
      this.show({ error: i18nT("settings.network.saveFailed", { error: errorText(err) }), retry: true });
    }
    return this.saved;
  }

  async begin() {
    this.show({});
    if (!this.want && !this.saved && !(await this.save())) return;
    if (await separationRunning()) {
      const key = this.want ? "settings.network.restartJobConfirm" : "settings.network.restartJobConfirmOff";
      this.show({ text: i18nT(key), ask: true });
      return;
    }
    this.confirmed = true;
    await this.restart();
  }

  async restart() {
    this.show({ text: i18nT("settings.network.restarting") });
    if (!this.saved && !(await this.save())) return;
    try {
      const { url } = await window.__TAURI__.core.invoke(RESTART_COMMAND);
      window.location.replace(url);
    } catch (err) {
      console.warn("network restart failed:", err);
      this.show({ error: i18nT("settings.network.restartFailed", { error: errorText(err) }), retry: true });
    }
  }
}

/** Save the network choice and restart the backend so it listens where the
 *  choice says. Resolves, when the dialog closes without a reload, with
 *  whether the choice was saved. */
function restartForNetwork(want) {
  return new Promise((resolve) => new NetworkRestartDialog(want, resolve).open());
}

/** Run a change of the switch through the restart. The switch moves only
 *  once the restart has applied, and stays disabled while the dialog is open,
 *  so one change is one restart. */
export async function applyNetworkSwitch(input) {
  const want = input.checked;
  input.checked = !want;
  input.disabled = true;
  const saved = await restartForNetwork(want);
  // Reached only when the dialog closed without a reload. A saved "off"
  // already refuses other devices, so the switch says off.
  input.checked = !want && !saved;
  input.disabled = false;
  input.focus();
}
