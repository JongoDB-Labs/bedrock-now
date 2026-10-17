// Run & test: what the page needs besides the wire (api.ts) — the tasks this browser ran after seeing them (their
// digests), how a run's result reads in the Problems list, and the draft for "Ask Claude to run it".
import type { RunResult, RunTask } from './types';

/** Tasks run after you saw them: their digests (this browser; a changed task asks again). */
const APPROVED = 'bn.code.run.v1';
export function approvedRun(digest: string | null): boolean {
  if (!digest) return false;
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(APPROVED) || '[]');
    return Array.isArray(list) && list.includes(digest);
  } catch {
    return false;
  }
}
export function approveRun(digest: string): void {
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(APPROVED) || '[]');
    const next = [digest, ...(Array.isArray(list) ? list.filter((d) => typeof d === 'string' && d !== digest) : [])].slice(0, 100);
    globalThis.localStorage?.setItem(APPROVED, JSON.stringify(next));
  } catch {
    /* blocked storage: it asks again next time */
  }
}

/** The command as you would type it: `npm test`, `npm run build`, `make check`, or the entry point by name. */
export function plainCommand(t: Pick<RunTask, 'source' | 'name'>): string {
  if (t.source === 'npm') return t.name === 'test' || t.name === 'start' ? `npm ${t.name}` : `npm run ${t.name}`;
  if (t.source === 'make') return `make ${t.name}`;
  return t.name;
}

/** The draft "Ask Claude to run it" puts into the prompt box (never sent by itself). */
export function askDraft(t: RunTask): string {
  if (t.source === 'python') {
    const ref = /^[A-Za-z_][\w.]*:[A-Za-z_][\w.]*$/.test(t.argv?.[4] ?? '') ? ` (\`${t.argv![4]}\`)` : '';
    return `Run the \`${t.name}\` entry point of pyproject.toml${ref} and fix failures.`;
  }
  return `Run \`${plainCommand(t)}\` and fix failures.`;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]{0,2000}(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/** A run's output as text: ANSI escapes (colours, cursor moves, titles) taken out, CR-overwritten lines as their last
 *  version (a progress bar). Other control characters stay for the page's visible() to show. */
export function plainOutput(tail: string): string {
  return tail
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.includes('\r') ? l.slice(l.lastIndexOf('\r', l.length - 2) + 1).replace(/\r$/, '') : l))
    .join('\n');
}

/** The last `n` non-empty lines of a run's output (each at most `width` characters). */
export function lastLines(tail: string, n = 6, width = 300): string[] {
  const lines = plainOutput(tail.length > 20_000 ? tail.slice(-20_000) : tail).split('\n');
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const l = lines[i].trimEnd();
    if (l.trim()) out.unshift(l.length > width ? `${l.slice(0, width)}…` : l);
  }
  return out;
}

export type Outcome = 'running' | 'ok' | 'failed' | 'lost';
export function outcome(r: RunResult): Outcome {
  if (r.state === 'running') return 'running';
  if (r.state === 'lost') return 'lost';
  return r.exitCode === 0 && !r.signal && !r.error ? 'ok' : 'failed';
}
/** "exit 1", "ok", "ended by SIGINT", "running…", "its window closed while it ran". */
export function outcomeText(r: RunResult): string {
  if (r.state === 'running') return 'running…';
  if (r.state === 'lost') return 'no result: its window closed while it ran';
  if (r.error) return r.error;
  if (r.signal) return `ended by ${r.signal}`;
  return r.exitCode === 0 ? 'ok (exit 0)' : r.exitCode === null ? 'ended' : `exit ${r.exitCode}`;
}
/** "12.3 s", "2 min 5 s" (null: not known). */
export function duration(r: RunResult, now = Date.now()): string | null {
  if (r.startedAt === null) return null;
  const end = r.state === 'running' ? now : r.endedAt;
  if (end === null || end < r.startedAt) return null;
  const s = (end - r.startedAt) / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
/** Runs whose task's latest run failed (the status bar's count): one per task. */
export function failing(runs: RunResult[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const r of runs) {
    const k = `${r.source}:${r.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (outcome(r) === 'failed') n++;
  }
  return n;
}
