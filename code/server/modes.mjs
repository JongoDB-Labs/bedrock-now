// The Code page's permission modes (protocol.mjs MODES) and the Claude Code primitives behind them. The page names
// modes as Claude Code's desktop app does, plus one of its own:
//   readOnly            Read only: Claude Code's dontAsk mode, with Edit, Write and NotebookEdit denied (flag settings).
//                       Reads and the CLI's read-only commands run; anything else is denied, never asked
//   plan                Plan: Claude Code's plan mode — it asks rather than handing commands to the auto-mode classifier
//                       (auto mode off, or useAutoModeDuringPlan: false while Settings allow Auto)
//   default             Manual: asks before edits and commands (Claude Code's default, "manual" in its CLI)
//   acceptEdits         Accept edits: file edits and file commands in the workspace run without asking
//   auto                Auto: Claude Code's auto mode — a reviewer model (its classifier, which asks for claude-sonnet-5:
//                       Sonnet 5.5 through the catalog's alias) approves routine actions and blocks risky ones; ask rules
//                       still ask. Only with CODE_AUTO_MODE; a process starts in Manual and is switched to it before its
//                       first prompt. Off (disableAutoMode) otherwise
//   bypassPermissions   Bypass permissions: nothing asks — except the ask rules below and AskUserQuestion; deny rules
//                       still deny. Only with CODE_ALLOW_BYPASS, a process started with
//                       --allow-dangerously-skip-permissions, and the page's confirmation; never at a process's start
// The flag-settings layer (Query.applyFlagSettings) merges top-level keys shallowly: a second `permissions` replaces the
// first whole, and null clears it. So a session keeps ONE composed `permissions` object — what its mode needs — and
// sends it whole each time (permissionsFor; a switch first applies both modes' rules, then the new mode's alone).
import { MODES } from './protocol.mjs';

/** Read only: the edit tools denied (Edit(...) rules cover Write and NotebookEdit too; all three named, as probed),
 *  and EnterPlanMode — Claude would leave Read only for Plan, and approving a plan switches to Manual or Accept edits. */
export const READ_ONLY_DENY = Object.freeze(['Edit', 'Write', 'NotebookEdit', 'EnterPlanMode']);

/** Bypass permissions: these still ask — files in your folder that run on your computer later (git hooks and config,
 *  Claude Code's and VS Code's settings, husky hooks, direnv, project MCP servers). Absolute (//workspace/…): probed
 *  against Claude Code 2.1.296 for absolute and relative tool paths. A speed bump: Bash can still write them (the
 *  watchlist reports that after the turn). */
export const BYPASS_ASK = Object.freeze([
  'Edit(//workspace/.git/**)', 'Edit(//workspace/.claude/**)', 'Edit(//workspace/.vscode/**)', 'Edit(//workspace/.husky/**)',
  'Edit(//workspace/.devcontainer/**)', 'Edit(//workspace/.envrc)', 'Edit(//workspace/.mcp.json)', 'Edit(//workspace/.devcontainer.json)',
]);

/** The modes Claude Code may be started in (--permission-mode: a new session, a resume, a fork): never bypass, never
 *  auto. A session in Auto starts its process in Manual and switches before the first prompt (Session.start). */
export const START_MODES = Object.freeze(['readOnly', 'plan', 'default', 'acceptEdits']);
/** The modes set_mode switches to (bypassPermissions and auto only through their gates: Session.setMode). */
export const SET_MODES = Object.freeze([...START_MODES, 'auto', 'bypassPermissions']);

/** The flag settings every process gets before its first prompt, besides its mode's rules. Auto off (CODE_AUTO_MODE
 *  unset): Claude Code counts auto mode as available behind our base URL and would hand Plan's commands to its
 *  classifier. Auto allowed: Plan still asks you (useAutoModeDuringPlan: false; the CLI's default is to let the
 *  classifier approve commands in Plan). */
export const startFlags = (allowAuto) => (allowAuto === true ? { useAutoModeDuringPlan: false } : { disableAutoMode: 'disable' });

/** A mode as the page or an older client names it: dontAsk (the Code page's former "Don't ask") is Read only now. */
export const normMode = (m) => (m === 'dontAsk' ? 'readOnly' : m);

/** cliMode(page mode) -> Claude Code's PermissionMode */
export const cliMode = (m) => (m === 'readOnly' ? 'dontAsk' : m);

/** pageMode(Claude Code's mode, as init / status report it) -> the page mode, or null for anything unknown */
export const pageMode = (m) => {
  if (m === 'dontAsk') return 'readOnly';
  if (m === 'manual') return 'default';
  return typeof m === 'string' && MODES.includes(m) && m !== 'readOnly' ? m : null;
};

/** The flag layer's `permissions` object a page mode needs, or null (nothing of ours there). */
export function permissionsFor(mode) {
  if (mode === 'readOnly') return { deny: [...READ_ONLY_DENY] };
  if (mode === 'bypassPermissions') return { ask: [...BYPASS_ASK] };
  return null;
}

/** Both modes' rules in one object (what holds while a switch is under way), or null. */
export function unionPermissions(a, b) {
  if (!a) return b ? clone(b) : null;
  if (!b) return clone(a);
  const out = {};
  for (const k of ['deny', 'ask', 'allow']) {
    const list = [...(a[k] || []), ...(b[k] || [])];
    if (list.length) out[k] = [...new Set(list)];
  }
  return out;
}

const clone = (p) => (p ? JSON.parse(JSON.stringify(p)) : null);
/** Whether two `permissions` objects (or nulls) say the same. */
export const samePermissions = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
