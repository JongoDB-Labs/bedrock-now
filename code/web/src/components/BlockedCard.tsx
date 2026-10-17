// A call Claude Code denied without asking you — above all one Auto mode's reviewer model blocked: what was blocked,
// the rule it matched ("[Data Exfiltration]", shown as a tag) or why it could not decide, and "Allow once" (the backend
// asks Claude to run it again and lets exactly that call through, once, without the reviewer; your deny rules still
// apply). Blocks by a deny rule or by Read only are shown too, with nothing to allow. Every string came from the
// sandbox: shown as text only.
import { useState } from 'preact/hooks';
import type { Mode } from '../types';
import { allowBlocked } from '../app';
import { ruleOf, sentence } from '../permission';
import { label, prettyJson, safe } from '../text';
import { PERMISSION_SHOWN_CHARS } from '../api';
import { Icon, Spinner } from './icons';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

export interface BlockedItem {
  tool: string;
  by: string;
  reason: string;
  text: string;
  input: unknown;
  allowId: string | null;
}


const BY: Record<string, string> = {
  classifier: 'Auto mode blocked this',
  rule: 'A deny rule blocked this',
  mode: 'Not allowed in this mode',
};

export function BlockedCard({ session, it, mode }: { session: string; it: BlockedItem; mode: Mode | null }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState('');
  const [why, setWhy] = useState(false);
  const auto = it.by === 'classifier';
  const rule = auto ? ruleOf(it.reason) : null;
  const what = sentence(it.tool, it.input);
  const i = obj(it.input);
  const command = it.tool === 'Bash' && typeof i.command === 'string' ? i.command : null;
  const allow = async () => {
    setState('busy');
    setError('');
    const e = await allowBlocked(session, it.allowId!);
    if (e) {
      setState('idle');
      setError(e);
    } else setState('done');
  };
  return (
    <div class={`blocked${auto ? ' blocked-auto' : ''}`} role="group" aria-label={BY[it.by] ?? 'Not allowed'} data-testid="blocked-card">
      <div class="blocked-head">
        <Icon name={auto ? 'sparkle' : 'shield'} size={15} />
        <span class="blocked-title">{BY[it.by] ?? 'Not allowed'}</span>
        {rule ? (
          <span class="tag blocked-rule" title="The rule Auto mode's reviewer matched" data-testid="blocked-rule">
            {rule}
          </span>
        ) : null}
        <span class="blocked-tool muted">{label(it.tool, 100)}</span>
      </div>
      {command !== null ? (
        <pre class="cmd blocked-cmd" data-testid="blocked-command">
          <span class="prompt">$ </span>
          {safe(command, 20_000)}
        </pre>
      ) : (
        <>
          {what.subject && <div class="perm-subject">{what.subject}</div>}
          {it.input !== null && what.detail !== 'none' && <pre class="json blocked-json">{prettyJson(it.input, PERMISSION_SHOWN_CHARS)}</pre>}
        </>
      )}
      {auto && !rule && it.reason && <div class="perm-reason" data-testid="blocked-reason">{label(it.reason, 500)}</div>}
      <p class="blocked-lede">
        {auto
          ? 'The reviewer model judged it risky, so it did not run. Claude was told why and may try another way.'
          : 'It did not run, and Claude was told why.'}
        {auto && it.allowId ? ' Allow once runs exactly this, once, without the reviewer — your deny rules still apply.' : ''}
      </p>
      {error && (
        <div class="perm-warn perm-partial" role="alert" data-testid="blocked-error">
          <Icon name="alert" size={14} /> {error}
        </div>
      )}
      <div class="perm-buttons blocked-buttons">
        <button type="button" class="linkish" aria-expanded={why} onClick={() => setWhy(!why)} data-testid="blocked-why">
          {why ? 'Hide what Claude was told' : 'What Claude was told'}
        </button>
        {it.allowId &&
          (state === 'done' ? (
            <span class="watch-done" data-testid="blocked-allowed">
              Allowed once — Claude runs it again
            </span>
          ) : (
            <button
              type="button"
              class="btn"
              disabled={state === 'busy' || mode !== 'auto'}
              title={mode !== 'auto' ? 'Only while the session is in Auto mode (in Manual, Claude asks you before running it)' : ''}
              onClick={() => void allow()}
              data-testid="blocked-allow"
            >
              {state === 'busy' ? <Spinner size={12} /> : <Icon name="check" size={13} />} Allow once
            </button>
          ))}
      </div>
      {why && <div class="blocked-told muted small">{label(it.text, 2000)}</div>}
    </div>
  );
}
