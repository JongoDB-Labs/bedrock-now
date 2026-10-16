// The JSON / JSON Lines / YAML preview's worker: the file → a capped tree (src/preview/tree.ts).
import { readJson, readJsonl, readYaml } from '../tree';
import { on, reportCsp, scope, textOf } from './common';

reportCsp();
on((m) => {
  const text = textOf(m);
  const r = m.kind === 'yaml' ? readYaml(text) : m.kind === 'jsonl' ? readJsonl(text) : readJson(text);
  scope.postMessage({ type: 'done', ...r });
});
