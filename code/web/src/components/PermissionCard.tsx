// A permission prompt: the sentence built from tool + input (the SDK's title is empty headless), what exactly would
// run or change, the reason the CLI gave, and Allow once / Always allow (with a preview of the rule it writes) /
// Deny (with an optional message for Claude). Keys 1/2/3 answer while the card has focus, like the CLI.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PermissionReq } from '../types';
import { rulePreview, sentence } from '../permission';
import { compact, lineDiff } from '../diff';
import { label, prettyJson, safe } from '../text';
import { answerPermission, answerQuestions } from '../app';
import { buildAnswers, emptyPick, parseQuestions, toggle, type Pick, type Question } from '../questions';
import { DiffLines } from './ToolCard';
import { MarkdownView } from './MarkdownView';
import { Icon } from './icons';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One question: its options as radio buttons (one choice) or checkboxes (several), and "Other" with a text field. */
function QuestionField({ q, n, pick, onPick }: { q: Question; n: number; pick: Pick; onPick: (p: Pick) => void }) {
  const type = q.multi ? 'checkbox' : 'radio';
  const name = `q${n}`;
  const otherRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (pick.other) otherRef.current?.focus();
  }, [pick.other]);
  return (
    <fieldset class="question" data-testid="question">
      <legend class="q-text">
        {q.header && <span class="q-chip">{q.header}</span>}
        {q.text}
        {q.multi && <span class="muted small"> (choose any)</span>}
      </legend>
      <div class="q-options" role={q.multi ? 'group' : 'radiogroup'}>
        {q.options.map((o, i) => (
          <label key={i} class={`q-opt${pick.chosen.includes(i) ? ' on' : ''}`}>
            <input type={type} name={name} checked={pick.chosen.includes(i)} onChange={() => onPick(toggle(q, pick, i))} />
            <span class="q-body">
              <span class="q-label">{o.label}</span>
              {o.description && <span class="q-desc">{o.description}</span>}
            </span>
          </label>
        ))}
        <label class={`q-opt${pick.other ? ' on' : ''}`}>
          <input type={type} name={name} checked={pick.other} onChange={() => onPick(toggle(q, pick, -1))} data-testid="q-other" />
          <span class="q-body">
            <span class="q-label">Other…</span>
          </span>
        </label>
        {pick.other && (
          <input
            class="q-other-text"
            type="text"
            maxLength={2000}
            placeholder="Your answer"
            aria-label={`Your own answer to: ${q.text}`}
            value={pick.otherText}
            onInput={(e) => onPick({ ...pick, otherText: (e.target as HTMLInputElement).value })}
            ref={otherRef}
            data-testid="q-other-text"
          />
        )}
      </div>
    </fieldset>
  );
}

/**
 * AskUserQuestion: Claude's questions as a small form. The answers go back through the SDK's own channel (the tool's
 * input with `answers`), so Claude gets them as answers — not as a refusal. Decline denies the tool instead.
 */
function QuestionCard({ req, qs, index, total }: { req: PermissionReq; qs: Question[]; index: number; total: number }) {
  const [picks, setPicks] = useState<Pick[]>(() => qs.map(emptyPick));
  const answers = buildAnswers(qs, picks);
  const send = () => {
    if (answers) answerQuestions(req.session, req.id, answers);
  };
  return (
    <form
      class="perm perm-question"
      role="alertdialog"
      aria-label="Claude has a question for you"
      data-testid="permission"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div class="perm-head">
        <Icon name="sparkle" size={16} />
        <span class="perm-title">{qs.length > 1 ? `Claude has ${qs.length} questions for you` : 'Claude has a question for you'}</span>
        {total > 1 && (
          <span class="perm-count">
            {index + 1} of {total}
          </span>
        )}
      </div>
      <div class="questions">
        {qs.map((q, i) => (
          <QuestionField key={i} q={q} n={i} pick={picks[i]} onPick={(p) => setPicks(picks.map((x, j) => (j === i ? p : x)))} />
        ))}
      </div>
      {req.reason && <div class="perm-reason">{req.reason}</div>}
      <div class="perm-buttons">
        <button type="button" class="btn ghost" onClick={() => answerPermission(req.session, req.id, 'deny', 'I would rather not answer that now.')} data-testid="q-decline">
          Decline
        </button>
        <button type="submit" class="btn primary" disabled={!answers} title={answers ? '' : 'Choose an answer for every question'} data-testid="q-send">
          {qs.length > 1 ? 'Send answers' : 'Send answer'}
        </button>
      </div>
    </form>
  );
}

