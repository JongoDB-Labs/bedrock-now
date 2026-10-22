// Your Claude Code and claude-bedrock sessions of a folder of this computer, copied into the sandbox (a project's ⋯ ›
// Import sessions from this computer…): a sheet of three steps. 1 Look — the update helper on the computer asks there
// first, in a dialog on its screen (Allow once, or Always for this folder), and only then lists them; never asked over
// remote access. 2 Pick — the sessions of that list (titles, dates, sizes). 3 Check and copy — each one read into the
// Code page's container, its possible secrets listed (a few characters and a length, never the whole of one) and
// redacted unless you keep one, its thinking blocks taken out when it ran elsewhere than Bedrock, then copied into the
// sandbox. Nothing is written back to the computer. And Suggested from your computer: the folders your tools kept
// sessions for, which you add as projects on the computer (the page names no folder to it).
// Everything a session says — titles, prompts, the transcript — is what a past session saw: shown as text (label, the
// page's Markdown view for Claude's words), never followed.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, refreshSessions, resumeSession, toast } from '../app';
import * as api from '../api';
import type { Ev, ImportPreview, ImportResult, ImportRow, ImportTool, ImportView, ProjectSuggestion, SandboxWords } from '../types';
import { ago, bytes, label, safe } from '../text';
import { Icon, Spinner } from './icons';
import { MarkdownView } from './MarkdownView';
import { SandboxSaid } from './Said';
import { Cmd, Dialog } from './ui';

export const TOOL_LABEL: Record<ImportTool, string> = { claude: 'Claude Code', 'claude-bedrock': 'claude-bedrock' };
export const TOOL_BADGE: Record<ImportTool, string> = { claude: 'CC', 'claude-bedrock': 'CB' };
const SHOWN_ROWS = 500;
// why a request to the helper did not go through, said by us (the helper says a fixed word: import-sessions.mjs)
const WHY: Record<string, string> = {
  password: 'The portal password was not right (the helper checks it itself).',
  busy: 'The computer is busy with another ./stack command: try again when it has finished.',
  limit: 'The helper asks at most once a minute (10 times a day): try again in a moment.',
  denied: 'Not allowed on the computer: nothing was read.',
  'no-screen': 'No dialog can be shown on the computer (no screen): in a terminal there, ./stack sessions import.',
  remote: 'Only on the computer running bedrock-now: a look is allowed in a dialog on its screen.',
  'no-consent': 'Reading them is not allowed now (an Allow once lasts an hour; Always can be taken back): look again.',
  'no-project': 'That folder is not added as a project (any more) on the computer.',
  'no-store': 'There is no store of sessions for this folder on the computer.',
  'no-sessions': 'No sessions in that list.',
  stale: 'That list is gone (older than a day, or taken back): look again.',
  reader: 'The reader on the computer could not read the store.',
  code: 'The Code page\'s container did not take what was read (./stack sessions in a terminal says more).',
  'bad-request': 'The helper refused the request.',
};
const STATE: Record<string, string> = {
  sent: 'Waiting for the update helper on the computer…',
  asking: 'Answer the dialog on the computer\'s screen (Allow once, or Always for this folder).',
  reading: 'Reading on the computer…',
};

