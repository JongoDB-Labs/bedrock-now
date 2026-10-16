// The PowerPoint preview's worker: a .pptx → its slides' outline and pictures (src/preview/office/pptx.ts).
import { readDeck } from '../office/pptx';
import { bytesOf, on, reportCsp, scope } from './common';

reportCsp();
on((m) => {
  const r = readDeck(bytesOf(m));
  scope.postMessage({ type: 'done', ...r }, r.images.map((i) => i.buf));
});
