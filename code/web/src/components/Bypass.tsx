// Bypass permissions: the confirmation every switch to it asks for (it names the real risks: your own folder, whose
// git hooks and settings run on your computer later; the sandbox's internet access; the budget), and the red strip
// above the prompt box while it is on. The backend refuses the switch without the confirmation, without
// CODE_ALLOW_BYPASS, and never keeps it past the session's process.
import { useSel } from '../store';
import { store, activeView, cancelBypass, confirmBypass, setMode } from '../app';
import { money } from '../text';
import { Dialog } from './ui';
import { Icon } from './icons';

export function BypassDialog() {
  const asking = useSel(store, (s) => s.bypassAsk !== null);
  const server = useSel(store, (s) => s.server);
  const budget = useSel(store, (s) => s.budget);
  if (!asking) return null;
  const folder = server?.workspace;
  // over remote access: Caddy's remote sites say so to the code container (/api/state), the local one says not
  const remote = server?.remote === true;
  const left = budget && budget.max !== null && budget.spend !== null ? Math.max(0, budget.max - budget.spend) : null;
  return (
    <Dialog title="Run everything without asking in this session?" onClose={cancelBypass} testid="bypass-dialog">
      <div class="bypass-dlg">
        <p class="bypass-lede">
          Claude will run every command and change every file without asking you — including actions that a file, a web page or a tool's output
          talks it into.
        </p>
        <ul class="bypass-risks">
          <li data-testid="bypass-risk-folder">
            It runs in the sandbox, not on your computer, but <strong>the workspace is your folder{folder ? ' ' : ''}</strong>
            {folder ? <code>{folder}</code> : null}. Git hooks, git config, package.json scripts, <code>.vscode/tasks.json</code>, <code>.envrc</code> and Claude
            Code settings in it run on your computer when you use the folder there. bedrock-now flags changes to those files after each turn, with
            Revert.
          </li>
          <li data-testid="bypass-risk-egress">
            {server?.egress === false ? (
              <>The sandbox has no internet access (TERMINAL_EGRESS=off).</>
            ) : (
              <>
                <strong>The sandbox has internet access</strong>, so anything in the workspace can be sent anywhere.
              </>
            )}
          </li>
          <li data-testid="bypass-risk-budget">
            It spends the Code page's key budget{left !== null ? ` (${money(left)} of ${money(budget?.max ?? 0)} left this period)` : ''} without pausing.
          </li>
          <li>
            Claude's file tools still ask before changing <code>.git</code>, <code>.claude</code>, <code>.vscode</code>, <code>.husky</code>, <code>.devcontainer</code>,{' '}
            <code>.envrc</code> or <code>.mcp.json</code> — shell commands do not; the watchlist flags those after the turn. Your deny rules still apply.
          </li>
          <li>It ends with this session's process: a resumed or restarted session goes on in Manual. New sessions start in your usual mode, never in Bypass.</li>
          {remote && (
            <li data-testid="bypass-risk-remote">
              <strong>You're using bedrock-now over remote access.</strong> Everything runs on the computer running bedrock-now, in its sandbox and its folder —
              not on this device.
            </li>
          )}
        </ul>
        <div class="perm-buttons">
          <button type="button" class="btn ghost" onClick={cancelBypass} data-testid="bypass-cancel">
            Cancel
          </button>
          <button type="button" class="btn danger" onClick={() => void confirmBypass()} data-testid="bypass-confirm">
            Bypass permissions for this session
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** The red strip above the prompt box while the session runs without asking. */
export function BypassBanner() {
  const on = useSel(store, (s) => {
    const v = activeView(s);
    return !!v && v.mode === 'bypassPermissions' && v.state !== 'closed' && v.state !== 'ended';
  });
  if (!on) return null;
  return (
    <div class="bypass-banner" role="status" data-testid="bypass-banner">
      <Icon name="forward" size={14} />
      <span>
        <strong>Bypass permissions on</strong> — Claude runs everything without asking in this session.
      </span>
      <button type="button" class="btn small" onClick={() => setMode('default')} data-testid="bypass-off">
        Switch to Manual
      </button>
    </div>
  );
}
