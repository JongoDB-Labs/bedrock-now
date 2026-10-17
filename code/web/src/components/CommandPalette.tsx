// The command palette (⌘K / Ctrl+K, Ctrl+Shift+P; ⌘P / Ctrl+P opens it as "Go to file"): actions (a new session, the
// mode, model and effort, panels, Ports, export, memory, plugins, MCP, settings), sessions to resume, files (what the
// explorer listed, and from two characters on a bounded search of the whole workspace), and what you ran last. A fuzzy
// match (fuzzy.ts: linear time, capped), entirely by keyboard (↑ ↓ Tab, Enter, Esc; ">" only actions, "#" only
// sessions). On a phone it is a sheet (⋯ → Command palette).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import {
  store,
  activeView,
  closePalette,
  exportTranscript,
  knownPaths,
  newSession,
  openFile,
  openModeMenu,
  openPalette,
  openReview,
  reloadPlugins,
  resumeSession,
  restartSession,
  setDialog,
  openRun,
  setEffort,
  setMode,
  setModel,
  setNotify,
  setSheet,
  showSearch,
  showGit,
  showSessions,
  toggleExplorer,
  toggleTerminal,
  type AppState,
} from '../app';
import { fsFind } from '../api';
import { rank } from '../fuzzy';
import { keysFor } from '../shortcuts';
import { MODE_INFO, offeredModes } from '../modes';
import { ago, label } from '../text';
import { Icon } from './icons';
import { Sheet, useMedia } from './ui';
import { mentionSelection } from './EditorArea';
import { addDiff, addProblems, addTerminal } from '../attach';

type Group = 'Recent' | 'Actions' | 'Sessions' | 'Files';
interface Item {
  id: string;
  group: Group;
  label: string;
  detail: string;
  keys: string;
  icon: string;
  run: () => void;
}

// what you ran last (ids, per browser; validated on every read)
const RECENT_KEY = 'bn.code.palette.v1';
function recentIds(): string[] {
  try {
    const v: unknown = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 600).slice(0, 12) : [];
  } catch {
    return [];
  }
}
function remember(id: string): void {
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, 12)));
  } catch {
    /* storage blocked: fine */
  }
}

function actions(s: AppState): Item[] {
  const v = activeView(s);
  const a = (id: string, label: string, run: () => void, icon = 'dot', detail = '', keys = ''): Item => ({ id: `a:${id}`, group: 'Actions', label, detail, keys, icon, run });
  const portal = s.server?.portalOrigin;
  const list: Item[] = [
    a('new', 'New session', () => void newSession(), 'plus'),
    a('review', 'Review changes', openReview, 'diff', 'every changed file: Keep, Undo, comments', keysFor('review')),
    a('search', 'Search in files', showSearch, 'search', '', keysFor('search')),
    a('git', 'Git: changes, commit, log', () => showGit(), 'branch', 'stage, commit, discard — no hooks run', keysFor('git')),
    a('git-commit', 'Git: commit the staged changes…', () => showGit(true), 'branch', 'the commit message box'),
    a('go-to-file', 'Go to file…', () => setTimeout(() => openPalette('files'), 0), 'file', '', keysFor('go-to-file')),
    a('sessions', 'Show the session list', showSessions, 'history'),
    a('terminal', s.prefs.layout.terminal ? 'Hide the terminal' : 'Show the terminal', toggleTerminal, 'terminal', '', keysFor('terminal')),
    a('explorer', s.prefs.layout.explorer ? 'Hide the explorer' : 'Show the explorer', toggleExplorer, 'sidebar', '', keysFor('explorer')),
    a('ports', 'Ports & previews…', () => setDialog('ports'), 'port', '', keysFor('ports')),
    a('run', 'Run & test…', openRun, 'play', "the workspace's scripts, make targets and entry points; Problems", keysFor('run')),
    a('memory', 'Memory (CLAUDE.md)…', () => setDialog('memory'), 'book'),
    a('plugins', 'Plugins & marketplaces…', () => setDialog('plugins'), 'plug'),
    a('mcp', 'MCP servers…', () => setDialog('mcp'), 'server'),
    a('reload-plugins', 'Reload plugins & skills', reloadPlugins, 'refresh'),
    a('export', 'Export the conversation (.md)', () => void exportTranscript(), 'download'),
    a('notify', s.prefs.notify ? 'Stop notifying me' : 'Notify me when Claude waits or is done', () => void setNotify(!s.prefs.notify), 'alert'),
    a('mode-menu', 'Permission mode menu', openModeMenu, 'shield', '', keysFor('mode-menu')),
    a('mention-selection', "Add the editor's selected lines to the prompt", () => void mentionSelection(), 'at', '@file#L5-10, quoted', keysFor('mention-selection')),
    a('mention-terminal', "Add the terminal's last lines to the prompt", () => void addTerminal(), 'terminal', '@terminal, quoted'),
    a('mention-diff', 'Add the changes to the prompt', () => void addDiff(), 'diff', "@diff: the Review pane's diff, quoted"),
    a('mention-problems', 'Add the Problems list to the prompt', () => void addProblems(), 'alert', "@problems: the failed runs' output, quoted"),
    a('shortcuts', 'Keyboard shortcuts', () => setDialog('shortcuts'), 'keyboard', '', keysFor('shortcuts')),
  ];
  if (v && v.state !== 'closed') list.push(a('restart', 'Restart this session (load new MCP servers)', () => void restartSession(), 'refresh'));
  // modes, models, effort: one entry each, so typing "plan" or "haiku" finds them
  for (const m of offeredModes(s.server?.allowBypass === true, s.server?.allowAuto === true)) {
    const info = MODE_INFO[m];
    list.push(a(`mode:${m}`, `Mode: ${info.label}`, () => setMode(m), info.icon, info.desc));
  }
  // the models Settings › Claude Code › Models lists (every one with the picker's "Show all")
  for (const m of s.models?.models ?? [])
    if (m.listed || s.prefs.allModels) list.push(a(`model:${m.id}`, `Model: ${label(m.name, 80)}`, () => void setModel(m.id), 'model', label(m.id, 120)));
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) list.push(a(`effort:${e}`, `Effort: ${e}`, () => setEffort(e), 'gauge'));
  list.push(a('effort:default', "Effort: the model's default", () => setEffort(null), 'gauge'));
  if (portal) {
    list.push(a('settings', 'bedrock-now Settings (Code page, Bypass, terminal)…', () => window.open(`${portal}/#settings`, '_blank', 'noopener,noreferrer'), 'external', 'opens the portal in a new tab'));
  }
  return list;
}

