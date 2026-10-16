// The conversation: user prompts, Claude's answers (markdown), thinking (collapsed), tool cards (Task calls hold
// their subagent's calls), local command output, the turn footer with its cost from bedrock-now's spend logs, and
// notices. Sticks to the bottom while you are at the bottom.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Item, SessionView } from '../session';
import { shownCost, turnCosts } from '../spend';
import { duration, money, tokens } from '../text';
import { sendPrompt } from '../app';
import { MarkdownView } from './MarkdownView';
import { ToolCard } from './ToolCard';
import { Icon, Spinner } from './icons';
import { memo } from './ui';

const PAGE = 300;

const UserMsg = memo(function UserMsg({ it }: { it: Extract<Item, { t: 'user' }> }) {
  return (
    <div class={`msg-user${it.queued ? ' queued' : ''}`} data-testid="msg-user">
      <div class="msg-user-text">{it.text}</div>
      {(it.images > 0 || it.queued) && (
        <div class="msg-user-meta">
          {it.images > 0 && (
            <span>
              <Icon name="image" size={13} /> {it.images} image{it.images === 1 ? '' : 's'}
            </span>
          )}
          {it.queued && <span>queued — sent when Claude finishes</span>}
        </div>
      )}
    </div>
  );
});

const Assistant = memo(function Assistant({ it }: { it: Extract<Item, { t: 'assistant' }> }) {
  return (
    <div class={`msg-claude${it.streaming ? ' streaming' : ''}`} data-testid="msg-claude">
      <MarkdownView text={it.text} />
    </div>
  );
});

const Thinking = memo(function Thinking({ it }: { it: Extract<Item, { t: 'thinking' }> }) {
  return (
    <details class="thinking">
      <summary>
        <Icon name="brain" size={14} /> {it.streaming ? 'Thinking…' : 'Thought'}
      </summary>
      <div class="thinking-text">{it.text}</div>
    </details>
  );
});

function ResultLine({ it, cost }: { it: Extract<Item, { t: 'result' }>; cost: number | null | undefined }) {
  const interrupted = it.subtype === 'error_during_execution';
  return (
    <div class={`turn-end${it.isError && !interrupted ? ' err' : ''}`} data-testid="turn-end">
      <span>{interrupted ? 'Stopped' : it.isError ? `Ended: ${it.subtype}` : 'Done'}</span>
      {it.durationMs > 0 && <span>{duration(it.durationMs)}</span>}
      {(it.usage.input || it.usage.output) > 0 && (
        <span title={`input ${it.usage.input} · output ${it.usage.output} · cache read ${it.usage.cacheRead} · cache write ${it.usage.cacheWrite}`}>
          {tokens(it.usage.input + it.usage.cacheRead + it.usage.cacheWrite)} in · {tokens(it.usage.output)} out
        </span>
      )}
      <span class="turn-cost" title="From bedrock-now's spend logs (what this turn cost on Bedrock)">{cost === undefined ? '' : money(cost)}</span>
    </div>
  );
}

function Welcome() {
  const ideas = ['Explain how this project is organised', 'Find and fix a failing test', 'Add a README section about setup', '/init'];
  return (
    <div class="welcome">
      <div class="welcome-mark">
        <Icon name="code" size={28} />
      </div>
      <h2>What should we work on?</h2>
      <p class="muted">Claude Code runs in your sandbox's /workspace. It asks before it runs commands or edits files, unless you choose a mode that doesn't.</p>
      <div class="ideas">
        {ideas.map((t) => (
          <button key={t} type="button" class="idea" onClick={() => void sendPrompt(t, [])}>
            {t}
          </button>
        ))}
      </div>
      <p class="muted small">Project settings in /workspace/.claude (including hooks) apply here as they do in the terminal.</p>
    </div>
  );
}

function Working({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div class="working" aria-live="polite">
      <Spinner size={14} /> <span>Working… {since ? duration(Date.now() - since) : ''}</span>
    </div>
  );
}

export function MessageList({ view }: { view: SessionView | undefined }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [limit, setLimit] = useState(PAGE);
  const [showJump, setShowJump] = useState(false);
  const items = view?.items ?? [];

  const costs = useMemo(() => (view?.spend ? turnCosts(view.turns, view.spend) : null), [view?.spend, view?.turns]);
  const pendingTools = useMemo(() => new Set((view?.permissions ?? []).map((p) => JSON.stringify(p.input))), [view?.permissions]);

  // children of Task calls, by parent tool-use id
  const { top, kids } = useMemo(() => {
    const ids = new Set(items.filter((i) => i.t === 'tool').map((i) => (i as { id: string }).id));
    const kids = new Map<string, Item[]>();
    const top: Item[] = [];
    for (const it of items) {
      const p = 'parent' in it ? it.parent : null;
      if (p && ids.has(p)) {
        const l = kids.get(p) ?? [];
        l.push(it);
        kids.set(p, l);
      } else top.push(it);
    }
    return { top, kids };
  }, [items]);

  const shown = top.length > limit ? top.slice(top.length - limit) : top;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setShowJump(true);
  }, [items, view?.permissions.length]);

  useEffect(() => {
    stick.current = true;
    setLimit(PAGE);
    setShowJump(false);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view?.id]);

  const render = (it: Item): ComponentChildren => {
    switch (it.t) {
      case 'user':
        return <UserMsg key={it.k} it={it} />;
      case 'assistant':
        return <Assistant key={it.k} it={it} />;
      case 'thinking':
        return <Thinking key={it.k} it={it} />;
      case 'tool': {
        const children = kids.get(it.id);
        return (
          <ToolCard
            key={it.k}
            it={it}
            waiting={it.status === 'running' && pendingTools.has(JSON.stringify(it.input))}
            nested={children ? children.map(render) : undefined}
          />
        );
      }
      case 'local':
        return (
          <div key={it.k} class="local" data-testid="local">
            <MarkdownView text={it.text} />
          </div>
        );
      case 'result':
        return <ResultLine key={it.k} it={it} cost={costs ? shownCost(view?.turns[it.turn], costs[it.turn]) : null} />;
      case 'notice':
        return (
          <div key={it.k} class={`notice notice-${it.level}`}>
            {it.level === 'error' && <Icon name="alert" size={14} />}
            <span>{it.text}</span>
          </div>
        );
    }
  };

  const last = items[items.length - 1];
  const busy = view?.state === 'busy' || view?.state === 'starting';
  const streaming = last && (last.t === 'assistant' || last.t === 'thinking') && last.streaming;
  const lastTurn = view?.turns[view.turns.length - 1];

  return (
    <div
      class="messages"
      ref={scroller}
      data-testid="messages"
      onScroll={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        if (stick.current) setShowJump(false);
      }}
    >
      <div class="messages-inner">
        {!view || (!items.length && view.state !== 'busy') ? (
          <Welcome />
        ) : (
          <>
            {(top.length > shown.length || view.dropped > 0) && (
              <button type="button" class="linkish earlier" onClick={() => setLimit(limit + PAGE)} disabled={top.length <= shown.length}>
                {top.length > shown.length ? `Show earlier messages (${top.length - shown.length})` : `${view.dropped} older messages are not kept in this page`}
              </button>
            )}
            {shown.map(render)}
            {busy && !streaming && !view.permissions.length && <Working since={lastTurn?.end === null ? lastTurn.start : 0} />}
          </>
        )}
      </div>
      {showJump && (
        <button
          type="button"
          class="jump"
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTop = el.scrollHeight;
            stick.current = true;
            setShowJump(false);
          }}
        >
          <Icon name="chevronDown" size={14} /> Latest
        </button>
      )}
    </div>
  );
}
