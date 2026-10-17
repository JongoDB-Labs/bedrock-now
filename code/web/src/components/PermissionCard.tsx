// A permission prompt: the sentence built from tool + input (the SDK's title is empty headless), what exactly would
// run or change, the reason the CLI gave, and Allow once / Always allow (with every rule it writes, as the backend
// will write it) / Deny (with an optional message for Claude). Keys 1/2/3 answer, like the CLI, once you went to the
// card yourself (a click on it, or Tab into it) — never a keystroke that reached it because it took the focus — and
// not in its first 400 ms, nor at all when the prompt asks to default to no. A card that appears takes the focus only
// from nothing you type into (a field, the editor, the terminal keep it). A prompt whose input could not be shown in
// full can only be denied. ExitPlanMode is a plan to approve: then Accept edits, or Manual (asking for each edit), or
// Auto (while Settings allow it), or not yet (keep planning, with a message). While Settings allow Auto, a shell
// command's card in Manual or Accept edits also offers "Allow, and switch to Auto", as the CLI does — not one that your
// ask rules or a hook asked for (Auto would ask for those too).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PermissionReq, RuleLine } from '../types';
import { destinationText, modeName, rulePreview, sentence } from '../permission';
import { compact, lineDiff } from '../diff';
import { commandShape, label, prettyJson, safe } from '../text';
import { answerPermission, answerQuestions, allowAndSwitchToAuto, store, autoOk } from '../app';
import { useSel } from '../store';
import { PERMISSION_SHOWN_CHARS, PERMISSION_SHOWN_EDITS, PERMISSION_SHOWN_STRING, type Decision } from '../api';
import { typingIn } from '../focus';
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
      // (a held Enter's repeats never answer: not this card again, nor the next one when it comes up)
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.repeat) e.preventDefault();
      }}
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

/** What a card shows of the input, in full or not at all: the SAME caps on both sides (protocol.mjs LIMITS). */
const MAX_EDITS = PERMISSION_SHOWN_EDITS;

function Details({ req }: { req: PermissionReq }) {
  const s = sentence(req.tool, req.input);
  const i = obj(req.input);
  switch (s.detail) {
    case 'command': {
      const shape = commandShape(i.command);
      return (
        <>
          {shape.warn && (
            <div class="perm-warn" data-testid="perm-command-warning">
              <Icon name="alert" size={14} /> A long or padded command: {shape.lines} line{shape.lines === 1 ? '' : 's'}, {shape.length.toLocaleString()} characters
              {shape.padding >= 40 ? `, a run of ${shape.padding} spaces` : ''}. Scroll through all of it before you allow it.
            </div>
          )}
          <pre class="cmd">
            <span class="prompt">$ </span>
            {safe(i.command, 200_000)}
          </pre>
        </>
      );
    }
    case 'edit': {
      const edits = Array.isArray(i.edits) ? (i.edits as unknown[]).map(obj) : [i];
      const lines = edits.slice(0, MAX_EDITS).flatMap((e) => compact(lineDiff(str(e.old_string), str(e.new_string))));
      const all = edits.some((e) => e.replace_all === true);
      return (
        <>
          {all && (
            <div class="perm-warn" data-testid="perm-replace-all">
              <Icon name="alert" size={14} /> Replaces every occurrence in the file{edits.length > 1 ? ' (in the marked edits)' : ''}, not only the first.
            </div>
          )}
          <DiffLines lines={lines} max={400} lineMax={PERMISSION_SHOWN_STRING} />
          {edits.length > MAX_EDITS && (
            <div class="perm-warn" data-testid="perm-more-edits">
              and {edits.length - MAX_EDITS} more edit{edits.length - MAX_EDITS === 1 ? '' : 's'} not shown here
            </div>
          )}
        </>
      );
    }
    case 'write': {
      const lines = lineDiff('', str(i.content));
      return <DiffLines lines={lines} max={40} lineMax={PERMISSION_SHOWN_STRING} />;
    }
    case 'plan':
      return <MarkdownView text={safe(i.plan, PERMISSION_SHOWN_STRING)} class="plan" />;
    case 'json':
      // whole: the input is already within the shown caps (indentation adds to it)
      return <pre class="json">{prettyJson(req.input, PERMISSION_SHOWN_CHARS * 4)}</pre>;
    default:
      return null;
  }
}

/** "Allow" stays off for a moment after a card appears: a keystroke meant for the prompt box must not approve. */
function useArmed(id: string, ms = 400): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    const t = setTimeout(() => setArmed(true), ms);
    return () => clearTimeout(t);
  }, [id]);
  return armed;
}

