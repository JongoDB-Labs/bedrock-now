// Model / mode / effort pickers and the cost and context meters. Model names and prices come from bedrock-now
// (/.bn/models), never from the CLI; costs come from bedrock-now's spend logs (/.bn/spend).
import { useSel } from '../store';
import { store, setModel, setMode, setEffort, activeView, defaultModel, refreshSpend } from '../app';
import { meter } from '../spend';
import { MODES, type BnModel, type Mode } from '../types';
import { modeName } from '../permission';
import { money, perMtok, tokens } from '../text';
import { Dropdown, MenuItem } from './ui';
import { Icon } from './icons';

const MODE_INFO: Record<Mode, string> = {
  default: 'Asks before commands and file edits',
  acceptEdits: 'Edits files without asking; asks before commands',
  plan: 'Reads and plans; changes nothing until you approve the plan',
  dontAsk: 'Never asks: anything not already allowed is denied',
};

/** ~30k tokens are written to the prompt cache on a new session or a model switch (measured on Bedrock). */
const CACHE_TOKENS = 30_000;

function matches(m: BnModel, current: string): boolean {
  return !!current && (m.id === current || m.alias === current || current.startsWith(m.id));
}

export function currentModel(models: BnModel[], current: string): BnModel | undefined {
  return models.find((m) => matches(m, current));
}

/** bedrock-now's name for a model the session reports, or '' (never the reported string itself). */
export function modelLabel(models: BnModel[] | undefined, reported: string): string {
  return (models && currentModel(models, reported)?.name) || '';
}

export function ModelPicker({ compact }: { compact?: boolean }) {
  const bn = useSel(store, (s) => s.models);
  const err = useSel(store, (s) => s.modelsError);
  const viewModel = useSel(store, (s) => activeView(s)?.model ?? '');
  const prefModel = useSel(store, (s) => defaultModel(s));
  const hasSession = useSel(store, (s) => !!activeView(s));
  const models = bn?.models ?? [];
  // the sandbox reports the session's model (init); only bedrock-now's own names are shown in the page's chrome
  const cur = currentModel(models, viewModel) ?? currentModel(models, prefModel);
  const current = cur ? (cur.alias ?? cur.id) : '';
  const name = cur?.name ?? (models.length ? 'Choose a model' : 'Model');
  return (
    <Dropdown
      title="Model"
      class="picker"
      panelClass="model-panel"
      testid="model-picker"
      trigger={
        <>
          <Icon name="model" size={15} />
          <span class="picker-value">{compact ? name.replace(/^Claude /, '') : name}</span>
          {!compact && cur && cur.input !== null && (
            <span class="picker-sub">
              {perMtok(cur.input)}/{perMtok(cur.output)}
            </span>
          )}
          <Icon name="chevronDown" size={13} class="picker-chev" />
        </>
      }
    >
      {(close) => (
        <>
          <div class="panel-head">Model</div>
          {err && <div class="panel-note err">Models could not be loaded: {err}</div>}
          {models.map((m) => (
            <MenuItem
              key={m.id}
              checked={matches(m, current)}
              testid={`model-${m.alias ?? m.id}`}
              onSelect={() => {
                setModel(m.alias ?? m.id);
                close();
              }}
              hint={m.input !== null ? `${perMtok(m.input)} / ${perMtok(m.output)}` : undefined}
            >
              <span class="mi-title">{m.name}</span>
              <span class="mi-desc">
                {m.alias ? `${m.alias} · ` : ''}
                {m.id}
                {hasSession && !matches(m, current) && m.cacheWrite !== null ? ` · switching ≈ ${money((CACHE_TOKENS * m.cacheWrite) / 1e6)}` : ''}
              </span>
            </MenuItem>
          ))}
          {!models.length && !err && <div class="panel-note">Loading models…</div>}
          <div class="panel-note">
            Prices per million input / output tokens, as bedrock-now bills them.
            {hasSession
              ? ' Switching mid-session writes the prompt cache again (~30k tokens at the new model’s cache price); so does every new session.'
              : ' Every new session first writes ~30k tokens of prompt cache.'}
          </div>
        </>
      )}
    </Dropdown>
  );
}

