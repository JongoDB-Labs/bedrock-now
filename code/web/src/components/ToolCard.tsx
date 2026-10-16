// The tool-call cards: one compact header line per call (icon, verb, subject, status) that expands into what the
// tool did. Bash: command + output; Edit/Write: inline diff → full diff in the editor; Read; Grep/Glob; WebFetch;
// Task with its nested calls; TodoWrite as a checklist; MCP; anything else as JSON. All content is text.
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { Item } from '../session';
import { compact, countChanges, hunkLines, lineDiff, type DiffLine } from '../diff';
import { displayPath, mcpParts } from '../permission';
import { cleanPath, label, prettyJson, preview, safe, LIMITS } from '../text';
import { openDiff, openFile } from '../app';
import { Icon, Spinner } from './icons';
import { MarkdownView } from './MarkdownView';
import { memo } from './ui';

type ToolItem = Extract<Item, { t: 'tool' }>;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function Output({ text, lines = 14, class: cls }: { text: string; lines?: number; class?: string }) {
  const [all, setAll] = useState(false);
  const shown = safe(text, LIMITS.output);
  const parts = shown.split('\n');
  const cut = !all && parts.length > lines;
  return (
    <div class={`out${cls ? ' ' + cls : ''}`}>
      <pre>{cut ? parts.slice(0, lines).join('\n') : shown}</pre>
      {parts.length > lines && (
        <button type="button" class="linkish out-more" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show ${parts.length - lines} more line${parts.length - lines === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  );
}

/** `lineMax`: characters shown of one line (a permission prompt shows each line whole). */
export function DiffLines({ lines, max = 400, lineMax = 4000 }: { lines: DiffLine[]; max?: number; lineMax?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, max);
  return (
    <div class="dl" role="table" aria-label="Changes">
      {shown.map((l, i) => (
        <div key={i} class={`dl-row dl-${l.kind}`} role="row">
          <span class="dl-no" role="cell">{l.oldNo ?? ''}</span>
          <span class="dl-no" role="cell">{l.newNo ?? ''}</span>
          <span class="dl-sign" role="cell">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
          <span class="dl-text" role="cell">{safe(l.text, lineMax)}</span>
        </div>
      ))}
      {lines.length > max && !all && (
        <button type="button" class="linkish out-more" onClick={() => setAll(true)}>
          Show {lines.length - max} more lines
        </button>
      )}
    </div>
  );
}

function PathButton({ path }: { path: string }) {
  const p = displayPath(path);
  return (
    <button
      type="button"
      class="path-btn"
      title={`Open ${p}`}
      onClick={(e) => {
        e.stopPropagation();
        void openFile(p);
      }}
    >
      {p}
    </button>
  );
}

function Changes({ add, del }: { add: number; del: number }) {
  return (
    <span class="chg">
      {add > 0 && <span class="chg-add">+{add}</span>}
      {del > 0 && <span class="chg-del">−{del}</span>}
    </span>
  );
}

const MAX_EDITS = 20;

function editLines(it: ToolItem): { lines: DiffLine[]; add: number; del: number; more: number } {
  const e = it.result?.edit;
  if (e && e.hunks.length) {
    const c = countChanges(e.hunks);
    return { lines: hunkLines(e.hunks), ...c, more: 0 };
  }
  const i = obj(it.input);
  const edits = Array.isArray(i.edits) ? (i.edits as unknown[]).map(obj) : [i];
  const lines: DiffLine[] = [];
  for (const ed of edits.slice(0, MAX_EDITS)) {
    if (lines.length) lines.push({ kind: 'hunk', text: '⋯', oldNo: null, newNo: null });
    lines.push(...compact(lineDiff(str(ed.old_string), str(ed.new_string))));
  }
  return { lines, add: lines.filter((l) => l.kind === 'add').length, del: lines.filter((l) => l.kind === 'del').length, more: Math.max(0, edits.length - MAX_EDITS) };
}

const ICONS: Record<string, string> = {
  Bash: 'terminal',
  BashOutput: 'terminal',
  KillShell: 'stop',
  Edit: 'pencil',
  MultiEdit: 'pencil',
  Write: 'newFile',
  NotebookEdit: 'pencil',
  Read: 'file',
  Glob: 'search',
  Grep: 'search',
  WebFetch: 'globe',
  WebSearch: 'globe',
  Task: 'sparkle',
  Agent: 'sparkle',
  TodoWrite: 'list',
  ExitPlanMode: 'book',
  Skill: 'sparkle',
};

interface Head {
  verb: string;
  subject: ComponentChildren;
  extra?: ComponentChildren;
  open: boolean;
}

function head(it: ToolItem): Head {
  const i = obj(it.input);
  const err = it.status === 'error';
  switch (it.name) {
    case 'Bash':
      return { verb: 'Bash', subject: <code class="one">{label(i.command, 300)}</code>, open: err };
    case 'BashOutput':
      return { verb: 'Output', subject: <code class="one">{label(i.bash_id, 80)}</code>, open: false };
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const path = str(i.file_path) || it.result?.edit?.path || '';
      const c = it.name === 'Write' && !it.result?.edit?.hunks.length ? { add: str(i.content).split('\n').length, del: 0 } : editLines(it);
      return { verb: it.name === 'Write' ? 'Write' : 'Edit', subject: <PathButton path={path} />, extra: <Changes add={c.add} del={c.del} />, open: true };
    }
    case 'NotebookEdit':
      return { verb: 'Notebook', subject: <PathButton path={str(i.notebook_path)} />, open: false };
    case 'Read': {
      const range = i.offset || i.limit ? ` · lines ${Number(i.offset) || 1}–${(Number(i.offset) || 1) + (Number(i.limit) || 0)}` : '';
      return { verb: 'Read', subject: <PathButton path={str(i.file_path)} />, extra: range ? <span class="muted">{range}</span> : undefined, open: false };
    }
    case 'Glob':
    case 'Grep': {
      const n = it.result ? it.result.text.split('\n').filter((l) => l.trim()).length : null;
      return {
        verb: it.name,
        subject: <code class="one">{label(i.pattern, 200)}</code>,
        extra: (
          <span class="muted">
            {i.path ? ` in ${displayPath(i.path)}` : ''}
            {n !== null ? ` · ${n} result${n === 1 ? '' : 's'}` : ''}
          </span>
        ),
        open: false,
      };
    }
    case 'WebFetch':
      return { verb: 'Fetch', subject: <span class="one url">{label(i.url, 300)}</span>, open: false };
    case 'WebSearch':
      return { verb: 'Search', subject: <span class="one">{label(i.query, 300)}</span>, open: false };
    case 'Task':
    case 'Agent':
      return { verb: 'Agent', subject: <span class="one">{label(i.description, 200)}</span>, extra: i.subagent_type ? <span class="tag">{label(i.subagent_type, 60)}</span> : undefined, open: true };
    case 'TodoWrite':
      return { verb: 'To-dos', subject: <span class="one muted">updated</span>, open: true };
    case 'ExitPlanMode':
      return { verb: 'Plan', subject: <span class="one muted">ready for review</span>, open: true };
    case 'AskUserQuestion': {
      const qs = Array.isArray(i.questions) ? (i.questions as unknown[]).map(obj) : [];
      return { verb: 'Asked', subject: <span class="one">{label(qs[0]?.question, 200)}{qs.length > 1 ? ` (+${qs.length - 1})` : ''}</span>, open: false };
    }
    case 'Skill':
      return { verb: 'Skill', subject: <code class="one">{label(i.skill ?? i.command ?? i.name, 200)}</code>, open: false };
    default: {
      const m = mcpParts(it.name);
      if (m) return { verb: m.tool, subject: <span class="one muted">{preview(it.input, 160)}</span>, extra: <span class="tag">MCP · {m.server}</span>, open: false };
      return { verb: it.name, subject: <span class="one muted">{preview(it.input, 160)}</span>, open: false };
    }
  }
}

function Todos({ input }: { input: unknown }) {
  const todos = (Array.isArray(obj(input).todos) ? (obj(input).todos as unknown[]) : []).slice(0, 100).map(obj);
  return (
    <ul class="todos">
      {todos.map((t, i) => (
        <li key={i} class={`todo todo-${label(t.status, 20)}`}>
          <span class="todo-box" aria-hidden="true">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : ''}</span>
          <span>{label(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content, 500)}</span>
        </li>
      ))}
    </ul>
  );
}

function Body({ it, nested }: { it: ToolItem; nested?: ComponentChildren }) {
  const i = obj(it.input);
  const r = it.result;
  switch (it.name) {
    case 'Bash':
      return (
        <>
          <pre class="cmd">
            <span class="prompt">$ </span>
            {safe(i.command, 20_000)}
          </pre>
          {i.description ? <div class="muted small">{label(i.description, 300)}</div> : null}
          {r && (r.text ? <Output text={r.text} class={r.isError ? 'err' : ''} /> : <div class="muted small">(no output)</div>)}
        </>
      );
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const e = r?.edit;
      const path = str(i.file_path) || e?.path || '';
      const isWrite = it.name === 'Write' && !e?.hunks.length;
      const ed = editLines(it);
      const lines = isWrite ? lineDiff('', str(i.content)) : ed.lines;
      const all = (Array.isArray(i.edits) ? (i.edits as unknown[]).map(obj) : [i]).some((x) => x.replace_all === true);
      return (
        <>
          {all && <div class="muted small">Replaced every occurrence, not only the first.</div>}
          <DiffLines lines={lines} max={isWrite ? 30 : 400} />
          {!isWrite && ed.more > 0 && <div class="muted small">and {ed.more} more edit{ed.more === 1 ? '' : 's'} (open the diff for all of them)</div>}
          {e && !e.complete && <div class="muted small">The change is too large to show in full here: open the file to see it.</div>}
          <div class="card-actions">
            <button
              type="button"
              class="btn small"
              onClick={() => openDiff(it.id, displayPath(path), e?.original ?? (isWrite ? '' : null), e?.hunks ?? [], isWrite ? str(i.content) : undefined)}
            >
              <Icon name="diff" size={14} /> Open diff
            </button>
            {/* (a file outside /workspace — the sandbox's home, /tmp — cannot be opened here) */}
            {path && cleanPath(path) !== null && (
              <button type="button" class="btn small ghost" onClick={() => void openFile(displayPath(path))}>
                <Icon name="file" size={14} /> Open file
              </button>
            )}
          </div>
          {r?.isError && <Output text={r.text} class="err" />}
        </>
      );
    }
    case 'TodoWrite':
      return <Todos input={it.input} />;
    case 'ExitPlanMode':
      return <MarkdownView text={safe(i.plan, LIMITS.text)} class="plan" />;
    case 'Task':
    case 'Agent':
      return (
        <>
          {i.prompt ? (
            <details class="sub-prompt">
              <summary>Instructions</summary>
              <Output text={str(i.prompt)} lines={30} />
            </details>
          ) : null}
          {nested && <div class="nested">{nested}</div>}
          {r && <MarkdownView text={r.text} class={`sub-result${r.isError ? ' err' : ''}`} />}
        </>
      );
    case 'WebFetch':
      return (
        <>
          {i.prompt ? <div class="muted small">{label(i.prompt, 500)}</div> : null}
          {r && <Output text={r.text} />}
        </>
      );
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'WebSearch':
    case 'BashOutput':
    case 'AskUserQuestion':
    case 'Skill':
      return r ? <Output text={r.text} lines={20} class={r.isError ? 'err' : ''} /> : null;
    default:
      return (
        <>
          <pre class="json">{prettyJson(it.input, 20_000)}</pre>
          {r && <Output text={r.text} class={r.isError ? 'err' : ''} />}
        </>
      );
  }
}

