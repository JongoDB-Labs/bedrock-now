// Memory: the CLAUDE.md files Claude Code reads at the start of every session — the project's (<its folder>/CLAUDE.md:
// /workspace/CLAUDE.md for the Workspace; shared with Claude Code on your computer when it opens that folder) and your
// user one in the sandbox
// (~/.claude/CLAUDE.md). A plain text editor; a save carries the modification time it read, so a change made
// meanwhile (Claude, the terminal, another tab) is never overwritten unasked.
import { useEffect, useState } from 'preact/hooks';
import * as api from '../api';
import type { Memory, MemoryScope } from '../api';
import { refreshExpandedDirs, toast } from '../app';
import { Dialog } from './ui';
import { SandboxSaid } from './Said';
import { Icon, Spinner } from './icons';

const SCOPES: [MemoryScope, string, string][] = [
  ['project', 'Project', "This project's CLAUDE.md: in your folder, so Claude Code on your computer reads it there too."],
  ['user', 'User', 'Your own CLAUDE.md in the sandbox: every session here reads it, in any project.'],
];

export function MemoryDialog({ onClose }: { onClose: () => void }) {
  const [scope, setScope] = useState<MemoryScope>('project');
  const [mem, setMem] = useState<Memory | null>(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [errorSaid, setErrorSaid] = useState<ReturnType<typeof api.saidOf>>(null);
  const [conflict, setConflict] = useState(false);
  const dirty = !!mem && text !== mem.text;

  const load = async (s: MemoryScope) => {
    setLoading(true);
    setError('');
    setErrorSaid(null);
    setConflict(false);
    try {
      const m = await api.getMemory(s);
      setMem(m);
      setText(m.text);
    } catch (e) {
      setMem(null);
      setError(e instanceof Error ? e.message : String(e));
      setErrorSaid(api.saidOf(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => void load(scope), [scope]);

  const save = async (overwrite = false) => {
    if (!mem || mem.truncated) return;
    setSaving(true);
    setError('');
    setErrorSaid(null);
    try {
      const r = await api.putMemory(scope, text, overwrite || !mem.exists ? null : mem.mtimeMs);
      if (!r.ok) {
        setConflict(true);
        return;
      }
      setConflict(false);
      setMem({ ...mem, exists: true, text, mtimeMs: r.mtimeMs });
      toast(`Saved ${mem.path}`, 'ok');
      if (scope === 'project') refreshExpandedDirs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setErrorSaid(api.saidOf(e));
    } finally {
      setSaving(false);
    }
  };

  const switchTo = (s: MemoryScope) => {
    if (s === scope) return;
    if (dirty) {
      toast('Save or revert your changes first.', 'error');
      return;
    }
    setScope(s);
  };

  return (
    <Dialog title="Memory (CLAUDE.md)" onClose={onClose} wide testid="memory-dialog">
      <div class="seg mem-tabs" role="tablist">
        {SCOPES.map(([s, name]) => (
          <button key={s} type="button" role="tab" aria-pressed={scope === s} aria-selected={scope === s} onClick={() => switchTo(s)} data-testid={`memory-tab-${s}`}>
            {name}
          </button>
        ))}
        {loading && <Spinner size={14} />}
      </div>
      <p class="muted small mem-about">
        {SCOPES.find(([s]) => s === scope)?.[2]} Claude Code reads it when a session starts; <code>#</code> at the start of a one-line prompt adds a line to the
        project's.
      </p>
      {mem && (
        <div class="mem-path">
          <Icon name="file" size={13} /> <code>{mem.path}</code>
          {!mem.exists && <span class="muted"> — not there yet: Save creates it</span>}
        </div>
      )}
      {mem?.truncated && (
        <div class="plg-note err" role="alert">
          This file is larger than the editor takes (1 MiB), so it is read-only here. Edit it in the terminal.
        </div>
      )}
      {conflict && (
        <div class="plg-note err mem-conflict" role="alert" data-testid="memory-conflict">
          <span>It changed meanwhile (Claude, the terminal or another tab).</span>
          <button type="button" class="btn small" onClick={() => void load(scope)} data-testid="memory-reload">
            Reload (drop yours)
          </button>
          <button type="button" class="btn small danger" onClick={() => void save(true)} data-testid="memory-overwrite">
            Overwrite with yours
          </button>
        </div>
      )}
      {error && (
        <div class="plg-note err">
          {error}
          {errorSaid && <SandboxSaid words={errorSaid} />}
        </div>
      )}
      <textarea
        class="mem-text"
        value={text}
        readOnly={!mem || mem.truncated}
        spellcheck={false}
        placeholder={mem && !mem.exists ? '# Notes for Claude\n\n- How to build and test this project\n- Conventions to follow' : ''}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            void save();
          }
        }}
        aria-label={`${scope === 'project' ? 'Project' : 'User'} CLAUDE.md`}
        data-testid="memory-text"
      />
      <div class="mem-foot">
        <span class="muted small">{dirty ? 'Unsaved changes' : mem?.exists ? 'Saved' : ''}</span>
        <button type="button" class="btn ghost" onClick={() => (dirty ? setText(mem?.text ?? '') : onClose())}>
          {dirty ? 'Revert' : 'Close'}
        </button>
        <button type="button" class="btn primary" disabled={!mem || mem.truncated || saving || (!dirty && mem.exists)} onClick={() => void save()} data-testid="memory-save">
          {saving ? 'Saving…' : mem && !mem.exists ? 'Create' : 'Save'}
        </button>
      </div>
    </Dialog>
  );
}

