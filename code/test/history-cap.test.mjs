// A transcript the sandbox crafts to make the SDK's chain builder slow (many compaction boundaries × many entries on
// one anchor): what reaches getSessionMessages is capped first (api.mjs capEntries), so reading its history stays fast
// and never stalls this process's event loop for long.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApi, capEntries, HISTORY_ENTRIES, HISTORY_BOUNDARIES } from '../server/api.mjs';

const SID = '11111111-1111-4111-8111-111111111111';
function crafted(K = 8000, N = 40000) {
  const entries = [];
  for (let i = 0; i < N; i++) entries.push({ type: 'user', uuid: `u${i}`, parentUuid: 'A0', sessionId: SID, message: { role: 'user', content: 'x' } });
  for (let i = 0; i < K; i++) {
    entries.push({ type: 'system', subtype: 'compact_boundary', uuid: `b${i}`, sessionId: SID,
      compactMetadata: { preservedSegment: { headUuid: 'u0', anchorUuid: `A${i % 2}`, tailUuid: `A${(i + 1) % 2}` } } });
  }
  return entries;
}

test('capEntries: the last 20,000 entries, at most 50 compaction boundaries (the latest), flagged', () => {
  const { list, cut } = capEntries(crafted());
  assert.equal(cut, true);
  assert.ok(list.length <= HISTORY_ENTRIES);
  assert.equal(list.filter((e) => e.subtype === 'compact_boundary').length, HISTORY_BOUNDARIES);
  assert.equal(list.at(-1).uuid, 'b7999', 'the latest boundary stays');
  const small = [{ type: 'user', uuid: 'a' }, 'junk', null, [1], { no: 'type' }];
  assert.deepEqual(capEntries(small), { list: [{ type: 'user', uuid: 'a' }], cut: false });
});

test('a crafted transcript: the history answers fast, the event loop keeps turning', async () => {
  const entries = crafted();
  const call = async (req) => ({ result: req.op === 'sessions.load' ? { entries, truncated: false } : {} });
  const api = makeApi({ call, sessions: { list: () => [], get: () => null } });
  let maxGap = 0, last = Date.now();
  const iv = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10);
  const t0 = Date.now();
  const r = await api.messages(SID, 0, 100);
  clearInterval(iv);
  const took = Date.now() - t0;
  assert.ok(took < 2000, `took ${took} ms`);
  assert.ok(maxGap < 1000, `event loop stalled ${maxGap} ms`);
  assert.equal(r.truncated, true);
});
