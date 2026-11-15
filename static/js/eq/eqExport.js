// The EQ and master parts of an export URL.

import { exportFxParam } from "../eqEngine.js";
import { exportMasterParam } from "../masterEngine.js";
import { addExportParams } from "./masterPanelModel.js";

/**
 * Add fx= for these lanes, and master= when mastering is on (the export
 * row's Master box). `master: false` leaves master= out, for the mix query
 * the loudness plan reads.
 */
export function addExportFx(q, laneNames, { master = true } = {}) {
  return addExportParams(q, {
    fx: exportFxParam(laneNames),
    master: master ? exportMasterParam() : "",
  });
}
