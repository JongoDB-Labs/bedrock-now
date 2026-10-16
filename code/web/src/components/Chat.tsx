// The Claude pane: header (session, state), banners, messages, waiting permission prompts, the to-do list, background
// tasks, composer.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, activeView, stopTask, newSession } from '../app';
import { overBudget } from '../api';
import { runningTasks } from '../session';
import { latestTodos } from '../transcript';
import { duration, label, money } from '../text';
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

/** The code host stopped letting this browser in (the unlock's 12 hours, Sign out, a new password). */
function UnlockExpired() {
  const locked = useSel(store, (s) => s.conn === 'locked');
  if (!locked) return null;
  return (
    <div class="banner warn" role="alert" data-testid="unlock-expired">
      <Icon name="alert" size={15} />
      <span>Your Code-page unlock expired (or you signed out). Sessions keep running; reload to unlock with the portal password.</span>
      <span class="banner-actions">
        <a class="btn small" href={location.pathname || '/'}>
          Reload
        </a>
      </span>
    </div>
  );
}

/** The terminal key's budget is spent: LiteLLM refuses the next request until it resets or goes up. */
function BudgetBanner() {
  const budget = useSel(store, (s) => s.budget);
  const hit = useSel(store, (s) => s.budgetHit);
  if (!hit && !overBudget(budget)) return null;
  const when = budget?.resetAt ? new Date(budget.resetAt).toLocaleDateString() : '';
  const figures = budget && budget.max !== null ? `: ${money(budget.spend)} of ${money(budget.max)}` : '';
  return (
    <div class="banner warn" role="alert" data-testid="budget-banner">
      <Icon name="alert" size={15} />
      <span>
        The Code page's key (claude-code-terminal) reached its budget{figures}
        {when ? `, until ${when}` : ''}. Raise BUDGET_TERMINAL in Settings (from the computer running bedrock-now), or wait for the reset.
      </span>
    </div>
  );
}

/** Claude's latest to-do list, pinned above the prompt box while some of it is left (collapsed to one line). */
function TodoPanel() {
  const v = useSel(store, (s) => activeView(s));
  const todos = useMemo(() => (v ? latestTodos(v.items) : null), [v?.items]);
  const [open, setOpen] = useState(false);
  if (!todos || !todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  if (done === todos.length && v?.state !== 'busy') return null;
  const now = todos.find((t) => t.status === 'in_progress');
  return (
    <div class={`todos${open ? ' open' : ''}`} data-testid="todo-panel">
      <button type="button" class="todos-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="list" size={14} />
        <span class="todos-count">
          {done}/{todos.length}
        </span>
        <span class="todos-now">{now ? now.activeForm || now.content : done === todos.length ? 'All done' : 'To do'}</span>
        <Icon name="chevronDown" size={13} class="todos-chev" />
      </button>
      {open && (
        <ul class="todos-list">
          {todos.map((t, i) => (
            <li key={i} class={`todo todo-${t.status}`}>
              <span class="todo-box" aria-label={t.status.replace('_', ' ')}>
                {t.status === 'completed' ? <Icon name="check" size={12} /> : t.status === 'in_progress' ? <Icon name="play" size={10} /> : null}
              </span>
              <span>{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ChatPane({ composerFooter, header = true, headerActions }: { composerFooter?: ComponentChildren; header?: boolean; headerActions?: ComponentChildren }) {
  const v = useSel(store, (s) => activeView(s));
  return (
    <section class="chat" aria-label="Claude" data-testid="chat">
      {header && <ChatHeader actions={headerActions} />}
      <UnlockExpired />
      <BudgetBanner />
      {v?.gap && <div class="banner subtle">Reconnected: reloading what was missed…</div>}
      <MessageList view={v} />
      <div class="chat-foot">
        <Permissions />
        <TodoPanel />
        <TaskList />
        <Composer footer={composerFooter} />
      </div>
    </section>
  );
}
