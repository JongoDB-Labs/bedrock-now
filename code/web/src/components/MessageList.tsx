// The conversation: user prompts, Claude's answers (markdown), thinking (collapsed), tool cards (Task calls hold
// their subagent's calls), local command output, the turn footer with its cost from bedrock-now's spend logs, and
// notices. Sticks to the bottom while you are at the bottom.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Item, Queued, SessionView } from '../session';
import { shownCost, turnCosts } from '../spend';
import { duration, money, tokens } from '../text';
import { forkFrom, loadEarlier, openGitDialog, rewindCancel, rewindConfirm, rewindPreview, sendPrompt, showGit, store, currentProject, openProjectDialog } from '../app';
import { useSel } from '../store';
import { MarkdownView } from './MarkdownView';
import { ToolCard } from './ToolCard';
import { WatchCard } from './WatchCard';
import { SandboxSaid } from './Said';
import type { SandboxWords } from '../types';
import { BlockedCard } from './BlockedCard';
import { modelLabel } from './Pickers';
import { otherModels } from '../models';
import { Icon, Spinner } from './icons';
import { memo } from './ui';
import { splitContext } from '../mentions';

const PAGE = 300;

/** "Restore files to here": what a dry run found, and Restore. */
function RewindPanel() {
  const rw = useSel(store, (s) => s.rewind);
  // not while Claude works in the session: what it changes meanwhile was not in the check
  const busy = useSel(store, (s) => {
    const v = s.rewind ? s.views[s.rewind.session] : undefined;
    return v?.state === 'busy' || v?.state === 'starting';
  });
  if (!rw) return null;
  const r = rw.result;
  const nothing = rw.phase === 'ready' && (!r || !r.canRewind || !r.files.length);
  return (
    <div class="rewind" role="group" aria-label="Restore files" data-testid="rewind-preview">
      {rw.note && rw.phase !== 'checking' && <div class="rewind-line muted" data-testid="rewind-note">{rw.note}</div>}
      {rw.phase === 'checking' ? (
        <div class="rewind-line">
          <Spinner size={12} /> Checking what Claude changed since this prompt…
        </div>
      ) : nothing ? (
        <div class="rewind-line">
          Nothing to restore{rw.error || r?.error ? `: ${rw.error || r?.error}` : r && !r.canRewind ? ' (no checkpoint for this prompt)' : ' — no file changed since this prompt.'}
          {(rw.said ?? r?.said) && <SandboxSaid words={(rw.said ?? r?.said) as SandboxWords} compact />}
        </div>
      ) : (
        <>
          <div class="rewind-line">
            Put back {r?.files.length} file{r?.files.length === 1 ? '' : 's'} as they were before this prompt{' '}
            <span class="add">+{r?.insertions}</span> <span class="del">−{r?.deletions}</span>
            {r && r.skippedLinks > 0 ? <span class="muted"> ({r.skippedLinks} links left alone)</span> : null}
          </div>
          <ul class="rewind-files">
            {r?.files.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
          {rw.error && (
            <div class="rewind-line err">
              {rw.error}
              {rw.said && <SandboxSaid words={rw.said} compact />}
            </div>
          )}
          <div class="muted small">Only files Claude changed with its edit tools; the conversation stays as it is.</div>
        </>
      )}
      <div class="rewind-buttons">
        <button type="button" class="btn small ghost" onClick={rewindCancel}>
          {nothing ? 'Close' : 'Cancel'}
        </button>
        {!nothing && rw.phase !== 'checking' && (
          <button
            type="button"
            class="btn small danger"
            disabled={rw.phase === 'restoring' || busy}
            title={busy ? 'Claude is working in this session: restore once the turn is over' : ''}
            onClick={() => void rewindConfirm()}
            data-testid="rewind-confirm"
          >
            {rw.phase === 'restoring' ? 'Restoring…' : 'Restore'}
          </button>
        )}
      </div>
    </div>
  );
}

/** A prompt of yours as text; the context its @-mentions added (mentions.ts) folded away below it. */
function UserText({ text }: { text: string }) {
  const parts = useMemo(() => splitContext(text), [text]);
  return (
    <>
      <div class="msg-user-text">{parts.prompt}</div>
      {parts.context && (
        <details class="msg-context" data-testid="msg-context">
          <summary>
            <Icon name="at" size={12} /> Context from the workspace{parts.count ? `: ${parts.count} @-mention${parts.count === 1 ? '' : 's'}` : ''}, quoted
          </summary>
          <pre class="msg-context-body">{parts.context}</pre>
        </details>
      )}
    </>
  );
}

const UserMsg = memo(function UserMsg({ it, session }: { it: Extract<Item, { t: 'user' }>; session: string }) {
  const rewinding = useSel(store, (s) => !!it.uuid && s.rewind?.message === it.uuid);
  return (
    <div class={`msg-user${it.queued ? ' queued' : ''}`} data-testid="msg-user">
      {it.uuid && (
        <span class="msg-actions">
          <button
            type="button"
            class="msg-rewind icon-btn tiny"
            title="Restore files to here: put back what Claude changed since this prompt"
            aria-label="Restore checkpoint"
            onClick={() => void rewindPreview(session, it.uuid as string)}
            data-testid="msg-rewind"
          >
            <Icon name="history" size={13} />
          </button>
          <button
            type="button"
            class="msg-fork icon-btn tiny"
            title="Fork from here: a new session with the conversation before this prompt, the prompt back in the box to change"
            aria-label="Fork from here"
            onClick={() => void forkFrom(session, it.uuid as string, it.text)}
            data-testid="msg-fork"
          >
            <Icon name="fork" size={13} />
          </button>
        </span>
      )}
      <UserText text={it.text} />
      {(it.images > 0 || it.queued || it.folded) && (
        <div class="msg-user-meta">
          {it.images > 0 && (
            <span>
              <Icon name="image" size={13} /> {it.images} image{it.images === 1 ? '' : 's'}
            </span>
          )}
          {it.queued && <span>queued — sent when Claude finishes</span>}
          {it.folded && <span data-testid="msg-folded">sent while Claude worked — taken into this turn</span>}
        </div>
      )}
      {rewinding && <RewindPanel />}
    </div>
  );
});

/** While an answer streams, its markdown is laid out at most once a frame (and less often once it is long):
 *  re-reading the whole text for every delta would grow with its square. */
function useStreamText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    if (!streaming) {
      setShown(text);
      return;
    }
    const wait = text.length > 20_000 ? 250 : text.length > 4000 ? 80 : 0;
    const left = last.current + wait - Date.now();
    let raf = 0;
    const t = setTimeout(() => {
      raf = requestAnimationFrame(() => {
        last.current = Date.now();
        setShown(text);
      });
    }, Math.max(0, left));
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, [text, streaming]);
  return streaming ? shown : text;
}

