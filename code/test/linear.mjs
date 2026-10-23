// assertLinear(make, run, label) — does run take time in proportion to its input? make(n) builds an input of about n
// units; the input is grown until run on it takes 20 ms or more (a time a clock can tell; at most max units), then run
// on 8 times that input is timed against it: about 8× for a linear shape, 64× for a quadratic one. Each the fastest of
// three runs taken in turn (a busy machine slows both alike, where a limit in seconds would fail); at most 16× passes,
// and a miss is measured once more before it counts. Run these files one at a time (node --test
// --test-concurrency=1): another test file's work at the same moment is noise.
import assert from 'node:assert/strict';

const time = (run, input) => { const t0 = performance.now(); run(input); return performance.now() - t0; };

export function assertLinear(make, run, label, { start = 1 << 12, max = 1 << 19 } = {}) {
  let n = start, small = make(n);
  while (time(run, small) < 20 && n < max) { n *= 2; small = make(n); }
  const large = make(n * 8);
  let q = Infinity, w = Infinity;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 3; i++) {
      q = Math.min(q, time(run, small));
      w = Math.min(w, time(run, large));
    }
    if (w <= 16 * Math.max(q, 2)) return;
  }
  assert.fail(`${label}: ${Math.round(w)} ms at 8× the input, ${Math.round(q)} ms at 1× — not linear`);
}
