// The Word preview's worker: a .docx → an allowlisted tree and its pictures (src/preview/office/docx.ts).
import { readDocx } from '../office/docx';
import { bytesOf, on, reportCsp, scope } from './common';

reportCsp();
on(async (m) => {
  const r = await readDocx(bytesOf(m));
  scope.postMessage({ type: 'done', ...r }, r.images.map((i) => i.buf));
});
