// The workbook preview's worker: .xlsx/.xls/.ods → each sheet's rows as text, one message per sheet, then the summary
// (src/preview/office/sheet.ts).
import { readWorkbook } from '../office/sheet';
import { bytesOf, on, reportCsp, scope } from './common';

reportCsp();
on((m) => {
  const r = readWorkbook(bytesOf(m), (sheet, rows) => scope.postMessage({ type: 'chunk', sheet, rows }));
  scope.postMessage({ type: 'done', ...r });
});
