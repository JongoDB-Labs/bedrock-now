// Run & test (README "Run & test"): the workspace's tasks — package.json's scripts, the Makefile's targets,
// pyproject.toml's entry points, and .claude/launch.json's dev servers — each with what it runs. Run shows the task in
// full first (like launch.json's Start: the files are the workspace's, which Claude can write too) and runs it through
// a fixed wrapper in a new window of the terminal; "Ask Claude" puts a draft prompt into the prompt box instead. Below,
// the Problems list: each run's exit status, how long it took and the last lines of its output (text from the
// sandbox); a row opens its window in the terminal.
import { useEffect, useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, askClaudeToRun, confirmRun, loadLaunch, loadRun, refreshRuns, requestLaunch, requestRun, setDialog, showRunWindow } from '../app';
import { getRunResults } from '../api';
import { duration, failing, lastLines, outcome, outcomeText, plainCommand, plainOutput } from '../run';
import type { RunResult, RunSource, RunTask } from '../types';
import { label, visible } from '../text';
import { Icon, Spinner } from './icons';
import { Dialog, Dropdown } from './ui';

const GROUPS: { source: RunSource; title: string }[] = [
  { source: 'npm', title: 'Scripts' },
  { source: 'make', title: 'Make targets' },
  { source: 'python', title: 'Entry points' },
];

/** The task's own text in one line (the script, the recipe's first line, the entry point). */
function gist(t: RunTask): string {
  const own = t.detail.find((d) => d.name === t.name) ?? t.detail[t.detail.length - 1];
  return own ? visible(own.text).replace(/\s+/g, ' ').trim() : '';
}

function TaskRow({ t, onDone }: { t: RunTask; onDone?: () => void }) {
  return (
    <li class="run-row" data-testid="run-task" data-source={t.source} data-name={t.name}>
      <div class="run-line">
        <span class="launch-name" title={visible(t.name)}>
          {label(t.name, 100)}
        </span>
        {t.error ? (
          <span class="muted small run-why" data-testid="run-why">
            {t.error}
          </span>
        ) : (
          <span class="port-actions">
            <button type="button" class="btn small" onClick={() => (onDone?.(), requestRun(t))} title="Run it in a new window of the terminal — shown in full first" data-testid="run-start">
              <Icon name="play" size={12} /> Run
            </button>
            <button type="button" class="btn small ghost" onClick={() => (onDone?.(), askClaudeToRun(t))} title={`A draft in the prompt box: "Run ${plainCommand(t)} and fix failures." (not sent)`} data-testid="run-ask">
              <Icon name="sparkle" size={12} /> Ask Claude
            </button>
          </span>
        )}
      </div>
      {!t.error && t.command && (
        <code class="run-cmd" title={`${visible(t.command)}\n\n${t.detail.map((d) => `${visible(d.name)}: ${visible(d.text)}`).join('\n')}`} data-testid="run-cmd">
          <span class="run-wrapper">{t.source === 'npm' ? `npm run -- ${t.name}` : t.source === 'make' ? `make -- ${t.name}` : `python3 … ${t.name}`}</span>
          <span class="run-gist"> → {gist(t) || '(empty)'}</span>
        </code>
      )}
    </li>
  );
}

