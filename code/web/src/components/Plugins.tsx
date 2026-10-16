// Plugins & marketplaces: what is installed (enable/disable, update, uninstall), the added marketplaces' catalog
// (search, install) and the marketplaces themselves (add, update, remove) — all `claude plugin …` in the sandbox,
// through the backend's allowlisted shapes. A plugin that a marketplace installs by running a command is never
// installed blindly: the CLI shows the command, this dialog shows it verbatim with its SHA-256, and only "Run this
// command and install" sends that hash back (the CLI's --accept-command; never -y). After any change the open
// sessions reload their plugins, so new commands and skills are in the / palette at once.
import { useEffect, useRef, useState } from 'preact/hooks';
import * as api from '../api';
import type { AvailablePlugin, Catalog, Confirmation, InstalledPlugin, Marketplace, Outcome } from '../types';
import { useSel } from '../store';
import { store, activeView, toast } from '../app';
import { label } from '../text';
import { Dialog } from './ui';
import { Icon, Spinner } from './icons';

type Tab = 'installed' | 'discover' | 'marketplaces';
interface Pending {
  action: api.PluginAction;
  id: string;
  confirm: Confirmation;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

function Note({ o }: { o: { ok: boolean; text: string } | null }) {
  if (!o) return null;
  return (
    <div class={`plg-note ${o.ok ? 'ok' : 'err'}`} role={o.ok ? 'status' : 'alert'} data-testid="plugins-note">
      <Icon name={o.ok ? 'check' : 'alert'} size={14} /> <span>{o.text}</span>
    </div>
  );
}

/** The marketplace-declared command, verbatim, and its SHA-256: what a person accepts. */
function ConfirmCommand({ p, busy, onAccept, onCancel }: { p: Pending; busy: boolean; onAccept: () => void; onCancel: () => void }) {
  const c = p.confirm;
  const [mkt] = p.id.split('@').slice(1);
  return (
    <div class="plg-confirm" role="alertdialog" aria-label="Confirm the install command" data-testid="plugin-confirm">
      <div class="plg-confirm-head">
        <Icon name="shield" size={16} />
        <strong>
          {label(p.id.split('@')[0], 100)} {c.kind === 'entry_helper' ? 'is fetched with the help of a command' : 'is installed by running a command'} from the marketplace {label(mkt || '?', 100)}
        </strong>
      </div>
      <p class="muted small">
        It runs in the sandbox (not on your computer), as you, with the sandbox's files and network access. Read it before you accept: nothing has run yet.
      </p>
      <pre class="cmd plg-cmd" data-testid="plugin-confirm-command">{c.command}</pre>
      {c.archiveUrl && (
        <div class="small">
          <span class="muted">Archive:</span> <code>{c.archiveUrl}</code>
        </div>
      )}
      <div class="small plg-sha">
        <span class="muted">SHA-256 of what you accept{c.mode ? ` (mode ${c.mode})` : ''}:</span> <code data-testid="plugin-confirm-sha">{c.sha256}</code>
      </div>
      {c.matched && (
        <div class="plg-note err small">This command was accepted before and refused again: the marketplace changed since. Review it once more.</div>
      )}
      <div class="dlg-buttons">
        <button type="button" class="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" class="btn danger" onClick={onAccept} disabled={busy} data-testid="plugin-confirm-accept">
          {busy ? <Spinner size={12} /> : <Icon name="play" size={14} />} Run this command and {p.action}
        </button>
      </div>
    </div>
  );
}

function Installed({
  installed,
  busy,
  act,
}: {
  installed: InstalledPlugin[];
  busy: string | null;
  act: (a: api.PluginAction, id: string) => void;
}) {
  const builtIn = useSel(store, (s) => activeView(s)?.init?.plugins ?? []);
  const [removing, setRemoving] = useState<string | null>(null);
  const names = new Set(installed.map((p) => p.name));
  const extra = builtIn.filter((p) => !names.has(p.name));
  return (
    <>
      {!installed.length && <p class="muted">No plugins installed yet. Find some under Discover (add a marketplace first).</p>}
      <ul class="plg-list" data-testid="plugins-installed">
        {installed.map((p) => (
          <li key={p.id} class={`plg-row${p.enabled ? '' : ' off'}`} data-plugin={p.id}>
            <div class="plg-main">
              <div class="plg-title">
                <span class="plg-name">{p.name}</span>
                <span class="muted">@{p.marketplace}</span>
                {p.version && <span class="tag">{p.version}</span>}
                {p.scope && <span class="tag">{p.scope}</span>}
                {p.fromFolder && <span class="tag" title="Read from its folder: edits there apply on the next reload">folder</span>}
                {!p.enabled && <span class="tag warn">off</span>}
              </div>
              {p.errors.map((e, i) => (
                <div key={i} class="plg-err small">
                  {e}
                </div>
              ))}
            </div>
            <div class="plg-actions">
              {busy === p.id ? (
                <Spinner size={14} />
              ) : removing === p.id ? (
                <>
                  <button type="button" class="btn small ghost" onClick={() => setRemoving(null)}>
                    Keep
                  </button>
                  <button type="button" class="btn small danger" onClick={() => (setRemoving(null), act('uninstall', p.id))} data-testid="plugin-uninstall-confirm">
                    Uninstall
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    class={`switch${p.enabled ? ' on' : ''}`}
                    role="switch"
                    aria-checked={p.enabled}
                    aria-label={`${p.enabled ? 'Disable' : 'Enable'} ${p.name}`}
                    title={p.enabled ? 'Enabled: click to disable' : 'Disabled: click to enable'}
                    disabled={busy !== null}
                    onClick={() => act(p.enabled ? 'disable' : 'enable', p.id)}
                    data-testid="plugin-toggle"
                  >
                    <i />
                  </button>
                  <button type="button" class="btn small" disabled={busy !== null} onClick={() => act('update', p.id)} data-testid="plugin-update">
                    Update
                  </button>
                  <button type="button" class="btn small ghost" disabled={busy !== null} onClick={() => setRemoving(p.id)} data-testid="plugin-uninstall">
                    Uninstall
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {extra.length > 0 && (
        <>
          <h3>Built in (loaded by this session)</h3>
          <ul class="plg-list">
            {extra.map((p) => (
              <li key={p.name} class="plg-row">
                <div class="plg-main">
                  <div class="plg-title">
                    <span class="plg-name">{p.name}</span>
                    {p.version && <span class="tag">{p.version}</span>}
                    <span class="tag">built in</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Discover({ busy, act, stamp }: { busy: string | null; act: (a: api.PluginAction, id: string) => void; stamp: number }) {
  const [q, setQ] = useState('');
  const [mkt, setMkt] = useState('');
  const [cat, setCat] = useState<Catalog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(
      () =>
        api
          .getAvailable(q, mkt)
          .then((c) => n === seq.current && (setCat(c), setErr(null)))
          .catch((e) => n === seq.current && setErr(errText(e)))
          .finally(() => n === seq.current && setLoading(false)),
      q ? 250 : 0,
    );
    return () => clearTimeout(t);
  }, [q, mkt, stamp]);
  return (
    <>
      <div class="plg-search">
        <label class="search">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Search plugins" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Search plugins" data-testid="plugins-search" />
        </label>
        <select value={mkt} onChange={(e) => setMkt((e.target as HTMLSelectElement).value)} aria-label="Marketplace" data-testid="plugins-marketplace">
          <option value="">All marketplaces</option>
          {(cat?.marketplaces ?? []).map((m) => (
            <option key={m.name} value={m.name}>
              {m.name} ({m.count})
            </option>
          ))}
        </select>
        {loading && <Spinner size={14} />}
      </div>
      {err && <div class="plg-note err">{err}</div>}
      {cat && !cat.plugins.length && !loading && <p class="muted">{q ? 'Nothing matches.' : 'No plugins: add a marketplace first.'}</p>}
      <ul class="plg-list" data-testid="plugins-available">
        {(cat?.plugins ?? []).map((p: AvailablePlugin) => (
          <li key={p.id} class="plg-row" data-plugin={p.id}>
            <div class="plg-main">
              <div class="plg-title">
                <span class="plg-name">{p.name}</span>
                <span class="muted">@{p.marketplace}</span>
                {p.version && <span class="tag">{p.version}</span>}
                {p.kind === 'command' && (
                  <span class="tag warn" title={p.command ?? ''}>
                    installs by running a command
                  </span>
                )}
              </div>
              {p.description && <div class="plg-desc">{p.description}</div>}
            </div>
            <div class="plg-actions">
              {p.installed ? (
                <span class="muted small">Installed</span>
              ) : busy === p.id ? (
                <Spinner size={14} />
              ) : (
                <button type="button" class="btn small primary" disabled={busy !== null} onClick={() => act('install', p.id)} data-testid="plugin-install">
                  Install
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {cat?.more && <p class="muted small">{cat.total - cat.plugins.length} more: narrow the search.</p>}
    </>
  );
}

function Marketplaces({ list, busy, run }: { list: Marketplace[]; busy: string | null; run: (key: string, f: () => Promise<Outcome>) => void }) {
  const [src, setSrc] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <>
      <form
        class="plg-add"
        onSubmit={(e) => {
          e.preventDefault();
          const s = src.trim();
          if (s) run(`+${s}`, () => api.marketplaceAdd(s).then((o) => (o.ok && setSrc(''), o)));
        }}
      >
        <input
          type="text"
          value={src}
          maxLength={500}
          placeholder="owner/repo, https://…, or /workspace/folder"
          aria-label="Marketplace source"
          onInput={(e) => setSrc((e.target as HTMLInputElement).value)}
          data-testid="marketplace-source"
        />
        <button type="submit" class="btn primary" disabled={!src.trim() || busy !== null} data-testid="marketplace-add">
          {busy?.startsWith('+') ? <Spinner size={12} /> : <Icon name="plus" size={14} />} Add
        </button>
      </form>
      <p class="muted small">
        GitHub and https sources are fetched by the sandbox over its internet access (none when the terminal's egress is off); a marketplace in a folder of
        the workspace works offline.
      </p>
      <ul class="plg-list" data-testid="marketplaces">
        {list.map((m) => (
          <li key={m.name} class="plg-row" data-marketplace={m.name}>
            <div class="plg-main">
              <div class="plg-title">
                <span class="plg-name">{m.name}</span>
                {m.source && <span class="tag">{m.source}</span>}
              </div>
              {m.location && <div class="plg-desc mono">{m.location}</div>}
            </div>
            <div class="plg-actions">
              {busy === m.name ? (
                <Spinner size={14} />
              ) : removing === m.name ? (
                <>
                  <button type="button" class="btn small ghost" onClick={() => setRemoving(null)}>
                    Keep
                  </button>
                  <button type="button" class="btn small danger" onClick={() => (setRemoving(null), run(m.name, () => api.marketplaceRemove(m.name)))} data-testid="marketplace-remove-confirm">
                    Remove with its plugins
                  </button>
                </>
              ) : (
                <>
                  <button type="button" class="btn small" disabled={busy !== null} onClick={() => run(m.name, () => api.marketplaceUpdate(m.name))}>
                    Update
                  </button>
                  <button type="button" class="btn small ghost" disabled={busy !== null} onClick={() => setRemoving(m.name)} data-testid="marketplace-remove">
                    Remove
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export function PluginsDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('installed');
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [markets, setMarkets] = useState<Marketplace[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [stamp, setStamp] = useState(0);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.getPlugins();
      setInstalled(r.installed);
      setMarkets(r.marketplaces);
      setLoadErr(null);
      if (!r.installed.length && r.marketplaces.length) setTab((t) => (t === 'installed' ? 'discover' : t));
    } catch (e) {
      setLoadErr(errText(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const done = (o: Outcome) => {
    if (o.ok) {
      const n = o.reloaded ?? 0;
      setNote({ ok: true, text: `${o.message}${n ? ` Reloaded in ${n} open session${n === 1 ? '' : 's'}: new commands are in the / palette.` : ''}` });
      setStamp((x) => x + 1);
      void load();
    } else setNote({ ok: false, text: o.message || 'That did not work.' });
  };

  /** One change; key marks what shows the spinner. */
  const run = (key: string, f: () => Promise<Outcome>) => {
    setBusy(key);
    setNote(null);
    f()
      .then(done)
      .catch((e) => setNote({ ok: false, text: errText(e) }))
      .finally(() => setBusy(null));
  };

  const act = (a: api.PluginAction, id: string) => {
    setBusy(id);
    setNote(null);
    api
      .pluginAction(a, id)
      .then((o) => {
        if (o.confirm) {
          // nothing ran: the CLI showed a command; a person reads it and accepts its hash (or not)
          setPending({ action: a, id, confirm: o.confirm });
          return;
        }
        done(o);
      })
      .catch((e) => setNote({ ok: false, text: errText(e) }))
      .finally(() => setBusy(null));
  };

  const accept = () => {
    if (!pending) return;
    const p = pending;
    setBusy(p.id);
    api
      .pluginAction(p.action, p.id, { acceptCommand: p.confirm.sha256 })
      .then((o) => {
        if (o.confirm) setPending({ ...p, confirm: o.confirm });
        else {
          setPending(null);
          done(o);
        }
      })
      .catch((e) => setNote({ ok: false, text: errText(e) }))
      .finally(() => setBusy(null));
  };

  const tabs: [Tab, string][] = [
    ['installed', `Installed${installed.length ? ` (${installed.length})` : ''}`],
    ['discover', 'Discover'],
    ['marketplaces', `Marketplaces${markets.length ? ` (${markets.length})` : ''}`],
  ];
  return (
    <Dialog title="Plugins & marketplaces" onClose={onClose} wide testid="plugins-dialog">
      <div class="seg plg-tabs" role="tablist">
        {tabs.map(([t, name]) => (
          <button key={t} type="button" role="tab" aria-pressed={tab === t} aria-selected={tab === t} onClick={() => setTab(t)} data-testid={`plugins-tab-${t}`}>
            {name}
          </button>
        ))}
        {loading && <Spinner size={14} />}
      </div>
      {loadErr && <div class="plg-note err">{loadErr}</div>}
      <Note o={note} />
      {pending ? (
        <ConfirmCommand
          p={pending}
          busy={busy !== null}
          onAccept={accept}
          onCancel={() => {
            setPending(null);
            toast('Not installed: the command did not run.');
          }}
        />
      ) : tab === 'installed' ? (
        <Installed installed={installed} busy={busy} act={act} />
      ) : tab === 'discover' ? (
        <Discover busy={busy} act={act} stamp={stamp} />
      ) : (
        <Marketplaces list={markets} busy={busy} run={run} />
      )}
      <p class="muted small plg-foot">
        Plugins live in the sandbox's Claude Code settings (the terminal's <code>claude</code> sees the same ones). Changes reload the open sessions'
        plugins; that rewrites their prompt cache on the next turn.
      </p>
    </Dialog>
  );
}
