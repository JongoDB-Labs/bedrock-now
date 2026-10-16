// What a conversation is besides its timeline: its latest to-do list (TodoWrite), and the conversation as a Markdown
// file to keep. Both read the page's own items, never anything the sandbox formatted.
import type { Item, SessionView } from './session';
import { duration, safe } from './text';

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

const STATUSES = ['pending', 'in_progress', 'completed'] as const;

/** The to-do list Claude wrote last in this conversation (its own, not a subagent's), or null. */
export function latestTodos(items: Item[]): Todo[] | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.t !== 'tool' || it.name !== 'TodoWrite' || it.parent) continue;
    const list = (it.input as { todos?: unknown } | null)?.todos;
    if (!Array.isArray(list)) continue;
    return list
      .slice(0, 100)
      .map((x): Todo | null => {
        const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
        if (!o || typeof o.content !== 'string' || !o.content.trim()) return null;
        const status = STATUSES.includes(o.status as Todo['status']) ? (o.status as Todo['status']) : 'pending';
        return { content: safe(o.content, 500), status, activeForm: typeof o.activeForm === 'string' ? safe(o.activeForm, 500) : '' };
      })
      .filter((x): x is Todo => x !== null);
  }
  return null;
}

/** Inline code that the text cannot close: a run of backticks longer than any in it. */
function code(text: string): string {
  const f = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length)) + 1);
  return f.length > 1 ? `${f} ${text} ${f}` : `${f}${text}${f}`;
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

function toolLine(it: Extract<Item, { t: 'tool' }>): string {
  const i = (it.input && typeof it.input === 'object' ? it.input : {}) as Record<string, unknown>;
  const what = [i.command, i.file_path, i.path, i.pattern, i.url, i.description].find((x) => typeof x === 'string' && x) as string | undefined;
  const status = it.status === 'error' ? ' (failed)' : it.status === 'running' ? ' (not finished)' : '';
  return what ? `- **${it.name}**${status}: ${code(what.split('\n')[0].slice(0, 500))}` : `- **${it.name}**${status}`;
}

/** The conversation as Markdown: prompts, answers, tool calls in one line each, local output, turn ends. */
export function toMarkdown(v: SessionView, title: string, now = new Date(), partial = false): string {
  const out = [`# ${title.replace(/\n/g, ' ') || 'Claude Code session'}`, '', `Exported from the Code page on ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC · session ${v.id}`, ''];
  if (partial) out.push('_(earlier messages not included)_', '');
  for (const it of v.items) {
    if ('parent' in it && it.parent) continue;   // a subagent's own steps stay in the page
    switch (it.t) {
      case 'user':
        out.push('## You', '', it.text + (it.images ? `\n\n_(${it.images} image${it.images === 1 ? '' : 's'})_` : ''), '');
        break;
      case 'assistant':
        out.push('## Claude', '', it.text, '');
        break;
      case 'tool':
        out.push(toolLine(it), '');
        break;
      case 'local':
        out.push(quote(it.text), '');
        break;
      case 'result':
        out.push(`_${it.isError ? (it.subtype === 'error_during_execution' ? 'Stopped' : 'Failed') : 'Done'}${it.durationMs > 0 ? ` · ${duration(it.durationMs)}` : ''}_`, '');
        break;
      case 'notice':
        out.push(`_${it.text}_`, '');
        break;
    }
  }
  for (const q of v.queued) out.push('## You (waiting)', '', q.text, '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** A file name for the export: the title's words, or the session id. */
export function exportName(v: SessionView, title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${base || 'session-' + v.id.slice(0, 8)}.md`;
}
