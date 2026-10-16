// The Claude pane: header (session, state), messages, waiting permission prompts, background tasks, composer.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, activeView, stopTask, newSession } from '../app';
import { runningTasks } from '../session';
import { duration, label } from '../text';
import { MessageList } from './MessageList';
import { PermissionCard } from './PermissionCard';
import { Composer } from './Composer';
import { Icon, Spinner } from './icons';

function TaskList() {
  const v = useSel(store, (s) => activeView(s));
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const tasks = runningTasks(v);
  const all = v ? Object.values(v.tasks) : [];
  useEffect(() => {
    if (!tasks.length) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [tasks.length]);
  if (!all.length) return null;
  const recent = all.filter((t) => tasks.includes(t) || Date.now() - t.updated < 60_000).slice(-8);
  if (!recent.length) return null;
  return (
    <div class={`tasks${open ? ' open' : ''}`} data-testid="tasks">
      <button type="button" class="tasks-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {tasks.length ? <Spinner size={12} /> : <Icon name="check" size={13} />}
        <span>
          {tasks.length ? `${tasks.length} background task${tasks.length === 1 ? '' : 's'} running` : 'Background tasks finished'}
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronUp'} size={13} />
      </button>
      {open && (
        <ul class="tasks-list">
          {recent.map((t) => {
            const running = tasks.includes(t);
            return (
              <li key={t.id} class={`task task-${label(t.status, 20)}`}>
                <span class="task-status">{running ? <Spinner size={11} /> : t.status === 'completed' ? <Icon name="check" size={12} /> : <Icon name="close" size={12} />}</span>
                <span class="task-sum" title={t.summary}>
                  {t.summary || t.id}
                </span>
                <span class="task-time">{duration((running ? Date.now() : t.updated) - t.started)}</span>
                {running && (
                  <button type="button" class="btn small ghost" onClick={() => stopTask(t.id)} data-testid="task-stop">
                    Stop
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Permissions() {
  const perms = useSel(store, (s) => activeView(s)?.permissions ?? []);
  if (!perms.length) return null;
  return (
    <div class="perms">
      <PermissionCard key={perms[0].id} req={perms[0]} index={0} total={perms.length} />
    </div>
  );
}

export function ChatHeader({ actions }: { actions?: ComponentChildren }) {
  const v = useSel(store, (s) => activeView(s));
  const title = v?.title || (v ? 'New session' : 'Claude');
  const state = v?.state;
  return (
    <div class="pane-head chat-head">
      <span class="pane-title" title={title}>
        {title}
      </span>
      {state && (
        <span class={`state state-${state}`} data-testid="session-state">
          {state === 'busy' || state === 'starting' ? <Spinner size={11} /> : <span class="sdot" />}
          {state === 'busy' ? 'working' : state}
        </span>
      )}
      <span class="pane-actions">
        {actions}
        <button type="button" class="icon-btn" title="New session" aria-label="New session" onClick={() => void newSession()} data-testid="chat-new">
          <Icon name="plus" />
        </button>
      </span>
    </div>
  );
}

export function ChatPane({ composerFooter, header = true, headerActions }: { composerFooter?: ComponentChildren; header?: boolean; headerActions?: ComponentChildren }) {
  const v = useSel(store, (s) => activeView(s));
  return (
    <section class="chat" aria-label="Claude" data-testid="chat">
      {header && <ChatHeader actions={headerActions} />}
      {v?.gap && <div class="banner subtle">Reconnected: reloading what was missed…</div>}
      <MessageList view={v} />
      <div class="chat-foot">
        <Permissions />
        <TaskList />
        <Composer footer={composerFooter} />
      </div>
    </section>
  );
}