export const ToolCard = memo(function ToolCard({ it, nested, waiting }: { it: ToolItem; nested?: ComponentChildren; waiting?: boolean }) {
  const h = head(it);
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? (h.open && !waiting);
  const status = waiting ? 'waiting' : it.status;
  return (
    <div class={`tool tool-${status}`} data-tool={label(it.name, 60)} data-testid="tool-card">
      <div class="tool-head" onClick={() => setOpen(!isOpen)}>
        <button
          type="button"
          class="tool-toggle"
          aria-expanded={isOpen}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!isOpen);
          }}
        >
          <span class="tool-icon">
            <Icon name={ICONS[it.name] ?? (mcpParts(it.name) ? 'server' : 'sparkle')} size={14} />
          </span>
          <span class="tool-verb">{h.verb}</span>
        </button>
        <span class="tool-subject">{h.subject}</span>
        {h.extra}
        <span class="tool-status" title={status}>
          {status === 'running' ? <Spinner size={13} /> : status === 'waiting' ? <Icon name="alert" size={14} /> : status === 'error' ? <Icon name="close" size={14} /> : <Icon name="check" size={14} />}
        </span>
        <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} class="tool-chev" />
      </div>
      {isOpen && (
        <div class="tool-body">
          <Body it={it} nested={nested} />
        </div>
      )}
    </div>
  );
});