/** The card takes focus when it appears, unless something you type into has it (empty or not). */
function useFocusOnArrival(ref: { current: HTMLElement | null }, id: string, target?: () => HTMLElement | null): void {
  useEffect(() => {
    if (!typingIn(document.activeElement)) (target?.() ?? ref.current)?.focus({ preventScroll: true });
  }, [id]);
}

/** Whether you went to this card yourself — clicked in it, or reached it with Tab — since it appeared: only then do
 *  1/2/3 answer it. A keystroke that lands on it because it took the focus is never an answer. */
function useEngaged(id: string): [boolean, () => void] {
  const [engaged, setEngaged] = useState<string | null>(null);
  return [engaged === id, () => setEngaged(id)];
}

function RuleList({ rules, label: what, testid }: { rules: RuleLine[]; label: string; testid?: string }) {
  return (
    <ul class="perm-rules" aria-label={what} data-testid={testid}>
      {rules.map((r, i) => (
        <li key={i}>
          {/^mode \w+$/.test(r.text) ? <span>Switch to {modeName(r.text.slice(5))} mode</span> : <code>{r.text}</code>}{' '}
          {r.destination && <span class="muted">{destinationText(r.destination)}</span>}
        </li>
      ))}
    </ul>
  );
}

/** ExitPlanMode: the plan, and how to go on. */
function PlanCard({ req, index, total }: { req: PermissionReq; index: number; total: number }) {
  const i = obj(req.input);
  const allowAuto = useSel(store, (s) => autoOk(s));
  const armed = useArmed(req.id);
  const [keep, setKeep] = useState(false);
  const [msg, setMsg] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useFocusOnArrival(ref, req.id);
  useEffect(() => {
    if (keep) box.current?.focus();
  }, [keep]);
  const ok = armed && req.complete;
  return (
    <div ref={ref} class="perm perm-plan" role="alertdialog" aria-label="Claude has a plan" tabIndex={-1} data-testid="permission">
      <div class="perm-head">
        <Icon name="book" size={16} />
        <span class="perm-title">Claude has a plan and wants to start working on it</span>
        {total > 1 && (
          <span class="perm-count">
            {index + 1} of {total}
          </span>
        )}
      </div>
      <div class="perm-details">
        <MarkdownView text={safe(i.plan, PERMISSION_SHOWN_STRING)} class="plan" />
      </div>
      {!req.complete && <Partial />}
      {keep ? (
        <form
          class="perm-deny"
          onSubmit={(e) => {
            e.preventDefault();
            answerPermission(req.session, req.id, 'deny', msg || 'Keep planning: not yet.');
          }}
        >
          <textarea ref={box} rows={2} placeholder="What should the plan change? (optional)" value={msg} maxLength={2000} onInput={(e) => setMsg((e.target as HTMLTextAreaElement).value)} />
          <div class="perm-buttons">
            <button type="button" class="btn ghost" onClick={() => setKeep(false)}>
              Back
            </button>
            <button type="submit" class="btn" data-testid="plan-keep-send">
              Keep planning
            </button>
          </div>
        </form>
      ) : (
        <div class="perm-buttons">
          <button type="button" class="btn ghost" onClick={() => setKeep(true)} data-testid="plan-keep">
            Keep planning…
          </button>
          <button type="button" class="btn" disabled={!ok} onClick={() => answerPermission(req.session, req.id, 'once', undefined, 'default')} data-testid="plan-approve-ask">
            Approve, Manual
          </button>
          {allowAuto && (
            <button type="button" class="btn" disabled={!ok} onClick={() => answerPermission(req.session, req.id, 'once', undefined, 'auto')} data-testid="plan-approve-auto">
              Approve, Auto
            </button>
          )}
          <button type="button" class="btn primary" disabled={!ok} onClick={() => answerPermission(req.session, req.id, 'once', undefined, 'acceptEdits')} data-testid="plan-approve-edits">
            Approve, Accept edits
          </button>
        </div>
      )}
    </div>
  );
}

function Partial() {
  return (
    <div class="perm-warn perm-partial" role="alert" data-testid="perm-partial">
      <Icon name="alert" size={14} /> Partially shown: this request is too large to show in full here, so it can only be denied. Ask Claude for something smaller.
    </div>
  );
}

export function PermissionCard({ req, index, total }: { req: PermissionReq; index: number; total: number }) {
  const qs = req.tool === 'AskUserQuestion' ? parseQuestions(req.input) : [];
  if (qs.length) return <QuestionCard req={req} qs={qs} index={index} total={total} />;
  if (req.tool === 'ExitPlanMode' && typeof obj(req.input).plan === 'string') return <PlanCard req={req} index={index} total={total} />;
  return <ToolPermission req={req} index={index} total={total} />;
}

