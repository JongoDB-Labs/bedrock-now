// Model / mode / effort pickers and the cost and context meters. Model names and prices come from bedrock-now
// (/.bn/models), never from the CLI; costs come from bedrock-now's spend logs (/.bn/spend).
import { useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, setModel, setMode, setEffort, activeView, defaultModel, refreshSpend, autoOk, setPrefs, toast } from '../app';
import { COMPAT_INFO, GROUP_TITLE, compatWarning, findModel, hiddenCount, modelSections } from '../models';
import { STARRED_MAX } from '../prefs';
import { meter } from '../spend';
import { percent } from '../budget';
import type { BnModel } from '../types';
import { MODE_INFO, offeredModes, startMode } from '../modes';
import { label, money, perMtok, tokens } from '../text';
import { Dropdown, MenuItem } from './ui';
import { Icon } from './icons';

/** ~30k tokens are written to the prompt cache on a new session or a model switch (measured on Bedrock). */
const CACHE_TOKENS = 30_000;
/** At most this many rows are drawn at once (OpenRouter can bring hundreds): the search narrows the rest. */
const SHOWN_MAX = 250;

export function currentModel(models: BnModel[], current: string): BnModel | undefined {
  return findModel(models, current);
}

/** bedrock-now's name for a model the session reports, or '' (never the reported string itself). */
export function modelLabel(models: BnModel[] | undefined, reported: string): string {
  return (models && currentModel(models, reported)?.name) || '';
}

/** A model's price as the picker shows it: "free" ($0, never spend), "$0.72 / $0.72", or nothing when unknown. */
export function priceHint(m: BnModel): string | undefined {
  if (m.free) return 'free';
  return m.input !== null && m.output !== null ? `${perMtok(m.input)} / ${perMtok(m.output)}` : undefined;
}

/** Switch to a model, and say what to expect from one that does not simply work as Claude Code's model. */
function pick(m: BnModel): void {
  void setModel(m.id).then((ok) => {   // by its full id: Claude Code runs exactly this model (an alias may let it run another)
    const w = ok ? compatWarning(m) : null;
    if (w) toast(w, m.compat === 'untested' ? 'info' : 'error');
  });
}