const Assistant = memo(function Assistant({ it }: { it: Extract<Item, { t: 'assistant' }> }) {
  const text = useStreamText(it.text, it.streaming);
  return (
    <div class={`msg-claude${it.streaming ? ' streaming' : ''}`} data-testid="msg-claude">
      <MarkdownView text={text} devLinks />
    </div>
  );
});

/** A prompt that waits for the turn in progress: pinned below it until the turn ends. */
function QueuedMsg({ q }: { q: Queued }) {
  return (
    <div class="msg-user queued" data-testid="msg-user">
      <UserText text={q.text} />
      <div class="msg-user-meta">
        {q.images > 0 && (
          <span>
            <Icon name="image" size={13} /> {q.images} image{q.images === 1 ? '' : 's'}
          </span>
        )}
        <span>waiting — Claude takes it when this turn ends</span>
      </div>
    </div>
  );
}

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
  const bn = useSel(store, (s) => s.models?.models);
  // what ran when it is not the model picked (Claude Code chose another one): bedrock-now's name for it, never the
  // string the sandbox reported
  const other = otherModels(it.models, it.picked);
  return (
    <div class={`turn-end${it.isError && !interrupted ? ' err' : ''}`} data-testid="turn-end">
      {/* (the SDK's own subtypes as they are — the backend sends "other" for anything else: never its text in ours) */}
      <span>{interrupted ? 'Stopped' : it.isError && it.subtype === 'success' ? 'Failed' : it.isError ? (it.subtype && it.subtype !== 'other' ? `Ended: ${it.subtype}` : 'Ended with an error') : 'Done'}</span>
      {it.durationMs > 0 && <span>{duration(it.durationMs)}</span>}
      {(it.usage.input || it.usage.output) > 0 && (
        <span title={`input ${it.usage.input} · output ${it.usage.output} · cache read ${it.usage.cacheRead} · cache write ${it.usage.cacheWrite}`}>
          {tokens(it.usage.input + it.usage.cacheRead + it.usage.cacheWrite)} in · {tokens(it.usage.output)} out
        </span>
      )}
      {other.length > 0 && (
        <span class="turn-model" title="Claude Code ran this turn on another model than the one picked" data-testid="turn-model">
          ran on {other.map((m) => modelLabel(bn, m) || 'another model').join(', ')}
        </span>
      )}
      <span class="turn-cost" title="From bedrock-now's spend logs (what this turn cost on Bedrock)">{cost === undefined ? '' : money(cost)}</span>
    </div>
  );
}

/** The Git panel with one of its dialogs (Clone, Git hosts) open, as the command palette and a ?git= link do. */
function gitDialog(d: 'clone' | 'hosts'): void {
  showGit();
  openGitDialog(d);
}

