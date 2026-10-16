// The CSV/TSV preview's worker: rows go to the page in batches as they are parsed, then the summary (src/preview/csv.ts).
import { readCsv } from '../csv';
import { on, reportCsp, scope, textOf } from './common';

reportCsp();
on((m) => {
  const { meta } = readCsv(textOf(m), m.tsv === true, (rows) => scope.postMessage({ type: 'chunk', rows }));
  scope.postMessage({ type: 'done', meta });
});
