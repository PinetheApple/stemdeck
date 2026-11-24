const WASH_CLASS = "cover-wash";
const HAS_COVER_CLASS = "has-cover";
const IMAGE_PROPERTY = "--cover-wash-image";
const LOADED_CLASS = "loaded";
const WASH_HOSTS = ["lanes", "stageView"];

function mountWash(host) {
  const wash = document.createElement("div");
  wash.className = WASH_CLASS;
  wash.setAttribute("aria-hidden", "true");
  host.prepend(wash);
  return wash;
}

function coverOf(thumb) {
  const src = thumb.getAttribute("src");
  return src && thumb.classList.contains(LOADED_CLASS) ? src : "";
}

function paintWashes(washes, cover) {
  for (const wash of washes) {
    wash.classList.toggle(HAS_COVER_CLASS, Boolean(cover));
    if (cover) wash.style.setProperty(IMAGE_PROPERTY, `url(${JSON.stringify(cover)})`);
    else wash.style.removeProperty(IMAGE_PROPERTY);
  }
}

function initCoverWash() {
  const thumb = document.getElementById("np-thumb");
  const hosts = WASH_HOSTS.map((id) => document.getElementById(id)).filter(Boolean);
  if (!thumb || !hosts.length) return;
  const washes = hosts.map(mountWash);
  function onThumbChange() {
    paintWashes(washes, coverOf(thumb));
  }
  new MutationObserver(onThumbChange).observe(thumb, { attributes: true, attributeFilter: ["src", "class"] });
  onThumbChange();
}

initCoverWash();