function ProblemRow({ r, onDone }: { r: RunResult; onDone?: () => void }) {
  const [full, setFull] = useState<{ tail: string; cut: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const o = outcome(r);
  const lines = lastLines(r.tail);
  const when = duration(r);
  return (
    <li class={`problem ${o}`} data-testid="problem" data-outcome={o} data-name={r.name}>
      <button type="button" class="problem-main" onClick={() => (onDone?.(), void showRunWindow(r))} title={`${visible(r.command)} — open its window in the terminal`} disabled={!r.window} data-testid="problem-open">
        <span class="problem-icon">{o === 'running' ? <Spinner size={12} /> : <Icon name={o === 'ok' ? 'check' : 'alert'} size={14} />}</span>
        <span class="problem-name">{label(plainCommand(r), 120)}</span>
        <span class="problem-status" data-testid="problem-status">
          {outcomeText(r)}
        </span>
        {when && <span class="muted small problem-time">{when}</span>}
      </button>
      {lines.length > 0 && !full && (
        <pre class="problem-tail" data-testid="problem-tail">
          {visible(lines.join('\n'))}
        </pre>
      )}
      {full && (
        <pre class="problem-tail full" data-testid="problem-full">
          {full.cut ? '… (the start of its output is not kept: the last 64 KiB are)\n' : ''}
          {visible(plainOutput(full.tail))}
        </pre>
      )}
      {r.state === 'done' && r.tail && (
        <button
          type="button"
          class="btn small ghost problem-more"
          disabled={loading}
          onClick={async () => {
            if (full) return setFull(null);
            setLoading(true);
            try {
              const one = (await getRunResults(r.id))[0];
              setFull(one ? { tail: one.tail, cut: one.cut } : { tail: r.tail, cut: r.cut });
            } catch {
              setFull({ tail: r.tail, cut: r.cut });
            } finally {
              setLoading(false);
            }
          }}
          data-testid="problem-output"
        >
          {full ? 'Less' : 'All output'}
        </button>
      )}
    </li>
  );
}

/** The Problems list: the last runs, newest first (above the tasks once there are any). */
export function Problems({ onDone }: { onDone?: () => void }) {
  const runs = useSel(store, (s) => s.runs);
  const bad = failing(runs);
  return (
    <section class="problems" data-testid="problems">
      <div class="pp-head">
        <strong>Problems</strong>
        <span class="muted small">{runs.length ? (bad ? `${bad} task${bad === 1 ? '' : 's'} failing` : 'nothing failing') : ''}</span>
      </div>
      {runs.length ? (
        <ul class="problem-list">
          {runs.map((r) => (
            <ProblemRow key={r.id} r={r} onDone={onDone} />
          ))}
        </ul>
      ) : (
        <p class="muted small pp-empty">No runs yet: run a task above — its exit status and the end of its output come here.</p>
      )}
    </section>
  );
}

/** The workspace's tasks and the Problems list (the status bar's Run, ⋯ → Run & test, the phone's sheet). */
export function RunPanel({ onDone }: { onDone?: () => void }) {
  const run = useSel(store, (s) => s.run);
  const error = useSel(store, (s) => s.runError);
  const launch = useSel(store, (s) => s.launch);
  useEffect(() => {
    void loadRun();
    void refreshRuns();
    void loadLaunch();
  }, []);
  const anyRuns = useSel(store, (s) => s.runs.length > 0);
  const launchable = launch?.entries.filter((e) => e.argv && e.digest) ?? [];
  const nothing = run && !run.sources.some((x) => x.exists) && !launchable.length;
  return (
    <div class="ports-panel-body run-panel-body" data-testid="run-panel">
      <div class="pp-head">
        <strong>Run & test</strong>
        <button type="button" class="icon-btn" title="Look again" aria-label="Look again" onClick={() => (void loadRun(), void refreshRuns(), void loadLaunch())}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {anyRuns && <Problems onDone={onDone} />}
      {error && <div class="banner warn small">Could not list the tasks: {label(error, 200)}</div>}
      {run === null && !error && (
        <p class="muted small">
          <Spinner size={11} /> Reading the workspace…
        </p>
      )}
      {run &&
        GROUPS.map(({ source, title }) => {
          const info = run.sources.find((x) => x.source === source);
          const tasks = run.tasks.filter((t) => t.source === source);
          if (!info?.exists && !tasks.length) return null;
          return (
            <section key={source} class="run-group" data-testid={`run-group-${source}`}>
              <h4>
                {title} <span class="muted small">{info?.file}</span>
              </h4>
              {info?.error && <p class="muted small">It cannot be used: {info.error}</p>}
              {tasks.length ? (
                <ul class="run-list">
                  {tasks.map((t, i) => (
                    <TaskRow key={`${t.name}-${i}`} t={t} onDone={onDone} />
                  ))}
                </ul>
              ) : (
                !info?.error && <p class="muted small">None.</p>
              )}
              {info?.more && <p class="muted small">Only the first 100 are listed.</p>}
            </section>
          );
        })}
      {launchable.length > 0 && (
        <section class="run-group" data-testid="run-group-launch">
          <h4>
            Dev servers <span class="muted small">.claude/launch.json</span>
          </h4>
          <ul class="run-list">
            {launchable.map((e, i) => (
              <li key={`${e.name}-${i}`} class="run-row" data-testid="run-launch">
                <div class="run-line">
                  <span class="launch-name">{label(e.name, 100)}</span>
                  <span class="port-actions">
                    <button type="button" class="btn small" onClick={() => (onDone?.(), requestLaunch(e))} title="Start it in a new window of the terminal, with PORT set — shown in full first">
                      <Icon name="play" size={12} /> Start
                    </button>
                  </span>
                </div>
                <code class="run-cmd">{label(e.command ?? '', 200)}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {nothing && (
        <p class="muted small pp-empty" data-testid="run-none">
          No package.json, Makefile, pyproject.toml or .claude/launch.json in the workspace's top folder.
        </p>
      )}
      {!anyRuns && <Problems onDone={onDone} />}
    </div>
  );
}

/** "Run ▸" in the status bar: a spinner while a task runs, the count of tasks whose last run failed. */
export function RunStatus() {
  const busy = useSel(store, (s) => s.runs.some((r) => r.state === 'running'));
  const bad = useSel(store, (s) => failing(s.runs));
  return (
    <Dropdown
      title="Run & test: the workspace's scripts, make targets and entry points, and the Problems list"
      class="sb-ports sb-run"
      panelClass="ports-panel run-panel"
      align="right"
      testid="run-status"
      trigger={
        <>
          <Icon name="play" size={12} /> Run
          {busy && <Spinner size={10} />}
          {bad > 0 && (
            <span class="sb-bad" data-testid="run-failing">
              <Icon name="alert" size={11} /> {bad}
            </span>
          )}
        </>
      }
    >
      {(close) => <RunPanel onDone={close} />}
    </Dropdown>
  );
}

/** Run's confirmation: exactly what will run — the wrapper's program and each argument, the folder, the texts that
 *  decide what it does (the script with npm's pre/post scripts, the recipe, the entry point), the files it is bound
 *  to, and warnings. The task comes from the workspace's files, which anything in the sandbox can write; Run sends
 *  the task's digest, so a file changed after this is refused. */
export function RunConfirm({ task }: { task: RunTask }) {
  const file = useSel(store, (s) => s.run?.sources.find((x) => x.source === task.source)?.file) ?? (task.source === 'npm' ? 'package.json' : task.source === 'make' ? 'Makefile' : 'pyproject.toml');
  const close = () => setDialog(null);
  return (
    <Dialog title={`Run "${label(task.name, 80)}"?`} onClose={close} wide testid="run-confirm">
      <p>
        From the workspace's <code>{file}</code>, which anything in the sandbox (Claude too) can write. It runs in the sandbox, in a new window of the
        terminal, without input — check that it is what you expect:
      </p>
      <h3>Program and arguments</h3>
      <ol class="launch-argv" data-testid="run-argv">
        {(task.argv ?? []).map((a, i) => (
          <li key={i}>
            <code>{visible(a) || '(empty)'}</code>
            {task.source === 'python' && i === 3 && (
              <span class="muted small">
                {' '}
                — bedrock-now's loader: it imports the module from the workspace (its code is the workspace's, which anything in the sandbox can change) and
                calls the function, as the script pip installs for it would
              </span>
            )}
            {task.source === 'npm' && i === 1 && <span class="muted small"> — the image's own npm, run by the image's own node</span>}
          </li>
        ))}
      </ol>
      <h3>Folder</h3>
      <p>
        <code class="launch-cwd">/workspace</code>
      </p>
      <h3>{task.source === 'npm' ? 'What npm runs' : task.source === 'make' ? 'Its recipe' : 'The entry point'}</h3>
      {task.detail.map((d, i) => (
        <div key={i} class="run-detail">
          <div class="muted small">{visible(d.name)}</div>
          <pre data-testid="run-detail">{visible(d.text) || '(empty)'}</pre>
        </div>
      ))}
      {task.source === 'npm' && task.detail.length > 1 && <p class="muted small">npm runs the pre… and post… scripts around it by itself.</p>}
      {task.source === 'npm' && <p class="muted small">The script runs in npm's shell, with the workspace's node_modules/.bin first on PATH: the programs it names are the workspace's to change.</p>}
      <p class="muted small" data-testid="run-env">
        Its environment: only the sandbox's HOME, USER, LANG and the like, and its PATH with the image's own folders first (a program of the same name in
        ~/.local/bin comes after the image's); npm reads neither your npmrc nor the global one; nothing of the terminal's other variables. What you see
        here is checked again when you click Run — not while the program runs: it reads its files then.
      </p>
      {task.files.length > 0 && (
        <p class="muted small" data-testid="run-files">
          Bound to {task.files.map((f) => `${f.path} (SHA-256 ${f.sha256.slice(0, 12)}…)`).join(', ')}: a change there asks again.
        </p>
      )}
      {task.notes.length > 0 && (
        <div class="banner warn small" data-testid="run-notes">
          {task.notes.map((n, i) => (
            <div key={i}>
              <Icon name="alert" size={13} /> {visible(n)}
            </div>
          ))}
        </div>
      )}
      <p class="muted small">Its exit status and the last 64 KiB of its output go to the Problems list; Ctrl-C in its window stops it.</p>
      <div class="dlg-buttons">
        <button type="button" class="btn" onClick={close}>
          Cancel
        </button>
        <button type="button" class="btn" onClick={() => (close(), askClaudeToRun(task))} data-testid="run-confirm-ask">
          Ask Claude instead
        </button>
        <button type="button" class="btn primary" onClick={confirmRun} data-testid="run-confirm-run">
          <Icon name="play" size={13} /> Run it
        </button>
      </div>
    </Dialog>
  );
}
