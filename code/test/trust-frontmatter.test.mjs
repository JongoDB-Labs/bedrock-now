// A skill's, command's or agent's front matter and shell commands as Claude Code reads them (server/trust.mjs, the
// trust step's reading — 2.1.296's own patterns, mirrored): the block after any whitespace opener Claude Code takes (a
// \f, a \v, an NBSP, U+2028, U+3000, CRs, blank lines), up to its first "---", a BOM off; grants found there, and in this
// page's plain reading too; anything not the same both ways never plain (never trusted). The shell commands a skill or
// command runs — ```! blocks and !`…` after whitespace, inline code blanked first — each listed. All of it linear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontMatter, ccFrontMatterBlock, shellBlocks, summarize } from '../server/trust.mjs';
import { assertLinear } from './linear.mjs';

const BASH = { key: 'allowed-tools', value: 'Bash(*)' };

test('H1: every opener Claude Code reads — the grants found, never plain unless it is the plain one', () => {
  const body = 'allowed-tools: Bash(*)\npermissionMode: bypassPermissions\n---\nRun it.\n';
  const grants = [BASH, { key: 'permissionMode', value: 'bypassPermissions' }];
  // (Claude Code's own: one BOM off, "---", whitespace as JavaScript's \s up to a line feed)
  for (const [label, opener, plain] of [['plain', '---\n', true], ['trailing spaces', '---   \n', true], ['a tab', '---\t\n', true], ['CRLF', '---\r\n', true],
    ['a BOM', '﻿---\n', true], ['a blank line', '---\n\n', true], ['a form feed', '---\f\n', false], ['a vertical tab', '---\v\n', false],
    ['an NBSP', '--- \n', false], ['U+2028', '--- \n', false], ['U+3000', '---　\n', false], ['CR CR LF', '---\r\r\n', false],
    ['spaces and a form feed', '---  \f  \n', false], ['blank lines of spaces', '---\n  \n\t\n', false]]) {
    const t = `${opener}${body}`;
    assert.notEqual(ccFrontMatterBlock(t), null, `${label}: Claude Code reads a block`);
    const fm = frontMatter(t);
    assert.deepEqual(fm.grants, grants, label);
    assert.equal(fm.plain, plain, label);
  }
  // CRLF throughout: plain, the same grants
  assert.deepEqual(frontMatter('---\r\nallowed-tools: Bash(*)\r\n---\r\nGo.\r\n'), { grants: [BASH], plain: true });
  // a BOM only once: two BOMs and Claude Code reads no front matter — nor does this page
  assert.deepEqual(frontMatter('﻿﻿---\nallowed-tools: Bash(*)\n---\n'), { grants: [], plain: true });
  assert.equal(ccFrontMatterBlock('﻿﻿---\nallowed-tools: Bash(*)\n---\n'), null);
});

test('H1: the block ends at Claude Code\'s first ---; a grant either reading finds is listed; anything off is not plain', () => {
  // (a "---" inside a value: Claude Code's block ends there — this page's plain reading goes on: both said, not plain)
  const inValue = '---\ndescription: before---after\nallowed-tools: Bash(*)\n---\nGo.\n';
  assert.equal(ccFrontMatterBlock(inValue), 'description: before');
  assert.deepEqual(frontMatter(inValue), { grants: [BASH], plain: false });
  // (a closer that is not on a line of its own: Claude Code's ends there, the plain reading finds none)
  assert.deepEqual(frontMatter('---\nallowed-tools: Bash(*)\n  ---\nGo.\n'), { grants: [BASH], plain: false });
  assert.deepEqual(frontMatter('---\nallowed-tools: Bash(*)---\nGo.\n'), { grants: [BASH], plain: false });
  // (starts with --- but Claude Code reads no block: not plain — never trusted)
  for (const t of ['---\nallowed-tools: Bash(*)\n', '---allowed-tools: Bash(*)\n---\n', '--- allowed-tools: Bash(*)\n---\n', '---', '----\n']) {
    assert.equal(frontMatter(t).plain, false, JSON.stringify(t));
  }
  // (a CR alone is a line break to YAML: the grant after it found, not plain)
  assert.deepEqual(frontMatter('---\ndescription: x\rallowed-tools: Bash(*)\n---\n'), { grants: [BASH], plain: false });
  // (a block of more than 64 KiB: not plain)
  assert.equal(frontMatter(`---\nallowed-tools: Bash(*)\ndescription: ${'x'.repeat(70000)}\n---\n`).plain, false);
  // (no front matter at all: nothing, plain)
  assert.deepEqual(frontMatter('# A skill\n\nallowed-tools: Bash(*)\n'), { grants: [], plain: true });
  assert.deepEqual(frontMatter(' ---\nallowed-tools: Bash(*)\n---\n'), { grants: [], plain: true });
  // (a key twice, in another case: not plain)
  assert.equal(frontMatter('---\nallowed-tools: Read\nAllowed-Tools: Bash(*)\n---\n').plain, false);
});

