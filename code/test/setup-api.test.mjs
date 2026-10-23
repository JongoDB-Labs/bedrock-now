// Bring your setup's routes (server/setup-api.mjs) over a stand-in of import-setup.mjs: the view says whether the page is
// on the computer itself, the requests are only setup's, a preview names items by their keys only, a copy keeps nothing
// (a keep goes through the portal with the password: refused here), and anything else is not this API's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSetupApi } from '../server/setup-api.mjs';

const K1 = 's_0123456789abcdef', K2 = 's_fedcba9876543210';
function fake() {
  const calls = [];
  const setup = {
    index: () => ({ scan: 'a'.repeat(32), at: 1, consent: 'once', project: null, head: { tools: {} }, rows: [{ n: 1 }] }),
    fetchable: () => true,
    staged: () => [{ key: K1 }],
    preview: async (keys, choices) => { calls.push(['preview', keys, choices]); return { digest: 'd'.repeat(64) }; },
    copy: async (units, opts) => { calls.push(['copy', units, opts]); return units.map((u) => ({ keys: u.keys, ok: true })); },
    drop: (key) => { calls.push(['drop', key]); return { ok: true }; },
  };
  const imports = {
    helper: () => ({ running: true, actions: ['setup-scan'], screen: true }),
    requests: () => [{ id: 'b'.repeat(32), action: 'setup-scan', state: 'done' }, { id: 'c'.repeat(32), action: 'sessions-scan', state: 'done' }],
  };
  return { api: makeSetupApi({ setup, imports }), calls };
}
async function route(api, m, p, { q = {}, remote = false, body = null } = {}) {
  let out = null;
  const r = await api.route({ m, p, q: new URLSearchParams(q), remote, readJson: async () => body, send: (status, b) => { out = { status, body: b }; return out; } });
  return r === false ? false : out;
}

test('the view: on the computer or not, setup\'s requests only', async () => {
  const { api } = fake();
  const v = (await route(api, 'GET', '/api/setup')).body;
  assert.equal(v.local, true);
  assert.equal(v.index.fetchable, true);
  assert.deepEqual(v.requests.map((r) => r.action), ['setup-scan']);
  assert.equal((await route(api, 'GET', '/api/setup', { remote: true })).body.local, false);
});

test('a preview by keys only; a copy keeps nothing — a keep needs the portal password; a drop by key', async () => {
  const { api, calls } = fake();
  assert.equal((await route(api, 'GET', '/api/setup/preview', { q: { keys: `${K1},${K2}`, mode: 'append', conflict: 'replace' } })).status, 200);
  assert.deepEqual(calls.at(-1), ['preview', [K1, K2], { mode: 'append', conflict: 'replace' }]);
  await assert.rejects(route(api, 'GET', '/api/setup/preview', { q: { keys: '../x' } }), /bad items/);
  await assert.rejects(route(api, 'GET', '/api/setup/preview', { q: { keys: '' } }), /bad items/);
  const r = await route(api, 'POST', '/api/setup/copy', { body: { units: [{ keys: [K1], mode: 'replace', conflict: 'leave', digest: 'd'.repeat(64), extra: 1 }] }, remote: true });
  assert.equal(r.status, 200);
  // (from another device: said to the copy — a unit with grants is refused there)
  assert.deepEqual(calls.at(-1), ['copy', [{ keys: [K1], mode: 'replace', conflict: 'leave', digest: 'd'.repeat(64), keep: [] }], { remote: true }]);
  await route(api, 'POST', '/api/setup/copy', { body: { units: [{ keys: [K1], digest: 'd'.repeat(64) }] } });
  assert.deepEqual(calls.at(-1)[2], { remote: false });
  await assert.rejects(route(api, 'POST', '/api/setup/copy', { body: { units: [{ keys: [K1], keep: ['v#0123456789abcdef'] }] } }), /portal password/);
  await assert.rejects(route(api, 'POST', '/api/setup/copy', { body: { units: [{ keys: [K1], keep: true }] } }), /portal password/);
  await assert.rejects(route(api, 'POST', '/api/setup/copy', { body: {} }), /units/);
  assert.equal((await route(api, 'DELETE', '/api/setup/staged', { q: { key: K2 } })).status, 200);
  assert.deepEqual(calls.at(-1), ['drop', K2]);
  assert.equal(await route(api, 'GET', '/api/setup/other'), false);
  assert.equal(await route(api, 'POST', '/api/setup'), false);
});
