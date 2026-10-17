// The readers at their caps keep their heap bounded: each runs in a child Node process limited to a 1 GB heap
// (test/mem.child.ts). In Chromium a worker that runs out of heap takes the Code page's renderer down with it, so a cap
// that does not bound memory is a way to crash the page with a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const child = path.join(import.meta.dirname, 'mem.child.mjs');

for (const [scenario, want] of [
  ['docx', /^docx: \d+ blocks/],
  ['xlsx', /^xlsx: \d+ rows/],
  ['hyperlinks', /^hyperlinks: 1 rows/],
  ['ods-repeats', /^ods repeats: \d+ rows/],
  ['pptx', /^pptx: \d+ paragraphs/],
  ['notebook', /^notebook: \d+ cells/],
] as const) {
  test(`memory: ${scenario} at its caps finishes within a 1 GB heap`, () => {
    const r = spawnSync(process.execPath, ['--max-old-space-size=1024', child, scenario], { encoding: 'utf8', timeout: 120_000 });
    const out = (r.stdout ?? '').trim();
    assert.equal(r.status, 0, `${scenario}: exit ${r.status} ${r.signal ?? ''} ${(r.stderr ?? '').slice(-400)}`);
    assert.match(out, want);
    console.log(`  ${out}`);
  });
}
