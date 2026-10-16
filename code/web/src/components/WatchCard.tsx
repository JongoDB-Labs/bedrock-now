// The watchlist's card: files of your folder that run on your computer later (git hooks and config, husky hooks,
// .envrc, VS Code tasks and settings, Claude Code's workspace settings, .mcp.json, package.json's install scripts, dev
// container commands) changed in a turn — in every mode, Bash included. Each with why it matters, a diff, and Revert
// (the file as the turn's start saw it, only while it is still as its end saw it; a new one goes to the workspace
// trash). Every string came from the sandbox: shown as text only.
import { useState } from 'preact/hooks';
import type { WatchChange } from '../types';
import { revertWatch } from '../app';
import { compact, lineDiff } from '../diff';
import { DiffLines } from './ToolCard';
import { Icon, Spinner } from './icons';

const CHANGE: Record<WatchChange['change'], string> = { added: 'new', changed: 'changed', removed: 'removed' };

function Change({ c, busy, result, onRevert }: { c: WatchChange; busy: boolean; result: { ok: boolean; text: string } | undefined; onRevert: () => void }) {
  const [open, setOpen] = useState(false);
  const diffable = c.before !== null || c.after !== null;
  return (
    <li class="watch-item" data-testid="watch-item">
      <div class="watch-row">
        <code class="watch-path">{c.path}</code>
        <span class={`tag watch-${c.change}`}>{CHANGE[c.change]}</span>
        {c.exec && c.change !== 'removed' && <span class="tag watch-exec">executable</span>}
        <span class="watch-actions">
          {diffable && !c.binary && (
            <button type="button" class="linkish" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="watch-diff">
              {open ? 'Hide diff' : 'Diff'}
            </button>
          )}
          {result ? (
            <span class={result.ok ? 'watch-done' : 'watch-err'} data-testid="watch-result">
              {result.ok ? (result.text === 'trashed' ? 'Moved to the workspace trash' : result.text === 'already' ? 'Put back already' : 'Put back') : result.text}
            </span>
          ) : c.revertable ? (
            <button type="button" class="btn small" disabled={busy} onClick={onRevert} data-testid="watch-revert-one">
              <Icon name="undo" size={13} /> Revert
            </button>
          ) : null}
        </span>
      </div>
      <div class="watch-why">{c.why}</div>
      {c.binary && <div class="watch-why muted">Not text: no diff here.</div>}
      {open && (
        <div class="watch-diff">
          <DiffLines lines={compact(lineDiff(c.before ?? '', c.after ?? ''))} max={600} />
          {c.cut && <div class="muted small">Only the first 64 KiB of each side are shown.</div>}
        </div>
      )}
    </li>
  );
}

export function WatchCard({ session, id, when, changes }: { session: string; id: string; when: 'turn' | 'between'; changes: WatchChange[] }) {
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [kept, setKept] = useState(false);
  const revert = async (path?: string) => {
    setBusy(true);
    setError('');
    const r = await revertWatch(session, id, path);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setResults((x) => ({ ...x, ...Object.fromEntries(r.results.map((y) => [y.path, { ok: y.ok, text: y.text }])) }));
  };
  const open = changes.filter((c) => c.revertable && !results[c.path]?.ok);
  const title = when === 'between' ? 'Changed since the last turn ended (a background command, the terminal, or you)' : 'Changed in this turn';
  if (kept) {
    return (
      <div class="watch watch-kept" data-testid="watch-card">
        <Icon name="alert" size={13} /> {changes.length} file{changes.length === 1 ? '' : 's'} that run on your computer changed ({changes.map((c) => c.path).join(', ')}): kept.{' '}
        <button type="button" class="linkish" onClick={() => setKept(false)}>
          Show
        </button>
      </div>
    );
  }
  return (
    <div class="watch" role="group" aria-label="Files that run on your computer changed" data-testid="watch-card">
      <div class="watch-head">
        <Icon name="alert" size={16} />
        <span class="watch-title">Files that run on your computer changed</span>
        <span class="watch-when">{title}</span>
      </div>
      <p class="watch-lede">
        These files are in your folder: git, VS Code, direnv, npm or Claude Code on your computer run what they say when you use the folder there — not
        in the sandbox. Check them before you do.
      </p>
      <ul class="watch-list">
        {changes.map((c) => (
          <Change key={c.path} c={c} busy={busy} result={results[c.path]} onRevert={() => void revert(c.path)} />
        ))}
      </ul>
      {error && (
        <div class="perm-warn perm-partial" role="alert" data-testid="watch-error">
          <Icon name="alert" size={14} /> {error}
        </div>
      )}
      <div class="perm-buttons">
        <button type="button" class="btn ghost" onClick={() => setKept(true)} data-testid="watch-keep">
          Keep
        </button>
        {open.length > 1 && (
          <button type="button" class="btn" disabled={busy} onClick={() => void revert()} data-testid="watch-revert-all">
            {busy ? <Spinner size={12} /> : <Icon name="undo" size={13} />} Revert all
          </button>
        )}
      </div>
    </div>
  );
}
