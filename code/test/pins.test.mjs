// The Agent SDK moves in lock-step with the terminal's Claude Code: the SDK's claudeCodeVersion (npm metadata) must
// be exactly the version terminal/claude-code pins, and both lockfiles must name the same patch number (0.3.N ↔ 2.1.N).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HERE, TERMINAL_DIR } from './helpers.mjs';

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('the SDK and the terminal\'s Claude Code are one pair', () => {
  const sdkPin = read(path.join(HERE, '../package.json')).dependencies['@anthropic-ai/claude-agent-sdk'];
  const sdk = read(path.join(HERE, '../node_modules/@anthropic-ai/claude-agent-sdk/package.json'));
  const cli = read(path.join(TERMINAL_DIR, 'claude-code/package.json')).dependencies['@anthropic-ai/claude-code'];
  assert.match(sdkPin, /^[0-9]+\.[0-9]+\.[0-9]+$/, 'the SDK pinned to an exact version');
  assert.equal(sdk.version, sdkPin);
  assert.equal(sdk.claudeCodeVersion, cli, `SDK ${sdk.version} is made for Claude Code ${sdk.claudeCodeVersion}; the terminal pins ${cli}`);
  assert.equal(sdkPin.split('.')[2], cli.split('.')[2]);
  const lock = read(path.join(HERE, '../package-lock.json')).packages;
  assert.equal(lock['node_modules/@anthropic-ai/claude-agent-sdk'].version, sdkPin);
  assert.match(lock['node_modules/@anthropic-ai/claude-agent-sdk'].integrity, /^sha512-/);
  assert.match(lock['node_modules/ws'].integrity, /^sha512-/);
  assert.deepEqual(Object.keys(read(path.join(HERE, '../package.json')).dependencies).sort(), ['@anthropic-ai/claude-agent-sdk', 'ws']);
});
