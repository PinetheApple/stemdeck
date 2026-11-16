// A track lane plays its active take, so the export names the track, not the take.

// Keeps the pitch list aligned with the names; the server never transposes a take.
export const TAKE_PITCH = 0;

/**
 * One row per track that has a take to play, ticked unless muted or the user said otherwise.
 * @param {object[]} views  buildTrackViews output
 * @param {(trackId:string) => {volume:number, muted:boolean, soloed:boolean}} mixOf
 * @param {Map<string, boolean>} ticks  the user's own ticks, by track id
 */
export function exportTakeRows(views, mixOf, ticks) {
  return views
    .filter((view) => view.activeTake)
    .map(function exportRow(view) {
      const { volume, muted, soloed } = mixOf(view.id);
      return {
        trackId: view.id,
        name: view.name,
        takeLabel: view.activeTake.label,
        volume,
        muted,
        soloed,
        ticked: ticks.get(view.id) ?? !muted,
      };
    });
}

export function tickedTrackIds(rows) {
  return rows.filter((row) => row.ticked).map((row) => row.trackId);
}

/** While anything is soloed, the mixer plays only soloed takes, so the export does too. */
export function takeLanes(rows, anySolo) {
  return rows
    .filter((row) => row.ticked && row.volume > 0 && (!anySolo || row.soloed))
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

/** The user's ticks, by track id; another song starts from the mute defaults again. */
export function createTickStore() {
  let jobId = null;
  const ticks = new Map();
  return {
    ticks,
    forJob(id) {
      if (id !== jobId) ticks.clear();
      jobId = id;
    },
  };
}