test('shell commands Claude Code runs each time a skill or command is used: ```! blocks and !`…` after whitespace, inline code blanked first', () => {
  const cmds = (t) => shellBlocks(t).map((x) => [x.kind, x.command]);
  assert.deepEqual(cmds('Status: !`git status --short`\n- Log: !`git log -1`'), [['inline', 'git status --short'], ['inline', 'git log -1']]);
  assert.deepEqual(cmds('```!\r\nnpm test\r\nnpm run lint\r\n```\nthen'), [['fenced', 'npm test\nnpm run lint']]);
  // (across lines, as Claude Code's [^`]+ reads it)
  assert.deepEqual(cmds('Run !`echo a\necho b` now'), [['inline', 'echo a\necho b']]);
  // (not after a letter; an empty one skipped; inline code blanked first — a ! inside it runs nothing)
  assert.deepEqual(cmds('a!`no` !`` ok'), []);
  assert.deepEqual(cmds('use `foo !`bar` baz'), []);
  assert.deepEqual(cmds('`code` !`yes`'), [['inline', 'yes']]);
  // (a fenced block with no closing ```: Claude Code runs nothing — listed anyway)
  assert.deepEqual(cmds('```!\nrm -rf /tmp/x\n'), [['fenced', 'rm -rf /tmp/x']]);
  // (a ```! block's own !` inside: both readings, as Claude Code does)
  assert.deepEqual(cmds('```!\nls\n```').length, 1);
  // the trust summary lists them with the file's grants
  const files = [{ name: '.claude/commands/go.md', size: 10, type: 'file', text: '---\nallowed-tools: Bash(git:*)\n---\nStatus: !`git status`\n```!\nmake\n```\n' }];
  assert.deepEqual(summarize(files).files[0].grants, [{ key: 'allowed-tools', value: 'Bash(git:*)' }, { key: 'runs in a shell when used (```!)', value: 'make' },
    { key: 'runs in a shell when used (!`…`)', value: 'git status' }]);
});

test('M-b and the rest: linear in the text — distinct keys in a closed block, whitespace openers, dashes, backticks', () => {
  const keys = (n) => `---\n${Array.from({ length: n }, (_, i) => `key${i}: value ${i}`).join('\n')}\n---\nbody\n`;
  assertLinear(keys, frontMatter, 'distinct keys, a closed block', { start: 1 << 10 });
  assertLinear((n) => `---\n${'tools: x\n'.repeat(n)}---\n`, frontMatter, 'one key again and again');
  assertLinear((n) => `---${' \n'.repeat(n)}x---`, frontMatter, 'an opener of whitespace and line feeds');
  assertLinear((n) => `---${' '.repeat(n * 4)}\n${'-'.repeat(n * 4)}`, frontMatter, 'spaces, then dashes');
  assertLinear((n) => `---\n${'a: b---'.repeat(n)}\n---\n`, frontMatter, '--- inside values');
  assertLinear((n) => `---\n${`k: ${' '.repeat(200)}x\n`.repeat(n / 8)}---\n`, frontMatter, 'runs of spaces inside lines');
  assertLinear((n) => `---\n${'\r'.repeat(n * 4)}---\n`, frontMatter, 'CRs');
  assertLinear((n) => `\`\`\`!${' '.repeat(n * 4)}`, shellBlocks, 'an unclosed ```! and whitespace');
  assertLinear((n) => ' !`'.repeat(n), shellBlocks, '!` again and again');
  assertLinear((n) => '`'.repeat(n * 4), shellBlocks, 'backticks only');
  assertLinear((n) => `!\`${'` x '.repeat(n)}`, shellBlocks, 'inline code spans after !`');
  assertLinear((n) => `${'`a\n'.repeat(n)} !\`x\``, shellBlocks, 'open spans across lines');
  assertLinear((n) => '```!```'.repeat(n), shellBlocks, 'empty fenced blocks');
});
