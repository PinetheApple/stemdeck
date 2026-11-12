// The global key a song opens at, read back from its saved lanes.
//
// The saved mix holds only absolute lane keys, and the global control moves
// every lane but drums by the same amount, so the lanes say where it was left.
//
// Run:  node tests/js/global-pitch-from-lanes.test.mjs

import { globalPitchFromLanes } from '../../static/js/pitchBus.js';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  -- expected ${expected}, got ${actual}`);
  }
}

const lane = (pitch) => ({ volume: 1, muted: false, soloed: false, pitch });
const LANES = ['vocals', 'drums', 'bass', 'other'];

check('the key the lanes were moved to',
  globalPitchFromLanes({ vocals: lane(-2), drums: lane(0), bass: lane(-2), other: lane(-2) }, LANES), -2);
check('drums never count, they are never moved',
  globalPitchFromLanes({ vocals: lane(3), drums: lane(0), bass: lane(3), other: lane(3) }, LANES), 3);
check('one lane moved on its own does not outvote the rest',
  globalPitchFromLanes({ vocals: lane(1), bass: lane(-2), other: lane(-2) }, LANES), -2);
check('a tie goes to the key nearer the original',
  globalPitchFromLanes({ vocals: lane(3), bass: lane(-1) }, ['vocals', 'bass']), -1);
check('lanes the song does not have are not counted',
  globalPitchFromLanes({ vocals: lane(-2), guitar: lane(5), piano: lane(5) }, LANES), -2);
check('a key out of range is clamped',
  globalPitchFromLanes({ vocals: lane(-11), bass: lane(-11) }, LANES), -6);
check('lanes all in their own key are the original key',
  globalPitchFromLanes({ vocals: lane(0), bass: lane(0) }, LANES), 0);
check('no record is the original key', globalPitchFromLanes(null, LANES), 0);
check('an empty record is the original key', globalPitchFromLanes({}, LANES), 0);
check('lanes that carry no key are the original key',
  globalPitchFromLanes({ vocals: { volume: 1, muted: true } }, LANES), 0);
check('no lane names is the original key',
  globalPitchFromLanes({ vocals: lane(-2) }, undefined), 0);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
