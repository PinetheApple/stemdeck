import { t } from "./i18n.js";

const TAG_CLASS = "my-part-tag";
const ROW_CLASS = "is-my-part";
const LABEL_KEY = "studio.myPart.label";
const PLACE_AFTER = "after";
const PLACE_INSIDE = "inside";
// helpMode.js reads a studio lane's name from .mx-name, so the tag sits beside it there.
const LANE_HOSTS = Object.freeze([
  { hostId: "mixer", row: ".lane-header", name: ".mx-name", place: PLACE_AFTER },
  { hostId: "stageMixerStrips", row: ".stage-strip", name: ".stage-strip-name", place: PLACE_INSIDE },
]);

let taggedLanes = [];
const watchedHosts = new Set();

function makeTag() {
  const tag = document.createElement("span");
  tag.className = `${TAG_CLASS} uplabel`;
  tag.dataset.i18n = LABEL_KEY;
  tag.textContent = t(LABEL_KEY);
  return tag;
}

function placeTag(row, spec) {
  const name = row.querySelector(spec.name);
  if (!name) row.append(makeTag());
  else if (spec.place === PLACE_INSIDE) name.append(makeTag());
  else name.after(makeTag());
}

function tagRow(row, spec) {
  const mine = taggedLanes.includes(row.dataset.stem);
  row.classList.toggle(ROW_CLASS, mine);
  const tag = row.querySelector(`.${TAG_CLASS}`);
  if (!mine) tag?.remove();
  else if (!tag) placeTag(row, spec);
}

function tagHost(spec) {
  const host = document.getElementById(spec.hostId);
  if (!host) return;
  if (!watchedHosts.has(spec.hostId)) {
    watchedHosts.add(spec.hostId);
    new MutationObserver(function onRowsChanged() {
      tagHost(spec);
    }).observe(host, { childList: true });
  }
  host.querySelectorAll(spec.row).forEach((row) => tagRow(row, spec));
}

export function tagMyPartLanes(lanes) {
  taggedLanes = lanes;
  LANE_HOSTS.forEach(tagHost);
}
