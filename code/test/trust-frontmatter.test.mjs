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
    ['a BOM', '\uFEFF---\n', true], ['a blank line', '---\n\n', true], ['a form feed', '---\f\n', false], ['a vertical tab', '---\v\n', false],
    ['an NBSP', '---\u00a0\n', false], ['U+2028', '---\u2028\n', false], ['U+3000', '---\u3000\n', false], ['CR CR LF', '---\r\r\n', false],
    ['spaces and a form feed', '---  \f  \n', false], ['blank lines of spaces', '---\n  \n\t\n', false]]) {
    const t = `${opener}${body}`;
    assert.notEqual(ccFrontMatterBlock(t), null, `${label}: Claude Code reads a block`);
    const fm = frontMatter(t);
    assert.deepEqual(fm.grants, grants, label);
    assert.equal(fm.plain, plain, label);
  }
  // CRLF throughout: plain, the same grants
  assert.deepEqual(frontMatter('---\r\nallowed-tools: Bash(*)\r\n---\r\nGo.\r\n'), { grants: [BASH], plain: true });
  // a BOM only once: two BOMs and Claude Code reads no front matter — this page reads its grants all the same, never plain
  assert.deepEqual(frontMatter('\uFEFF\uFEFF---\nallowed-tools: Bash(*)\n---\n'), { grants: [BASH], plain: false });
  assert.deepEqual(frontMatter('\uFEFF\uFEFF\uFEFF---\nallowed-tools: Bash(*)\n---\n'), { grants: [BASH], plain: false });
  assert.deepEqual(frontMatter('\uFEFF\uFEFF# no front matter'), { grants: [], plain: true });
  assert.equal(ccFrontMatterBlock('\uFEFF\uFEFF---\nallowed-tools: Bash(*)\n---\n'), null);
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
  for (const t of ['---\nallowed-tools: Bash(*)\n', '---allowed-tools: Bash(*)\n---\n', '---\u2028allowed-tools: Bash(*)\n---\n', '---', '----\n']) {
    assert.equal(frontMatter(t).plain, false, JSON.stringify(t));
  }
  // (a CR alone is a line break to YAML: the grant after it found, not plain)
  assert.deepEqual(frontMatter('---\ndescription: x\rallowed-tools: Bash(*)\n---\n'), { grants: [BASH], plain: false });
  // (a block of more than 64 KiB: not plain)
  assert.equal(frontMatter(`---\nallowed-tools: Bash(*)\ndescription: ${'x'.repeat(70000)}\n---\n`).plain, false);
  // (no front matter at all: nothing, plain)
  assert.deepEqual(frontMatter('# A skill\n\nallowed-tools: Bash(*)\n'), { grants: [], plain: true });
  assert.deepEqual(frontMatter(' ---\nallowed-tools: Bash(*)\n---\n'), { grants: [], plain: true });
  // (a control character in the block but a tab or a line break — or a NEL, a line break to some YAML parsers: not plain,
  // the grant after it found)
  for (const c of ['\x00', '\x01', '\x0b', '\x0c', '\x1b', '\x1f', '\x85']) {
    assert.equal(frontMatter(`---\ndescription: a${c}b\nallowed-tools: Bash(*)\n---\n`).plain, false, JSON.stringify(c));
  }
  assert.deepEqual(frontMatter('---\ndescription: a\x85\nallowed-tools: Bash(*)\n---\n'), { grants: [BASH], plain: false });
  // (a key twice, in another case: not plain)
  assert.equal(frontMatter('---\nallowed-tools: Read\nAllowed-Tools: Bash(*)\n---\n').plain, false);
});

