// The page frame: top bar, the three panes + bottom terminal on desktops, chat + one of explorer/editor and a
// terminal drawer on tablets (700–1100 px), chat-first with sheets on phones. Pane sizes and open panels are
// remembered per browser (prefs.ts).
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useSel } from '../store';
import {
  store,
  activeView,
  interrupt,
  newSession,
  reloadPlugins,
  setDialog,
  setLayout,
  setSheet,
  terminalUrl,
  exportTranscript,
  setNotify,
  toggleExplorer,
  toggleTerminal,
  socket,
  defaultModel,
  dismissToast,
  openModeMenu,
} from '../app';
import { BOUNDS } from '../prefs';
import { basename, label } from '../text';
import { modeName } from '../permission';
import { ChatPane } from './Chat';
import { EditorPanes, EditorTabs, saveActiveTab, MOD } from './EditorArea';
import { FileTree } from './FileTree';
import { SessionList } from './SessionList';
import { ContextMeter, CostMeter, EffortPicker, ModelPicker, currentModel, modelLabel } from './Pickers';
import { BypassDialog } from './Bypass';
import { Dialog, Dropdown, MenuItem, Sheet, Splitter, useMedia } from './ui';
import { PluginsDialog } from './Plugins';
import { McpPanel } from './Mcp';
import { MemoryDialog } from './Memory';
import { Icon, Spinner } from './icons';
import { LaunchConfirm, PortsPanel } from './DevPreview';

// ---------------------------------------------------------------- pieces

function Brand() {
  return (
    <span class="brand" title="bedrock-now · Code">
      <span class="brand-mark">
        <Icon name="code" size={15} />
      </span>
      <span class="brand-name">Code</span>
    </span>
  );
}

function MoreMenu() {
  const term = useSel(store, (s) => terminalUrl(s));
  const notifyOn = useSel(store, (s) => s.prefs.notify);
  return (
    <Dropdown title="More" align="right" class="more" trigger={<Icon name="more" />} testid="more-menu">
      {(close) => (
        <>
          <MenuItem icon="plus" onSelect={() => (close(), void newSession())}>
            New session
          </MenuItem>
          <MenuItem icon="plug" onSelect={() => (close(), setDialog('plugins'))} testid="menu-plugins">
            Plugins & marketplaces…
          </MenuItem>
          <MenuItem icon="server" onSelect={() => (close(), setDialog('mcp'))} testid="menu-mcp">
            MCP servers…
          </MenuItem>
          <MenuItem icon="book" onSelect={() => (close(), setDialog('memory'))} testid="menu-memory">
            Memory (CLAUDE.md)…
          </MenuItem>
          <MenuItem icon="port" onSelect={() => (close(), setDialog('ports'))} testid="menu-ports">
            Ports & previews…
          </MenuItem>
          <MenuItem icon="refresh" onSelect={() => (close(), reloadPlugins())}>
            Reload plugins & skills
          </MenuItem>
          <MenuItem icon="download" onSelect={() => (close(), exportTranscript())} testid="menu-export">
            Export the conversation (.md)
          </MenuItem>
          <MenuItem checked={notifyOn} onSelect={() => (close(), void setNotify(!notifyOn))} testid="menu-notify">
            Notify me when Claude waits or is done
          </MenuItem>
          {term && (
            <MenuItem
              icon="external"
              onSelect={() => {
                close();
                window.open(term, '_blank', 'noopener,noreferrer');
              }}
            >
              Open the terminal in a new tab
            </MenuItem>
          )}
          <MenuItem icon="keyboard" onSelect={() => (close(), setDialog('shortcuts'))}>
            Keyboard shortcuts
          </MenuItem>
        </>
      )}
    </Dropdown>
  );
}

