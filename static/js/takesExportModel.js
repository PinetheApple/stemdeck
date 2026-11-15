// Which recording tracks an export carries; pure, so it can be tested under node.
// A track lane plays its active take, so the export names the track, not the take.

// The server never transposes a take either; the zero keeps the pitch list aligned.
export const TAKE_PITCH = 0;

/**
 * One row per track that has a take to play, ticked unless muted or the user said otherwise.
 * @param {object[]} views  buildTrackViews output
 * @param {(trackId:string) => {volume:number, muted:boolean}} mixOf
 * @param {Map<string, boolean>} ticks  the user's own ticks, by track id
 */
export function exportTakeRows(views, mixOf, ticks) {
  return views
    .filter((view) => view.activeTake)
    .map(function exportRow(view) {
      const { volume, muted } = mixOf(view.id);
      return {
        trackId: view.id,
        name: view.name,
        takeLabel: view.activeTake.label,
        volume,
        muted,
        ticked: ticks.get(view.id) ?? !muted,
      };
    });
}

export function tickedTrackIds(rows) {
  return rows.filter((row) => row.ticked).map((row) => row.trackId);
}

/** The ticked tracks as mix lanes at their own volume; a silent one adds nothing. */
export function takeLanes(rows) {
  return rows
    .filter((row) => row.ticked && row.volume > 0)
    .map((row) => ({ id: row.trackId, gain: row.volume }));
}

/** The stems' mix lists with the take lanes appended. */
export function withTakeLanes(mix, lanes) {
  return {
    names: [...mix.names, ...lanes.map((lane) => lane.id)],
    gains: [...mix.gains, ...lanes.map((lane) => lane.gain)],
    pitches: [...mix.pitches, ...lanes.map(() => TAKE_PITCH)],
  };
}