export function ModePicker({ compact }: { compact?: boolean }) {
  const mode = useSel(store, (s) => activeView(s)?.mode ?? s.prefs.mode);
  return (
    <Dropdown
      title="Permission mode (Shift+Tab)"
      class={`picker mode-${mode}`}
      testid="mode-picker"
      trigger={
        <>
          <Icon name="shield" size={15} />
          <span class="picker-value">{compact ? modeName(mode) : `${modeName(mode)}`}</span>
          <Icon name="chevronDown" size={13} class="picker-chev" />
        </>
      }
    >
      {(close) => (
        <>
          <div class="panel-head">Permission mode</div>
          {MODES.map((m) => (
            <MenuItem
              key={m}
              checked={m === mode}
              testid={`mode-${m}`}
              onSelect={() => {
                setMode(m);
                close();
              }}
            >
              <span class="mi-title">{modeName(m)}</span>
              <span class="mi-desc">{MODE_INFO[m]}</span>
            </MenuItem>
          ))}
          <div class="panel-note">Shift+Tab in the prompt box cycles modes. Bypass and auto modes are not offered here.</div>
        </>
      )}
    </Dropdown>
  );
}

export function EffortPicker() {
  const v = useSel(store, (s) => activeView(s));
  const prefEffort = useSel(store, (s) => s.prefs.effort);
  const model = v?.model ?? '';
  const cli = v?.cliModels ?? [];
  const entry = cli.find((m) => m.value === model || m.resolved === model || (model && (m.resolved.startsWith(model) || model.startsWith(m.value)))) ?? (v?.init ? cli.find((m) => m.resolved === v.init?.model) : undefined);
  const levels = entry?.efforts ?? [];
  const effort = v?.effort ?? prefEffort;
  if (!levels.length) return null;
  return (
    <Dropdown
      title="Reasoning effort"
      class="picker"
      testid="effort-picker"
      trigger={
        <>
          <Icon name="gauge" size={15} />
          <span class="picker-value">{effort ?? 'auto'}</span>
          <Icon name="chevronDown" size={13} class="picker-chev" />
        </>
      }
    >
      {(close) => (
        <>
          <div class="panel-head">Effort</div>
          <MenuItem
            checked={!effort}
            onSelect={() => {
              setEffort(null);
              close();
            }}
          >
            <span class="mi-title">Auto</span>
            <span class="mi-desc">The model's default</span>
          </MenuItem>
          {levels.map((l) => (
            <MenuItem
              key={l}
              checked={effort === l}
              onSelect={() => {
                setEffort(l);
                close();
              }}
            >
              <span class="mi-title">{l}</span>
            </MenuItem>
          ))}
          <div class="panel-note">More effort: more thinking tokens, slower and dearer turns.</div>
        </>
      )}
    </Dropdown>
  );
}

export function CostMeter() {
  const v = useSel(store, (s) => activeView(s));
  const budget = useSel(store, (s) => s.budget);
  if (!v) return null;
  const { turn, session } = meter(v.turns, v.spend);
  const key =
    budget && budget.max !== null
      ? `\nThe key claude-code-terminal: ${money(budget.spend)} of its ${money(budget.max)} budget${budget.resetAt ? ` (resets ${new Date(budget.resetAt).toLocaleDateString()})` : ''}.`
      : '';
  return (
    <button
      type="button"
      class="meter-btn"
      title={`Cost from bedrock-now's spend logs (what Bedrock billed). Turns appear a few seconds after they end. Click to refresh.${key}`}
      onClick={() => void refreshSpend(v.id)}
      data-testid="cost"
    >
      {turn !== undefined && (
        <span class="meter-turn">
          <span class="meter-fig">{money(turn)}</span>
          <span class="meter-label"> turn</span>
          <span class="meter-sep"> · </span>
        </span>
      )}
      <span class="meter-fig">{money(session)}</span>
      <span class="meter-label">session</span>
    </button>
  );
}

export function ContextMeter() {
  const c = useSel(store, (s) => activeView(s)?.context ?? null);
  if (!c) return null;
  const pct = Math.min(100, Math.round((c.used / c.max) * 100));
  const level = pct >= 85 ? 'over' : pct >= 65 ? 'warn' : '';
  return (
    <span class={`ctx ${level}`} title={`Context: ${tokens(c.used)} of ${tokens(c.max)} tokens${c.categories.length ? '\n' + c.categories.map((x) => `${x.name}: ${tokens(x.tokens)}`).join('\n') : ''}\n/compact frees it.`} data-testid="context">
      <span class="ctx-gauge">
        <i
          ref={(el) => {
            if (el) el.style.width = `${pct}%`;
          }}
        />
      </span>
      <span class="ctx-label">{pct}%</span>
    </span>
  );
}