function sessionItems(s: AppState): Item[] {
  return s.sessions.slice(0, 200).map((x) => ({
    id: `s:${x.id}`,
    group: 'Sessions' as const,
    label: label(x.title || x.firstPrompt || x.id.slice(0, 8), 200),
    detail: [s.views[x.id] && s.views[x.id].state !== 'closed' ? 'open' : '', x.branch ? label(x.branch, 60) : '', x.modified ? ago(x.modified) : ''].filter(Boolean).join(' · '),
    keys: '',
    icon: 'history',
    run: () => void resumeSession(x.id),
  }));
}

const fileItem = (p: string): Item => ({ id: `f:${p}`, group: 'Files', label: p, detail: '', keys: '', icon: p.endsWith('/') ? 'folder' : 'file', run: () => (p.endsWith('/') ? undefined : void openFile(p)) });

export function CommandPalette() {
  const pal = useSel(store, (s) => s.palette);
  if (!pal) return null;
  return <PaletteBody key={pal.n} mode={pal.mode} />;
}

function PaletteBody({ mode }: { mode: 'all' | 'files' }) {
  const phone = useMedia('(max-width: 699.98px)');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [found, setFound] = useState<{ q: string; paths: string[] }>({ q: '', paths: [] });
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);
  // (the slices the lists are made of: not the whole state, which changes with every streamed word)
  const slices = [
    useSel(store, (s) => s.sessions),
    useSel(store, (s) => s.models),
    useSel(store, (s) => s.prefs),
    useSel(store, (s) => s.server),
    useSel(store, (s) => s.fs.dirs),
    useSel(store, (s) => activeView(s)?.state),
  ];
  const st = useMemo(() => store.get(), slices);
  // (focused as it renders: keys typed right after the shortcut land here)
  useLayoutEffect(() => {
    input.current?.focus();
    return () => {
      const el = back.current as HTMLElement | null;
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
    };
  }, []);

  // what the query asks for: ">" only actions, "#" only sessions; Go to file: files
  const only: Group | null = query.startsWith('>') ? 'Actions' : query.startsWith('#') ? 'Sessions' : mode === 'files' ? 'Files' : null;
  const q = only && only !== 'Files' ? query.slice(1).trim() : query.trim();
  const wantFiles = only === 'Files' || (!only && q.length >= 2);

  // from two characters on, the whole workspace (bn-coded's bounded find), after a pause in typing
  useEffect(() => {
    if (!wantFiles || q.length < 2) return;
    let gone = false;
    const t = setTimeout(() => {
      fsFind(q, 100).then((r) => !gone && setFound({ q, paths: r.paths }), () => undefined);
    }, 150);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [q, wantFiles]);

  const items = useMemo(() => {
    const acts = only === 'Sessions' || only === 'Files' ? [] : actions(st);
    const sess = only === 'Actions' || only === 'Files' ? [] : sessionItems(st);
    const files: Item[] = [];
    if (wantFiles) {
      const set = new Set(knownPaths(st).filter((p) => !p.endsWith('/')));
      if (found.q === q) for (const p of found.paths) if (!p.endsWith('/')) set.add(p);
      for (const p of set) files.push(fileItem(p));
    }
    const all = [...acts, ...sess, ...files];
    if (!q) {
      // nothing typed: what you ran last, then (in its order) the rest
      const byId = new Map(all.map((i) => [i.id, i]));
      const recent = recentIds().map((id) => byId.get(id) ?? (id.startsWith('f:') && (only === 'Files' || !only) ? fileItem(id.slice(2)) : undefined)).filter((i): i is Item => !!i);
      const rest = only === 'Files' ? [] : all.filter((i) => !recent.includes(i));
      return [...recent.map((i) => ({ item: { ...i, group: 'Recent' as Group }, hits: [] as number[] })), ...rest.slice(0, 60).map((i) => ({ item: i, hits: [] as number[] }))];
    }
    return rank(all, q, (i) => i.label, (i) => i.detail, 80).map((r) => ({ item: r.item, hits: r.hits }));
  }, [q, only, st, found, wantFiles]);

  useEffect(() => setSel(0), [q, only]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  }, [sel, items.length]);

  const run = (i: number) => {
    const it = items[i]?.item;
    if (!it) return;
    remember(it.id);
    closePalette();
    it.run();
  };
  const onKey = (e: KeyboardEvent) => {
    const n = items.length;
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      if (n) setSel((x) => (x + 1) % n);
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      if (n) setSel((x) => (x - 1 + n) % n);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      if (n) setSel((x) => Math.min(n - 1, x + 8));
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      if (n) setSel((x) => Math.max(0, x - 8));
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      run(sel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
    }
  };

  const placeholder = mode === 'files' ? 'Go to file…' : 'Type a command, a session or a file  ( > actions · # sessions )';
  let lastGroup: Group | null = null;
  const body = (
    <div class={`cp${phone ? ' phone' : ''}`} data-testid="command-palette">
      <div class="cp-input-row">
        <Icon name={mode === 'files' ? 'file' : 'search'} size={15} />
        <input
          ref={input}
          class="cp-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="cp-list"
          aria-activedescendant={items.length ? `cp-opt-${sel}` : undefined}
          aria-autocomplete="list"
          aria-label={mode === 'files' ? 'Go to file' : 'Command palette'}
          placeholder={placeholder}
          value={query}
          maxLength={200}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={onKey}
          data-testid="cp-input"
        />
      </div>
      <div class="cp-list" id="cp-list" role="listbox" aria-label="Results" ref={list}>
        {!items.length && <div class="cp-empty muted">{wantFiles && q.length >= 2 && found.q !== q ? 'Searching the workspace…' : 'Nothing matches.'}</div>}
        {items.map(({ item, hits }, i) => {
          const head = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <div key={`${item.group}:${item.id}`}>
              {head && (
                <div class="cp-group" role="presentation">
                  {head}
                </div>
              )}
              <div
                id={`cp-opt-${i}`}
                role="option"
                aria-selected={i === sel}
                class={`cp-item${i === sel ? ' on' : ''}`}
                onMouseMove={() => i !== sel && setSel(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(i)}
                data-testid="cp-item"
                data-id={item.id}
              >
                <Icon name={item.icon} size={14} />
                <span class="cp-label">
                  <Highlight text={item.label} hits={hits} />
                </span>
                {item.detail && <span class="cp-detail muted">{item.detail}</span>}
                {item.keys && <kbd>{item.keys}</kbd>}
              </div>
            </div>
          );
        })}
      </div>
      <div class="cp-foot muted small">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> run
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
        <span>
          <kbd>&gt;</kbd> actions · <kbd>#</kbd> sessions
        </span>
      </div>
    </div>
  );
  if (phone) {
    return (
      <Sheet title={mode === 'files' ? 'Go to file' : 'Command palette'} onClose={closePalette} testid="cp-sheet">
        {body}
      </Sheet>
    );
  }
  return (
    <div class="cp-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closePalette()} role="dialog" aria-modal="true" aria-label="Command palette">
      {body}
    </div>
  );
}

/** The label with the matched characters marked (as text). */
function Highlight({ text, hits }: { text: string; hits: number[] }) {
  if (!hits.length) return <>{text}</>;
  const set = new Set(hits);
  const parts: preact.JSX.Element[] = [];
  let run = '';
  let on = false;
  const flush = (k: number) => {
    if (run) parts.push(on ? <mark key={k}>{run}</mark> : <span key={k}>{run}</span>);
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const h = set.has(i);
    if (h !== on) {
      flush(i);
      on = h;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}

/** ⋯ on a phone: the palette as a sheet. */
export function openPaletteFromMenu(): void {
  setSheet(null);
  openPalette('all');
}
