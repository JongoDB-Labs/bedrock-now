// The workbook preview's worker: .xlsx/.xls/.ods → each sheet's rows as text, one message per sheet, then the summary
// (src/preview/office/sheet.ts).
import { readWorkbook } from '../office/sheet';
import { capsFor } from '../limits';
import { bytesOf, on, reportCsp, scope } from './common';

reportCsp();
on((m) => {
  const caps = capsFor(m.small === true);
  const r = readWorkbook(bytesOf(m), (sheet, rows) => scope.postMessage({ type: 'chunk', sheet, rows }), caps.sheet, caps.sheetZip);
  scope.postMessage({ type: 'done', ...r });
});
