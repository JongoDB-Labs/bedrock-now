// Workbooks (.xlsx, .xlsm, .xls, .ods): read in the sheet worker (office/sheet.ts: SheetJS behind our own zip checks,
// values only — formulas are neither read nor computed), each sheet a tab over the same virtual grid as CSV files.
import { useEffect, useRef, useState } from 'preact/hooks';
import { runJob } from './run';
import { SHEET_LIMITS, type SheetMeta } from './limits';
import { Grid } from './TableView';
import { NotShown, PreviewMsg, errText, type ViewerProps } from './Preview';
import { smallDevice } from './device';
import { Spinner } from '../components/icons';

function checkSheets(v: unknown): SheetMeta[] {
  if (!Array.isArray(v)) return [];
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
  return v.slice(0, SHEET_LIMITS.sheets).map((o: Record<string, unknown>, i) => ({
    name: typeof o?.name === 'string' && o.name ? o.name.slice(0, 200) : `Sheet ${i + 1}`,
    rows: n(o?.rows),
    cols: Math.min(n(o?.cols), SHEET_LIMITS.cols),
    hidden: o?.hidden === true,
    header: o?.header === true,
    rowsCut: o?.rowsCut === true,
    colsCut: o?.colsCut === true,
    cellsCut: o?.cellsCut === true,
  }));
}

export function View({ tab, pv, data, phone }: ViewerProps) {
  const sheets = useRef<string[][][]>([]);
  const [metas, setMetas] = useState<SheetMeta[] | null>(null);
  const [extra, setExtra] = useState<{ errors: string[]; charsCut: boolean }>({ errors: [], charsCut: false });
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState(0);

  useEffect(() => {
    sheets.current = [];
    setMetas(null);
    setErr(null);
    setAt(0);
    const buf = data.buf ? data.buf.slice(0) : null;
    if (!buf) {
      setErr('The workbook could not be read.');
      return;
    }
    const job = runJob<Record<string, unknown>>('sheet', { buf, small: smallDevice() }, [buf], {
      timeoutMs: 60_000,
      onChunk: (m) => {
        const i = typeof m.sheet === 'number' && Number.isInteger(m.sheet) && m.sheet >= 0 && m.sheet < SHEET_LIMITS.sheets ? m.sheet : -1;
        if (i < 0 || !Array.isArray(m.rows)) return;
        sheets.current[i] = (m.rows as unknown[]).filter(Array.isArray).map((r) => (r as unknown[]).slice(0, SHEET_LIMITS.cols).map((c) => (typeof c === 'string' ? c : '')));
      },
    });
    job.promise.then(
      (m) => {
        const ms = checkSheets(m.sheets);
        setMetas(ms);
        setExtra({ errors: Array.isArray(m.errors) ? m.errors.slice(0, 5).map((e) => String(e).slice(0, 300)) : [], charsCut: m.charsCut === true });
        // the first sheet that is not hidden
        const first = ms.findIndex((s) => !s.hidden);
        setAt(first < 0 ? 0 : first);
      },
      (e) => errText(e) !== 'cancelled' && setErr(errText(e)),
    );
    return () => job.cancel();
  }, [data]);

  if (err) return <NotShown tab={tab} what="This workbook" err={err} />;
  if (!metas) {
    return (
      <div class="pane-msg">
        <Spinner /> Reading {pv.what}…
      </div>
    );
  }
  if (!metas.length) return <PreviewMsg tab={tab}>This workbook has no sheets to show.</PreviewMsg>;
  const m = metas[Math.min(at, metas.length - 1)];
  const rows = sheets.current[at] ?? [];
  const cut = [
    m.rowsCut && `only the first ${SHEET_LIMITS.rows.toLocaleString('en-US')} rows`,
    m.cellsCut && `only the first ${rows.length.toLocaleString('en-US')} rows (previews stop at ${SHEET_LIMITS.cells.toLocaleString('en-US')} cells per workbook)`,
    m.colsCut && `only the first ${SHEET_LIMITS.cols} columns`,
    extra.charsCut && `cells past ${(SHEET_LIMITS.chars / 1e6).toFixed(0)} million characters in all are empty`,
  ].filter((x): x is string => !!x);
  return (
    <div class="pv-sheet" data-testid="preview-sheet">
      <div class="pv-tabs" role="tablist" aria-label="Sheets" data-testid="sheet-tabs">
        {metas.map((s, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === at}
            class={`pv-tab${s.hidden ? ' hidden-sheet' : ''}`}
            title={s.hidden ? `${s.name} (a hidden sheet)` : s.name}
            onClick={() => setAt(i)}
          >
            {s.name}
            {s.hidden && <span class="muted"> (hidden)</span>}
          </button>
        ))}
      </div>
      <Grid
        key={at}
        rows={rows}
        count={rows.length}
        cols={m.cols}
        done
        headerGuess={m.header}
        cut={cut}
        errors={extra.errors}
        kind="sheet"
        what={pv.what}
        info="values as saved: formulas are not computed"
        phone={phone}
      />
    </div>
  );
}
