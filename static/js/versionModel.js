// A song's versions: which stems each one plays, its mix's store key and its automatic name.
// No DOM here, so the node tests can import it.

import { STEM_NAMES } from "./constants.js";

export const DEFAULT_VERSION_ID = "main";
const MIX_KEY_PREFIX = "stemdeck:mix:";
const FIRST_NEW_VERSION = 2;
const MIN_VERSIONS_FOR_ROWS = 2;

/** The default version keeps the key every mix had before versions. */
export function mixStoreKey(jobId, versionId = DEFAULT_VERSION_ID) {
  const songKey = `${MIX_KEY_PREFIX}${jobId}`;
  return versionId === DEFAULT_VERSION_ID ? songKey : `${songKey}:${versionId}`;
}

export function sameLanes(stemsA, stemsB) {
  const a = new Set(stemsA);
  const b = new Set(stemsB);
  return a.size === b.size && [...a].every((name) => b.has(name));
}

export function missingStems(versionStems) {
  const have = new Set(versionStems);
  return STEM_NAMES.filter((name) => !have.has(name));
}

export function versionLabel(version, t) {
  return version.name ?? t("versions.original");
}

/** "Version N", the smallest N from 2 whose name no version uses. */
export function nextVersionName(versions, t) {
  const used = new Set(versions.map((version) => versionLabel(version, t)));
  for (let n = FIRST_NEW_VERSION; ; n++) {
    const name = t("versions.untitled", { n });
    if (!used.has(name)) return name;
  }
}

export function addedName(stems, t) {
  return t("versions.added", { stems: stems.map((name) => t(`stem.${name}`)).join(", ") });
}

export function openVersionOf(track) {
  const versions = track?.versions ?? [];
  return versions.find((version) => version.id === track.openVersion) ?? versions[0] ?? null;
}

export function hasVersionRows(track) {
  return (track?.versions?.length ?? 0) >= MIN_VERSIONS_FOR_ROWS;
}