function ToolPermission({ req, index, total }: { req: PermissionReq; index: number; total: number }) {
  const s = sentence(req.tool, req.input);
  // what "Always" applies: the backend's own list (older backends: a preview from the CLI's suggestions)
  const rules: RuleLine[] = req.rules.length ? req.rules : req.noAlways ? [] : rulePreview(req.suggestions).map((text) => ({ text, destination: '' }));
  const project = req.projectRules;
  const armed = useArmed(req.id);
  const [engaged, engage] = useEngaged(req.id);
  const [denying, setDenying] = useState(false);
  const [msg, setMsg] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useFocusOnArrival(ref, req.id, () => (req.defaultNo ? denyRef.current : null));
  useEffect(() => {
    if (denying) reasonRef.current?.focus();
  }, [denying]);

  const allow = armed && req.complete;
  const answer = (d: Decision) => {
    if (d !== 'deny' && !allow) return;
    answerPermission(req.session, req.id, d, d === 'deny' ? msg : undefined);
  };
  // "Allow, and switch to Auto" (the CLI's "Yes, and switch to auto mode"): a shell command in Manual or Accept edits,
  // not asked for by one of your ask rules or a hook, while Settings allow Auto
  const sessionMode = useSel(store, (s) => s.views[req.session]?.mode ?? null);
  const allowAuto = useSel(store, (s) => autoOk(s));
  const offerAuto = allowAuto && req.tool === 'Bash' && (sessionMode === 'default' || sessionMode === 'acceptEdits') && req.reasonType !== 'rule' && req.reasonType !== 'hook';
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoErr, setAutoErr] = useState('');
  const toAuto = async () => {
    if (!allow || autoBusy) return;
    setAutoBusy(true);
    setAutoErr('');
    const e = await allowAndSwitchToAuto(req.session, req.id);
    setAutoBusy(false);
    if (e) setAutoErr(e);
  };

  return (
    <div
      ref={ref}
      class={`perm${req.complete ? '' : ' partial'}`}
      role="alertdialog"
      aria-label={s.title}
      tabIndex={-1}
      data-testid="permission"
      data-engaged={engaged ? 'true' : undefined}
      onPointerDown={engage}
      onKeyUp={(e) => {
        if (e.key === 'Tab') engage();
      }}
      onKeyDown={(e) => {
        // (a held key's repeats never answer a card)
        if (e.repeat || denying || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
        if (req.defaultNo) {
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
            e.preventDefault();
            setDenying(true);
          }
          return;
        }
        if (!armed || !engaged) return;
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
      {!req.complete && <Partial />}
      {req.reason && (
        <div class="perm-reason" data-testid="perm-reason">
          {req.reasonType === 'classifier' && <strong>Auto mode paused: </strong>}
          {req.reason}
        </div>
      )}
      {autoErr && (
        <div class="perm-warn perm-partial" role="alert" data-testid="perm-auto-error">
          <Icon name="alert" size={14} /> Not switched to Auto: {autoErr}
        </div>
      )}
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
                if (!e.repeat) answer('deny');
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
          <button type="button" class="btn primary" disabled={!allow} onClick={() => answer('once')} data-testid="perm-once">
            Allow once {!req.defaultNo && <kbd>1</kbd>}
          </button>
          {rules.length > 0 && (
            <button type="button" class="btn" disabled={!allow} onClick={() => answer('always')} title={rules.map((r) => r.text).join('\n')} data-testid="perm-always">
              Always allow {!req.defaultNo && <kbd>2</kbd>}
            </button>
          )}
          {project.length > 0 && (
            <button type="button" class="btn" disabled={!allow} onClick={() => answer('always_project')} data-testid="perm-always-project">
              Always, in this workspace's settings
            </button>
          )}
          {offerAuto && (
            <button type="button" class="btn" disabled={!allow || autoBusy} onClick={() => void toAuto()} title="Runs this command, then switches the session to Auto: a reviewer model checks the next actions instead of you" data-testid="perm-once-auto">
              Allow, and switch to Auto
            </button>
          )}
          <button ref={denyRef} type="button" class="btn ghost" onClick={() => setDenying(true)} data-testid="perm-deny">
            Deny {!req.defaultNo && <kbd>3</kbd>}
          </button>
        </div>
      )}
      {rules.length > 0 && !denying && <RuleList rules={rules} label="What Always allow saves" testid="perm-rules" />}
      {project.length > 0 && !denying && (
        <div class="perm-project" data-testid="perm-project-note">
          <span class="muted small">
            "Always, in this workspace's settings" writes these into your folder's .claude settings — Claude Code on your computer honours them in that folder
            too:
          </span>
          <RuleList rules={project} label="What it writes into the workspace" />
        </div>
      )}
    </div>
  );
}
