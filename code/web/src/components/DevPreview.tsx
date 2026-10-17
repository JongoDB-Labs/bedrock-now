// Previews of dev servers in the sandbox (README "Previews of dev servers"): the preview pane (a tab of the editor area, so desktops
// show chat | preview), the Ports panel (status bar; a sheet on phones) with the servers listening in the sandbox,
// their previews, Stop and the workspace's .claude/launch.json entries, and the "Open preview" chips.
//
// The frame shows sandbox content from a site of its own (p<port>-<capability>.<preview domain>; the portal mints the
// link): it gets none of bedrock-now's cookies, and its sandbox flags leave out allow-top-navigation, so it cannot
// take this page away. Nothing here reads from or posts to the frame. Over remote access the frame loads the remote
// preview host through a single-use hand-off for its port (each load a new one); that host is on the portal's site
// there, and every app host refuses its requests (the same-site guard, caddy/Caddyfile not_from_preview).
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, navigatePreview, openPreview, reloadPreview, setPreviewViewport, stopServer, loadLaunch, loadPreviewInfo, refreshPorts, requestLaunch,
  confirmLaunch, setDialog, type PreviewTab } from '../app';
import { previewTabUrl } from '../api';
import { VIEWPORTS, cleanPreviewPath, fitScale, loaderWhy } from '../devpreview';
import type { LaunchEntry, PortInfo } from '../types';
import { label, visible } from '../text';
import { Icon, Spinner } from './icons';
import { Dialog, copyText, useMedia } from './ui';

/** What the preview frame may do: run its scripts on its own origin (another site), forms, popups (as new tabs, outside
 *  the sandbox flags: an OAuth window or "open in a new tab" works), alerts, downloads — never navigate this page. */
export const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

const PHONE = '(max-width: 699.98px)';