/** A request to the helper, followed until it is over: its state (sent, asking, reading) and how it ended. */
function useRequest(onDone: () => void) {
  const [req, setReq] = useState<{ id: string; state: string; why: string | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const follow = (id: string, n = 0) => {
    timer.current = setTimeout(async () => {
      let r = null;
      try { r = await api.importRequestState(id); } catch { /* next time */ }
      if (r && ['done', 'refused', 'cancelled', 'failed'].includes(r.state)) {
        setReq({ id, state: r.state, why: r.why });
        if (r.state === 'done') onDone();
        return;
      }
      if (r) setReq({ id, state: r.state, why: r.why });
      // (at most ~10 minutes: a dialog unanswered closes after 2, the reader has 3)
      if (n < 400) follow(id, n + 1);
      else setReq({ id, state: 'failed', why: null });
    }, n < 10 ? 700 : 1500);
  };
  return { req, start: (id: string) => { setReq({ id, state: 'sent', why: null }); follow(id); }, clear: () => setReq(null) };
}
function RequestLine({ req }: { req: { state: string; why: string | null } | null }) {
  if (!req) return null;
  if (STATE[req.state]) return (<div class="imp-req small" data-testid="import-request" data-state={req.state}><Spinner size={12} /> {STATE[req.state]}</div>);
  if (req.state === 'done') return null;
  return (
    <div class="imp-req plg-err small" role="alert" data-testid="import-request" data-state={req.state}>
      {(req.why && WHY[req.why]) || (req.state === 'cancelled' ? 'Cancelled on the computer: nothing was read.' : 'It did not go through on the computer (./stack sessions in a terminal there says why).')}
    </div>
  );
}

/** The portal password, asked again for a request to the helper (it checks it against its own copy). */
function Password({ value, onInput, testid }: { value: string; onInput: (v: string) => void; testid: string }) {
  return (
    <label class="imp-pw small">
      Portal password
      <input type="password" autocomplete="current-password" value={value} maxLength={300} onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)} data-testid={testid} />
    </label>
  );
}

