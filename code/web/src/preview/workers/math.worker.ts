// The formulas' worker: one formula at a time → KaTeX's HTML → an allowlisted tree (src/preview/mathrender.ts). The
// page ends this worker when a formula takes longer than its time budget.
import katex from 'katex';
import { renderFormula } from '../mathrender';
import { on, reportCsp, scope } from './common';

reportCsp();
on((m) => {
  const id = typeof m.id === 'number' ? m.id : -1;
  const r = renderFormula(katex as unknown as { renderToString(t: string, o: Record<string, unknown>): string }, String(m.tex ?? '').slice(0, 10_000), m.display === true);
  scope.postMessage({ type: 'math', id, ...r });
});