function SessionTitle({ onClick }: { onClick: () => void }) {
  const v = useSel(store, (s) => activeView(s));
  const pendingOther = useSel(store, (s) => Object.values(s.views).filter((x) => x.id !== s.active).reduce((n, x) => n + x.permissions.length, 0));
  return (
    <button type="button" class="sess-switch" onClick={onClick} title="Sessions" data-testid="session-switch">
      <Icon name="history" size={15} />
      <span class="sess-switch-title">{v ? v.title || 'New session' : 'No session'}</span>
      {pendingOther > 0 && (
        <span class="badge warn" title="Another session is waiting for your permission">
          {pendingOther}
        </span>
      )}
      <Icon name="chevronDown" size={13} />
    </button>
  );
}

function TopBar({ tablet }: { tablet?: boolean }) {
  const layout = useSel(store, (s) => s.prefs.layout);
  return (
    <header class="topbar" data-testid="topbar">
      <div class="tb-left">
        {!tablet && (
          <button type="button" class={`icon-btn${layout.explorer ? ' on' : ''}`} title={`Explorer (${MOD}+B)`} aria-label="Toggle explorer" aria-pressed={layout.explorer} onClick={toggleExplorer}>
            <Icon name="sidebar" />
          </button>
        )}
        <Brand />
        <SessionTitle
          onClick={() => {
            if (tablet) setLayout({ tabletPane: 'files', side: 'sessions' });
            else setLayout({ explorer: true, side: 'sessions' });
          }}
        />
      </div>
      <div class="tb-mid">
        <ModelPicker compact={tablet} />
        <EffortPicker />
      </div>
      <div class="tb-right">
        <CostMeter />
        <ContextMeter />
        {tablet && (
          <div class="seg" role="group" aria-label="Left pane">
            <button type="button" aria-pressed={layout.tabletPane === 'files'} aria-label="Files" title="Files" onClick={() => setLayout({ tabletPane: 'files' })}>
              <Icon name="files" size={15} /> <span class="seg-label">Files</span>
            </button>
            <button type="button" aria-pressed={layout.tabletPane === 'editor'} aria-label="Editor" title="Editor" onClick={() => setLayout({ tabletPane: 'editor' })}>
              <Icon name="code" size={15} /> <span class="seg-label">Editor</span>
            </button>
          </div>
        )}
        <button type="button" class={`icon-btn${layout.terminal ? ' on' : ''}`} title="Terminal (Ctrl+`)" aria-label="Toggle terminal" aria-pressed={layout.terminal} onClick={toggleTerminal} data-testid="toggle-terminal">
          <Icon name="terminal" />
        </button>
        <MoreMenu />
      </div>
    </header>
  );
}

function SidePanel({ onOpenFile }: { onOpenFile?: () => void }) {
  const side = useSel(store, (s) => s.prefs.layout.side);
  const pending = useSel(store, (s) => Object.values(s.views).reduce((n, v) => n + v.permissions.length, 0));
  return (
    <aside class="side" aria-label="Explorer and sessions">
      <div class="side-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={side === 'files'} onClick={() => setLayout({ side: 'files' })} data-testid="side-files">
          <Icon name="files" size={15} /> Explorer
        </button>
        <button type="button" role="tab" aria-selected={side === 'sessions'} onClick={() => setLayout({ side: 'sessions' })} data-testid="side-sessions">
          <Icon name="history" size={15} /> Sessions
          {pending > 0 && <span class="badge warn">{pending}</span>}
        </button>
      </div>
      {side === 'files' ? <FileTree onOpen={onOpenFile} /> : <SessionList />}
    </aside>
  );
}