export function ImportSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const project = useSel(store, (s) => s.projects.find((p) => p.id === id) ?? null);
  const remote = useSel(store, (s) => s.server?.remote === true);
  const [view, setView] = useState<ImportView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [pw, setPw] = useState('');
  const [tool, setTool] = useState<ImportTool | 'both'>('both');
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState<ImportTool | 'all'>('all');
  const [needle, setNeedle] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async (next?: 1 | 2 | 3) => {
    try {
      const v = await api.getImports(id);
      setView(v);
      setErr(null);
      if (next) setStep(next);
      else if (v.staged.length) setStep(3);
      else if (v.index) setStep(2);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The list could not be read.');
    }
  };
  const look = useRequest(() => void load(2));
  const read = useRequest(() => void load(3));
  useEffect(() => { void load(); }, [id]);
  if (!project) return null;
  const name = label(project.name, 80);
  const where = label(project.path, 400);
  const helperOk = view?.helper.running === true;
  const cmd = `./stack sessions import --project ${/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(project.name) ? project.name : 'NAME'}`;
  const ask = async () => {
    setBusy(true);
    try { look.start(await api.importScan(id, tool, pw)); setPw(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Not asked.'); }
    setBusy(false);
  };
  const fetchPicked = async () => {
    setBusy(true);
    try { read.start(await api.importFetch(id, picked, pw)); setPw(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Not asked.'); }
    setBusy(false);
  };
  return (
    <Dialog title={`Import sessions into ${name}`} onClose={onClose} wide testid="import-sheet">
      <ol class="imp-steps" aria-label="Steps">
        {(['Look on this computer', 'Pick', 'Check and copy'] as const).map((t, i) => (
          <li key={t} class={step === i + 1 ? 'on' : ''} aria-current={step === i + 1 ? 'step' : undefined}>{i + 1} {t}</li>
        ))}
      </ol>
      {err && <div class="plg-err small" role="alert" data-testid="import-error">{label(err, 300)}</div>}
      {!view && !err && <div class="side-note"><Spinner size={12} /> Loading…</div>}
      {view && step === 1 && (
        <div class="imp-step" data-testid="import-step-look">
          <p>
            Your sessions of <b>Claude Code</b> (<code>~/.claude</code>) and <b>claude-bedrock</b> (<code>~/.claude-bedrock</code>) in this folder on the computer
            running bedrock-now: <code data-testid="import-folder">{where}</code>.
          </p>
          <p class="small">
            The update helper on the computer asks you there first, in a dialog on its screen — <b>Allow once</b>, or <b>Always for this folder</b> — then lists
            them: titles, dates and sizes only. You pick the ones to copy next, and see each one before anything is copied. Nothing is ever written back to the
            computer; its logins, settings and plugins are never read.
          </p>
          {view.index && (
            <p class="small muted" data-testid="import-last-look">
              Last look: {ago(view.index.at)} — {view.index.rows.length} session{view.index.rows.length === 1 ? '' : 's'} (allowed {view.index.consent === 'always' ? 'always for this folder' : 'once'}).{' '}
              <button type="button" class="linkish" onClick={() => setStep(2)} data-testid="import-use-last">Use this list</button>
            </p>
          )}
          {remote || !view.local ? (
            <p class="small warn-text" data-testid="import-remote">
              Only on the computer running bedrock-now: a look is allowed there, in a dialog on its screen. From here you can read and copy sessions of a look
              already allowed there.
            </p>
          ) : !helperOk ? (
            <div class="small" data-testid="import-no-helper">
              The update helper is not running on the computer (<code>./stack helper install</code>). In a terminal there:
              <Cmd text={cmd} testid="import-cmd" />
            </div>
          ) : (
            <div class="imp-ask">
              <label class="small">
                Tools{' '}
                <select value={tool} onChange={(e) => setTool((e.currentTarget as HTMLSelectElement).value as ImportTool | 'both')} data-testid="import-tool">
                  <option value="both">Claude Code and claude-bedrock</option>
                  <option value="claude">Claude Code only</option>
                  <option value="claude-bedrock">claude-bedrock only</option>
                </select>
              </label>
              <Password value={pw} onInput={setPw} testid="import-password" />
              <button type="button" class="btn primary" disabled={busy || !pw || (look.req !== null && Boolean(STATE[look.req.state]))} onClick={() => void ask()} data-testid="import-look">
                {busy ? <Spinner size={12} /> : <Icon name="monitor" size={14} />} Look on this computer
              </button>
            </div>
          )}
          <RequestLine req={look.req} />
          {view.local && helperOk && <p class="muted small">Or in a terminal there: <Cmd text={cmd} testid="import-cmd" /></p>}
        </div>
      )}
      {view && step === 2 && <PickStep view={view} picked={picked} setPicked={setPicked} filter={filter} setFilter={setFilter} needle={needle} setNeedle={setNeedle} />}
      {view && step === 2 && (
        <div class="imp-ask">
          {view.index && !view.index.fetchable ? (
            <span class="small warn-text" data-testid="import-stale">That look was allowed once, more than an hour ago: look again to read them.</span>
          ) : !helperOk ? (
            <span class="small">The update helper is not running on the computer: in a terminal there, <Cmd text={cmd} testid="import-cmd-2" /></span>
          ) : (
            <>
              <Password value={pw} onInput={setPw} testid="import-password-2" />
              <button type="button" class="btn primary" disabled={busy || !pw || !picked.length || (read.req !== null && Boolean(STATE[read.req.state]))} onClick={() => void fetchPicked()}
                data-testid="import-read">
                {busy ? <Spinner size={12} /> : null} Read {picked.length || ''} session{picked.length === 1 ? '' : 's'} to check them
              </button>
            </>
          )}
          <RequestLine req={read.req} />
        </div>
      )}
      {view && step === 3 && <CheckStep project={id} view={view} onCopied={() => void load(3)} />}
      <div class="dlg-actions">
        {step > 1 && <button type="button" class="btn" onClick={() => setStep(step === 3 ? 2 : 1)} data-testid="import-back">Back</button>}
        {step === 2 && view?.staged.length ? <button type="button" class="btn" onClick={() => setStep(3)} data-testid="import-to-check">Check the {view.staged.length} read</button> : null}
        <button type="button" class="btn" onClick={onClose}>Close</button>
      </div>
    </Dialog>
  );
}

/** Step 2: the sessions of the last look (the newest first), to pick. */
function PickStep(props: { view: ImportView; picked: string[]; setPicked: (v: string[]) => void; filter: ImportTool | 'all'; setFilter: (v: ImportTool | 'all') => void;
  needle: string; setNeedle: (v: string) => void }) {
  const { view, picked, setPicked } = props;
  const rows = view.index?.rows ?? [];
  const q = props.needle.trim().toLowerCase();
  const shown = useMemo(() => rows.filter((r) => (props.filter === 'all' || r.tool === props.filter) && (!q || `${r.title}\n${r.first}`.toLowerCase().includes(q))), [rows, props.filter, q]);
  const left = Object.entries(view.index?.counts ?? {}).reduce((n, [, c]) => n + (c?.otherFolder ?? 0) + (c?.noCwd ?? 0) + (c?.unreadable ?? 0) + (c?.older ?? 0), 0);
  const toggle = (id: string, on: boolean) => setPicked(on ? [...new Set([...picked, id])].slice(0, 50) : picked.filter((x) => x !== id));
  if (!view.index) return <div class="side-note" data-testid="import-step-pick">No list yet: look on this computer first.</div>;
  return (
    <div class="imp-step" data-testid="import-step-pick">
      <div class="imp-filter">
        <select value={props.filter} onChange={(e) => props.setFilter((e.currentTarget as HTMLSelectElement).value as ImportTool | 'all')} aria-label="Tool" data-testid="import-filter">
          <option value="all">All tools</option>
          <option value="claude">Claude Code</option>
          <option value="claude-bedrock">claude-bedrock</option>
        </select>
        <input type="search" placeholder="Search titles" value={props.needle} onInput={(e) => props.setNeedle((e.currentTarget as HTMLInputElement).value)} aria-label="Search titles"
          data-testid="import-search" />
        <span class="muted small">{picked.length} picked (at most 50 at once)</span>
      </div>
      {!rows.length && <div class="side-note" data-testid="import-none">No sessions of Claude Code or claude-bedrock in this folder on the computer.</div>}
      <ul class="imp-rows" data-testid="import-rows">
        {shown.slice(0, SHOWN_ROWS).map((r) => <PickRow key={`${r.tool}:${r.id}`} r={r} picked={picked.includes(r.id)} onPick={(on) => toggle(r.id, on)} />)}
      </ul>
      {shown.length > SHOWN_ROWS && <div class="muted small" data-testid="import-more">{shown.length - SHOWN_ROWS} more: narrow them with the search.</div>}
      {left > 0 && <div class="muted small">{left} other transcript{left === 1 ? '' : 's'} in the store folder left out (another folder's of the same name, too old to list, or unreadable).</div>}
    </div>
  );
}
function PickRow({ r, picked, onPick }: { r: ImportRow; picked: boolean; onPick: (on: boolean) => void }) {
  const title = r.title || r.first || 'Untitled session';
  return (
    <li class={`imp-row${r.tooLarge ? ' off' : ''}`} data-testid="import-row" data-session={r.id}>
      <label>
        <input type="checkbox" checked={picked} disabled={r.tooLarge} onChange={(e) => onPick((e.currentTarget as HTMLInputElement).checked)} data-testid="import-pick" />
        <span class="imp-badge" title={`${TOOL_LABEL[r.tool]} on this computer`} data-testid="import-badge">{TOOL_BADGE[r.tool]}</span>
        <span class="imp-title">{title}</span>
        <span class="imp-meta muted small">
          {ago(r.last)}{r.messages !== null ? ` · ${r.messages} msgs` : ''} · {bytes(r.size)}
          {r.copied ? ' · copied before' : ''}{r.tooLarge ? ' · too large to copy (32 MiB)' : ''}
          {r.format === 'other' ? ` · written by Claude Code ${r.version ?? '?'} (not a version these imports were tested with: check it)` : ''}
        </span>
      </label>
    </li>
  );
}

/** Step 3: each session read into the container — what was found, what becomes of it, and Copy into the sandbox. */
function CheckStep({ project, view, onCopied }: { project: string; view: ImportView; onCopied: () => void }) {
  const [choices, setChoices] = useState<Record<string, { keep: string[]; thinking: 'strip' | 'keep' | null; skip: boolean }>>({});
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const ch = (id: string) => choices[id] ?? { keep: [], thinking: null, skip: false };
  const set = (id: string, v: Partial<{ keep: string[]; thinking: 'strip' | 'keep' | null; skip: boolean }>) => setChoices((c) => ({ ...c, [id]: { ...ch(id), ...v } }));
  const todo = view.staged.filter((s) => !ch(s.id).skip);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.importCopy(project, todo.map((s) => ({ id: s.id, keep: ch(s.id).keep, thinking: ch(s.id).thinking })));
      setResults(r);
      void refreshSessions();
      onCopied();
    } catch (e) {
      toast(`Not copied: ${e instanceof Error ? e.message : 'the copy failed'}`, 'error');
    }
    setBusy(false);
  };
  return (
    <div class="imp-step" data-testid="import-step-check">
      {results && (
        <ul class="imp-results" data-testid="import-results">
          {results.map((r) => (
            <li key={r.id} data-testid="import-result" data-ok={r.ok ? '1' : '0'}>
              {r.ok ? (
                <>
                  Copied{r.forked ? ' as a new session (the copy here had been continued since)' : ''} — {r.redacted} redaction{r.redacted === 1 ? '' : 's'}
                  {r.kept ? `, ${r.kept} kept as they were` : ''}{r.thinkingRemoved ? `, ${r.thinkingRemoved} thinking block${r.thinkingRemoved === 1 ? '' : 's'} out` : ''}
                  {r.left ? `, ${r.left} file${r.left === 1 ? '' : 's'} beside it left behind` : ''}.{' '}
                  {r.as && <button type="button" class="linkish" onClick={() => void resumeSession(r.as as string)} data-testid="import-open">Open it</button>}
                </>
              ) : (
                <>Not copied: {r.why}{r.said && <SandboxSaid words={r.said as SandboxWords} compact />}</>
              )}
            </li>
          ))}
        </ul>
      )}
      {!view.staged.length && !results && <div class="side-note">Nothing read yet: pick sessions first.</div>}
      {view.staged.map((s) => <Staged key={s.id} project={project} id={s.id} tool={s.tool} choice={ch(s.id)} set={(v) => set(s.id, v)} />)}
      {view.staged.length > 0 && (
        <>
          <p class="muted small">
            Copied sessions resume on any model of the catalog, and open in Manual the first time (their history is what a past session saw: Claude asks
            before each change). Copying again later replaces the copy while it is as it was copied; once continued here, a later copy comes in as a new session.
          </p>
          <div class="imp-ask">
            <button type="button" class="btn primary" disabled={busy || !todo.length} onClick={() => void go()} data-testid="import-copy">
              {busy ? <Spinner size={12} /> : null} Copy {todo.length} into the sandbox
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Staged({ project, id, tool, choice, set }: { project: string; id: string; tool: ImportTool; choice: { keep: string[]; thinking: 'strip' | 'keep' | null; skip: boolean };
  set: (v: Partial<{ keep: string[]; thinking: 'strip' | 'keep' | null; skip: boolean }>) => void }) {
  const [pv, setPv] = useState<ImportPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let gone = false;
    api.importPreview(project, id, choice.thinking).then((p) => { if (!gone) setPv(p); }, (e) => { if (!gone) setErr(e instanceof Error ? e.message : 'not read'); });
    return () => { gone = true; };
  }, [project, id, choice.thinking]);
  const keepable = pv?.findings.filter((f) => f.keepable) ?? [];
  return (
    <section class={`imp-staged${choice.skip ? ' off' : ''}`} data-testid="import-staged" data-session={id}>
      <div class="imp-staged-head">
        <label class="small">
          <input type="checkbox" checked={!choice.skip} onChange={(e) => set({ skip: !(e.currentTarget as HTMLInputElement).checked })} data-testid="import-include" /> Copy
        </label>
        <span class="imp-badge" title={`${TOOL_LABEL[tool]} on this computer`}>{TOOL_BADGE[tool]}</span>
        <span class="imp-title">{pv ? pv.title || 'Untitled session' : 'Reading…'}</span>
        <span class="muted small">{pv?.messages != null ? `${pv.messages} msgs · ` : ''}{pv?.size != null ? bytes(pv.size) : ''}</span>
        <button type="button" class="linkish small" onClick={() => void api.importDrop(project, id).then(() => set({ skip: true }))} data-testid="import-drop">Drop</button>
      </div>
      {err && <div class="plg-err small">{label(err, 300)}</div>}
      {pv && (
        <div class="imp-checks">
          {pv.findingsTotal === 0 ? (
            <div class="small" data-testid="import-no-findings">No possible secret found (a secret in a shape the scan does not know, or in prose, can still be there: look at it).</div>
          ) : (
            <div data-testid="import-findings">
              <div class="small warn-text">
                <Icon name="alert" size={13} /> {pv.findingsTotal} possible secret{pv.findingsTotal === 1 ? '' : 's'}: redacted unless you keep one.{' '}
                {keepable.length > 0 && <button type="button" class="linkish" onClick={() => set({ keep: [] })} data-testid="import-redact-all">Redact all</button>}
              </div>
              <ul class="imp-findings">
                {pv.findings.map((f) => (
                  <li key={f.id} data-testid="import-finding" data-kind={f.kind}>
                    <label>
                      <input type="checkbox" checked={!choice.keep.includes(f.id)} disabled={!f.keepable}
                        onChange={(e) => set({ keep: (e.currentTarget as HTMLInputElement).checked ? choice.keep.filter((k) => k !== f.id) : [...choice.keep, f.id] })}
                        data-testid="import-redact" />{' '}
                      redact
                    </label>{' '}
                    <b>{f.label}</b> <span class="muted">{f.part ? `in ${f.part}` : `message ${f.message}`}</span> <code>{f.preview}</code>
                    <div class="imp-context small muted">{f.context}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pv.thinking.blocks > 0 && (
            <div class="small" data-testid="import-thinking">
              {pv.thinking.blocks} thinking block{pv.thinking.blocks === 1 ? '' : 's'}:{' '}
              {pv.thinking.strip ? 'taken out (the text stays)' : 'kept'}{pv.thinking.source === 'anthropic' ? ' — it ran elsewhere than Bedrock, whose signatures Bedrock may refuse on resume' : ''}.{' '}
              <button type="button" class="linkish" onClick={() => set({ thinking: pv.thinking.strip ? 'keep' : 'strip' })} data-testid="import-thinking-toggle">
                {pv.thinking.strip ? 'Keep them' : 'Take them out'}
              </button>
            </div>
          )}
          {pv.outside.count > 0 && (
            <div class="small" data-testid="import-outside">
              {pv.outside.count} path{pv.outside.count === 1 ? '' : 's'} outside the project named in its tool calls (not in the sandbox): {pv.outside.sample.slice(0, 5).join(', ')}{pv.outside.count > 5 ? ' …' : ''}
            </div>
          )}
          {pv.left.length > 0 && (
            <div class="small" data-testid="import-left">{pv.left.length} file{pv.left.length === 1 ? '' : 's'} beside it cannot be checked and stay behind: {pv.left.slice(0, 3).map((l) => `${l.part} (${l.why})`).join(', ')}</div>
          )}
          {pv.bad > 0 && <div class="small muted">{pv.bad} line{pv.bad === 1 ? '' : 's'} of the transcript are not readable and stay behind.</div>}
          {pv.hidden && <div class="small muted">Its folder's path on the computer is rewritten to where the sandbox sees it ({pv.rewritten} places); other paths of yours stay as they were.</div>}
          {pv.format === 'other' && <div class="small warn-text">Written by Claude Code {pv.version ?? '?'}: not a version these imports were tested with — check it below.</div>}
          <button type="button" class="linkish small" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="import-preview-toggle">
            {open ? 'Hide the transcript' : `Show the transcript as it would be copied (${pv.total} messages)`}
          </button>
          {open && <Transcript events={pv.events} />}
        </div>
      )}
    </section>
  );
}

/** A transcript as it would be copied: your prompts and tool results as text, Claude's words in the page's Markdown view
 *  (its own sanitizing), tool calls in one line each — read only. */
function Transcript({ events }: { events: Ev[] }) {
  const shown = events.slice(-200);
  return (
    <div class="imp-transcript" data-testid="import-transcript">
      {events.length > shown.length && <div class="muted small">{events.length - shown.length} earlier events not shown.</div>}
      {shown.map((e, i) => {
        switch (e.kind) {
          case 'user': return <div key={i} class="imp-user"><span class="imp-who">You</span><div class="imp-text">{safe(e.text, 4000)}</div></div>;
          case 'text': return <div key={i} class="imp-assistant"><MarkdownView text={safe(e.text, 20000)} /></div>;
          case 'thinking': return <div key={i} class="imp-thinking muted small">Thinking: {label(e.text, 300)}</div>;
          case 'tool_use': return <div key={i} class="imp-tool small"><Icon name="terminal" size={12} /> {label(e.name, 60)} {label(JSON.stringify(e.input ?? {}), 200)}</div>;
          case 'tool_result': return <div key={i} class="imp-result small muted">{label(e.text, 240)}</div>;
          case 'local': return <div key={i} class="imp-local small muted">{label(e.text, 240)}</div>;
          default: return null;
        }
      })}
    </div>
  );
}

/** Suggested from your computer: the folders your tools kept sessions for — added as projects on the computer, never
 *  from here (a page names no folder to it). */
export function Suggestions() {
  const remote = useSel(store, (s) => s.server?.remote === true);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ProjectSuggestion[] | null>(null);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const loadRows = async () => {
    try { setRows((await api.getSuggestions()).rows); } catch (e) { setErr(e instanceof Error ? e.message : 'not read'); }
  };
  const look = useRequest(() => void loadRows());
  useEffect(() => { if (open && rows === null) void loadRows(); }, [open]);
  const ask = async () => {
    setBusy(true);
    try { look.start(await api.suggestProjects(pw)); setPw(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Not asked.'); }
    setBusy(false);
  };
  return (
    <div class="proj-suggest" data-testid="suggestions">
      <button type="button" class="proj-add" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="suggestions-toggle">
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} /> Suggested from your computer
      </button>
      {open && (
        <div class="proj-body">
          {err && <div class="side-note err small">{label(err, 300)}</div>}
          {rows !== null && !rows.length && <div class="side-note small">None yet.</div>}
          <ul class="sess-list">
            {(rows ?? []).slice(0, 100).map((r) => (
              <li key={r.path} class="imp-suggestion" data-testid="suggestion">
                <span class="imp-title" title={r.path}>{r.path}</span>
                <span class="muted small">
                  {r.claude ? ` CC ${r.claude}` : ''}{r.claudeBedrock ? ` CB ${r.claudeBedrock}` : ''}{r.last ? ` · ${ago(r.last)}` : ''}
                </span>
                <details class="small">
                  <summary data-testid="suggestion-add">Add…</summary>
                  Add it on the computer running bedrock-now: Settings › Claude Code › Project folders › <b>Choose on this computer…</b>, or in a terminal there:
                  <Cmd text={`./stack project add '${r.path.replace(/'/g, `'\\''`)}'`} testid="suggestion-cmd" />
                </details>
              </li>
            ))}
          </ul>
          {remote ? (
            <div class="side-note small">Looking for them is asked only on the computer running bedrock-now.</div>
          ) : (
            <div class="imp-ask small">
              <span>The names of the folders Claude Code and claude-bedrock keep sessions for (no session is read; the computer asks you first):</span>
              <Password value={pw} onInput={setPw} testid="suggest-password" />
              <button type="button" class="btn small" disabled={busy || !pw} onClick={() => void ask()} data-testid="suggest-look">Look on this computer</button>
              <RequestLine req={look.req} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
