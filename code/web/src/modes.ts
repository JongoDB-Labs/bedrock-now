// The permission modes as the page shows them — Claude Code's desktop app's names and order, plus Read only — and the
// rules around them: what Shift+Tab cycles through, what a new session remembers, what a new process may start in.
// What each one is in Claude Code's terms: code/server/modes.mjs.
import type { Mode } from './types';

export interface ModeInfo {
  label: string;
  /** one line under the label in the picker */
  desc: string;
  /** what runs without asking */
  runs: string;
  icon: string;
  /** chip colour: slate (Read only), grey (Manual), teal (Plan, as the CLI), blue (Accept edits, Auto), red (Bypass) */
  tone: 'slate' | 'grey' | 'teal' | 'blue' | 'red';
  /** the CLI's status-line marker */
  mark: string;
}

export const MODE_INFO: Record<Mode, ModeInfo> = {
  readOnly: {
    label: 'Read only',
    desc: 'Reads and runs read-only commands; changes nothing, never asks',
    runs: 'Without asking: reading, searching, read-only commands (ls, cat, git status …) and commands you always allow. Everything else is denied.',
    icon: 'eye',
    tone: 'slate',
    mark: '👁',
  },
  plan: {
    label: 'Plan',
    desc: 'Reads and plans; changes nothing until you approve the plan',
    runs: 'Without asking: reading, searching, read-only commands. It asks before anything else, then shows its plan.',
    icon: 'pause',
    tone: 'teal',
    mark: '⏸',
  },
  default: {
    label: 'Manual',
    desc: 'Asks before every edit and command',
    runs: 'Without asking: reading, searching, read-only commands. Edits and other commands wait for you.',
    icon: 'shield',
    tone: 'grey',
    mark: '',
  },
  acceptEdits: {
    label: 'Accept edits',
    desc: 'Edits files and runs file commands without asking; asks before other commands',
    runs: 'Without asking: file edits in the workspace and mkdir, touch, mv, cp, rm, sed there. Other commands wait for you.',
    icon: 'forward',
    tone: 'blue',
    mark: '⏵⏵',
  },
  auto: {
    label: 'Auto',
    // (the CLI's own words: "no routine prompts; a reviewer model screens actions")
    desc: 'No routine prompts: a reviewer model screens actions, runs routine ones and blocks risky ones',
    runs: 'Without asking: reading, read-only commands, file edits in the workspace, and what the reviewer (Sonnet 5.5) approves. Blocked: downloading and running code, sending data out, force pushes and the like — each with the rule it matched and "Allow once". Your ask rules still ask; Plan still asks you. Each check costs model tokens (~$0.13 per 5 minutes in use, on the terminal\'s key).',
    icon: 'sparkle',
    tone: 'blue',
    mark: '⏵⏵',
  },
  bypassPermissions: {
    label: 'Bypass permissions',
    desc: 'Runs everything without asking, in the sandbox',
    runs: 'Without asking: every command and edit. Claude\'s file tools still ask before changing .git, .claude, .vscode, .husky, .devcontainer, .envrc or .mcp.json — shell commands do not (the watchlist flags those after the turn) — and your deny rules still deny.',
    icon: 'forward',
    tone: 'red',
    mark: '⏵⏵',
  },
};

/** A mode's name ('' for an unknown one: it is shown as it came, never parsed). */
export function modeName(m: string): string {
  return (MODE_INFO as Record<string, ModeInfo>)[m]?.label ?? m;
}

/** The modes the picker lists, in the desktop app's order: Auto and Bypass only when Settings allow them. */
export function offeredModes(allowBypass: boolean, allowAuto = false): Mode[] {
  const out: Mode[] = ['readOnly', 'plan', 'default', 'acceptEdits'];
  if (allowAuto) out.push('auto');
  if (allowBypass) out.push('bypassPermissions');
  return out;
}

/** Shift+Tab, as in the CLI: Manual → Accept edits → Plan → [Bypass] → [Auto] → Manual (the optional modes after Plan,
 *  Bypass first and Auto last). Read only is outside the cycle (like the CLI's dontAsk): from it, the cycle starts at
 *  Manual. */
export function nextMode(cur: Mode, allowBypass: boolean, allowAuto = false): Mode {
  const cycle: Mode[] = ['default', 'acceptEdits', 'plan'];
  if (allowBypass) cycle.push('bypassPermissions');
  if (allowAuto) cycle.push('auto');
  const i = cycle.indexOf(cur);
  return i < 0 ? 'default' : cycle[(i + 1) % cycle.length];
}

/** Remembered for new sessions (this browser): Read only, Manual, Accept edits, Auto — as the desktop app and VS Code
 *  remember Manual, Accept edits and Auto. Plan and Bypass apply to the session they were picked in only. */
export const remembered = (m: Mode): boolean => m === 'readOnly' || m === 'default' || m === 'acceptEdits' || m === 'auto';

/** What a session (re)starts in: never Bypass (switched to per process, after its dialog); Auto only while Settings
 *  allow it (the backend starts it in Manual and switches before the first prompt), else Manual — as Claude Code's
 *  own apps start in Manual when auto mode is not available. */
export const startMode = (m: Mode | null | undefined, fallback: Mode = 'default', allowAuto = false): Mode => {
  const ok = (x: Mode | null | undefined): x is Mode => x === 'readOnly' || x === 'plan' || x === 'default' || x === 'acceptEdits' || (x === 'auto' && allowAuto);
  return ok(m) ? m : ok(fallback) ? fallback : 'default';
};