export function PreviewPane({ tab, active }: { tab: PreviewTab; active: boolean }) {
  const [addr, setAddr] = useState(tab.at);
  const [bad, setBad] = useState(false);
  const [copied, setCopied] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  const listening = useSel(store, (s) => s.ports.some((p) => p.port === tab.port));
  const portsKnown = useSel(store, (s) => s.portsError === null);
  const vp = VIEWPORTS.find((v) => v.id === tab.viewport) ?? VIEWPORTS[0];
  const scale = vp.w ? fitScale(vp.w, vp.h, room.w, room.h) : 1;

  // The field shows the frame's path again after a navigation from elsewhere (Reload, a chip, the Ports panel) — never
  // after one of its own: its Enter shows the cleaned path at once, and whatever is typed after that stays. (Synced
  // from an effect after the store's next frame and the next paint instead, a navigation's echo could land after the
  // next Enter: the older path back in the field over a refused one, its mark cleared.)
  const shown = useRef({ at: tab.at, n: tab.n });
  useLayoutEffect(() => {
    if (shown.current.at === tab.at && shown.current.n === tab.n) return;
    shown.current = { at: tab.at, n: tab.n };
    setAddr(tab.at);
    setBad(false);
  }, [tab.at, tab.n]);
  useEffect(() => {
    const el = area.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.width = vp.w ? `${vp.w}px` : '';
    el.style.height = vp.h ? `${vp.h}px` : '';
    el.style.transform = vp.w && scale < 1 ? `scale(${scale})` : '';
  });

  // the field's own value: an Enter right after typing may come before the re-render that updates `addr`
  const go = (value: string) => {
    const p = cleanPreviewPath(value);
    if (p === null) return setBad(true);
    setBad(false);
    setAddr(p);
    navigatePreview(tab.key, p);
    // (the store has the navigation now; this pane renders it a frame later — already shown)
    const t = store.get().tabs.find((x) => x.key === tab.key);
    if (t?.kind === 'devserver') shown.current = { at: t.at, n: t.n };
  };
  // what the frame loads (over remote access the hand-off, which goes on to the path), and its address (to copy)
  const src = tab.link ? (tab.link.handoff ? tab.link.url : tab.link.origin + tab.at) : null;
  const copyUrl = tab.link ? tab.link.origin + tab.at : null;
  return (
    <div class={`pane preview-pane${active ? '' : ' hidden'}`} data-testid="preview-pane" data-port={tab.port}>
      <div class="pv-bar">
        <span
          class="pv-badge"
          title={tab.link?.handoff
            ? `Sandbox content: the server on port ${tab.port} in the sandbox, shown from the preview address (${new URL(tab.link.origin).host}), which gets none of bedrock-now's cookies; over remote access this browser previews one port at a time`
            : `Sandbox content: the server on port ${tab.port} in the sandbox, shown from a site of its own${tab.link ? ` (${new URL(tab.link.origin).host})` : ''} that gets none of bedrock-now's cookies`}
        >
          <Icon name="window" size={14} /> sandbox
        </span>
        <button type="button" class="icon-btn" title="Reload" aria-label="Reload the preview" onClick={() => reloadPreview(tab.key)} data-testid="preview-reload">
          <Icon name="refresh" size={15} />
        </button>
        <label class={`pv-addr${bad ? ' bad' : ''}`}>
          <span class="pv-host">localhost:{tab.port}</span>
          <input
            type="text"
            value={addr}
            spellcheck={false}
            autocomplete="off"
            aria-label="Path on the preview"
            title="A path on this server (Enter to open it)"
            data-testid="preview-path"
            onInput={(e) => {
              setAddr((e.currentTarget as HTMLInputElement).value);
              setBad(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                go((e.currentTarget as HTMLInputElement).value);
              }
            }}
          />
        </label>
        <div class="seg pv-vp" role="group" aria-label="Viewport">
          {VIEWPORTS.map((v) => (
            <button key={v.id} type="button" aria-pressed={tab.viewport === v.id} title={v.label} aria-label={v.label} onClick={() => setPreviewViewport(tab.key, v.id)} data-testid={`viewport-${v.id}`}>
              <Icon name={v.icon} size={15} />
            </button>
          ))}
        </div>
        <button
          type="button"
          class="icon-btn"
          title={tab.link?.handoff
            ? "Copy the preview's address (it works in this browser while it previews this port, for as long as this unlock lasts)"
            : "Copy the preview's address (it works in this browser's other tabs, for as long as this unlock lasts)"}
          aria-label="Copy the preview's address"
          disabled={!copyUrl}
          onClick={async () => {
            if (copyUrl && (await copyText(copyUrl))) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={15} />
        </button>
        <a class="icon-btn" href={previewTabUrl(tab.port, tab.at)} target="_blank" rel="noopener noreferrer" title="Open in a new tab (its developer tools, full size)" aria-label="Open the preview in a new tab" data-testid="preview-new-tab">
          <Icon name="external" size={15} />
        </a>
      </div>
      {!listening && portsKnown && !tab.error && (
        <div class="banner subtle" data-testid="preview-not-listening">
          <span>Nothing listens on :{tab.port} in the sandbox right now. Start the server (in the terminal, or ask Claude); the preview loads it by itself.</span>
        </div>
      )}
      <div class={`pv-area${vp.w ? ' fixed' : ''}`} ref={area}>
        {tab.error ? (
          <div class="pane-msg err" data-testid="preview-error">
            <Icon name="alert" /> {label(tab.error, 400)}
            <button type="button" class="btn small" onClick={() => reloadPreview(tab.key)}>
              Try again
            </button>
          </div>
        ) : !src ? (
          <div class="pane-msg">
            <Spinner /> Getting a preview link…
          </div>
        ) : (
          <div class="pv-box" ref={box}>
            <iframe
              key={tab.n}
              class="pv-frame"
              src={src}
              title={`Preview of localhost:${tab.port} in the sandbox`}
              sandbox={FRAME_SANDBOX}
              allow=""
              referrerpolicy="no-referrer"
              data-testid="preview-frame"
            />
          </div>
        )}
      </div>
      {vp.w > 0 && (
        <div class="pv-foot muted small">
          {vp.label}
          {scale < 1 ? ` · shown at ${Math.round(scale * 100)}%` : ''}
        </div>
      )}
    </div>
  );
}

/** "Open preview :5173": the preview tab (desktop, tablet), or a new browser tab (phone, where a pane has no room). */
export function PreviewChip({ port, text }: { port: number; text?: string }) {
  const phone = useMedia(PHONE);
  const body = (
    <>
      <Icon name="window" size={13} /> {text ?? `Preview :${port}`}
    </>
  );
  if (phone) {
    return (
      <a class="chip-preview" href={previewTabUrl(port)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} data-testid="preview-chip">
        {body}
      </a>
    );
  }
  return (
    <button
      type="button"
      class="chip-preview"
      title={`Open the preview of localhost:${port} (the sandbox's)`}
      onClick={(e) => {
        e.stopPropagation();
        void openPreview(port);
      }}
      data-testid="preview-chip"
    >
      {body}
    </button>
  );
}

function PortRow({ p, onDone }: { p: PortInfo; onDone?: () => void }) {
  const phone = useMedia(PHONE);
  const [confirm, setConfirm] = useState(false);
  const available = useSel(store, (s) => s.preview?.available !== false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);
  const where = p.addrs.some((a) => a === '0.0.0.0' || a === '::') ? 'all addresses' : 'localhost';
  return (
    <li class="port-row" data-testid="port-row" data-port={p.port}>
      <span class="port-num">:{p.port}</span>
      <span class="port-cmd" title={`${p.cmd || 'process not known'}${p.pid ? ` (pid ${p.pid})` : ''} — listens on ${where} (${p.addrs.join(', ')})`}>
        {p.cmd ? label(p.cmd, 120) : <span class="muted">process not known</span>}
      </span>
      <span class="port-actions">
        {phone ? (
          available ? (
            <a class="btn small" href={previewTabUrl(p.port)} target="_blank" rel="noopener noreferrer" data-testid="port-preview">
              <Icon name="external" size={13} /> Preview
            </a>
          ) : (
            <button type="button" class="btn small" disabled>
              Preview
            </button>
          )
        ) : (
          <>
            <button type="button" class="btn small primary" disabled={!available} onClick={() => (onDone?.(), void openPreview(p.port))} data-testid="port-preview">
              <Icon name="window" size={13} /> Preview
            </button>
            <a class="icon-btn" href={previewTabUrl(p.port)} target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label={`Open the preview of :${p.port} in a new tab`}>
              <Icon name="external" size={14} />
            </a>
          </>
        )}
        <button
          type="button"
          class={`btn small${confirm ? ' danger' : ' ghost'}`}
          disabled={!p.pid}
          title={p.pid ? `Stop the process (pid ${p.pid}): SIGTERM` : 'Its process is not known here: stop it in the terminal'}
          onClick={() => {
            if (!confirm) return setConfirm(true);
            setConfirm(false);
            void stopServer(p);
          }}
          data-testid="port-stop"
        >
          {confirm ? 'Stop it?' : 'Stop'}
        </button>
      </span>
    </li>
  );
}

/** The servers listening in the sandbox, previewing another port, and the workspace's .claude/launch.json. */
export function PortsPanel({ onDone }: { onDone?: () => void }) {
  const ports = useSel(store, (s) => s.ports);
  const error = useSel(store, (s) => s.portsError);
  const info = useSel(store, (s) => s.preview);
  const launch = useSel(store, (s) => s.launch);
  const [other, setOther] = useState('');
  const phone = useMedia(PHONE);
  useEffect(() => {
    void refreshPorts();
    void loadPreviewInfo();
    void loadLaunch();
  }, []);
  const n = Number(other);
  const otherOk = /^[1-9][0-9]{0,4}$/.test(other) && n <= 65535;
  return (
    <div class="ports-panel-body" data-testid="ports-panel">
      <div class="pp-head">
        <strong>Servers in the sandbox</strong>
        <button type="button" class="icon-btn" title="Look again" aria-label="Look again" onClick={() => (void refreshPorts(), void loadLaunch())}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {info && !info.available && <div class="banner warn small" data-testid="preview-unavailable">{label(info.reason, 300) || 'Previews are off here.'}</div>}
      {info?.available && info.routing === 'cookie' && (
        <p class="muted small" data-testid="preview-one-port">
          Over remote access a browser previews one port at a time: opening another port's preview switches the one shown.
        </p>
      )}
      {error && <div class="banner warn small">Could not list them: {label(error, 200)}</div>}
      {ports.length ? (
        <ul class="port-list">
          {ports.map((p) => (
            <PortRow key={p.port} p={p} onDone={onDone} />
          ))}
        </ul>
      ) : (
        <p class="muted small pp-empty">Nothing listens in the sandbox yet. Start a dev server (npm run dev in the terminal, or ask Claude) and it shows up here.</p>
      )}
      <div class="pp-other">
        <label>
          Another port
          <input type="text" inputMode="numeric" value={other} placeholder="8080" onInput={(e) => setOther((e.currentTarget as HTMLInputElement).value.trim())} data-testid="port-other" />
        </label>
        {phone && otherOk && info?.available !== false ? (
          <a class="btn small" href={previewTabUrl(n)} target="_blank" rel="noopener noreferrer">
            Preview
          </a>
        ) : (
          <button type="button" class="btn small" disabled={!otherOk || info?.available === false} onClick={() => (onDone?.(), void openPreview(n))} data-testid="port-other-go">
            Preview
          </button>
        )}
      </div>
      <div class="pp-head">
        <strong>.claude/launch.json</strong>
      </div>
      {launch === null ? (
        <p class="muted small">
          <Spinner size={11} /> Reading it…
        </p>
      ) : launch.error && !launch.entries.length ? (
        <p class="muted small">It cannot be used: {launch.error}</p>
      ) : !launch.exists ? (
        <p class="muted small">None in this workspace. The Claude Code desktop app's dev-server list works here too: its entries can be started from this panel.</p>
      ) : (
        <ul class="launch-list">
          {launch.entries.map((e, i) => (
            <li key={`${e.name}-${i}`} class="launch-row" data-testid="launch-row">
              <span class="launch-name">{e.name}</span>
              {e.error ? (
                <span class="muted small">{e.error}</span>
              ) : (
                <>
                  <code class="launch-cmd" title={`${e.command ?? e.url ?? ''}${e.cwd !== '.' ? ` (in ${e.cwd})` : ''}${e.env.length ? ` · sets ${e.env.join(', ')}` : ''}`}>
                    {e.command ? label(e.command, 80) : `runs already: ${e.url ?? ''}`}
                  </code>
                  {e.port !== null && <span class="muted small">:{e.port}</span>}
                  <span class="port-actions">
                    {e.argv && e.digest && (
                      <button type="button" class="btn small" onClick={() => (onDone?.(), requestLaunch(e))} title="Run this entry's command in a new window of the terminal (tmux), with PORT set — shown in full first" data-testid="launch-start">
                        <Icon name="play" size={12} /> Start
                      </button>
                    )}
                    {e.port !== null && !phone && (
                      <button type="button" class="btn small ghost" disabled={info?.available === false} onClick={() => (onDone?.(), void openPreview(e.port!))}>
                        Preview
                      </button>
                    )}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Start's confirmation: exactly what will run — the program and each argument, the folder, every environment variable
 *  with its value (PORT included), and a warning on those that run or load code of their own. The entry comes from the
 *  workspace's .claude/launch.json, which anything in the sandbox can write; Start sends this entry's digest, so a file
 *  changed after this is refused. */
export function LaunchConfirm({ entry }: { entry: LaunchEntry }) {
  const env = [...entry.env.filter((v) => v.name !== 'PORT'), ...(entry.port ? [{ name: 'PORT', value: String(entry.port) }] : [])];
  const loaders = env.filter((v) => loaderWhy(v.name));
  const close = () => setDialog(null);
  return (
    <Dialog title={`Start "${label(entry.name, 80)}"?`} onClose={close} wide testid="launch-confirm">
      <p>
        From the workspace's <code>.claude/launch.json</code>, which anything in the sandbox (Claude too) can write. It runs in the sandbox, in a new
        window of the terminal — check that it is what you expect:
      </p>
      <h3>Program and arguments</h3>
      <ol class="launch-argv" data-testid="launch-argv">
        {(entry.argv ?? []).map((a, i) => (
          <li key={i}>
            <code>{visible(a) || '(empty)'}</code>
          </li>
        ))}
      </ol>
      <h3>Folder</h3>
      <p>
        <code class="launch-cwd" data-testid="launch-cwd">/workspace{entry.cwd === '.' ? '' : `/${visible(entry.cwd)}`}</code>
      </p>
      <h3>Environment</h3>
      <ul class="launch-env" data-testid="launch-env">
        {env.map((v) => {
          const why = loaderWhy(v.name);
          return (
            <li key={v.name} class={why ? 'loader' : ''} data-testid={why ? 'launch-env-loader' : 'launch-env-var'}>
              <code>
                {v.name}={visible(v.value)}
              </code>
              {v.name === 'PORT' && <span class="muted small"> (set by bedrock-now)</span>}
              {why && (
                <span class="loader-why">
                  <Icon name="alert" size={13} /> {why}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {loaders.length > 0 && (
        <div class="banner warn small" data-testid="launch-loaders">
          {loaders.length === 1 ? 'One variable' : `${loaders.length} variables`} above can run code before the command itself. Start it only if you
          know why it is there.
        </div>
      )}
      <div class="dlg-buttons">
        <button type="button" class="btn" onClick={close}>
          Cancel
        </button>
        <button type="button" class="btn primary" onClick={confirmLaunch} data-testid="launch-confirm-run">
          <Icon name="play" size={13} /> Start it
        </button>
      </div>
    </Dialog>
  );
}