function TerminalPanel({ drawer }: { drawer?: boolean }) {
  const open = useSel(store, (s) => s.prefs.layout.terminal);
  const url = useSel(store, (s) => terminalUrl(s));
  const [loaded, setLoaded] = useState(open);
  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);
  if (!loaded) return null;
  return (
    <section class={`terminal${drawer ? ' drawer' : ''}${open ? '' : ' hidden'}`} aria-label="Terminal" data-testid="terminal">
      <div class="pane-head">
        <Icon name="terminal" size={14} />
        <span class="pane-title">Terminal</span>
        <span class="muted small">sandbox · ttyd + tmux</span>
        <span class="pane-actions">
          {url && (
            <a class="icon-btn" href={url} target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label="Open the terminal in a new tab">
              <Icon name="external" size={15} />
            </a>
          )}
          <button type="button" class="icon-btn" title="Close (Ctrl+`)" aria-label="Close terminal" onClick={toggleTerminal}>
            <Icon name="close" size={15} />
          </button>
        </span>
      </div>
      {url ? (
        <iframe class="term-frame" src={url} title="Terminal" referrerpolicy="no-referrer" allow="clipboard-read; clipboard-write" />
      ) : (
        <div class="pane-msg">The terminal's address is not known here. Open it from the portal's Terminal tab.</div>
      )}
    </section>
  );
}

