// The Word preview's worker: a .docx → an allowlisted tree and its pictures (src/preview/office/docx.ts).
import { readDocx } from '../office/docx';
import { capsFor } from '../limits';
import { bytesOf, on, reportCsp, scope } from './common';

reportCsp();
on(async (m) => {
  const caps = capsFor(m.small === true);
  const r = await readDocx(bytesOf(m), caps.doc, caps.docxZip);
  scope.postMessage({ type: 'done', ...r }, r.images.map((i) => i.buf));
});
