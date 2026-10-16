// MCP servers: the active session's servers as Claude Code reports them (mcpServerStatus): status, tools, errors;
// reconnect one, or switch it off/on for this session. Servers of your own are added to (or removed from) the
// sandbox's user configuration (`claude mcp add-json/remove --scope user`): a stdio server's command runs inside the
// sandbox only — never on your computer. New servers load when a session starts (Restart does that for this one).
import { useEffect, useState } from 'preact/hooks';
import * as api from '../api';
import type { McpServer } from '../types';
import { useSel } from '../store';
import { store, activeView, mcpReconnect, mcpToggle, requestMcp, restartSession } from '../app';
import { Dialog } from './ui';
import { Icon, Spinner } from './icons';
import { pairs } from '../forms';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
const DOT: Record<string, string> = { connected: 'live', failed: 'err', 'needs-auth': 'warn', pending: 'warn' };
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function ServerRow({ s, busy, onBusy }: { s: McpServer; busy: boolean; onBusy: (name: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const disabled = s.status === 'disabled';
  const own = s.scope === 'user' || s.source === 'user';
  return (
    <li class={`mcp-row${disabled ? ' off' : ''}`} data-server={s.name} data-testid="mcp-server">
      <div class="mcp-main">
        <div class="plg-title">
          <span class={`sdot ${DOT[s.status] ?? ''}`} />
          <span class="plg-name">{s.name}</span>
          <span class={`mcp-status st-${s.status}`} data-testid="mcp-status">
            {s.status}
          </span>
          {(s.source || s.scope) && <span class="tag">{s.source === 'dynamic' && s.name === 'bedrock-shared' ? 'bedrock-now' : s.source || s.scope}</span>}
          {s.tools !== null && (
            <button type="button" class="linkish small" onClick={() => setOpen(!open)} aria-expanded={open}>
              {s.tools} tool{s.tools === 1 ? '' : 's'}
            </button>
          )}
        </div>
        {(s.command || s.url) && (
          <div class="plg-desc mono" title={s.transport}>
            {s.transport ? `${s.transport}: ` : ''}
            {s.command || s.url}
          </div>
        )}
        {s.error && <div class="plg-err small">{s.error}</div>}
        {msg && <div class="plg-err small">{msg}</div>}
        {open && s.toolNames.length > 0 && (
          <ul class="mcp-tools">
            {s.toolNames.map((t) => (
              <li key={t}>
                <code>{t}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div class="plg-actions">
        {busy ? (
          <Spinner size={14} />
        ) : removing ? (
          <>
            <button type="button" class="btn small ghost" onClick={() => setRemoving(false)}>
              Keep
            </button>
            <button
              type="button"
              class="btn small danger"
              data-testid="mcp-remove-confirm"
              onClick={() => {
                setRemoving(false);
                onBusy(s.name);
                api
                  .mcpRemove(s.name)
                  .then((o) => setMsg(o.ok ? 'Removed from your configuration: gone after a restart of the session.' : o.message))
                  .catch((e) => setMsg(errText(e)))
                  .finally(() => onBusy(null));
              }}
            >
              Remove
            </button>
          </>
        ) : (
          <>
            {!disabled && (
              <button type="button" class="btn small" onClick={() => (onBusy(s.name), mcpReconnect(s.name))} data-testid="mcp-reconnect">
                Reconnect
              </button>
            )}
            <button
              type="button"
              class={`switch${disabled ? '' : ' on'}`}
              role="switch"
              aria-checked={!disabled}
              aria-label={`${disabled ? 'Enable' : 'Disable'} ${s.name} for this session`}
              title={disabled ? 'Off for this session: click to enable' : 'On for this session: click to disable'}
              onClick={() => (onBusy(s.name), mcpToggle(s.name, disabled))}
              data-testid="mcp-toggle"
            >
              <i />
            </button>
            {own && (
              <button type="button" class="btn small ghost" onClick={() => setRemoving(true)} data-testid="mcp-remove">
                Remove
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function AddServer({ running }: { running: boolean }) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async () => {
    setNote(null);
    if (!NAME.test(name) || name === 'bedrock-shared') return setNote({ ok: false, text: 'A name of letters, digits, - and _ (not bedrock-shared).' });
    const form: api.McpForm = { name, transport };
    if (transport === 'stdio') {
      const e = pairs(env, '=');
      if ('bad' in e) return setNote({ ok: false, text: `Environment, line ${e.bad}: KEY=value, please.` });
      form.command = command.trim();
      form.args = args.split('\n').map((a) => a.trim()).filter(Boolean);
      form.env = e.ok;
    } else {
      const h = pairs(headers, ':');
      if ('bad' in h) return setNote({ ok: false, text: `Headers, line ${h.bad}: Name: value, please.` });
      form.url = url.trim();
      form.headers = h.ok;
    }
    setBusy(true);
    try {
      const o = await api.mcpAdd(form);
      setNote({ ok: o.ok, text: o.ok ? `${o.message || 'Added.'} It connects in sessions started from now on${running ? ' — or restart this one' : ''}.` : o.message });
      if (o.ok) {
        setName('');
        setCommand('');
        setArgs('');
        setEnv('');
        setUrl('');
        setHeaders('');
      }
    } catch (e) {
      setNote({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class="mcp-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      data-testid="mcp-add"
    >
      <h3>Add a server of your own</h3>
      <p class="mcp-warn small" data-testid="mcp-sandbox-note">
        <Icon name="shield" size={14} />
        <span>
          A stdio server's command runs <strong>inside the sandbox only</strong> — never on your computer — with the sandbox's files (/workspace) and network
          access. Saved in the sandbox's Claude Code user configuration, so the terminal's <code>claude</code> has it too.
        </span>
      </p>
      <div class="mcp-grid">
        <label>
          <span>Name</span>
          <input type="text" value={name} maxLength={64} placeholder="my-tools" onInput={(e) => setName((e.target as HTMLInputElement).value)} data-testid="mcp-name" />
        </label>
        <label>
          <span>Transport</span>
          <select value={transport} onChange={(e) => setTransport((e.target as HTMLSelectElement).value as 'stdio' | 'http' | 'sse')} data-testid="mcp-transport">
            <option value="stdio">stdio (a command)</option>
            <option value="http">HTTP</option>
            <option value="sse">SSE</option>
          </select>
        </label>
        {transport === 'stdio' ? (
          <>
            <label class="wide">
              <span>Command</span>
              <input type="text" value={command} maxLength={500} placeholder="npx" onInput={(e) => setCommand((e.target as HTMLInputElement).value)} data-testid="mcp-command" />
            </label>
            <label class="wide">
              <span>Arguments (one per line)</span>
              <textarea rows={2} value={args} placeholder={'-y\nsome-mcp-server@1.2.3'} onInput={(e) => setArgs((e.target as HTMLTextAreaElement).value)} data-testid="mcp-args" />
            </label>
            <label class="wide">
              <span>Environment (KEY=value per line)</span>
              <textarea rows={2} value={env} onInput={(e) => setEnv((e.target as HTMLTextAreaElement).value)} />
            </label>
          </>
        ) : (
          <>
            <label class="wide">
              <span>URL</span>
              <input type="url" value={url} maxLength={2000} placeholder="https://mcp.example.com/mcp" onInput={(e) => setUrl((e.target as HTMLInputElement).value)} data-testid="mcp-url" />
            </label>
            <label class="wide">
              <span>Headers (Name: value per line)</span>
              <textarea rows={2} value={headers} onInput={(e) => setHeaders((e.target as HTMLTextAreaElement).value)} />
            </label>
          </>
        )}
      </div>
      {note && (
        <div class={`plg-note ${note.ok ? 'ok' : 'err'}`} data-testid="mcp-note">
          {note.text}
        </div>
      )}
      <div class="dlg-buttons">
        {note?.ok && running && (
          <button type="button" class="btn" onClick={() => void restartSession()} data-testid="mcp-restart">
            <Icon name="refresh" size={14} /> Restart this session
          </button>
        )}
        <button type="submit" class="btn primary" disabled={busy || !name || (transport === 'stdio' ? !command.trim() : !url.trim())} data-testid="mcp-add-submit">
          {busy ? <Spinner size={12} /> : <Icon name="plus" size={14} />} Add server
        </button>
      </div>
    </form>
  );
}

export function McpPanel({ onClose }: { onClose: () => void }) {
  const v = useSel(store, (s) => activeView(s));
  const [busy, setBusy] = useState<string | null>(null);
  const running = !!v && v.state !== 'closed' && v.state !== 'ended';
  const servers: McpServer[] = v?.mcp.length
    ? v.mcp
    : (v?.init?.mcp ?? []).map((m) => ({ ...m, tools: null, error: '', scope: '', source: '', toolNames: [], serverVersion: '', transport: '', command: '', url: '' }));
  // a fresh list ends the spinner (or 15 s do)
  useEffect(() => setBusy(null), [v?.mcp]);
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setBusy(null), 15_000);
    return () => clearTimeout(t);
  }, [busy]);
  return (
    <Dialog title="MCP servers" onClose={onClose} wide testid="mcp-dialog">
      <div class="mcp-head">
        <span class="muted small">{running ? 'This session’s servers, as Claude Code reports them.' : 'Start a session (or send a prompt) to see its servers.'}</span>
        {running && (
          <button type="button" class="btn small ghost" onClick={requestMcp} title="Refresh">
            <Icon name="refresh" size={14} /> Refresh
          </button>
        )}
      </div>
      {servers.length > 0 && (
        <ul class="plg-list mcp-list" data-testid="mcp-servers">
          {servers.map((s) => (
            <ServerRow key={s.name} s={s} busy={busy === s.name} onBusy={setBusy} />
          ))}
        </ul>
      )}
      {running && !servers.length && <p class="muted">No MCP servers reported yet.</p>}
      <AddServer running={running} />
    </Dialog>
  );
}