function StatusBar() {
  const conn = useSel(store, (s) => s.conn);
  const retryAt = useSel(store, (s) => s.retryAt);
  const v = useSel(store, (s) => activeView(s));
  const server = useSel(store, (s) => s.server);
  const serverError = useSel(store, (s) => s.serverError);
  const cursor = useSel(store, (s) => s.cursor);
  const activeTab = useSel(store, (s) => s.tabs.find((t) => t.key === s.activeTab));
  const modelName = useSel(store, (s) => {
    const m = s.models?.models ?? [];
    return (currentModel(m, activeView(s)?.model ?? '') ?? currentModel(m, defaultModel(s)))?.name ?? '';
  });
  const [, tick] = useState(0);
  useEffect(() => {
    if (conn !== 'closed') return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [conn]);
  const secs = retryAt ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0;
  return (
    <footer class="statusbar" data-testid="statusbar">
      <span class={`sb-conn sb-${conn}`} data-testid="conn">
        <span class="sdot" />
        {conn === 'open' ? 'Connected' : conn === 'connecting' ? 'Connecting…' : conn === 'locked' ? 'Locked: reload to unlock' : (
          <>
            Offline · retry in {secs}s{' '}
            <button type="button" class="linkish" onClick={() => socket.retryNow()}>
              now
            </button>
          </>
        )}
      </span>
      {serverError && <span class="sb-item err" title={serverError}>Server: {label(serverError, 80)}</span>}
      {v && (
        <span class="sb-item" title={v.id}>
          {v.state === 'busy' ? <Spinner size={11} /> : null} {v.state} · {v.id.slice(0, 8)}
        </span>
      )}
      {v && v.permissions.length > 0 && (
        <span class="sb-item warn">
          <Icon name="alert" size={13} /> {v.permissions.length} waiting for you
        </span>
      )}
      {v?.status === 'compacting' && (
        <span class="sb-item">
          <Spinner size={11} /> Compacting…
        </span>
      )}
      <span class="sb-spacer" />
      {activeTab && cursor && activeTab.kind === 'file' && (
        <span class="sb-item">
          Ln {cursor.line}, Col {cursor.col} · {cursor.lang}
        </span>
      )}
      {activeTab?.kind === 'file' && activeTab.dirty && <span class="sb-item">● unsaved</span>}
      <PortsStatus />
      {v && <span class="sb-item">{modeName(v.mode)}</span>}
      {modelName && <span class="sb-item">{modelName}</span>}
      {server?.cli && <span class="sb-item muted">Claude Code {server.cli}</span>}
    </footer>
  );
}

/** "Ports (n)": the servers listening in the sandbox, their previews and the workspace's launch.json entries. */
function PortsStatus() {
  const n = useSel(store, (s) => s.ports.length);
  return (
    <Dropdown
      title="Servers in the sandbox and their previews"
      class="sb-ports"
      panelClass="ports-panel"
      align="right"
      testid="ports-status"
      trigger={
        <>
          <Icon name="port" size={13} /> Ports{n ? ` (${n})` : ''}
        </>
      }
    >
      {(close) => <PortsPanel onDone={close} />}
    </Dropdown>
  );
}

function Toasts() {
  const toasts = useSel(store, (s) => s.toasts);
  return (
    <div class="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={`toast toast-${t.level}`} role={t.level === 'error' ? 'alert' : 'status'} data-testid="toast">
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              class="btn small toast-action"
              onClick={() => {
                dismissToast(t.id);
                t.action?.run();
              }}
              data-testid="toast-action"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Dialogs() {
  const dialog = useSel(store, (s) => s.dialog);
  const launchConfirm = useSel(store, (s) => s.launchConfirm);
  const close = () => setDialog(null);
  if (dialog === 'shortcuts') {
    const rows: [string, string][] = [
      ['Send', 'Enter'],
      ['New line', 'Shift+Enter'],
      ['Stop Claude', 'Esc'],
      ['Cycle permission mode', 'Shift+Tab'],
      ['Open the permission mode menu', 'Alt+M'],
      ['Previous prompt', '↑ in an empty box'],
      ['Commands, skills, plugin commands', '/'],
      ['Mention a file', '@'],
      ['Answer a permission prompt', '1 · 2 · 3'],
      ['Save the file', `${MOD}+S`],
      ['Find in the file', `${MOD}+F`],
      ['Toggle the terminal', 'Ctrl+`'],
      ['Toggle the explorer', `${MOD}+B`],
    ];
    return (
      <Dialog title="Keyboard shortcuts" onClose={close}>
        <dl class="keys">
          {rows.map(([a, b]) => (
            <div key={a}>
              <dt>{a}</dt>
              <dd>
                <kbd>{b}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </Dialog>
    );
  }
  if (dialog === 'plugins') return <PluginsDialog onClose={close} />;
  if (dialog === 'mcp') return <McpPanel onClose={close} />;
  if (dialog === 'memory') return <MemoryDialog onClose={close} />;
  if (dialog === 'launch') return launchConfirm ? <LaunchConfirm entry={launchConfirm} /> : null;
  if (dialog === 'ports') {
    return (
      <Dialog title="Ports & previews" onClose={close} testid="ports-dialog">
        <PortsPanel onDone={close} />
      </Dialog>
    );
  }
  return <BypassDialog />;
}

/** Shortcuts that work anywhere on the page. */
function useGlobalKeys() {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault();
        toggleTerminal();
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyM') {
        // the permission mode menu (the desktop app's ⌘⇧M is the browser's own on macOS)
        e.preventDefault();
        openModeMenu();
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleExplorer();
      } else if (mod && e.key.toLowerCase() === 's') {
        // CodeMirror saves itself when it has focus; elsewhere, keep the browser's "save page" away and save the tab
        e.preventDefault();
        saveActiveTab();
      } else if (e.key === 'Escape' && !e.defaultPrevented && document.activeElement === document.body && !store.get().dialog) {
        if (activeView()?.state === 'busy') interrupt();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
}

function useViewportWidth(): number {
  const [w, setW] = useState(innerWidth);
  useEffect(() => {
    const f = () => setW(innerWidth);
    addEventListener('resize', f);
    return () => removeEventListener('resize', f);
  }, []);
  return w;
}

const size = (prop: 'width' | 'height', px: number) => (el: HTMLElement | null) => {
  if (el) el.style[prop] = `${px}px`;
};

// ---------------------------------------------------------------- layouts

function Desktop() {
  const layout = useSel(store, (s) => s.prefs.layout);
  const vw = useViewportWidth();
  // keep at least 320 px for the editor column
  const left = layout.explorer ? Math.min(layout.left, Math.max(BOUNDS.left[0], vw - layout.right - 320)) : 0;
  const right = Math.min(layout.right, Math.max(BOUNDS.right[0], vw - left - 320));
  return (
    <div class="app desktop">
      <TopBar />
      <div class="main">
        {layout.explorer && (
          <>
            <div class="col-left" ref={size('width', left)}>
              <SidePanel />
            </div>
            <Splitter axis="x" value={left} min={BOUNDS.left[0]} max={BOUNDS.left[1]} onChange={(v) => setLayout({ left: v })} label="Resize explorer" testid="split-left" />
          </>
        )}
        <div class="col-center">
          <div class="editor">
            <EditorTabs />
            <EditorPanes />
          </div>
          {layout.terminal && <Splitter axis="y" sign={-1} value={layout.bottom} min={BOUNDS.bottom[0]} max={BOUNDS.bottom[1]} onChange={(v) => setLayout({ bottom: v })} label="Resize terminal" />}
          <div class={`col-bottom${layout.terminal ? '' : ' hidden'}`} ref={size('height', layout.bottom)}>
            <TerminalPanel />
          </div>
        </div>
        <Splitter axis="x" sign={-1} value={right} min={BOUNDS.right[0]} max={BOUNDS.right[1]} onChange={(v) => setLayout({ right: v })} label="Resize chat" testid="split-right" />
        <div class="col-right" ref={size('width', right)}>
          <ChatPane />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}

function Tablet() {
  const layout = useSel(store, (s) => s.prefs.layout);
  const vw = useViewportWidth();
  const right = Math.min(Math.max(layout.right, Math.round(vw * 0.45)), vw - 300);
  return (
    <div class="app tablet">
      <TopBar tablet />
      <div class="main">
        <div class="col-center">
          {layout.tabletPane === 'files' ? (
            <SidePanel onOpenFile={() => setLayout({ tabletPane: 'editor' })} />
          ) : (
            <div class="editor">
              <EditorTabs />
              <EditorPanes />
            </div>
          )}
        </div>
        <Splitter axis="x" sign={-1} value={right} min={BOUNDS.right[0]} max={vw - 300} onChange={(v) => setLayout({ right: v })} label="Resize chat" />
        <div class="col-right" ref={size('width', right)}>
          <ChatPane />
        </div>
      </div>
      <TerminalPanel drawer />
      <StatusBar />
    </div>
  );
}

function PhoneMenu() {
  const term = useSel(store, (s) => terminalUrl(s));
  return (
    <Sheet title="Session" onClose={() => setSheet(null)} testid="phone-menu">
      <div class="phone-menu">
        <div class="pm-row">
          <span class="pm-label">Model</span>
          <ModelPicker />
        </div>
        <div class="pm-row">
          <span class="pm-label">Effort</span>
          <EffortPicker />
        </div>
        <div class="pm-row">
          <span class="pm-label">Cost</span>
          <CostMeter />
        </div>
        <div class="pm-row">
          <span class="pm-label">Context</span>
          <ContextMeter />
        </div>
        <hr />
        <button type="button" class="pm-link" onClick={() => (setSheet(null), void newSession())}>
          <Icon name="plus" /> New session
        </button>
        {term && (
          <a class="pm-link" href={term} target="_blank" rel="noopener noreferrer">
            <Icon name="terminal" /> Open the terminal
          </a>
        )}
        <button type="button" class="pm-link" onClick={() => setSheet('ports')} data-testid="phone-menu-ports">
          <Icon name="port" /> Ports & previews
        </button>
        <button type="button" class="pm-link" onClick={() => (setSheet(null), setDialog('mcp'))}>
          <Icon name="server" /> MCP servers
        </button>
        <button type="button" class="pm-link" onClick={() => (setSheet(null), setDialog('plugins'))}>
          <Icon name="plug" /> Plugins & marketplaces
        </button>
        <button type="button" class="pm-link" onClick={() => (setSheet(null), setDialog('memory'))} data-testid="phone-menu-memory">
          <Icon name="book" /> Memory (CLAUDE.md)
        </button>
        <button type="button" class="pm-link" onClick={() => (setSheet(null), reloadPlugins())}>
          <Icon name="refresh" /> Reload plugins & skills
        </button>
        <button type="button" class="pm-link" onClick={() => (setSheet(null), exportTranscript())}>
          <Icon name="download" /> Export the conversation (.md)
        </button>
      </div>
    </Sheet>
  );
}

function Phone() {
  const sheet = useSel(store, (s) => s.sheet);
  const tab = useSel(store, (s) => s.tabs.find((t) => t.key === s.activeTab));
  const tabsN = useSel(store, (s) => s.tabs.length);
  const pending = useSel(store, (s) => Object.values(s.views).filter((v) => v.id !== s.active).reduce((n, v) => n + v.permissions.length, 0));
  return (
    <div class="app phone">
      <header class="topbar phone-top" data-testid="topbar">
        <button type="button" class="icon-btn" aria-label="Sessions" title="Sessions" onClick={() => setSheet('sessions')} data-testid="phone-sessions">
          <Icon name="menu" size={20} />
          {pending > 0 && <span class="badge warn dot-badge">{pending}</span>}
        </button>
        <ChatHeaderPhone />
        <PhoneConn />
        <button type="button" class="icon-btn" aria-label="Files" title="Files" onClick={() => setSheet('files')} data-testid="phone-files">
          <Icon name="files" size={20} />
        </button>
        {tabsN > 0 && (
          <button type="button" class="icon-btn" aria-label="Editor" title="Editor" onClick={() => setSheet('editor')}>
            <Icon name="code" size={20} />
          </button>
        )}
        <button type="button" class="icon-btn" aria-label="Session settings" title="Model, mode, cost" onClick={() => setSheet('menu')} data-testid="phone-menu-btn">
          <Icon name="more" size={20} />
        </button>
      </header>
      <ChatPane header={false} />
      {sheet === 'sessions' && (
        <Sheet title="Sessions" onClose={() => setSheet(null)} testid="sheet-sessions">
          <SessionList />
        </Sheet>
      )}
      {sheet === 'files' && (
        <Sheet title="Files" onClose={() => setSheet(null)} testid="sheet-files">
          <FileTree onOpen={() => setSheet('editor')} />
        </Sheet>
      )}
      {sheet === 'editor' && (
        <Sheet title={tab ? basename(tab.path) : 'Editor'} onClose={() => setSheet(null)} testid="sheet-editor">
          <div class="editor">
            <EditorTabs />
            <EditorPanes />
          </div>
        </Sheet>
      )}
      {sheet === 'menu' && <PhoneMenu />}
      {sheet === 'ports' && (
        <Sheet title="Ports & previews" onClose={() => setSheet(null)} testid="sheet-ports">
          <PortsPanel />
        </Sheet>
      )}
    </div>
  );
}

/** Phones have no status bar: a dot in the header (and a line when offline). */
function PhoneConn() {
  const conn = useSel(store, (s) => s.conn);
  return (
    <span class={`phone-conn sb-${conn}`} title={conn === 'open' ? 'Connected' : conn === 'connecting' ? 'Connecting…' : 'Offline, retrying'}>
      <span class="sdot" />
      <span class="sr" data-testid="conn">
        {conn === 'open' ? 'Connected' : conn === 'connecting' ? 'Connecting…' : conn === 'locked' ? 'Locked' : 'Offline'}
      </span>
    </span>
  );
}

function ChatHeaderPhone() {
  const v = useSel(store, (s) => activeView(s));
  const model = useSel(store, (s) => modelLabel(s.models?.models, activeView(s)?.model ?? ''));
  return (
    <div class="phone-title">
      <span class="pt-title">{v?.title || (v ? 'New session' : 'Code')}</span>
      {v && (
        <span class={`state state-${v.state}`}>
          {v.state === 'busy' ? <Spinner size={10} /> : <span class="sdot" />}
          {v.state === 'busy' ? 'working' : v.state}
          {model ? ` · ${model}` : ''}
        </span>
      )}
    </div>
  );
}

export function AppShell(): ComponentChildren {
  useGlobalKeys();
  const phone = useMedia('(max-width: 699.98px)');
  const tablet = useMedia('(min-width: 700px) and (max-width: 1099.98px)');
  return (
    <>
      {phone ? <Phone /> : tablet ? <Tablet /> : <Desktop />}
      <Dialogs />
      <Toasts />
    </>
  );
}
