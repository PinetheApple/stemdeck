import { GLOBAL_PITCH_FIELD, globalPitchFromLanes, savedGlobalPitch } from '../../static/js/pitchBus.js';

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

check(
  'the key the lanes were moved to',
  globalPitchFromLanes({ vocals: lane(-2), drums: lane(0), bass: lane(-2), other: lane(-2) }, LANES),
  -2,
);
check(
  'drums never count, they are never moved',
  globalPitchFromLanes({ vocals: lane(3), drums: lane(0), bass: lane(3), other: lane(3) }, LANES),
  3,
);
check(
  'one lane moved on its own does not outvote the rest',
  globalPitchFromLanes({ vocals: lane(1), bass: lane(-2), other: lane(-2) }, LANES),
  -2,
);
check(
  'lanes left in their own key outvote one moved lane',
  globalPitchFromLanes({ vocals: lane(-2), bass: lane(0), other: lane(0) }, LANES),
  0,
);
check(
  'a tie goes to the key nearer the original',
  globalPitchFromLanes({ vocals: lane(3), bass: lane(-1) }, ['vocals', 'bass']),
  -1,
);
check(
  'an equal-distance tie goes to the lower key, whatever the stem order',
  globalPitchFromLanes({ vocals: lane(2), bass: lane(-2) }, ['vocals', 'bass']),
  -2,
);
check(
  'the equal-distance tie read in the other stem order',
  globalPitchFromLanes({ vocals: lane(2), bass: lane(-2) }, ['bass', 'vocals']),
  -2,
);
check(
  'lanes the song does not have are not counted',
  globalPitchFromLanes({ vocals: lane(-2), guitar: lane(5), piano: lane(5) }, LANES),
  -2,
);
check(
  'a key out of range is clamped',
  globalPitchFromLanes({ vocals: lane(-11), bass: lane(-11) }, LANES),
  -6,
);
check('no record is the original key', globalPitchFromLanes(null, LANES), 0);
check('an empty record is the original key', globalPitchFromLanes({}, LANES), 0);
check(
  'lanes that carry no key are the original key',
  globalPitchFromLanes({ vocals: { volume: 1, muted: true } }, LANES),
  0,
);
check('no lane names is the original key', globalPitchFromLanes({ vocals: lane(-2) }, undefined), 0);

check(
  'a saved global key is read as it is',
  savedGlobalPitch({ [GLOBAL_PITCH_FIELD]: -2, vocals: lane(-2), bass: lane(-2) }, LANES),
  -2,
);
check(
  'a saved global key wins over a lane vote that says otherwise',
  savedGlobalPitch({ [GLOBAL_PITCH_FIELD]: -2, vocals: lane(0), bass: lane(-2) }, ['vocals', 'bass']),
  -2,
);
check(
  'a saved global key of 0 is 0, whatever the lanes say',
  savedGlobalPitch({ [GLOBAL_PITCH_FIELD]: 0, vocals: lane(3), bass: lane(3) }, LANES),
  0,
);
check(
  'a saved global key out of range is clamped',
  savedGlobalPitch({ [GLOBAL_PITCH_FIELD]: -11 }, LANES),
  -6,
);
check(
  'a record without a saved global key falls back to the lane vote',
  savedGlobalPitch({ vocals: lane(-2), bass: lane(-2), other: lane(-2) }, LANES),
  -2,
);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
