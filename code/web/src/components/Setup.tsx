// Bring your setup (Settings › Claude Code › Bring your setup…, the ⋯ menu, a project's ⋯, the Git panel's Use yours
// from this computer): items of your Claude Code setup on the computer running bedrock-now — CLAUDE.md, skills, agents,
// commands, output styles, key bindings, four keys of settings.json, MCP servers, plugins — and your Git name and email,
// copied into the sandbox. A sheet of three steps. 1 Look — the update helper on the computer asks there first, in a
// dialog on its screen, then lists names and sizes only; never asked over remote access. 2 Pick and open — the items
// you tick are read in whole (on the computer too). 3 Check and copy — each one as it will be: what it costs in every
// request, the programs, paths and rules it brings, its possible secrets (redacted, or left out, unless you keep one:
// the portal password), whether the sandbox has one of its own (left as it is unless you choose), the exact text it
// writes. Nothing is written back to the computer; logins, credentials and env are never read.
// Everything shown is what your setup held — untrusted text (a skill can say anything): shown as text only; what the
// sandbox has now is its own words, shown apart.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, toast } from '../app';
import * as api from '../api';
import type { SetupCounts, SetupKind, SetupPreview, SetupResult, SetupRow, SetupTool, SetupView, SetupWrite, SandboxWords } from '../types';
import { ago, bytes, label, safe } from '../text';
import { Icon, Spinner } from './icons';
import { SandboxSaid } from './Said';
import { Cmd, Dialog } from './ui';
import { Password, RequestLine, STATE, WHY, useRequest } from './Import';
import { ConfirmCommand } from './Plugins';

export const SETUP_TOOL_LABEL: Record<SetupTool, string> = { claude: 'Claude Code', 'claude-bedrock': 'claude-bedrock', git: 'Git' };
const BADGE: Record<SetupTool, string> = { claude: 'CC', 'claude-bedrock': 'CB', git: 'Git' };
const KIND_LABEL: Record<SetupKind, string> = {
  memory: 'Memory (CLAUDE.md)', skill: 'Skills', agent: 'Agents', command: 'Commands', 'output-style': 'Output styles', keybindings: 'Key bindings',
  setting: 'Settings (settings.json)', mcp: 'MCP servers', plugin: 'Plugins', identity: 'Git name and email',
};
const KINDS: SetupKind[] = ['memory', 'skill', 'agent', 'command', 'output-style', 'keybindings', 'setting', 'mcp', 'plugin', 'identity'];
const SETTING_WHAT: Record<string, string> = { permissions: 'permission rules (allow, ask, deny)', statusLine: 'the status line (a command)', outputStyle: 'the output style', hooks: 'hooks (commands)' };
const SETUP_WHY: Record<string, string> = {
  ...WHY,
  denied: 'Not allowed on the computer: nothing was read.',
  remote: 'Only on the computer running bedrock-now: your setup is read there, after you allowed it in a dialog on its screen.',
  'no-consent': 'Reading it is not allowed now (an Allow once lasts an hour; Always can be taken back): look again.',
  stale: 'That look is gone (older than a day, or taken back): look again.',
  reader: 'The reader on the computer could not read your setup.',
  'no-screen': 'No dialog can be shown on the computer (no screen): in a terminal there, ./stack sessions config import.',
  changed: 'It changed since you checked it: check it again.',
};
const CMD = './stack sessions config import';

