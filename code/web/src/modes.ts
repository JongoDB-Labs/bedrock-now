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
  /** chip colour: slate (Read only), grey (Manual, Plan), blue (Accept edits, Auto), red (Bypass) */
  tone: 'slate' | 'grey' | 'blue' | 'red';
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
    tone: 'grey',
    mark: '⏸',
  },
  default: {
    label: 'Manual',
    desc: 'Asks before every edit and command',
    runs: 'Without asking: reading, searching, read-only commands. Edits and other commands wait for you.',
    icon: 'pause',
    tone: 'grey',
    mark: '⏸',
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
    desc: 'A reviewer model approves routine actions; asks or blocks risky ones',
    runs: 'Not offered yet.',
    icon: 'forward',
    tone: 'blue',
    mark: '⏵⏵',
  },
  bypassPermissions: {
    label: 'Bypass permissions',
    desc: 'Runs everything without asking, in the sandbox',
    runs: 'Without asking: every command and edit — except files that run on your computer (git hooks, .claude, .vscode, .envrc …), which still ask, and your deny rules.',
    icon: 'forward',
    tone: 'red',
    mark: '⏵⏵',
  },
};

/** A mode's name ('' for an unknown one: it is shown as it came, never parsed). */
export function modeName(m: string): string {
  return (MODE_INFO as Record<string, ModeInfo>)[m]?.label ?? m;
}

/** The modes the picker lists, in the desktop app's order (Auto is not offered yet; Bypass only when Settings allow it). */
export function offeredModes(allowBypass: boolean): Mode[] {
  return allowBypass ? ['readOnly', 'plan', 'default', 'acceptEdits', 'bypassPermissions'] : ['readOnly', 'plan', 'default', 'acceptEdits'];
}

/** Shift+Tab, as in the CLI: Manual → Accept edits → Plan → [Bypass] → Manual. Read only is outside the cycle (like
 *  the CLI's dontAsk): from it, the cycle starts at Manual. */
export function nextMode(cur: Mode, allowBypass: boolean): Mode {
  const cycle: Mode[] = allowBypass ? ['default', 'acceptEdits', 'plan', 'bypassPermissions'] : ['default', 'acceptEdits', 'plan'];
  const i = cycle.indexOf(cur);
  return i < 0 ? 'default' : cycle[(i + 1) % cycle.length];
}

/** Remembered for new sessions (this browser): Read only, Manual, Accept edits (Auto later). Plan and Bypass apply to
 *  the session they were picked in only, as in the desktop app and VS Code. */
export const remembered = (m: Mode): boolean => m === 'readOnly' || m === 'default' || m === 'acceptEdits' || m === 'auto';

/** What a session (re)starts in: never Bypass (nor Auto) — those are switched to, per process. */
export const startMode = (m: Mode | null | undefined, fallback: Mode = 'default'): Mode =>
  m === 'readOnly' || m === 'plan' || m === 'default' || m === 'acceptEdits' ? m : fallback === 'bypassPermissions' || fallback === 'auto' ? 'default' : fallback;
