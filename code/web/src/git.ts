// The Git panel's model, kept free of DOM and network (test/git.test.ts): the prompt "Write message" sends to the open
// session (the staged diff in a fence it cannot close, file names quoted as the Review quotes them), the message taken
// out of Claude's answer (a draft for the commit box — never committed by itself), and small labels. Every scan here is
// linear in its input (a crafted diff or answer cannot make it slow).
import type { GitEntry, GitFile, GitStatus } from './types';
import { promptPath } from './review';

/** At most this much diff goes into the prompt (the rest is said to be cut). */
export const MESSAGE_DIFF_MAX = 30_000;
/** A proposal longer than this is cut (git takes 64 KiB; a commit message is a few lines). */
export const PROPOSAL_MAX = 8_000;
/** The first words of the prompt: how the page knows its own request in the conversation. */
export const MESSAGE_ASK = 'Propose a git commit message for the changes staged in /workspace';

/** The longest run of `ch` in `s` (one pass). */
export function longestRun(s: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) {
      run++;
      if (run > best) best = run;
    } else run = 0;
  }
  return best;
}

/** The staged changes as unified-diff text (headers with quoted names), at most `max` characters. */
export function diffText(files: GitFile[], max = MESSAGE_DIFF_MAX): { text: string; cut: boolean } {
  const parts: string[] = [];
  let size = 0;
  let cut = false;
  const push = (line: string): boolean => {
    if (size + line.length + 1 > max) {
      cut = true;
      return false;
    }
    parts.push(line);
    size += line.length + 1;
    return true;
  };
  outer: for (const f of files) {
    const name = promptPath(f.path);
    const what = f.status === 'added' ? ' (new file)' : f.status === 'deleted' ? ' (deleted)' : '';
    if (!push(`--- ${name}${what}`)) break;
    if (f.binary) {
      if (!push('(binary file)')) break;
      continue;
    }
    for (const h of f.hunks) {
      if (!push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)) break outer;
      for (const l of h.lines) if (!push(l)) break outer;
    }
    if (f.cut) push('(this file\'s diff is cut here)');
  }
  return { text: parts.join('\n'), cut };
}

/** The prompt "Write message" sends: the staged files, their diff, and what to answer (only the message, in a block). */
export function messagePrompt(staged: GitEntry[], files: GitFile[]): string {
  const add = staged.reduce((n, e) => n + (e.add ?? 0), 0);
  const del = staged.reduce((n, e) => n + (e.del ?? 0), 0);
  const list = staged.slice(0, 50).map((e) => `- ${promptPath(e.path)}${e.binary ? ' (binary)' : ` (+${e.add ?? 0} −${e.del ?? 0})`}`);
  if (staged.length > 50) list.push(`- … and ${staged.length - 50} more`);
  const d = diffText(files);
  const fence = '`'.repeat(Math.max(3, longestRun(d.text, '`') + 1));
  return [
    `${MESSAGE_ASK} (the diff is below). Reply with only the message, in one \`\`\`text block: a subject line of at most 72 characters, in the imperative mood, then — only if it helps — a blank line and a short body. Do not use any tools, do not run git and do not commit: the message goes into the Code page's commit box as a draft for me to read and edit.`,
    '',
    `Staged: ${staged.length} file${staged.length === 1 ? '' : 's'}, +${add} −${del}`,
    ...list,
    '',
    `${fence}diff`,
    d.text,
    fence,
    ...(d.cut ? [`(The diff is longer: only its first ${MESSAGE_DIFF_MAX.toLocaleString('en-US')} characters are shown.)`] : []),
  ].join('\n');
}

// what a commit message may hold (the backend refuses the rest): no control characters but tab and newline, nothing that
// changes the direction of text
const NOT_IN_MESSAGE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** A fence line's marker (``` or ~~~, at least 3, after up to 3 spaces) — counted, not matched by a pattern. */
function fenceOf(line: string): { ch: string; n: number } | null {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let n = 0;
  while (line[i + n] === ch) n++;
  return n >= 3 ? { ch, n } : null;
}
/** The commit message Claude proposed: the first fenced block of its answer, else the whole answer — blank lines at
 *  either end dropped, control and direction-changing characters taken out, at most PROPOSAL_MAX characters. null:
 *  nothing usable. */
export function proposedMessage(answer: string): string | null {
  if (typeof answer !== 'string') return null;
  const lines = answer.replace(/\r\n?/g, '\n').split('\n');
  let body = lines;
  for (let i = 0; i < lines.length; i++) {
    const open = fenceOf(lines[i]);
    if (!open) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const close = fenceOf(lines[j]);
      if (close && close.ch === open.ch && close.n >= open.n && lines[j].trim() === open.ch.repeat(close.n)) {
        end = j;
        break;
      }
    }
    body = lines.slice(i + 1, end);
    break;
  }
  let a = 0;
  let b = body.length;
  while (a < b && !body[a].trim()) a++;
  while (b > a && !body[b - 1].trim()) b--;
  const text = body
    .slice(a, b)
    .map((l) => l.replace(NOT_IN_MESSAGE, '').trimEnd())
    .join('\n')
    .slice(0, PROPOSAL_MAX);
  return text.trim() ? text : null;
}

/** Every file with a change, once (staged, unstaged, new, conflicts): the Git tab's count. */
export function changedCount(s: GitStatus | null): number {
  if (!s?.repo) return 0;
  return new Set([...s.staged, ...s.unstaged, ...s.untracked, ...s.conflicts].map((e) => e.path)).size;
}

/** Why Commit cannot run now, or '' */
export function commitBlocker(s: GitStatus | null, message: string): string {
  if (!s?.repo) return 'not a git repository';
  if (s.state && s.state !== 'merge') return `a ${s.state} is in progress: finish it in the terminal`;
  if (s.conflicts.length) return 'resolve the conflicts first (stage each file once it is resolved)';
  if (!s.staged.length) return 'stage the changes to commit first';
  if (!message.trim()) return 'write a message first';
  return '';
}

/** What a group's letter means. */
export function codeTitle(code: string, untracked = false): string {
  if (untracked) return 'New, not tracked by git yet';
  const t: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', T: 'Type changed (a file became a link, or the other way)', R: 'Renamed', C: 'Copied', U: 'Unmerged' };
  return t[code] ?? (code.length === 2 ? 'A conflict' : 'Changed');
}
