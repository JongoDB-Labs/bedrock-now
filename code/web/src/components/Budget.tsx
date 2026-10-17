// ⋯ › Budget for this session: an amount for the session shown (warnings at 50 % and 80 % of it from bedrock-now's spend
// logs, and at 100 %), an optional stop (Claude Code's own: it ends a turn after the request that reaches the budget, by
// its own estimate; the page also stops a turn the spend logs show past it), and whether new sessions start with the
// same budget. Off by default.
import { useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, activeView, setSessionBudget } from '../app';
import { BUDGET_MAX, BUDGET_MIN, parseUsd, percent } from '../budget';
import { sessionCost } from '../spend';
import { money } from '../text';
import { Dialog } from './ui';

export function BudgetDialog({ onClose }: { onClose: () => void }) {
  const v = useSel(store, (s) => activeView(s));
  const next = useSel(store, (s) => s.budgetNext);
  const key = useSel(store, (s) => s.budget);
  const cur = v?.budget ?? null;
  const [amount, setAmount] = useState(cur ? cur.usd.toFixed(2) : next ? next.usd.toFixed(2) : '');
  const [hard, setHard] = useState(cur ? cur.hard : next?.hard ?? false);
  const [forNew, setForNew] = useState(!!next);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const spent = v?.spend ? sessionCost(v.spend) : null;
  const usd = parseUsd(amount);

  const save = async (off = false) => {
    setError('');
    if (!off && usd === null) {
      setError(`An amount from $${BUDGET_MIN.toFixed(2)} to $${BUDGET_MAX}, like 2 or 2.50.`);
      return;
    }
    setBusy(true);
    const b = off ? null : { usd: usd as number, hard };
    const why = await setSessionBudget(v?.id ?? null, b, off ? (forNew ? undefined : false) : forNew);
    setBusy(false);
    if (why) setError(why);
    else onClose();
  };

  return (
    <Dialog title="Budget for this session" onClose={onClose} testid="budget-dialog">
      <form
        class="budget-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p class="muted">
          {v ? (
            <>
              This session has cost {spent === null ? 'nothing known yet' : money(spent)} so far (bedrock-now's spend logs: what Bedrock billed).
              {cur && spent !== null ? ` That is ${Math.round(percent(spent, cur))} % of its ${money(cur.usd, 2)} budget.` : ''}
            </>
          ) : (
            'No session is open: the budget is for the sessions you start from now on.'
          )}
        </p>
        <label class="budget-amount">
          <span>Budget (USD)</span>
          <input type="text" inputMode="decimal" value={amount} placeholder="e.g. 2.00" maxLength={8} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} data-testid="budget-amount" />
        </label>
        <p class="muted small">You are warned at 50 % and 80 % of it, and when it is reached.</p>
        <label class="check">
          <input type="checkbox" checked={hard} onChange={(e) => setHard((e.target as HTMLInputElement).checked)} data-testid="budget-hard" />
          <span>
            <strong>Stop at the budget.</strong> Claude Code ends a turn after the request that reaches it (its own estimate of the cost: it can go over by one
            request), and refuses new prompts until you raise the budget or turn this off. A change while Claude Code runs applies from your next prompt: it
            restarts for it, which may write the prompt cache again.
          </span>
        </label>
        <label class="check">
          <input type="checkbox" checked={forNew} onChange={(e) => setForNew((e.target as HTMLInputElement).checked)} data-testid="budget-for-new" />
          <span>New sessions start with this budget too (in this browser).</span>
        </label>
        {key && key.max !== null && (
          <p class="muted small">
            The Code page's key (claude-code-terminal) has its own monthly budget: {money(key.spend)} of {money(key.max)}. That one always applies.
          </p>
        )}
        {error && (
          <p class="err" role="alert" data-testid="budget-error">
            {error}
          </p>
        )}
        <div class="dlg-actions">
          {(cur || next) && (
            <button type="button" class="btn ghost" disabled={busy} onClick={() => void save(true)} data-testid="budget-remove">
              No budget
            </button>
          )}
          <button type="button" class="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={busy} data-testid="budget-save">
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
