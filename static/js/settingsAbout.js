const TEMPLATE_ID = "aboutTemplate";
const VERSION_ID = "aboutVersion";

/** Into the template and into an About tab already showing, which is a clone of it. */
export function setAboutVersion(version) {
  const template = document.getElementById(TEMPLATE_ID)?.content;
  for (const badge of [template?.getElementById(VERSION_ID), document.getElementById(VERSION_ID)]) {
    if (badge) badge.textContent = `v${version}`;
  }
}

export function mountAboutPane(pane) {
  const template = document.getElementById(TEMPLATE_ID);
  if (pane && template) pane.replaceChildren(template.content.cloneNode(true));
}