/** The sheet: a project's (its local MCP servers come along when it is a folder of this computer), or none. */
export function SetupSheet({ project: pid, tool: firstTool = null, onClose }: { project: string | null; tool?: 'git' | null; onClose: () => void }) {
  const project = useSel(store, (s) => (pid ? s.projects.find((p) => p.id === pid) ?? null : null));
  const projects = useSel(store, (s) => s.projects);
  const remote = useSel(store, (s) => s.server?.remote === true);
  const [view, setView] = useState<SetupView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [pw, setPw] = useState('');
  const [tool, setTool] = useState<SetupTool | 'all'>(firstTool ?? 'all');
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const load = async (next?: 1 | 2 | 3) => {
    try {
      const v = await api.getSetup();
      setView(v);
      setErr(null);
      if (next) setStep(next);
      else if (v.staged.length) setStep(3);
      else if (v.index) setStep(2);
      // (from the Git panel: the Git name and email picked at once)
      if (firstTool === 'git' && v.index) setPicked((x) => (x.length ? x : v.index?.rows.filter((r) => r.kind === 'identity').map((r) => r.n) ?? []));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The list could not be read.');
    }
  };
  const look = useRequest(() => void load(2));
  const open = useRequest(() => void load(3));
  useEffect(() => { void load(); }, []);
  // (a folder of this computer: its local MCP servers come along)
  const host = project?.host && !project.gone ? project : null;
  const helperOk = view?.helper.running === true && view.helper.actions.includes('setup-scan');
  const ask = async () => {
    setBusy(true);
    try { look.start(await api.setupScan(tool, host?.id ?? null, pw)); setPw(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Not asked.'); }
    setBusy(false);
  };
  const openPicked = async () => {
    setBusy(true);
    try { if (!view?.index) throw new Error('No list yet: look first.'); open.start(await api.setupFetch(view.index.scan, picked, pw)); setPw(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Not asked.'); }
    setBusy(false);
  };
  const local = Boolean(view?.local) && !remote;
  return (
    <Dialog title="Bring your setup" onClose={onClose} wide testid="setup-sheet">
      <ol class="imp-steps" aria-label="Steps">
        {(['Look on this computer', 'Pick and open', 'Check and copy'] as const).map((t, i) => (
          <li key={t} class={step === i + 1 ? 'on' : ''} aria-current={step === i + 1 ? 'step' : undefined}>{i + 1} {t}</li>
        ))}
      </ol>
      {err && <div class="plg-err small" role="alert" data-testid="setup-error">{label(err, 300)}</div>}
      {!view && !err && <div class="side-note"><Spinner size={12} /> Loading…</div>}
      {view && step === 1 && (
        <div class="imp-step" data-testid="setup-step-look">
          <p>
            Items of your <b>Claude Code</b> setup (<code>~/.claude</code>) and <b>claude-bedrock</b>'s (<code>~/.claude-bedrock</code>) on the computer running bedrock-now, and your
            <b> Git name and email</b> (<code>~/.gitconfig</code>), copied into the sandbox — each one your choice: CLAUDE.md, skills, agents, commands, output styles, key bindings,
            settings.json's permissions, status line, output style and hooks, MCP servers{host ? <> (with <b>{label(host.name, 60)}</b>'s own)</> : null}, and plugins (installed again from their marketplace).
          </p>
          <p class="small">
            The update helper on the computer asks you there first, in a dialog on its screen — <b>Allow once</b>, or <b>Always</b> — then lists names and sizes only. You open the
            ones you pick next, and see each one before anything is copied. <b>Never read</b>: env in settings, logins and credentials, your account, <code>~/.ssh</code>,
            <code> ~/.aws</code>, Git's credential helpers. Nothing is ever written back to the computer.
          </p>
          <p class="small muted">
            Every definition you bring goes into each request on Bedrock (billed per token): the sandbox starts lean, as <code>claude-bedrock</code> does — bring only what you use.
          </p>
          {view.index && (
            <p class="small muted" data-testid="setup-last-look">
              Last look: {ago(view.index.at)} — {view.index.rows.length} item{view.index.rows.length === 1 ? '' : 's'} (allowed {view.index.consent === 'always' ? 'always' : 'once'}).{' '}
              <button type="button" class="linkish" onClick={() => setStep(2)} data-testid="setup-use-last">Use this list</button>
            </p>
          )}
          {!local ? (
            <p class="small warn-text" data-testid="setup-remote">
              Only on the computer running bedrock-now: your setup is read there, in a dialog on its screen. From here you can see the list of a look made there, and check
              and copy what was opened there.
            </p>
          ) : !helperOk ? (
            <div class="small" data-testid="setup-no-helper">
              The update helper is not running on the computer (<code>./stack helper install</code>), or is older than this page. In a terminal there:
              <Cmd text={CMD} testid="setup-cmd" />
            </div>
          ) : (
            <div class="imp-ask">
              <label class="small">
                From{' '}
                <select value={tool} onChange={(e) => setTool((e.currentTarget as HTMLSelectElement).value as SetupTool | 'all')} data-testid="setup-tool">
                  <option value="all">Claude Code, claude-bedrock and Git</option>
                  <option value="claude">Claude Code only</option>
                  <option value="claude-bedrock">claude-bedrock only</option>
                  <option value="git">Git name and email only</option>
                </select>
              </label>
              <Password value={pw} onInput={setPw} testid="setup-password" />
              <button type="button" class="btn primary" disabled={busy || !pw || (look.req !== null && Boolean(STATE[look.req.state]))} onClick={() => void ask()} data-testid="setup-look">
                {busy ? <Spinner size={12} /> : <Icon name="monitor" size={14} />} Look on this computer
              </button>
            </div>
          )}
          <RequestLine req={look.req} why={SETUP_WHY} cmd="./stack sessions config" testid="setup-request" />
          {local && helperOk && <p class="muted small">Or in a terminal there: <Cmd text={CMD} testid="setup-cmd" /></p>}
        </div>
      )}
      {view && step === 2 && <PickStep view={view} picked={picked} setPicked={setPicked} projects={projects} />}
      {view && step === 2 && view.index && (
        <div class="imp-ask">
          {!view.index.fetchable ? (
            <span class="small warn-text" data-testid="setup-stale">That look was allowed once, more than an hour ago: look again to open items of it.</span>
          ) : !local ? (
            <span class="small warn-text" data-testid="setup-remote-open">Opening items is done on the computer running bedrock-now only.</span>
          ) : !helperOk ? (
            <span class="small">The update helper is not running on the computer: in a terminal there, <Cmd text={CMD} testid="setup-cmd-2" /></span>
          ) : (
            <>
              <Password value={pw} onInput={setPw} testid="setup-password-2" />
              <button type="button" class="btn primary" disabled={busy || !pw || !picked.length || (open.req !== null && Boolean(STATE[open.req.state]))} onClick={() => void openPicked()}
                data-testid="setup-open">
                {busy ? <Spinner size={12} /> : null} Open {picked.length || ''} item{picked.length === 1 ? '' : 's'} to check {picked.length === 1 ? 'it' : 'them'}
              </button>
            </>
          )}
          <RequestLine req={open.req} why={SETUP_WHY} cmd="./stack sessions config" testid="setup-request-2" />
        </div>
      )}
      {view && step === 3 && <CheckStep view={view} onChanged={() => void load(3)} />}
      <div class="dlg-actions">
        {step > 1 && <button type="button" class="btn" onClick={() => setStep(step === 3 ? 2 : 1)} data-testid="setup-back">Back</button>}
        {step === 2 && view?.staged.length ? <button type="button" class="btn" onClick={() => setStep(3)} data-testid="setup-to-check">Check the {view.staged.length} opened</button> : null}
        <button type="button" class="btn" onClick={onClose}>Close</button>
      </div>
    </Dialog>
  );
}

/** Step 2: the items of the last look, by tool and kind, to tick and open. */
function PickStep({ view, picked, setPicked, projects }: { view: SetupView; picked: number[]; setPicked: (v: number[]) => void; projects: { id: string; name: string }[] }) {
  const rows = view.index?.rows ?? [];
  const [needle, setNeedle] = useState('');
  const q = needle.trim().toLowerCase();
  const shown = useMemo(() => rows.filter((r) => !q || r.name.toLowerCase().includes(q)), [rows, q]);
  const toggle = (n: number, on: boolean) => setPicked(on ? [...new Set([...picked, n])].slice(0, 100) : picked.filter((x) => x !== n));
  if (!view.index) return <div class="side-note" data-testid="setup-step-pick">No list yet: look on this computer first.</div>;
  const ix = view.index;
  const localOf = ix.project ? projects.find((p) => p.id === ix.project)?.name ?? null : null;
  const tools: SetupTool[] = (['claude', 'claude-bedrock', 'git'] as SetupTool[]).filter((t) => shown.some((r) => r.tool === t) || ix.counts[t]);
  return (
    <div class="imp-step" data-testid="setup-step-pick">
      <div class="imp-filter">
        <input type="search" placeholder="Search names" value={needle} onInput={(e) => setNeedle((e.currentTarget as HTMLInputElement).value)} aria-label="Search names" data-testid="setup-search" />
        <span class="muted small">{picked.length} picked (at most 100 at once)</span>
      </div>
      {!rows.length && <div class="side-note" data-testid="setup-none">Nothing of your setup to bring.</div>}
      <div class="setup-groups" data-testid="setup-rows">
        {tools.map((t) => (
          <section key={t} class="setup-tool" data-tool={t}>
            <h4 class="setup-tool-head">{SETUP_TOOL_LABEL[t]}</h4>
            {KINDS.filter((k) => shown.some((r) => r.tool === t && r.kind === k)).map((k) => (
              <div key={k} class="setup-kind">
                <div class="setup-kind-head small muted">{KIND_LABEL[k]}</div>
                <ul class="imp-rows setup-rows">
                  {shown.filter((r) => r.tool === t && r.kind === k).slice(0, 500).map((r) => <PickRow key={r.n} r={r} picked={picked.includes(r.n)} onPick={(on) => toggle(r.n, on)} localOf={localOf} />)}
                </ul>
                {shown.filter((r) => r.tool === t && r.kind === k).length > 500 && (
                  <div class="muted small" data-testid="setup-more">{shown.filter((r) => r.tool === t && r.kind === k).length - 500} more: narrow them with the search.</div>
                )}
              </div>
            ))}
            <LeftOut counts={ix.counts[t]} tool={t} />
          </section>
        ))}
      </div>
    </div>
  );
}
function LeftOut({ counts, tool }: { counts: SetupCounts | undefined; tool: SetupTool }) {
  if (!counts) return null;
  const parts = [
    counts.settingsOther ? `${counts.settingsOther} other key${counts.settingsOther === 1 ? '' : 's'} of settings.json (env among them: never offered)` : '',
    counts.mcpOther ? `${counts.mcpOther} MCP server${counts.mcpOther === 1 ? '' : 's'} of another shape or name` : '',
    counts.pluginsOther ? `${counts.pluginsOther} plugin${counts.pluginsOther === 1 ? '' : 's'} of a project or another scope` : '',
    counts.links ? `${counts.links} link${counts.links === 1 ? '' : 's'} (never followed)` : '',
    counts.left ? `${counts.left} other file${counts.left === 1 ? '' : 's'} or folder${counts.left === 1 ? '' : 's'} not offered` : '',
  ].filter(Boolean);
  if (!parts.length) return null;
  return <div class="muted small" data-testid="setup-left-out" data-tool={tool}>Left out: {parts.join('; ')}.</div>;
}
function PickRow({ r, picked, onPick, localOf }: { r: SetupRow; picked: boolean; onPick: (on: boolean) => void; localOf: string | null }) {
  const meta: string[] = [];
  if (r.kind === 'memory') meta.push(`${bytes(r.size)} · about ${Math.ceil(r.size / 4).toLocaleString('en')} tokens in every request`);
  else if (r.kind === 'skill') meta.push(`${r.files ?? 0} file${r.files === 1 ? '' : 's'}, ${bytes(r.size)}${r.programs ? ` · ${r.programs} program${r.programs === 1 ? '' : 's'}` : ''}${r.skipped ? ` · ${r.skipped} left behind` : ''}`);
  else if (r.kind === 'setting') meta.push(SETTING_WHAT[r.name] ?? '');
  else if (r.kind === 'mcp') meta.push(`${r.transport ?? 'stdio'}${r.scope === 'local' ? ` · local scope${localOf ? ` of ${label(localOf, 60)}` : ''}` : ''}`);
  else if (r.kind === 'plugin') meta.push(`from ${r.source === 'github' || r.source === 'git' || r.source === 'url' ? `its marketplace (${r.source})` : r.source === 'directory' ? 'a folder of your computer: not offered' : 'a marketplace the sandbox cannot add'}${r.enabled === false ? ' · off' : ''}`);
  else if (r.kind === 'identity') meta.push([r.has?.name && 'user.name', r.has?.email && 'user.email'].filter(Boolean).join(', '));
  else meta.push(bytes(r.size));
  if (r.copied) meta.push('copied before');
  if (r.tooLarge) meta.push('too large to copy');
  const name = r.kind === 'command' ? `/${r.name.replace(/\//g, ':')}` : r.name;
  return (
    <li class={`imp-row${r.tooLarge ? ' off' : ''}`} data-testid="setup-row" data-kind={r.kind} data-n={r.n}>
      <label>
        <input type="checkbox" checked={picked} disabled={r.tooLarge} onChange={(e) => onPick((e.currentTarget as HTMLInputElement).checked)} data-testid="setup-pick" />
        <span class="imp-badge" title={`${SETUP_TOOL_LABEL[r.tool]} on this computer`}>{BADGE[r.tool]}</span>
        <span class="imp-title">{name}</span>
        <span class="imp-meta muted small">{meta.filter(Boolean).join(' · ')}</span>
      </label>
    </li>
  );
}

// the units of what waits: one item each, the settings of one tool together (one settings.json is written)
function unitsOf(staged: SetupView['staged']): string[][] {
  const out: string[][] = [];
  const settings = new Map<string, string[]>();
  for (const s of staged) {
    if (s.kind === 'setting') { if (!settings.has(s.tool)) { const l: string[] = []; settings.set(s.tool, l); out.push(l); } settings.get(s.tool)?.push(s.key); } else out.push([s.key]);
  }
  return out;
}
type Choice = { skip: boolean; mode: 'replace' | 'append'; conflict: 'leave' | 'replace'; keep: string[] };
const FRESH: Choice = { skip: false, mode: 'replace', conflict: 'leave', keep: [] };
const TERMINAL = ['done', 'refused', 'cancelled', 'failed'];
async function follow(id: string) {
  for (let n = 0; n < 400; n++) {
    await new Promise((r) => setTimeout(r, n < 10 ? 700 : 1500));
    let r = null;
    try { r = await api.setupRequestState(id); } catch { /* next time */ }
    if (r && TERMINAL.includes(r.state)) return r;
  }
  return null;
}

/** Step 3: each unit opened — what copying it will do — and Copy into the sandbox. A choice holds for the unit as it was
 *  checked: when what it depends on changes, it is checked again. */
function CheckStep({ view, onChanged }: { view: SetupView; onChanged: () => void }) {
  const units = useMemo(() => unitsOf(view.staged), [view.staged]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [previews, setPreviews] = useState<Record<string, SetupPreview | null>>({});
  const [results, setResults] = useState<SetupResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState('');
  const [phase, setPhase] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SetupResult | null>(null);
  const idOf = (keys: string[]) => keys.join('+');
  const ch = (keys: string[]) => choices[idOf(keys)] ?? FRESH;
  const set = (keys: string[], v: Partial<Choice>) => setChoices((c) => ({ ...c, [idOf(keys)]: { ...(c[idOf(keys)] ?? FRESH), ...v } }));
  // (a unit refused as it is — or an MCP server whose URL or arguments hold a secret not kept — is not sent)
  const copyable = (k: string[]) => { const p = previews[idOf(k)]; return Boolean(p) && (!p?.blocked || Boolean(p.needsKeep?.length && p.needsKeep.every((id) => ch(k).keep.includes(id)))); };
  const todo = units.filter((k) => !ch(k).skip && copyable(k));
  const kept = todo.filter((k) => ch(k).keep.length > 0);
  const every = todo.reduce((n, k) => n + (previews[idOf(k)]?.tokens.every ?? 0), 0);
  const unknown = todo.some((k) => previews[idOf(k)]?.tokens.unknown);
  const go = async () => {
    setBusy(true);
    const out: SetupResult[] = [];
    try {
      // (nothing kept: here, at once; some kept: through the portal and the helper, with the password, one at a time)
      const plain = todo.filter((k) => !kept.includes(k));
      if (plain.length) out.push(...await api.setupCopy(plain.map((k) => ({ keys: k, mode: ch(k).mode, conflict: ch(k).conflict, digest: previews[idOf(k)]?.digest ?? '' }))));
      for (const k of kept) {
        const pv = previews[idOf(k)];
        setPhase('Copying on the computer, with what you chose to keep…');
        try {
          const req = await api.setupCopyKept({ keys: k, mode: ch(k).mode, conflict: ch(k).conflict, digest: pv?.digest ?? '', keep: ch(k).keep }, pw);
          const r = await follow(req);
          if (r?.results?.length) out.push(...r.results);
          else out.push({ keys: k, ok: false, nothing: false, kind: pv?.kind ?? '', name: pv?.name ?? '', why: (r?.why && SETUP_WHY[r.why]) || 'it did not go through on the computer (./stack sessions config in a terminal there says why)', said: null, trashed: null, confirm: null, pluginId: null });
        } catch (e) {
          out.push({ keys: k, ok: false, nothing: false, kind: pv?.kind ?? '', name: pv?.name ?? '', why: e instanceof Error ? label(e.message, 300) : 'not asked', said: null, trashed: null, confirm: null, pluginId: null });
        }
      }
      setPw('');
      setResults(out);
      setChoices({});
      onChanged();
    } catch (e) {
      toast(`Not copied: ${e instanceof Error ? e.message : 'the copy failed'}`, 'error');
    }
    setPhase(null);
    setBusy(false);
  };
  const accept = async (r: SetupResult) => {
    if (!r.confirm || !r.pluginId) return;
    setBusy(true);
    try {
      const o = await api.pluginAction('install', r.pluginId, { scope: 'user', acceptCommand: r.confirm.sha256 });
      if (o.ok) { toast(`${label(r.pluginId, 100)} installed in the sandbox.`, 'ok'); for (const k of r.keys) await api.setupDrop(k).catch(() => {}); onChanged(); }
      else toast(`Not installed: ${o.message}`, 'error');
    } catch (e) { toast(`Not installed: ${e instanceof Error ? e.message : 'it failed'}`, 'error'); }
    setConfirm(null);
    setBusy(false);
  };
  return (
    <div class="imp-step" data-testid="setup-step-check">
      {results && <Results results={results} onConfirm={setConfirm} />}
      {confirm?.confirm && confirm.pluginId && (
        <ConfirmCommand p={{ action: 'install', id: confirm.pluginId, confirm: confirm.confirm }} busy={busy} onAccept={() => void accept(confirm)} onCancel={() => setConfirm(null)} />
      )}
      {!units.length && !results && <div class="side-note">Nothing opened yet: pick items first.</div>}
      {units.length > 0 && (
        <p class="small" data-testid="setup-tokens">
          {every ? <>About <b>{every.toLocaleString('en')}</b> tokens more in every request{unknown ? ', and the tools of MCP servers (counted once they connect)' : ''}, for what is ticked.</>
            : unknown ? 'MCP servers\' tools go into every request (counted once they connect).' : 'Nothing ticked adds to every request.'}{' '}
          <span class="muted">Billed per token on Bedrock (less when cached): bring only what you use.</span>
        </p>
      )}
      {units.map((k) => (
        <Unit key={idOf(k)} keys={k} staged={view.staged} choice={ch(k)} set={(v) => set(k, v)} onPreview={(p) => setPreviews((x) => ({ ...x, [idOf(k)]: p }))} onDropped={onChanged} />
      ))}
      {units.length > 0 && (
        <>
          {kept.length > 0 && (
            <p class="small warn-text" data-testid="setup-keep-note">
              Keeping a possible secret needs the portal password: the update helper on the computer makes that copy ({kept.length} item{kept.length === 1 ? '' : 's'}).
            </p>
          )}
          <div class="imp-ask">
            {kept.length > 0 && <Password value={pw} onInput={setPw} testid="setup-password-3" />}
            <button type="button" class="btn primary" disabled={busy || !todo.length || (kept.length > 0 && !pw)} onClick={() => void go()} data-testid="setup-copy">
              {busy ? <Spinner size={12} /> : null} Copy {todo.length} into the sandbox
            </button>
          </div>
          {phase && <div class="imp-req small" data-testid="setup-copy-phase"><Spinner size={12} /> {phase}</div>}
          <p class="muted small">
            New sessions start with them (MCP servers and plugins: from the next session; the open one with <b>Restart this session</b>). Copying again later replaces only
            what bedrock-now copied — what the sandbox has of its own is left as it is unless you choose, and then goes to its trash folder (<code>~/.claude/.bedrock-now-trash</code>).
          </p>
        </>
      )}
    </div>
  );
}

function Results({ results, onConfirm }: { results: SetupResult[]; onConfirm: (r: SetupResult) => void }) {
  return (
    <ul class="imp-results" data-testid="setup-results">
      {results.map((r) => (
        <li key={r.keys.join('+')} data-testid="setup-result" data-ok={r.ok ? '1' : '0'}>
          <b>{r.name || r.kind}</b>:{' '}
          {r.ok ? (r.nothing ? `not changed (${r.why || 'the sandbox has it already'})` : `copied${r.trashed ? ` — what was there is in the sandbox's ~/.claude/${r.trashed}` : ''}.`)
            : r.confirm ? (
              <>its marketplace runs a command to install it: <button type="button" class="linkish" onClick={() => onConfirm(r)} data-testid="setup-confirm">read it first</button></>
            ) : (
              <>not copied: {r.why}{r.said && <SandboxSaid words={r.said as SandboxWords} compact />}</>
            )}
        </li>
      ))}
    </ul>
  );
}

function Unit({ keys, staged, choice, set, onPreview, onDropped }: { keys: string[]; staged: SetupView['staged']; choice: Choice; set: (v: Partial<Choice>) => void;
  onPreview: (p: SetupPreview | null) => void; onDropped: () => void }) {
  const [pv, setPv] = useState<SetupPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const first = staged.find((s) => s.key === keys[0]);
  const digests = keys.map((k) => staged.find((s) => s.key === k)?.digest ?? '').join(',');
  useEffect(() => {
    let gone = false;
    setErr(null);
    api.setupPreview(keys, choice.mode, choice.conflict).then((p) => { if (!gone) { setPv(p); onPreview(p); } }, (e) => { if (!gone) { setErr(e instanceof Error ? e.message : 'not read'); onPreview(null); } });
    return () => { gone = true; };
  }, [keys.join('+'), digests, choice.mode, choice.conflict]);
  if (!first) return null;
  const keepOf = (id: string) => choice.keep.includes(id);
  const toggleKeep = (id: string, on: boolean) => set({ keep: on ? [...new Set([...choice.keep, id])] : choice.keep.filter((x) => x !== id) });
  const title = keys.length > 1 ? `settings.json: ${keys.map((k) => staged.find((s) => s.key === k)?.name).filter(Boolean).join(', ')}` : first.kind === 'command' ? `/${first.name.replace(/\//g, ':')}` : first.name;
  const blockedForGood = pv?.blocked && !pv.needsKeep;
  const keyable = pv?.needsKeep && pv.needsKeep.every((id) => keepOf(id));
  return (
    <section class={`imp-staged setup-unit${choice.skip || blockedForGood ? ' off' : ''}`} data-testid="setup-unit" data-kind={first.kind} data-keys={keys.join('+')}>
      <div class="imp-staged-head">
        <label class="small">
          <input type="checkbox" checked={!choice.skip && !blockedForGood} disabled={Boolean(blockedForGood)} onChange={(e) => set({ skip: !(e.currentTarget as HTMLInputElement).checked })} data-testid="setup-include" /> Copy
        </label>
        <span class="imp-badge" title={`${SETUP_TOOL_LABEL[first.tool]} on this computer`}>{BADGE[first.tool]}</span>
        <span class="muted small">{KIND_LABEL[first.kind]}</span>
        <span class="imp-title">{title}</span>
        <button type="button" class="linkish small" onClick={() => void Promise.all(keys.map((k) => api.setupDrop(k))).then(onDropped, () => {})} data-testid="setup-drop">Drop</button>
      </div>
      {err && <div class="plg-err small">{label(err, 300)}</div>}
      {!pv && !err && <div class="side-note small"><Spinner size={12} /> Checking…</div>}
      {pv && (
        <div class="imp-checks">
          {pv.blocked && (
            <div class={`small ${keyable ? 'muted' : 'plg-err'}`} data-testid="setup-blocked">
              <Icon name="alert" size={13} /> {keyable ? 'Copied with the secret you keep (the portal password).' : pv.blocked}
            </div>
          )}
          {first.kind === 'memory' && (
            <div class="small setup-choice" role="radiogroup" aria-label="CLAUDE.md in the sandbox" data-testid="setup-mode">
              <label><input type="radio" checked={choice.mode === 'replace'} onChange={() => set({ mode: 'replace' })} /> Replace the sandbox's CLAUDE.md</label>
              <label><input type="radio" checked={choice.mode === 'append'} onChange={() => set({ mode: 'append' })} data-testid="setup-mode-append" /> Add yours after it</label>
            </div>
          )}
          {pv.conflict && (
            <div class="small setup-conflict" data-testid="setup-conflict">
              <div class="warn-text"><Icon name="alert" size={13} /> {pv.conflict.dest}: {pv.conflict.why}.</div>
              <div class="setup-choice" role="radiogroup" aria-label="What the sandbox has">
                <label><input type="radio" checked={choice.conflict === 'leave'} onChange={() => set({ conflict: 'leave' })} /> Leave the sandbox's as it is</label>
                <label><input type="radio" checked={choice.conflict === 'replace'} onChange={() => set({ conflict: 'replace' })} data-testid="setup-replace" /> Replace it (the sandbox's goes to its trash folder)</label>
              </div>
            </div>
          )}
          {pv.flags.length > 0 && (
            <ul class="setup-flags" data-testid="setup-flags">
              {pv.flags.map((f, i) => (
                <li key={i} class={f.level === 'warn' ? 'warn-text' : ''} data-level={f.level}>
                  <Icon name={f.level === 'warn' ? 'alert' : 'dot'} size={12} /> {f.text}
                  {f.items.length > 0 && <div class="setup-items">{f.items.map((x, j) => <code key={j}>{x}</code>)}</div>}
                </li>
              ))}
            </ul>
          )}
          {pv.secrets.length > 0 && (
            <div data-testid="setup-secrets">
              <div class="small warn-text"><Icon name="alert" size={13} /> {pv.secrets.length === 1 ? '1 value that looks like a secret: left out unless you copy it.' : `${pv.secrets.length} values that look like secrets: each left out unless you copy it.`}</div>
              <ul class="imp-findings">
                {pv.secrets.map((x) => (
                  <li key={x.id} data-testid="setup-secret" data-where={x.where}>
                    <label>
                      <input type="checkbox" checked={keepOf(x.id)} onChange={(e) => toggleKeep(x.id, (e.currentTarget as HTMLInputElement).checked)} data-testid="setup-secret-copy" />{' '}
                      copy into the sandbox (Claude could read it there)
                    </label>{' '}
                    <b>{x.where}</b> <span class="muted">{x.label}</span> <code>{x.preview}</code>
                    {x.drop === 'server' && <span class="muted"> — the server is not copied without it</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pv.findingsTotal > 0 && (
            <div data-testid="setup-findings">
              <div class="small warn-text"><Icon name="alert" size={13} /> {pv.findingsTotal} possible secret{pv.findingsTotal === 1 ? '' : 's'}: redacted unless you keep one.</div>
              <ul class="imp-findings">
                {pv.findings.map((f) => (
                  <li key={f.id} data-testid="setup-finding" data-kind={f.kind}>
                    <label>
                      <input type="checkbox" checked={!keepOf(f.id)} disabled={!f.keepable} onChange={(e) => toggleKeep(f.id, !(e.currentTarget as HTMLInputElement).checked)} data-testid="setup-redact" /> redact
                    </label>{' '}
                    <b>{f.label}</b> {f.file && <span class="muted">in {f.file}</span>} <code>{f.preview}</code>
                    <div class="imp-context small muted">{f.context}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pv.writes.length > 0 && (
            <>
              <button type="button" class="linkish small" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="setup-show">
                {open ? 'Hide what will be written' : 'Show what will be written'}
              </button>
              {open && pv.writes.map((w, i) => <WriteView key={i} w={w} />)}
            </>
          )}
          {pv.action === 'none' && !pv.blocked && !pv.conflict && <div class="small muted" data-testid="setup-nothing">Nothing to copy: the sandbox has it already.</div>}
        </div>
      )}
    </section>
  );
}
/** What a write is, as it will be: text shown as text (safe: controls and direction marks visible), never rendered. */
function WriteView({ w }: { w: SetupWrite }) {
  if (w.type === 'file') {
    return (
      <div class="setup-write" data-testid="setup-write" data-dest={w.dest}>
        <div class="small"><b>~/.claude/{w.dest}</b> in the sandbox{w.replaces ? ' (replacing what is there)' : ' (new)'} — {bytes(w.size)}</div>
        {w.text !== null ? <pre class="setup-text" data-testid="setup-text">{w.text}</pre> : <div class="small muted">Too long to show here (SHA-256 {w.sha256}).</div>}
        {w.before !== null && (
          <details class="small" data-testid="setup-before">
            <summary>Now in the sandbox (the sandbox's own text, shown as text)</summary>
            <pre class="setup-text">{w.before}</pre>
          </details>
        )}
      </div>
    );
  }
  if (w.type === 'dir') {
    return (
      <div class="setup-write" data-testid="setup-write" data-dest={w.dest}>
        <div class="small"><b>~/.claude/{w.dest}/</b> in the sandbox{w.replaces ? ' (replacing the folder there)' : ' (new)'}: {w.files.length} file{w.files.length === 1 ? '' : 's'}</div>
        {w.files.map((f) => (
          <details key={f.path} class="small" data-testid="setup-file">
            <summary><code>{f.path}</code> {bytes(f.size)}{f.exec ? ' · a program' : ''}</summary>
            {f.text !== null ? <pre class="setup-text">{f.text}</pre> : <div class="muted">Too long to show here (SHA-256 {f.sha256}).</div>}
          </details>
        ))}
        {w.before && <div class="small muted">Now in the sandbox's folder: {w.before.slice(0, 20).join(', ')}{w.before.length > 20 ? ' …' : ''}</div>}
      </div>
    );
  }
  if (w.type === 'mcp') {
    return (
      <div class="setup-write" data-testid="setup-write" data-dest={`mcp:${w.name}`}>
        <div class="small">MCP server <b>{w.name}</b> of user scope in the sandbox{w.replaces ? ' (replacing the one there)' : ''} — <code>claude mcp add-json</code>:</div>
        <pre class="setup-text">{safe(JSON.stringify(w.config, null, 2), 40000)}</pre>
      </div>
    );
  }
  if (w.type === 'plugin') {
    return (
      <div class="setup-write small" data-testid="setup-write" data-dest={`plugin:${w.id}`}>
        Installs <b>{w.id}</b> in the sandbox from its marketplace <b>{w.marketplace}</b> (<code>{w.source}</code>{w.addMarketplace ? ', added first' : ''}){w.disable ? ', then turns it off' : ''}.
      </div>
    );
  }
  return (
    <div class="setup-write small" data-testid="setup-write" data-dest="gitconfig">
      The sandbox's <code>~/.gitconfig</code>: <code>user.name = {w.name}</code>, <code>user.email = {w.email}</code>
      {(w.before.name || w.before.email) && <span class="muted"> (now: {[w.before.name, w.before.email].filter(Boolean).join(', ')})</span>}.
    </div>
  );
}
