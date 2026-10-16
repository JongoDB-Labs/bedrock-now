// Search in files (the side panel's Search tab; a sheet on a phone): a text — or, with .*, a regular expression in
// ripgrep's engine — searched in the workspace's files by the sandbox (GET /api/fs/grep), any case unless Aa, with
// files to include / exclude (globs). Results by file, then line; a line opens the file in the editor there. Searches
// run on Enter and after a pause in typing (older answers are dropped).
import { useEffect, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, openFileAt, runSearch, setSearch } from '../app';
import { label, safe } from '../text';
import type { GrepFile, GrepHit } from '../types';
import { Icon, Spinner } from './icons';
import { MOD } from '../shortcuts';

let focusedFor = 0;

export function SearchPanel({ onOpen }: { onOpen?: () => void }) {
  const st = useSel(store, (s) => s.search);
  const input = useRef<HTMLInputElement>(null);
  const typed = useRef(0);
  // focused when asked for (the tab, Ctrl/⌘+Shift+F, the palette) — not when the page opens on this tab
  useEffect(() => {
    if (st.focus <= focusedFor) return;
    focusedFor = st.focus;
    input.current?.focus();
    input.current?.select();
  }, [st.focus]);
  // a pause in typing searches (two characters at least); Enter searches at once
  const schedule = () => {
    const n = ++typed.current;
    setTimeout(() => {
      if (n === typed.current && store.get().search.q.trim().length >= 2) void runSearch();
    }, 450);
  };
  const r = st.result;
  return (
    <div class="fsrch" data-testid="search-panel">
      <div class="fsrch-box">
        <div class="fsrch-row">
          <input
            ref={input}
            type="search"
            class="fsrch-input"
            placeholder="Search in files"
            aria-label="Search in files"
            value={st.q}
            maxLength={1000}
            onInput={(e) => {
              setSearch({ q: (e.currentTarget as HTMLInputElement).value });
              schedule();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                typed.current++;
                void runSearch();
              } else if (e.key === 'ArrowDown') {
                const first = document.querySelector<HTMLElement>('[data-testid=search-hit]');
                if (first) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
            data-testid="search-input"
          />
          <button type="button" class={`fsrch-toggle${st.caseSensitive ? ' on' : ''}`} aria-pressed={st.caseSensitive} title="Match case" aria-label="Match case"
            onClick={() => (setSearch({ caseSensitive: !st.caseSensitive }), st.q.trim() && void runSearch())} data-testid="search-case">
            Aa
          </button>
          <button type="button" class={`fsrch-toggle${st.regex ? ' on' : ''}`} aria-pressed={st.regex} title="Regular expression (ripgrep's syntax)" aria-label="Regular expression"
            onClick={() => (setSearch({ regex: !st.regex }), st.q.trim() && void runSearch())} data-testid="search-regex">
            .*
          </button>
          <button type="button" class={`fsrch-toggle${st.globs ? ' on' : ''}`} aria-pressed={st.globs} title="Files to include or exclude" aria-label="Files to include or exclude"
            onClick={() => setSearch({ globs: !st.globs })} data-testid="search-globs">
            <Icon name="more" size={14} />
          </button>
        </div>
        {st.globs && (
          <div class="fsrch-globs">
            <input type="text" class="fsrch-input" placeholder="Files to include (src/**, *.ts)" aria-label="Files to include" value={st.include} maxLength={2200}
              onInput={(e) => setSearch({ include: (e.currentTarget as HTMLInputElement).value })} onKeyDown={(e) => e.key === 'Enter' && void runSearch()} data-testid="search-include" />
            <input type="text" class="fsrch-input" placeholder="Files to exclude (*.min.js, vendor/**)" aria-label="Files to exclude" value={st.exclude} maxLength={2200}
              onInput={(e) => setSearch({ exclude: (e.currentTarget as HTMLInputElement).value })} onKeyDown={(e) => e.key === 'Enter' && void runSearch()} data-testid="search-exclude" />
          </div>
        )}
        <div class="fsrch-status muted small" data-testid="search-status" aria-live="polite">
          {st.loading ? (
            <>
              <Spinner size={11} /> Searching…
            </>
          ) : st.error ? (
            <span class="err">{label(st.error, 300)}</span>
          ) : r ? (
            <>
              {r.hits ? `${r.hits} result${r.hits === 1 ? '' : 's'} in ${r.files.length} file${r.files.length === 1 ? '' : 's'}` : 'No results'}
              {r.truncated && ' — the first 2,000: narrow the search'}
              {r.timedOut && ' — it took too long: the results so far'}
              {r.engine === 'node' && ' (text only: no ripgrep in the sandbox)'}
            </>
          ) : (
            <>Skips .git, dependencies and build output; honours .gitignore. {MOD}+Shift+F</>
          )}
        </div>
      </div>
      <div class="fsrch-results" role="tree" aria-label="Search results">
        {r?.files.map((f) => <FileHits key={f.path} f={f} onOpen={onOpen} />)}
      </div>
    </div>
  );
}

function FileHits({ f, onOpen }: { f: GrepFile; onOpen?: () => void }) {
  const [open, setOpen] = useState(true);
  const slash = f.path.lastIndexOf('/');
  return (
    <div class="fsrch-file" role="treeitem" aria-expanded={open} data-testid="search-file" data-path={f.path}>
      <button type="button" class="fsrch-file-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
        <Icon name="file" size={13} />
        <span class="fsrch-file-name">{label(f.path.slice(slash + 1), 200)}</span>
        {slash > 0 && <span class="fsrch-file-dir muted">{label(f.path.slice(0, slash), 300)}</span>}
        <span class="badge">{f.hits.length}</span>
      </button>
      {open && (
        <div role="group">
          {f.hits.map((h, i) => (
            <Hit key={i} path={f.path} h={h} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function Hit({ path, h, onOpen }: { path: string; h: GrepHit; onOpen?: () => void }) {
  const before = h.text.slice(0, h.col);
  const match = h.text.slice(h.col, h.col + h.len);
  const after = h.text.slice(h.col + h.len);
  // (the start of a long line is left out: keep the match in view)
  const lead = before.length > 40 ? `…${before.slice(-40)}` : before;
  return (
    <button
      type="button"
      role="treeitem"
      class="fsrch-hit"
      title={`${path}:${h.line}`}
      onClick={() => {
        onOpen?.();
        void openFileAt(path, h.line, h.col, h.len);
      }}
      onKeyDown={(e) => {
        const el = e.currentTarget as HTMLElement;
        const all = [...document.querySelectorAll<HTMLElement>('[data-testid=search-hit]')];
        const i = all.indexOf(el);
        if (e.key === 'ArrowDown' && i + 1 < all.length) (e.preventDefault(), all[i + 1].focus());
        else if (e.key === 'ArrowUp') (e.preventDefault(), i > 0 ? all[i - 1].focus() : document.querySelector<HTMLElement>('[data-testid=search-input]')?.focus());
      }}
      data-testid="search-hit"
    >
      <span class="fsrch-line muted">{h.line}</span>
      <span class="fsrch-text">
        {safe(lead.trimStart(), 300)}
        <mark>{safe(match, 300)}</mark>
        {safe(after, 300)}
        {h.cut && '…'}
      </span>
    </button>
  );
}
