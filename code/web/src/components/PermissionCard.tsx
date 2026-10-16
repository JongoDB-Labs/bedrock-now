// A permission prompt: the sentence built from tool + input (the SDK's title is empty headless), what exactly would
// run or change, the reason the CLI gave, and Allow once / Always allow (with a preview of the rule it writes) /
// Deny (with an optional message for Claude). Keys 1/2/3 answer while the card has focus, like the CLI.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PermissionReq } from '../types';
import { rulePreview, sentence } from '../permission';
import { compact, lineDiff } from '../diff';
import { label, prettyJson, safe } from '../text';
import { answerPermission } from '../app';
import { DiffLines } from './ToolCard';
import { MarkdownView } from './MarkdownView';
import { Icon } from './icons';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

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
