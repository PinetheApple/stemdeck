// Band merging, the one-time upload and the held list (trackBand.js).
// Run:  node tests/js/track-band.test.mjs

import {
  HELD_DROP,
  HELD_KEEP,
  HELD_SEND,
  bandTagName,
  bandUploadIds,
  foundBandIds,
  heldBandAction,
  isGuessedBand,
  libraryArtist,
  mergedBand,
  sendHeldBand,
  uploadBands,
} from "../../static/js/trackBand.js";

let pass = 0;
let fail = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}`, detail);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const LOCAL = { id: "Q1", name: "Local", englishName: "Local" };
const SERVER = { id: "Q2", name: "Server", englishName: "Server" };

check("libraryArtist keeps a Wikidata item", same(libraryArtist({ ...LOCAL, extra: 1 }), LOCAL));
check("libraryArtist fills missing names", same(libraryArtist({ id: "Q1" }), { id: "Q1", name: "", englishName: "" }));
for (const bad of [null, undefined, "Q1", {}, { id: "1" }, { id: "Q" }, { id: "Q1x" }, { id: "xQ1" }]) {
  check(`libraryArtist refuses ${JSON.stringify(bad)}`, libraryArtist(bad) === null);
}

check("the server's band wins", same(mergedBand(LOCAL, { artist: SERVER }, false), SERVER));
check("no band on the server keeps the local one", mergedBand(LOCAL, { artist: null }, false) === LOCAL);
check("a malformed server band keeps the local one", mergedBand(LOCAL, { artist: { id: "x" } }, false) === LOCAL);
check("a held local band beats a found one", mergedBand(LOCAL, { artist: SERVER, user_band: null }, true) === LOCAL);
check(
  "a band saved on the server beats the hold",
  same(mergedBand(LOCAL, { artist: SERVER, user_band: SERVER }, true), SERVER),
);
check("the hold has nothing to hold on a new track", same(mergedBand(undefined, { artist: SERVER }, true), SERVER));
check("the hold does not keep a malformed band", same(mergedBand({ id: "x" }, { artist: SERVER }, true), SERVER));

const job = (id, fields = {}) => ({ job_id: id, user_band: null, artist: null, ...fields });
const uploads = (tracks, jobs) => bandUploadIds(tracks, jobs);

check("a band the server lacks is sent", same(uploads({ a: { artist: LOCAL } }, [job("a")]), ["a"]));
check(
  "a band differing from the found one is sent",
  same(uploads({ a: { artist: LOCAL } }, [job("a", { artist: SERVER })]), ["a"]),
);
check("a band matching the server's is not sent", same(uploads({ a: { artist: LOCAL } }, [job("a", { artist: LOCAL })]), []));
check(
  "a track already saved on the server is not sent",
  same(uploads({ a: { artist: LOCAL } }, [job("a", { user_band: SERVER, artist: SERVER })]), []),
);
check("a track with no band is not sent", same(uploads({ a: {} }, [job("a")]), []));
check("an invalid id is not sent", same(uploads({ a: { artist: { id: "nope", name: "x" } } }, [job("a")]), []));
check("a track missing from the list is sent, for its 404", same(uploads({ a: { artist: LOCAL } }, []), ["a"]));

const JAY_CHOU = { id: "Q238819", name: "Jay Chou", englishName: "Jay Chou" };
const forbidden = async (name) => {
  throw new Error(`no lookup expected for ${name}`);
};
const answers = (artist) => async () => artist;
const offline = async () => {
  throw new Error("offline");
};
const tagged = (artist, fields = {}) => ({ audioTags: { artist }, ...fields });

check("no tag is no guess, unasked", (await isGuessedBand({}, LOCAL, forbidden)) === false);
check("a name matching the tag is a guess, unasked", (await isGuessedBand(tagged("Local"), LOCAL, forbidden)) === true);
check(
  "a featured artist is ignored in the tag",
  (await isGuessedBand(tagged("Local feat. Someone"), LOCAL, forbidden)) === true,
);
check(
  "the user's artist comes before the tag",
  (await isGuessedBand(tagged("Other", { userArtist: "Local" }), LOCAL, forbidden)) === true,
);
check(
  "a lookup answering the same id is a guess, across scripts",
  (await isGuessedBand(tagged("周杰倫"), JAY_CHOU, answers({ id: JAY_CHOU.id }))) === true,
);
check("a lookup answering another id is a pick", (await isGuessedBand(tagged("Other"), LOCAL, answers(SERVER))) === false);
check("a lookup finding nobody is a pick", (await isGuessedBand(tagged("Other"), LOCAL, answers(null))) === false);
let thrown = false;
await isGuessedBand(tagged("Other"), LOCAL, offline).catch(() => { thrown = true; });
check("a throwing lookup is no answer", thrown);

const noHold = () => {};

function recordingSend(sent) {
  return async (trackId, band) => {
    sent.push([trackId, band.id]);
  };
}

{
  const sent = [];
  const tracks = {
    pick: tagged("Other", { artist: LOCAL }),
    guess: tagged("Local", { artist: LOCAL }),
    gone: { artist: SERVER },
  };
  const finished = await uploadBands(tracks, [job("pick"), job("guess"), job("gone")], {
    lookup: answers(SERVER),
    send: recordingSend(sent),
    hold: noHold,
  });
  check("picks are sent and guesses are not", same(sent, [["pick", "Q1"], ["gone", "Q2"]]), sent);
  check("every track settled is finished", finished === true);
}

{
  const sent = [];
  const tracks = { unknown: tagged("Other", { artist: LOCAL }), rest: { artist: SERVER } };
  const finished = await uploadBands(tracks, [], { lookup: offline, send: recordingSend(sent), hold: noHold });
  check("a throwing lookup does not stop the others", same(sent, [["rest", "Q2"]]), sent);
  check("a throwing lookup leaves it unfinished", finished === false);
}

{
  const sent = [];
  const send = async (trackId, band) => {
    sent.push(trackId);
    if (band.id === LOCAL.id) throw new Error("HTTP 500");
  };
  const finished = await uploadBands({ fails: { artist: LOCAL }, rest: { artist: SERVER } }, [], { lookup: forbidden, send, hold: noHold });
  check("a failed send does not stop the others", same(sent, ["fails", "rest"]), sent);
  check("a failed send leaves it unfinished", finished === false);
}

{
  let running = 0;
  let most = 0;
  const oneAtATime = async (result) => {
    running++;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 1));
    running--;
    return result;
  };
  const tracks = {
    a: tagged("One", { artist: LOCAL }),
    b: tagged("Two", { artist: SERVER }),
    c: tagged("Three", { artist: LOCAL }),
  };
  await uploadBands(tracks, [], { lookup: () => oneAtATime(null), send: () => oneAtATime(), hold: noHold });
  check("lookups and sends run one at a time", most === 1, most);
}

{
  const sent = [];
  const tracks = { a: tagged("Other", { artist: LOCAL }) };
  const lookup = async () => {
    tracks.a.artist = SERVER;
    return null;
  };
  const held = [];
  await uploadBands(tracks, [], { lookup, send: recordingSend(sent), hold: (id) => held.push(id) });
  check("a band changed during the lookup is not overwritten", same(sent, []), sent);
  check("a band changed during the lookup is not held", same(held, []), held);
}

check(
  "a band equal to the found one counts as found",
  same(foundBandIds({ a: { artist: LOCAL } }, [job("a", { artist: LOCAL })]), ["a"]),
);
check(
  "a band saved on the server does not count as found",
  same(foundBandIds({ a: { artist: LOCAL } }, [job("a", { artist: LOCAL, user_band: LOCAL })]), []),
);
check(
  "a band differing from the found one does not count as found",
  same(foundBandIds({ a: { artist: LOCAL } }, [job("a", { artist: SERVER })]), []),
);
check("a track missing from the list does not count as found", same(foundBandIds({ a: { artist: LOCAL } }, []), []));

async function heldBy(tracks, jobs, lookup = forbidden) {
  const held = {};
  const sent = [];
  const finished = await uploadBands(tracks, jobs, {
    lookup,
    send: recordingSend(sent),
    hold: (trackId, entry) => { held[trackId] = entry; },
  });
  return { held, sent, finished };
}

{
  const { held, sent } = await heldBy({ a: tagged("Local", { artist: LOCAL }) }, [job("a")]);
  check("a guess is held with its tag name", same(held, { a: { band: LOCAL, tagName: "Local" } }), held);
  check("a held guess is not sent", same(sent, []), sent);
}
{
  const { held } = await heldBy({ a: tagged("周杰倫", { artist: JAY_CHOU }) }, [job("a")], answers({ id: JAY_CHOU.id }));
  check("a guess by lookup is held", same(held, { a: { band: JAY_CHOU, tagName: "周杰倫" } }), held);
}
{
  const { held, sent, finished } = await heldBy(
    { a: tagged("Other", { artist: LOCAL }) },
    [job("a", { artist: LOCAL })],
  );
  check("a band equal to the found one is held", same(held, { a: { band: LOCAL, tagName: "Other" } }), held);
  check("a band equal to the found one is not sent", same(sent, []), sent);
  check("a held band does not leave the upload unfinished", finished === true);
}
{
  const { held } = await heldBy({ a: { artist: LOCAL } }, [job("a", { artist: LOCAL, audio_tags: { artist: "Read" } })]);
  check("a held band's name can come from the state's tags", held.a?.tagName === "Read", held);
}
{
  const { held, sent } = await heldBy({ a: tagged("Other", { artist: LOCAL }) }, [job("a")], answers(null));
  check("a pick is sent, not held", same(held, {}) && same(sent, [["a", "Q1"]]), { held, sent });
}
{
  const { held } = await heldBy({ a: tagged("Local", { artist: LOCAL }) }, [job("a", { user_band: LOCAL, artist: LOCAL })]);
  check("a band saved on the server is not held", same(held, {}), held);
}
{
  const { held, finished } = await heldBy({ a: tagged("Other", { artist: LOCAL }) }, [job("a")], offline);
  check("an unknown guess is not held", same(held, {}), held);
  check("an unknown guess leaves the upload unfinished", finished === false);
}
{
  const tracks = { a: tagged("Other", { artist: LOCAL }) };
  const { held } = await heldBy(tracks, [job("a")], async () => {
    tracks.a.userArtist = "Renamed meanwhile";
    return { id: LOCAL.id };
  });
  check("a guess by lookup keeps the name it was judged against", held.a?.tagName === "Other", held);
}

check("the tag name is the user's artist first", bandTagName(tagged("Tag", { userArtist: "Mine" })) === "Mine");
check("the tag name drops a featured artist", bandTagName(tagged("Tag feat. Someone")) === "Tag");
check("no name at all is empty", bandTagName({}) === "");
check("a state's user artist replaces the track's", bandTagName({ userArtist: "Old" }, job("a", { user_artist: "New" })) === "New");
check("a state with no user artist restores the tag", bandTagName(tagged("Tag", { userArtist: "Old" }), job("a")) === "Tag");
check(
  "the library's tag comes before the state's",
  bandTagName(tagged("Kept"), job("a", { audio_tags: { artist: "Reread" } })) === "Kept",
);

const ENTRY = { band: LOCAL, tagName: "Local" };
const heldTrack = tagged("Local", { artist: LOCAL });
const action = (state, track = heldTrack) => heldBandAction(ENTRY, track, job("a", state));

check("a saved band drops the entry", action({ user_band: SERVER, artist: SERVER }) === HELD_DROP);
check("the held band saved drops the entry", action({ user_band: LOCAL, artist: LOCAL }) === HELD_DROP);
check("a differing band with the same name sends", action({ artist: SERVER }) === HELD_SEND);
check("a renamed artist drops the entry over a differing band", action({ artist: SERVER, user_artist: "New" }) === HELD_DROP);
check("a renamed artist drops the entry with no band yet", action({ user_artist: "New" }) === HELD_DROP);
check("an artist rename undone drops the entry", heldBandAction(
  { band: LOCAL, tagName: "Mine" },
  tagged("Local", { userArtist: "Mine" }),
  job("a", { artist: SERVER }),
) === HELD_DROP);
check("the same band keeps the entry", action({ artist: LOCAL }) === HELD_KEEP);
check("no band on the server keeps the entry", action({ artist: null }) === HELD_KEEP);
check("a malformed server band keeps the entry", action({ artist: { id: "x" } }) === HELD_KEEP);
check("a featured artist added to the tag is the same name", action({ artist: SERVER, user_artist: "Local ft. Someone" }) === HELD_SEND);

async function sendOutcome(send) {
  const dropped = [];
  const answer = await sendHeldBand("a", ENTRY, { send, drop: (trackId) => dropped.push(trackId) });
  return { dropped, answer };
}

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

{
  const asked = [];
  const { dropped, answer } = await sendOutcome(async (trackId, band) => {
    asked.push([trackId, band.id]);
    return { artist: band, user_band: band };
  });
  check("a held band is sent as itself", same(asked, [["a", "Q1"]]), asked);
  check("a saved held band drops the entry", same(dropped, ["a"]), dropped);
  check("a saved held band answers the state", same(answer?.user_band, LOCAL), answer);
}
{
  const { dropped, answer } = await sendOutcome(async () => { throw httpError(404); });
  check("a 404 drops the entry", same(dropped, ["a"]), dropped);
  check("a 404 answers no state", answer === null);
}
{
  const { dropped, answer } = await sendOutcome(async () => { throw httpError(422); });
  check("a 422 drops the entry", same(dropped, ["a"]), dropped);
  check("a 422 answers no state", answer === null);
}
for (const failure of [httpError(500), httpError(409), new Error("offline")]) {
  const { dropped, answer } = await sendOutcome(async () => { throw failure; });
  check(`${failure.message} keeps the entry`, same(dropped, []), dropped);
  check(`${failure.message} answers no state`, answer === null);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
