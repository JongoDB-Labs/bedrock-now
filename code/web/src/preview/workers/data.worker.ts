// The JSON / JSON Lines / YAML preview's worker: the file → a capped tree (src/preview/tree.ts); and notebooks → their
// cells and outputs (src/preview/notebook.ts; images as transferred bytes).
import { readJson, readJsonl, readYaml } from '../tree';
import { readNotebook } from '../notebook';
import { on, reportCsp, scope, textOf } from './common';

reportCsp();
on((m) => {
  const text = textOf(m);
  if (m.kind === 'notebook') {
    const { transfer, ...nb } = readNotebook(text);
    return scope.postMessage({ type: 'done', notebook: nb }, transfer);
  }
  const r = m.kind === 'yaml' ? readYaml(text) : m.kind === 'jsonl' ? readJsonl(text) : readJson(text);
  scope.postMessage({ type: 'done', ...r });
});
