// What a permission prompt says. The SDK's `title` is empty for headless sessions, so the page builds
// the sentence from the tool and its input itself, and previews what "Always allow" would write from the
// suggestions. All of it is untrusted text (the sandbox chooses the tool name and input); it is only ever shown as
// text, inside the card.
import type { Suggestion } from './types';
import { modeName } from './modes';
import { cleanPath, label } from './text';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const s = (v: unknown, max = 300): string => label(v, max);

export function displayPath(p: unknown): string {
  if (typeof p !== 'string') return '';
  const c = cleanPath(p);
  return c === null ? s(p, 300) : c || '/workspace';
}

/** "mcp__server__tool" → {server, tool} */
export function mcpParts(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : null;
}

export interface Sentence {
  /** "Claude wants to run a command" */
  title: string;
  /** what the action is about (a path, a URL, a pattern), shown monospaced */
  subject: string;
  /** the kind of details block the card shows */
  detail: 'command' | 'edit' | 'write' | 'json' | 'plan' | 'question' | 'none';
}

export function sentence(tool: string, input: unknown): Sentence {
  const i = obj(input);
  switch (tool) {
    case 'Bash':
      return { title: i.description ? `Claude wants to run a command: ${s(i.description, 200)}` : 'Claude wants to run a command', subject: '', detail: 'command' };
    case 'BashOutput':
      return { title: 'Claude wants to read the output of a background command', subject: s(i.bash_id, 80), detail: 'none' };
    case 'KillShell':
    case 'KillBash':
      return { title: 'Claude wants to stop a background command', subject: s(i.shell_id ?? i.bash_id, 80), detail: 'none' };
    case 'Edit':
    case 'MultiEdit':
      return { title: 'Claude wants to edit a file', subject: displayPath(i.file_path), detail: 'edit' };
    case 'Write':
      return { title: 'Claude wants to write a file', subject: displayPath(i.file_path), detail: 'write' };
    case 'NotebookEdit':
      return { title: 'Claude wants to edit a notebook', subject: displayPath(i.notebook_path), detail: 'json' };
    case 'Read':
      return { title: 'Claude wants to read a file', subject: displayPath(i.file_path), detail: 'none' };
    case 'Glob':
      return { title: 'Claude wants to find files', subject: `${s(i.pattern, 200)}${i.path ? ` in ${displayPath(i.path)}` : ''}`, detail: 'none' };
    case 'Grep':
      return { title: 'Claude wants to search file contents', subject: `${s(i.pattern, 200)}${i.path ? ` in ${displayPath(i.path)}` : ''}`, detail: 'none' };
    case 'WebFetch':
      return { title: 'Claude wants to fetch a web page', subject: s(i.url, 500), detail: 'none' };
    case 'WebSearch':
      return { title: 'Claude wants to search the web', subject: s(i.query, 300), detail: 'none' };
    case 'Task':
    case 'Agent':
      return { title: `Claude wants to start a subagent${i.subagent_type ? ` (${s(i.subagent_type, 60)})` : ''}`, subject: s(i.description, 200), detail: 'json' };
    case 'AskUserQuestion':
      return { title: 'Claude has a question for you', subject: '', detail: 'question' };
    case 'ExitPlanMode':
      return { title: 'Claude has a plan and wants to start working on it', subject: '', detail: 'plan' };
    case 'TodoWrite':
      return { title: 'Claude wants to update its to-do list', subject: '', detail: 'none' };
    case 'Skill':
      return { title: 'Claude wants to use a skill', subject: s(i.skill ?? i.command ?? i.name, 120), detail: 'json' };
    case 'SlashCommand':
      return { title: 'Claude wants to run a slash command', subject: s(i.command, 200), detail: 'none' };
    default: {
      const m = mcpParts(tool);
      if (m) return { title: `Claude wants to use ${m.tool} from the MCP server ${m.server}`, subject: '', detail: 'json' };
      return { title: `Claude wants to use ${tool}`, subject: '', detail: 'json' };
    }
  }
}

export const DESTINATIONS: Record<string, string> = {
  session: 'for this session',
  localSettings: "in this workspace's .claude/settings.local.json",
  projectSettings: "in this workspace's .claude/settings.json",
  userSettings: "in the sandbox's Claude Code settings (every session there)",
  cliArg: 'for this session',
};

/** Where a rule goes, in words ('' when unknown). */
export function destinationText(d: string): string {
  return DESTINATIONS[d] ?? (d ? `(${d})` : '');
}

/** Human-readable preview of what "Always allow" would do, one line per suggestion. Empty when there is nothing. */
export function rulePreview(suggestions: Suggestion[]): string[] {
  const out: string[] = [];
  for (const sg of suggestions.slice(0, 6)) {
    const where = DESTINATIONS[sg.destination] ?? (sg.destination ? `(${sg.destination})` : '');
    if (sg.type === 'addRules' || sg.type === 'replaceRules') {
      const rules = sg.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).filter(Boolean);
      if (rules.length) out.push(`${sg.behavior === 'deny' ? 'Deny' : sg.behavior === 'ask' ? 'Ask for' : 'Allow'} ${rules.join(', ')} ${where}`.trim());
    } else if (sg.type === 'setMode' && sg.mode) {
      out.push(`Switch to ${modeName(sg.mode)} mode ${where}`.trim());
    } else if (sg.type === 'addDirectories' && sg.directories.length) {
      out.push(`Allow access to ${sg.directories.join(', ')} ${where}`.trim());
    }
  }
  return out;
}

/** A mode's name as the page shows it (modes.ts). */
export { modeName } from './modes';
