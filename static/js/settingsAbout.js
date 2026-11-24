// settingsAbout.js — Settings > About: the app's name, version, links, credits,
// licence and "Where your data goes", cloned from <template id="aboutTemplate">.

const TEMPLATE_ID = "aboutTemplate";
const VERSION_ID = "aboutVersion";

/** The version the About tab shows, set once the server has answered. */
export function setAboutVersion(version) {
  const badge = document.getElementById(TEMPLATE_ID)?.content.getElementById(VERSION_ID);
  if (badge) badge.textContent = `v${version}`;
}

export function mountAboutPane(pane) {
  const template = document.getElementById(TEMPLATE_ID);
  if (pane && template) pane.replaceChildren(template.content.cloneNode(true));
}
