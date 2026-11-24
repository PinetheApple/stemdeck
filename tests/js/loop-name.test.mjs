import { loopedSection } from "../../static/js/loopName.js";

let pass = 0;
let fail = 0;
const check = (name, condition) => {
  if (condition) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}`);
  }
};

const sections = [
  { id: "a", start: 0, end: 10 },
  { id: "b", start: 10, end: 20.25 },
];
const on = (start, end) => ({ enabled: true, start, end });

check("a loop over a section's span is that section", loopedSection(on(10, 20.25), sections)?.id === "b");
check("bounds a hair off a section's still match it", loopedSection(on(10.0004, 20.2496), sections)?.id === "b");
check("any other range is no section", loopedSection(on(10, 15), sections) === null);
check("a loop that is off loops no section", loopedSection({ enabled: false, start: 0, end: 10 }, sections) === null);
check("no sections, no section", loopedSection(on(0, 10), []) === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