function Details({ req }: { req: PermissionReq }) {
  const s = sentence(req.tool, req.input);
  const i = obj(req.input);
  switch (s.detail) {
    case 'command':
      return (
        <pre class="cmd">
          <span class="prompt">$ </span>
          {safe(i.command, 20_000)}
        </pre>
      );
    case 'edit': {
      const edits = Array.isArray(i.edits) ? (i.edits as unknown[]).map(obj) : [i];
      const lines = edits.slice(0, 20).flatMap((e) => compact(lineDiff(str(e.old_string), str(e.new_string))));
      return <DiffLines lines={lines} max={200} />;
    }
    case 'write':
      return <DiffLines lines={lineDiff('', str(i.content)).slice(0, 2000)} max={40} />;
    case 'plan':
      return <MarkdownView text={safe(i.plan, 100_000)} class="plan" />;
    case 'json':
      return <pre class="json">{prettyJson(req.input, 20_000)}</pre>;
    default:
      return null;
  }
}

export function PermissionCard({ req, index, total }: { req: PermissionReq; index: number; total: number }) {
  const qs = req.tool === 'AskUserQuestion' ? parseQuestions(req.input) : [];
  return qs.length ? <QuestionCard req={req} qs={qs} index={index} total={total} /> : <ToolPermission req={req} index={index} total={total} />;
}

function ToolPermission({ req, index, total }: { req: PermissionReq; index: number; total: number }) {
  const s = sentence(req.tool, req.input);
  const rules = rulePreview(req.suggestions);
  const [denying, setDenying] = useState(false);
  const [msg, setMsg] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (denying) reasonRef.current?.focus();
  }, [denying]);

  const answer = (d: 'once' | 'always' | 'deny') => answerPermission(req.session, req.id, d, d === 'deny' ? msg : undefined);

  return (
    <div
      ref={ref}
      class="perm"
      role="alertdialog"
      aria-label={s.title}
      tabIndex={-1}
      data-testid="permission"
      onKeyDown={(e) => {
        if (denying || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
        if (e.key === '1') answer('once');
        else if (e.key === '2' && rules.length) answer('always');
        else if (e.key === '3') setDenying(true);
      }}
    >
      <div class="perm-head">
        <Icon name="shield" size={16} />
        <span class="perm-title">{label(s.title, 300)}</span>
        {total > 1 && (
          <span class="perm-count">
            {index + 1} of {total}
          </span>
        )}
      </div>
      {s.subject && <div class="perm-subject">{s.subject}</div>}
      <div class="perm-details">
        <Details req={req} />
      </div>
      {req.reason && <div class="perm-reason">{req.reason}</div>}
      {denying ? (
        <form
          class="perm-deny"
          onSubmit={(e) => {
            e.preventDefault();
            answer('deny');
          }}
        >
          <textarea
            ref={reasonRef}
            rows={2}
            placeholder="Tell Claude what to do instead (optional)"
            value={msg}
            maxLength={2000}
            onInput={(e) => setMsg((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                answer('deny');
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setDenying(false);
              }
            }}
          />
          <div class="perm-buttons">
            <button type="button" class="btn ghost" onClick={() => setDenying(false)}>
              Back
            </button>
            <button type="submit" class="btn danger" data-testid="perm-deny-send">
              Deny
            </button>
          </div>
        </form>
      ) : (
        <div class="perm-buttons">
          <button type="button" class="btn primary" onClick={() => answer('once')} data-testid="perm-once">
            Allow once <kbd>1</kbd>
          </button>
          {rules.length > 0 && (
            <button type="button" class="btn" onClick={() => answer('always')} title={rules.join('\n')} data-testid="perm-always">
              Always allow <kbd>2</kbd>
            </button>
          )}
          <button type="button" class="btn ghost" onClick={() => setDenying(true)} data-testid="perm-deny">
            Deny <kbd>3</kbd>
          </button>
        </div>
      )}
      {rules.length > 0 && !denying && (
        <ul class="perm-rules" aria-label="What Always allow saves">
          {rules.map((r, i) => (
            <li key={i}>
              <span class="muted">Always:</span> <code>{r}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