function Welcome() {
  const ideas = ['Explain how this project is organised', 'Find and fix a failing test', 'Add a README section about setup', '/init'];
  const hosts = useSel(store, (s) => s.git.hosts);
  const project = useSel(store, (s) => currentProject(s));
  return (
    <div class="welcome">
      <div class="welcome-mark">
        <Icon name="code" size={28} />
      </div>
      <h2>What should we work on?</h2>
      <p class="muted" data-testid="welcome-where">
        {project.workspace ? 'Claude Code runs in your sandbox\'s /workspace.' : `A new session runs in ${project.name}, your sandbox's ${project.path}.`} It asks before it runs commands or
        edits files, unless you choose a mode that doesn't.
      </p>
      <div class="ideas">
        {ideas.map((t) => (
          <button key={t} type="button" class="idea" onClick={() => void sendPrompt(t, [])}>
            {t}
          </button>
        ))}
      </div>
      <div class="welcome-repo" data-testid="welcome-repo">
        <span class="muted small">Start from a repository:</span>
        <button type="button" class="btn small" onClick={() => gitDialog('clone')} data-testid="welcome-clone">
          <Icon name="download" size={13} /> Clone a repository
        </button>
        <button type="button" class="btn small" onClick={() => gitDialog('hosts')} title="Git hosts: tokens and SSH keys for push, pull and clone of private repositories" data-testid="welcome-hosts">
          <Icon name="server" size={13} /> {hosts && hosts.hosts.length ? 'Git hosts' : 'Connect a git host'}
        </button>
        <button type="button" class="btn small" onClick={() => openProjectDialog({ kind: 'new', tab: 'empty' })} data-testid="welcome-new-project">
          <Icon name="folder" size={13} /> New project
        </button>
      </div>
      <p class="muted small">
        {project.workspace
          ? 'Project settings in /workspace/.claude (including hooks) apply here as they do in the terminal.'
          : `This project's own Claude Code configuration (${project.path}/.claude, .mcp.json) applies only once you trust it: ⋯ › Claude Code settings…`}
      </p>
    </div>
  );
}

function Working({ since, status }: { since: number; status: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // Bedrock retries (throttling, a 5xx) show here as they happen
  const retry = /retry/i.test(status) ? status : '';
  return (
    <div class={`working${retry ? ' retrying' : ''}`} data-testid="working">
      <Spinner size={14} /> <span>Working… {since ? duration(Date.now() - since) : ''}</span>
      {retry && <span class="working-status">{retry}</span>}
      {status === 'compacting' && <span class="working-status">compacting the conversation</span>}
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
  }, [items, view?.permissions.length, view?.queued.length]);

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
        return <UserMsg key={it.k} it={it} session={view?.id ?? ''} />;
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
      case 'watch':
        return <WatchCard key={it.k} session={view?.id ?? ''} id={it.id} when={it.when} changes={it.changes} incomplete={it.incomplete} />;
      case 'blocked':
        return <BlockedCard key={it.k} session={view?.id ?? ''} it={it} mode={view?.mode ?? null} />;
      case 'notice':
        return (
          <div key={it.k} class={`notice notice-${it.level}`}>
            {it.level === 'error' && <Icon name="alert" size={14} />}
            <span>{it.text}</span>
            {it.said && <SandboxSaid words={it.said} />}
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
      <div class="messages-inner" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation">
        {!view || (!items.length && view.state !== 'busy' && !view.queued.length) ? (
          <Welcome />
        ) : (
          <>
            {top.length <= shown.length && !!view.historyOffset && (
              <button type="button" class="linkish earlier" onClick={() => void loadEarlier(view.id)} data-testid="load-earlier">
                Load earlier messages ({view.historyOffset} more in the transcript)
              </button>
            )}
            {view.historyTruncated && top.length <= shown.length && (
              <div class="notice notice-warn" data-testid="history-truncated">
                <Icon name="alert" size={14} /> <span>This transcript is long: only its last part could be read here (the whole one is in the sandbox).</span>
              </div>
            )}
            {(top.length > shown.length || view.dropped > 0) && (
              <button type="button" class="linkish earlier" onClick={() => setLimit(limit + PAGE)} disabled={top.length <= shown.length}>
                {top.length > shown.length ? `Show earlier messages (${top.length - shown.length})` : `${view.dropped} older messages are not kept in this page`}
              </button>
            )}
            {shown.map(render)}
            {busy && !streaming && !view.permissions.length && <Working since={lastTurn?.end === null ? lastTurn.start : 0} status={view.status} />}
            {view.queued.map((q, i) => (
              <QueuedMsg key={`q${i}-${q.uuid ?? ''}`} q={q} />
            ))}
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