export function ModelPicker({ compact }: { compact?: boolean }) {
  const bn = useSel(store, (s) => s.models);
  const err = useSel(store, (s) => s.modelsError);
  const viewModel = useSel(store, (s) => activeView(s)?.model ?? '');
  const prefModel = useSel(store, (s) => defaultModel(s));
  const hasSession = useSel(store, (s) => !!activeView(s));
  const starred = useSel(store, (s) => s.prefs.starred);
  const all = useSel(store, (s) => s.prefs.allModels);
  const signal = useSel(store, (s) => s.modelMenu);
  const [query, setQuery] = useState('');
  const models = bn?.models ?? [];
  // the sandbox reports the session's model (init); only bedrock-now's own names are shown in the page's chrome
  const cur = currentModel(models, viewModel) ?? currentModel(models, prefModel);
  const current = cur?.id ?? '';
  const name = cur?.name ?? (models.length ? 'Choose a model' : 'Model');
  const sections = modelSections(models, { query, starred, all, current });
  const hidden = hiddenCount(models);
  const sub = cur ? priceHint(cur) : undefined;
  let drawn = 0;
  return (
    <Dropdown
      title={`Model: ${name}`}
      class="picker"
      panelClass="model-panel"
      testid="model-picker"
      openSignal={signal}
      focus=".mp-search"
      trigger={
        <>
          <Icon name="model" size={15} />
          <span class="picker-value">{compact ? name.replace(/^Claude /, '') : name}</span>
          {!compact && sub && <span class={`picker-sub${cur?.free ? ' free' : ''}`}>{sub.replace(' / ', '/')}</span>}
          {cur && cur.compat !== 'works' && <span class={`mp-badge tone-${COMPAT_INFO[cur.compat].tone}`}>{COMPAT_INFO[cur.compat].badge}</span>}
          <Icon name="chevronDown" size={13} class="picker-chev" />
        </>
      }
    >
      {(close) => (
        <>
          <div class="panel-head mp-head">
            <span>Model</span>
            {bn?.scope && bn.scope.mode !== 'all' && (
              <span class="mp-scope" data-testid="model-scope">
                {bn.scope.mode === 'anthropic' ? 'Anthropic only' : 'your list'} · Settings › Claude Code
              </span>
            )}
          </div>
          <div class="mp-searchbox">
            <Icon name="search" size={14} />
            <input
              class="mp-search"
              type="search"
              value={query}
              placeholder={`Search ${all ? models.length : models.length - hidden} models: name, provider, free…`}
              aria-label="Search the models"
              autocomplete="off"
              spellcheck={false}
              data-testid="model-search"
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const first = sections[0]?.models[0];
                if (first) {
                  pick(first);
                  setQuery('');
                  close();
                }
              }}
            />
          </div>
          {err && <div class="panel-note err">Models could not be loaded: {err}</div>}
          {sections.map(({ group, models: list }) => (
            <div class="mp-group" key={group} role="group" aria-label={GROUP_TITLE[group]} data-testid={`model-group-${group}`}>
              <div class="mp-group-head">{GROUP_TITLE[group]}</div>
              {list.map((m) => {
                if (drawn >= SHOWN_MAX) return null;
                drawn++;
                const info = COMPAT_INFO[m.compat];
                const star = starred.includes(m.id);
                return (
                  <div class={`mp-row${m.compat === 'fails' ? ' mp-fails' : ''}`} key={m.id}>
                    <MenuItem
                      checked={m.id === current}
                      testid={`model-${m.alias ?? m.id}`}
                      onSelect={() => {
                        pick(m);
                        setQuery('');
                        close();
                      }}
                      hint={priceHint(m)}
                    >
                      <span class="mi-title">
                        {m.name}
                        {m.free && <span class="mp-free" data-testid="free-tag">free</span>}
                        {(m.compat !== 'works' || !isClaude(m)) && (
                          <span class={`mp-badge tone-${info.tone}`} title={info.says} data-testid={`compat-${m.compat}`}>
                            {info.badge}
                          </span>
                        )}
                      </span>
                      <span class="mi-desc">
                        {[m.vendor && m.vendor !== 'Anthropic' ? m.vendor : '', m.provider !== 'Bedrock' ? m.provider : '', m.alias ? m.alias : '', m.id].filter(Boolean).join(' · ')}
                        {m.context ? ` · ${tokens(m.context)} context` : ''}
                        {hasSession && m.id !== current && m.cacheWrite !== null ? ` · switching ≈ ${money((CACHE_TOKENS * m.cacheWrite) / 1e6)}` : ''}
                      </span>
                      {m.compat !== 'works' && m.note && <span class="mi-desc mp-note">{m.note}</span>}
                    </MenuItem>
                    <button
                      type="button"
                      class={`mp-star${star ? ' on' : ''}`}
                      aria-pressed={star}
                      aria-label={star ? `Unstar ${m.name}` : `Star ${m.name}: listed first`}
                      title={star ? 'Starred: listed first (in this browser)' : 'Star: list it first (in this browser)'}
                      data-testid={`star-${m.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleStar(m.id);
                      }}
                    >
                      <Icon name="star" size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
          {drawn >= SHOWN_MAX && <div class="panel-note">More models match: search to narrow the list.</div>}
          {!sections.length && models.length > 0 && <div class="panel-note" data-testid="model-none">No model matches “{label(query, 40)}”.</div>}
          {!models.length && !err && <div class="panel-note">Loading models…</div>}
          {hidden > 0 && (
            <label class="mp-all">
              <input type="checkbox" checked={all} onChange={() => setPrefs((p) => ({ ...p, allModels: !p.allModels }))} data-testid="model-show-all" />
              Show all models ({hidden} more: outside Settings › Claude Code › Models{models.some((m) => m.compat === 'fails') ? ', or failing' : ''})
            </label>
          )}
          <div class="panel-note">
            Prices per million input / output tokens, as bedrock-now bills them; free models cost $0. Claude Code speaks Anthropic's API with tools: other
            providers' models answer through LiteLLM's translation, and tool use, thinking, prompt caching and long contexts vary —{' '}
            <strong>works</strong> means a tool-using turn was checked, <strong>chat only</strong> that it cannot use tools.
            {hasSession
              ? ' Switching mid-session writes the prompt cache again (~30k tokens at the new model’s cache price, where it has one); so does every new session.'
              : ' Every new session first writes ~30k tokens of prompt cache on models that cache.'}
          </div>
        </>
      )}
    </Dropdown>
  );
}

const isClaude = (m: BnModel): boolean => m.vendor === 'Anthropic' && m.provider === 'Bedrock';

/** Star or unstar a model (kept in this browser; starred models come first in the picker). */
export function toggleStar(id: string): void {
  setPrefs((p) => ({ ...p, starred: p.starred.includes(id) ? p.starred.filter((x) => x !== id) : [id, ...p.starred].slice(0, STARRED_MAX) }));
}

/** The permission mode, next to Send as in Claude Code's desktop app: Read only · Plan · Manual · Accept edits · Auto ·
 *  Bypass permissions (Auto and Bypass when Settings allow them). Shift+Tab in the prompt box cycles, Alt+M opens it. */
export function ModePicker({ compact }: { compact?: boolean }) {
  // (no session: the mode the next one starts in — a remembered Auto shows as Manual while Settings do not allow it)
  const mode = useSel(store, (s) => activeView(s)?.mode ?? startMode(s.startWith ?? s.prefs.mode, 'default', autoOk(s)));
  const allowBypass = useSel(store, (s) => s.server?.allowBypass === true);
  const allowAuto = useSel(store, (s) => s.server?.allowAuto === true);
  const signal = useSel(store, (s) => s.modeMenu);
  const info = MODE_INFO[mode] ?? MODE_INFO.default;
  const name = compact && mode === 'bypassPermissions' ? 'Bypass' : info.label;
  return (
    <Dropdown
      title={`Permission mode: ${info.label} (Shift+Tab cycles, Alt+M opens)`}
      class={`picker mode-picker tone-${info.tone}`}
      panelClass="mode-panel"
      testid="mode-picker"
      openSignal={signal}
      trigger={
        <>
          <Icon name={info.icon} size={14} />
          <span class="picker-value">{name}</span>
          {mode === 'bypassPermissions' && <Icon name="alert" size={13} class="mode-warn" />}
          <Icon name="chevronDown" size={13} class="picker-chev" />
        </>
      }
    >
      {(close) => (
        <>
          <div class="panel-head">Permission mode</div>
          {offeredModes(allowBypass, allowAuto).map((m) => {
            const mi = MODE_INFO[m];
            return (
              <MenuItem
                key={m}
                checked={m === mode}
                testid={`mode-${m}`}
                onSelect={() => {
                  close();
                  setMode(m);
                }}
              >
                <span class={`mi-title mode-title tone-${mi.tone}`}>
                  <Icon name={mi.icon} size={13} /> {mi.label}
                </span>
                <span class="mi-desc">{mi.desc}</span>
                <span class="mi-desc mi-runs">{mi.runs}</span>
              </MenuItem>
            );
          })}
          {(!allowAuto || !allowBypass) && (
            <div class="panel-note" data-testid={allowBypass ? 'mode-auto-off' : 'mode-bypass-off'}>
              {!allowAuto && !allowBypass ? 'Auto and Bypass permissions are off' : !allowAuto ? 'Auto is off' : 'Bypass permissions is off'}. Settings › Claude Code turns{' '}
              {!allowAuto && !allowBypass ? 'them' : 'it'} on (from the computer running bedrock-now).
            </div>
          )}
          <div class="panel-note">
            Shift+Tab in the prompt box cycles Manual → Accept edits → Plan{allowBypass ? ' → Bypass' : ''}
            {allowAuto ? ' → Auto' : ''}; Alt+M opens this menu. Read only, Manual, Accept edits{allowAuto ? ' and Auto' : ''} are remembered for new
            sessions; Plan and Bypass permissions are for this session only.
          </div>
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
  const pct = v.budget ? percent(session, v.budget) : 0;
  const level = !v.budget ? '' : pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '';
  const key =
    budget && budget.max !== null
      ? `\nThe key claude-code-terminal: ${money(budget.spend)} of its ${money(budget.max)} budget${budget.resetAt ? ` (resets ${new Date(budget.resetAt).toLocaleDateString()})` : ''}.`
      : '';
  return (
    <button
      type="button"
      class={`meter-btn${level}`}
      title={`Cost from bedrock-now's spend logs (what Bedrock billed). Turns appear a few seconds after they end. Click to refresh.${v.budget ? `\nThis session's budget: ${money(v.budget.usd, 2)}${v.budget.hard ? ', stop on' : ' (warnings only)'} — ⋯ › Budget.` : ''}${key}`}
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
      {v.budget && (
        <span class="meter-budget" data-testid="cost-budget" aria-label={`${Math.round(pct)} % of its ${money(v.budget.usd, 2)} budget`}>
          {' '}
          · {Math.round(pct)}%
        </span>
      )}
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
