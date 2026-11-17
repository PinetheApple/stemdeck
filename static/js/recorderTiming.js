// Placing a captured frame on the song, from the engine's own clock mapping, so
// it runs under node and the server alone applies the device round trip.

/**
 * The song position leaving the graph at context time `sec`, uncompensated.
 * `outputSec` is the engine's getCurrentTime() read at context time `nowSec`;
 * the difference to the sources' position there is the graph's own delay.
 */
export function songTimeAtCtx(ctxToSource, nowSec, outputSec, sec) {
  const graphDelay = ctxToSource(nowSec) - outputSec;
  return ctxToSource(sec) - graphDelay;
}