test('shell commands Claude Code runs each time a skill or command is used: ```! blocks and !`…` after whitespace, inline code blanked first', () => {
  const cmds = (t) => shellBlocks(t).list.map((x) => [x.kind, x.command]);
  assert.deepEqual(cmds('Status: !`git status --short`\n- Log: !`git log -1`'), [['inline', 'git status --short'], ['inline', 'git log -1']]);
  assert.deepEqual(cmds('```!\r\nnpm test\r\nnpm run lint\r\n```\nthen'), [['fenced', 'npm test\nnpm run lint']]);
  // (across lines, as Claude Code's [^`]+ reads it)
  assert.deepEqual(cmds('Run !`echo a\necho b` now'), [['inline', 'echo a\necho b']]);
  // (not after a letter; an empty one skipped; inline code blanked first — a ! inside it runs nothing)
  assert.deepEqual(cmds('a!`no` !`` ok'), []);
  assert.deepEqual(cmds('use `foo !`bar` baz'), []);
  assert.deepEqual(cmds('`code` !`yes`'), [['inline', 'yes']]);
  // (a fenced block with no closing ```: Claude Code runs nothing — listed anyway)
  assert.deepEqual(cmds('```!\nrm -rf /tmp/x\n'), [['open', 'rm -rf /tmp/x']]);
  // (a ```! block's own !` inside: both readings, as Claude Code does)
  assert.deepEqual(cmds('```!\nls\n```').length, 1);
  // the trust summary lists them with the file's grants
  const files = [{ name: '.claude/commands/go.md', size: 10, type: 'file', text: '---\nallowed-tools: Bash(git:*)\n---\nStatus: !`git status`\n```!\nmake\n```\n' }];
  assert.deepEqual(summarize(files).files[0].grants, [{ key: 'allowed-tools', value: 'Bash(git:*)' }, { key: 'runs in a shell when used (```!)', value: 'make' },
    { key: 'runs in a shell when used (!`…`)', value: 'git status' }]);
});

// Claude Code 2.1.296's own code, copied from its binary (the oracle — never used by the server; its patterns are
// quadratic on some inputs, so only small ones here): si (Gb, Pv) gives the body a skill's or command's shell commands
// are found in — its content —; cOe blanks inline code, gVn and hVn find the commands, Gtr lists them, with their places.
// blank: cOe — or, for the second reading, the lookbehind one (a span right after ! or ` not matched)
const BOM = String.fromCharCode(0xfeff), LS = String.fromCharCode(0x2028), NBSP = String.fromCharCode(0xa0);
const CC_BLANK = (x) => x.replace(/`[^`\n]+`/g, (n, r) => { const s = x[r - 1]; return s === '!' || s === '`' ? n : `\`${' '.repeat(n.length - 2)}\``; });
const LB_BLANK = (x) => x.replace(/(?<![!`])`[^`\n]+`/g, (n) => `\`${' '.repeat(n.length - 2)}\``);
// si(t) -> {content, at, matched}: the body Claude Code scans (its place in t), or the whole text when it reads no front
// matter (its content: the text as it was)
function si(t) {
  const e = t.charCodeAt(0) === 65279 ? t.slice(1) : t;
  const m = e.indexOf('---', 3) < 0 ? null : e.match(/^---\s*\n([\s\S]*?)---\s*\n?/);
  return m ? { content: e.slice(m[0].length), at: t.length - e.length + m[0].length, matched: true } : { content: t, at: 0, matched: false };
}
function ccShellCommands(e, blank = CC_BLANK, from = 0) {
  const gVn = /```!\s*\n?([\s\S]*?)\n?```/g, hVn = /(?<=^|\s)!`([^`]+)`/gm;
  const s5r = (x) => x.trim().replaceAll('\r\n', '\n');
  const n = e.matchAll(gVn), r = e.includes('!`') ? blank(e).matchAll(hVn) : [], out = [];
  for (const h of [...n, ...r]) { const y = s5r(h[1] ?? ''); if (y) out.push(`${from + h.index}\0${y}`); }
  return out;
}
// what Claude Code runs: Gtr(si(t).content)
const ccRuns = (t) => { const b = si(t); return ccShellCommands(b.content, CC_BLANK, b.at); };
const sorted = (l) => [...new Set(l)].sort();

test('the shell commands found: every one Claude Code runs (its own code as the oracle, on its real input — the body), and both readings of the whole text and the body — the union', () => {
  const mine = (t) => shellBlocks(t).list.filter((x) => x.kind !== 'open').map((x) => `${x.at}\0${x.command}`);
  const check = (t) => {
    const m = new Set(mine(t));
    for (const c of ccRuns(t)) assert.ok(m.has(c), `${JSON.stringify(t)}: Claude Code runs ${JSON.stringify(c.split('\0')[1])}, not listed`);
    const b = si(t);
    const union = [...ccShellCommands(t), ...ccShellCommands(t, LB_BLANK), ...(b.matched ? [...ccShellCommands(b.content, CC_BLANK, b.at), ...ccShellCommands(b.content, LB_BLANK, b.at)] : [])];
    assert.deepEqual(sorted(mine(t)), sorted(union), JSON.stringify(t));
  };
  // (the reviewer's: Claude Code runs only a — the lookbehind reading finds cmd too: both listed)
  assert.deepEqual(shellBlocks('!`a` b` !`cmd`').list.map((x) => x.command), ['a', 'cmd']);
  assert.deepEqual(ccShellCommands('!`a` b` !`cmd`').map((c) => c.split('\0')[1]), ['a']);
  // (M1: a !` left open in the front matter swallows the body's command in a scan of the whole text — Claude Code scans
  // the body alone, and runs it: listed)
  const fm = '---\ndescription: x !`\n---\nRun !`echo marker` now.\n';
  assert.ok(shellBlocks(fm).list.some((x) => x.command === 'echo marker'));
  assert.deepEqual(ccRuns(fm).map((c) => c.split('\0')[1]), ['echo marker']);
  assert.ok(shellBlocks('---\nx: 1\n---!`at the body start`').list.some((x) => x.command === 'at the body start'));
  for (const t of ['!`a` b` !`cmd`', '``!`x` !`y`', '!`a` `b !`c` d`', 'x `a` !`b` `c`', '`!`a`` !`b`', '!``a` !`b`', '```!\nls\n``` !`pwd` `q !`r` s`',
    '`a\n!`b` `c`', '!`a\r\nb` !`c`', ' !`a`!`b` !`c`', '`` !`a` ``', `!\`a\`${LS}!\`b\`${NBSP}!\`c\``, fm, `${BOM}---\nd: !\`\n---\n!\`x\``, '---\f\nd: `\n--- !`y` `z`']) check(t);
  // random texts of the characters that matter, front matter among them
  const parts = ['`', '!', '!`', '```!', '```', ' ', '\n', '\r\n', 'a', 'ls', '\t', LS, '$1', '---', '---\n', 'd: x', BOM, '\f'];
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let i = 0; i < 20000; i++) {
    let t = '';
    const n = 1 + (next() % 24);
    for (let k = 0; k < n; k++) t += parts[next() % parts.length];
    // (a ```! block with no closing ```: Claude Code runs nothing, this page lists it — the rest exactly the union)
    check(t);
  }
});

