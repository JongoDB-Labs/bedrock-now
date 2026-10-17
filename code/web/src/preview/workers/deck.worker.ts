// The PowerPoint preview's worker: a .pptx → its slides' outline and pictures (src/preview/office/pptx.ts).
import { readDeck } from '../office/pptx';
import { capsFor } from '../limits';
import { bytesOf, on, reportCsp, scope } from './common';

reportCsp();
on((m) => {
  const caps = capsFor(m.small === true);
  const r = readDeck(bytesOf(m), caps.deck, caps.deckZip);
  scope.postMessage({ type: 'done', ...r }, r.images.map((i) => i.buf));
});
