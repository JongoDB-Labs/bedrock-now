// ⋯ › Permissions: the rules Claude Code applies in the sandbox — what runs without asking (allow), what asks, what is
// refused (deny). The sandbox's own user settings (~/.claude/settings.json: where "Always" on a permission card puts its
// rules) can be taken out one by one here; the workspace's .claude/settings.json and settings.local.json are shown
// only (they are in your folder: Claude Code on your computer follows them too). Then the rules the page's modes add on
// their own. Rules are sandbox data: shown as text, invisible characters made visible.
import { useEffect, useState } from 'preact/hooks';
import * as api from '../api';
import type { PermFile, Permissions } from '../api';
import { toast, currentProject } from '../app';
import { safe } from '../text';
import { Dialog } from './ui';
import { Icon, Spinner } from './icons';

type List = 'allow' | 'ask' | 'deny';
const LISTS: { key: List; title: string; what: string }[] = [
  { key: 'allow', title: 'Allow', what: 'runs without asking' },
  { key: 'ask', title: 'Ask', what: 'always asks first' },
  { key: 'deny', title: 'Deny', what: 'refused' },
];

/** What taking a rule out of a list makes possible (its button's tooltip, and the confirmation for ask and deny:
 *  those loosen what Claude may do; taking out an allow rule only makes Claude ask again). */
export const removeEffect: Record<List, string> = {
  allow: 'Take this rule out: Claude asks again before doing this.',
  ask: 'Take this rule out: Claude may then do this without asking, where an allow rule or the session\'s mode lets it.',
  deny: 'Take this rule out: this is no longer blocked — Claude may then do it (asking first, unless an allow rule or the session\'s mode lets it run).',
};

function Rules({ id, file, removable, onRemove, busy }: { id: string; file: PermFile; removable: boolean; onRemove?: (list: List, rule: string) => void; busy: string }) {
  // an ask or deny rule's Remove asks first, saying what becomes possible
  const [confirming, setConfirming] = useState('');
  if (file.error) return <p class="muted small">{file.path}: {file.error}</p>;
  if (!file.exists) return <p class="muted small">{file.path}: not there (no rules).</p>;
  const empty = !file.allow.length && !file.ask.length && !file.deny.length;
  return (
    <div class="perm-file" data-testid={`perm-file-${id}`}>
      {empty && <p class="muted small">{file.path}: no permission rules.</p>}
      {LISTS.filter((l) => file[l.key].length).map((l) => (
        <div key={l.key} class={`perm-list perm-${l.key}`}>
          <h4>
            {l.title} <span class="muted">— {l.what}</span>
          </h4>
          <ul>
            {file[l.key].map((r, i) => (
              <li key={`${i}:${r}`} data-testid="perm-rule">
                <code class="perm-rule">{safe(r, 4000)}</code>
                {removable && onRemove && (
                  <button
                    type="button"
                    class="btn small ghost"
                    disabled={!!busy}
                    title={removeEffect[l.key]}
                    onClick={() => (l.key === 'allow' ? onRemove(l.key, r) : setConfirming(`${l.key}:${r}`))}
                    data-testid="perm-remove"
                  >
                    {busy === `${l.key}:${r}` ? <Spinner size={11} /> : <Icon name="close" size={12} />} Remove
                  </button>
                )}
                {removable && onRemove && confirming === `${l.key}:${r}` && (
                  <div class="perm-confirm" role="alert" data-testid="perm-remove-confirm">
                    <span>
                      {l.key === 'ask' ? (
                        <>
                          Claude may then <code>{safe(r, 200)}</code> without asking, where an allow rule or the session's mode lets it.
                        </>
                      ) : (
                        <>
                          <code>{safe(r, 200)}</code> is no longer blocked: Claude may then do it — asking first, unless an allow rule or the session's mode lets it run.
                        </>
                      )}
                    </span>
                    <button
                      type="button"
                      class="btn small danger"
                      disabled={!!busy}
                      onClick={() => {
                        setConfirming('');
                        onRemove(l.key, r);
                      }}
                      data-testid="perm-remove-yes"
                    >
                      Remove it
                    </button>
                    <button type="button" class="btn small ghost" onClick={() => setConfirming('')} data-testid="perm-remove-no">
                      Keep it
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {file.other > 0 && <p class="muted small">{file.other} more entries that are not rules (left as they are).</p>}
      {file.truncated && <p class="muted small">Only the first 500 rules of each list are shown.</p>}
      {file.defaultMode && <p class="muted small">Its default mode: {safe(file.defaultMode, 40)} (the Code page picks each session's mode itself).</p>}
      {file.directories.length > 0 && <p class="muted small">More folders Claude may use: {file.directories.map((d) => safe(d, 300)).join(', ')}</p>}
    </div>
  );
}

export function PermissionsDialog({ onClose }: { onClose: () => void }) {
  const [p, setP] = useState<Permissions | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = async () => {
    setError('');
    try {
      setP(await api.getPermissions());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => void load(), []);

  const remove = async (list: List, rule: string) => {
    if (!p?.user.sha256) return;
    setBusy(`${list}:${rule}`);
    try {
      await api.removePermission(list, rule, p.user.sha256);
      toast(`Removed: ${safe(rule, 120)}`, 'ok');
    } catch (e) {
      // changed meanwhile (an "Always" just now, the terminal): the list is read again, nothing was removed
      toast(e instanceof api.ApiError && e.status === 409 ? 'The settings changed meanwhile: here they are again. Nothing was removed.' : `Not removed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setBusy('');
      void load();
    }
  };

  return (
    <Dialog title="Permissions" onClose={onClose} wide testid="permissions-dialog">
      <p class="muted">
        What Claude Code may do in the sandbox without asking, what it asks about first, and what it is refused. Deny wins over ask, ask over allow; the mode you
        pick next to Send decides the rest.
      </p>
      {error && (
        <p class="err" role="alert">
          {error}
        </p>
      )}
      {!p && !error && <Spinner />}
      {p && (
        <>
          <section class="perm-sec">
            <h3>This sandbox — ~/.claude/settings.json</h3>
            <p class="muted small">Where "Always" on a permission card puts its rules. Every Code-page and terminal session in the sandbox follows them.</p>
            <Rules id="user" file={p.user} removable={!!p.user.sha256} onRemove={(l, r) => void remove(l, r)} busy={busy} />
          </section>
          <section class="perm-sec">
            <h3>This project — {currentProject().path}/.claude/settings.json and settings.local.json</h3>
            <p class="muted small">
              In your folder: <strong>Claude Code on your computer honours these too.</strong> Shown here only — change them in the editor or on your computer.
            </p>
            <Rules id="project" file={p.project} removable={false} busy="" />
            <Rules id="local" file={p.local} removable={false} busy="" />
          </section>
          <section class="perm-sec">
            <h3>The Code page's own rules</h3>
            <p class="muted small">
              <strong>Always ask, even in Bypass permissions:</strong> edits of files that run on your computer later.
            </p>
            <ul class="perm-fixed" data-testid="perm-bypass-ask">
              {p.bypassAsk.map((r) => (
                <li key={r}>
                  <code>{r}</code>
                </li>
              ))}
            </ul>
            <p class="muted small">
              <strong>Read only</strong> denies {p.readOnlyDeny.join(', ')}. Commands that change something are refused there too (Claude Code's dontAsk mode).
            </p>
          </section>
          <p class="muted small">Claude Code watches its settings files: a removed rule reaches new and resumed sessions, and usually running ones too.</p>
        </>
      )}
    </Dialog>
  );
}