test('never a command cut or left out unseen: past 200 in a file, or one over 2,000 characters, the summary is incomplete', () => {
  const file = (text) => ({ name: '.claude/commands/go.md', size: text.length, type: 'file', text });
  const many = Array.from({ length: 201 }, (_, i) => `- !\`echo ${i}\``).join('\n');
  assert.equal(shellBlocks(many, 200).more, true);
  assert.equal(shellBlocks(many, 200).list.length, 200);
  let sm = summarize([file(many)]);
  assert.equal(sm.complete, false);
  assert.ok(sm.missing.some((m) => /more than 200 shell commands in one file/.test(m)), sm.missing.join('; '));
  sm = summarize([file(Array.from({ length: 200 }, (_, i) => `- !\`echo ${i}\``).join('\n'))]);
  assert.equal(sm.complete, true);
  const long = `!\`echo ${'x'.repeat(2100)}\``;
  assert.equal(shellBlocks(long).list[0].command.length, 2105, 'never cut');
  sm = summarize([file(long)]);
  assert.equal(sm.complete, false);
  assert.ok(sm.missing.some((m) => /a shell command too long to show/.test(m)), sm.missing.join('; '));
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
  assertLinear((n) => `\`\`\`!${' '.repeat(n * 4)}`, (t) => shellBlocks(t), 'an unclosed ```! and whitespace');
  assertLinear((n) => ' !`'.repeat(n), (t) => shellBlocks(t), '!` again and again');
  assertLinear((n) => '`'.repeat(n * 4), (t) => shellBlocks(t), 'backticks only');
  assertLinear((n) => `!\`${'` x '.repeat(n)}`, (t) => shellBlocks(t), 'inline code spans after !`');
  assertLinear((n) => `${'`a\n'.repeat(n)} !\`x\``, (t) => shellBlocks(t), 'open spans across lines');
  assertLinear((n) => '```!```'.repeat(n), (t) => shellBlocks(t), 'empty fenced blocks');
  assertLinear((n) => ' !`x`'.repeat(n), (t) => shellBlocks(t, 1e9), 'many commands, every one listed');
});
