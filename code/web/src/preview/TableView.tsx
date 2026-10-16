// CSV and TSV as a table: parsed in a worker (workers/csv.worker.ts → csv.ts, with its caps), rows arriving in
// batches; drawn virtually in both directions (only the cells in view exist), with a header row that can be turned
// off, sorting and a row filter for files of up to SORT_MAX rows. Every cell is text.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { runJob } from './run';
import { CSV_LIMITS, isNumeric } from './limits';
import type { CsvMeta } from './csv';
import { PreviewMsg, errText, type ViewerProps } from './Preview';
import { Spinner } from '../components/icons';
import { useMedia } from '../components/ui';

const SORT_MAX = 200_000;
const HEAD_H = 28;
const NUM_W = 56;

function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function checkMeta(m: unknown): CsvMeta | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    delimiter: typeof o.delimiter === 'string' ? o.delimiter.slice(0, 1) : ',',
    rows: n(o.rows),
    cols: Math.min(n(o.cols), CSV_LIMITS.cols),
    rowsCut: o.rowsCut === true,
    colsCut: o.colsCut === true,
    cellsCut: o.cellsCut === true,
    header: o.header === true,
    errors: Array.isArray(o.errors) ? o.errors.slice(0, 5).map((e) => String(e).slice(0, 300)) : [],
  };
}

const cellText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

// text widths for the columns: measured with the page's font (a canvas), so a header is never cut by an estimate
let measure: { ctx: CanvasRenderingContext2D; family: string; weight: number } | null = null;
function textWidth(s: string, weight: number): number {
  if (!measure) {
    const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    if (!ctx) return s.length * 7.6;
    measure = { ctx, family: getComputedStyle(document.body).fontFamily || 'sans-serif', weight: 0 };
  }
  if (measure.weight !== weight) {
    measure.ctx.font = `${weight} 12.5px ${measure.family}`;
    measure.weight = weight;
  }
  return measure.ctx.measureText(s.slice(0, 80)).width;
}
const DELIM_NAME: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };

/** CSV/TSV: parsed in the csv worker, rows arriving in batches, drawn by Grid. */
export function View({ tab, pv, data, phone }: ViewerProps) {
  const rows = useRef<string[][]>([]);
  const [count, setCount] = useState(0);
  const [cols, setCols] = useState(0);
  const [meta, setMeta] = useState<CsvMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    rows.current = [];
    setCount(0);
    setCols(0);
    setMeta(null);
    setErr(null);
    let frame = 0;
    let width = 0;
    const buf = data.buf ? data.buf.slice(0) : null;
    const job = runJob<Record<string, unknown>>('csv', buf ? { buf, tsv: pv.kind === 'tsv' } : { text: data.text ?? '', tsv: pv.kind === 'tsv' }, buf ? [buf] : [], {
      timeoutMs: 30_000,
      onChunk: (m) => {
        if (!Array.isArray(m.rows)) return;
        for (const r of m.rows as unknown[]) {
          if (!Array.isArray(r)) continue;
          rows.current.push(r as string[]);
          if (r.length > width) width = Math.min(r.length, CSV_LIMITS.cols);
        }
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            setCount(rows.current.length);
            setCols(width);
          });
        }
      },
    });
    job.promise.then(
      (m) => {
        cancelAnimationFrame(frame);
        setMeta(checkMeta(m.meta));
        setCount(rows.current.length);
        setCols(width);
      },
      (e) => errText(e) !== 'cancelled' && setErr(errText(e)),
    );
    return () => {
      cancelAnimationFrame(frame);
      job.cancel();
    };
  }, [data, pv.kind]);

  if (err) return <PreviewMsg tab={tab} err>{err}</PreviewMsg>;
  if (!count && !meta) {
    return (
      <div class="pane-msg">
        <Spinner /> Reading {pv.what}…
      </div>
    );
  }
  const notes = [
    meta?.rowsCut && `only the first ${CSV_LIMITS.rows.toLocaleString('en-US')} rows`,
    meta?.cellsCut && `only the first ${meta.rows.toLocaleString('en-US')} rows (previews stop at ${CSV_LIMITS.cells.toLocaleString('en-US')} cells)`,
    meta?.colsCut && `only the first ${CSV_LIMITS.cols} columns`,
  ].filter((x): x is string => !!x);
  return (
    <Grid
      rows={rows.current}
      count={count}
      cols={cols}
      done={meta !== null}
      headerGuess={meta?.header ?? false}
      cut={notes}
      errors={meta?.errors ?? []}
      kind={pv.kind}
      what={pv.what}
      info={meta ? `${DELIM_NAME[meta.delimiter] ?? meta.delimiter}-separated` : ''}
      phone={phone}
    />
  );
}

export interface GridProps {
  /** every row (a header row too, when there is one); appended to while `done` is false */
  rows: string[][];
  count: number;
  cols: number;
  done: boolean;
  /** "First row is a header" until you change it */
  headerGuess: boolean;
  /** what was left out ("only the first … rows"), and the parser's errors */
  cut: string[];
  errors: string[];
  kind: string;
  what: string;
  info?: string;
  phone: boolean;
}

/** A table of text cells drawn virtually in both directions, with a header row that can be turned off, sorting and a
 *  row filter (up to SORT_MAX rows), resizable columns and a cell's full text below. */
export function Grid({ rows: all, count, cols, done, headerGuess, cut, errors, kind, what, info, phone }: GridProps) {
  const coarse = useMedia('(pointer: coarse)');
  const rowH = coarse ? 32 : 26;
  const rows = useRef<string[][]>(all);
  rows.current = all;
  const [header, setHeader] = useState<boolean | null>(null);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  const [sized, setSized] = useState<Record<number, number>>({});
  const [picked, setPicked] = useState<{ r: number; c: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ top: 0, left: 0, height: 600, width: 1000 });

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWin({ top: el.scrollTop, left: el.scrollLeft, height: el.clientHeight, width: el.clientWidth }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [done || count > 0]);

  const hasHeader = header ?? headerGuess;
  const bodyStart = hasHeader ? 1 : 0;

  // the filter applies 150 ms after the last keystroke (each run reads every row)
  useEffect(() => {
    const t = setTimeout(() => setFilter(filterInput), 150);
    return () => clearTimeout(t);
  }, [filterInput]);

  // column widths: at least the header's text (with room for the sort mark), else the widest of the first rows' cells,
  // within [56, 320] px (200 on a phone); a column dragged by its edge keeps the width it was given
  const auto = useMemo(() => {
    const max = phone ? 200 : 320;
    const out: number[] = [];
    const sample = rows.current.slice(hasHeader ? 1 : 0, 100);
    const head = hasHeader ? rows.current[0] ?? [] : [];
    for (let c = 0; c < cols; c++) {
      const name = hasHeader ? cellText(head[c]) || colName(c) : colName(c);
      let w = textWidth(name, 600) + 34;
      for (const r of sample) w = Math.max(w, textWidth(cellText(r[c]).slice(0, 60), 400) + 18);
      out.push(Math.round(Math.max(56, Math.min(max, w))));
    }
    return out;
  }, [cols, done, phone, hasHeader, count > 0 && count < 100 ? count : 100]);
  const widths = useMemo(() => auto.map((w, c) => sized[c] ?? w), [auto, sized]);
  const offsets = useMemo(() => {
    const o = [0];
    for (const w of widths) o.push(o[o.length - 1] + w);
    return o;
  }, [widths]);

  const canSort = done && count <= SORT_MAX;
  // the body's row order: filtered, then sorted (indices into rows.current)
  const order = useMemo(() => {
    if (!canSort || (!sort && !filter.trim())) return null;
    const all = rows.current;
    let idx: number[] = [];
    const f = filter.trim().toLowerCase();
    for (let i = bodyStart; i < all.length; i++) if (!f || all[i].some((c) => cellText(c).toLowerCase().includes(f))) idx.push(i);
    if (sort) {
      const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      const { col, dir } = sort;
      const num = idx.every((i) => {
        const v = cellText(all[i][col]);
        return v === '' || isNumeric(v);
      });
      const val = (i: number) => cellText(all[i][col]);
      idx = idx.sort((a, b) => {
        const x = val(a);
        const y = val(b);
        if (x === '' || y === '') return x === y ? a - b : x === '' ? 1 : -1;
        const r = num ? parseFloat(x.replace(/,/g, '')) - parseFloat(y.replace(/,/g, '')) : coll.compare(x, y);
        return r ? r * dir : a - b;
      });
    }
    return idx;
  }, [sort, filter, canSort, bodyStart, count]);

  const total = order ? order.length : Math.max(0, count - bodyStart);
  const rowAt = (i: number): string[] => rows.current[order ? order[i] : i + bodyStart] ?? [];
  const first = Math.max(0, Math.floor(win.top / rowH) - 8);
  const last = Math.min(total, Math.ceil((win.top + win.height) / rowH) + 8);
  let c0 = 0;
  while (c0 < cols && offsets[c0 + 1] < win.left - NUM_W) c0++;
  let c1 = c0;
  while (c1 < cols && offsets[c1] < win.left + win.width) c1++;
  const visCols: number[] = [];
  for (let c = Math.max(0, c0 - 1); c < Math.min(cols, c1 + 1); c++) visCols.push(c);
  const names = hasHeader ? rows.current[0] ?? [] : [];
  const place = (top: number, height: number) => (el: HTMLElement | null) => {
    if (!el) return;
    el.style.top = `${top}px`;
    el.style.height = `${height}px`;
  };
  const at = (c: number) => (el: HTMLElement | null) => {
    if (!el) return;
    el.style.left = `${NUM_W + offsets[c]}px`;
    el.style.width = `${widths[c]}px`;
  };
  const pickedRow = picked ? rowAt(picked.r) : null;
  return (
    <div class="pv-table" data-testid="preview-table" data-kind={kind}>
      <div class="pv-tools">
        <span class="small" data-testid="table-size">
          {total.toLocaleString('en-US')} {total === 1 ? 'row' : 'rows'}
          {order && ` of ${Math.max(0, count - bodyStart).toLocaleString('en-US')}`} × {cols} {cols === 1 ? 'column' : 'columns'}
          {!done && ' (reading…)'}
        </span>
        {info && <span class="muted small">{info}</span>}
        <label class="small pv-check">
          <input type="checkbox" checked={hasHeader} onChange={(e) => setHeader((e.currentTarget as HTMLInputElement).checked)} data-testid="table-header" /> First row is a header
        </label>
        <input
          class="pv-filter"
          type="search"
          placeholder={canSort ? 'Filter rows' : `Filter: up to ${SORT_MAX.toLocaleString('en-US')} rows`}
          disabled={!canSort}
          value={filterInput}
          onInput={(e) => setFilterInput((e.currentTarget as HTMLInputElement).value.slice(0, 200))}
          data-testid="table-filter"
        />
      </div>
      {(cut.length > 0 || errors.length > 0) && (
        <div class="banner subtle" data-testid="table-notes">
          <span>
            {cut.length > 0 && `Shown: ${cut.join('; ')}. `}
            {errors.length ? `The parser said: ${errors.join(' · ')}` : ''}
          </span>
        </div>
      )}
      <div
        class="tv-scroll"
        ref={scroller}
        role="table"
        aria-rowcount={total + 1}
        aria-colcount={cols}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLElement;
          setWin({ top: el.scrollTop, left: el.scrollLeft, height: el.clientHeight, width: el.clientWidth });
        }}
      >
        <div
          class="tv-space"
          ref={(el) => {
            if (!el) return;
            el.style.height = `${HEAD_H + total * rowH}px`;
            el.style.width = `${NUM_W + offsets[cols]}px`;
          }}
        >
          <div
            class="tv-head"
            role="row"
            ref={(el) => {
              if (el) el.style.width = `${NUM_W + offsets[cols]}px`;
            }}
          >
            <div class="tv-num tv-corner" role="columnheader" />
            {visCols.map((c) => {
              const s = sort?.col === c ? sort.dir : 0;
              return (
                <button
                  key={c}
                  type="button"
                  class={`tv-h${s ? ' sorted' : ''}`}
                  role="columnheader"
                  aria-sort={s > 0 ? 'ascending' : s < 0 ? 'descending' : 'none'}
                  disabled={!canSort}
                  title={canSort ? `Sort by ${hasHeader ? cellText(names[c]) : colName(c)}` : `Sorting: up to ${SORT_MAX.toLocaleString('en-US')} rows`}
                  ref={at(c)}
                  onClick={() => setSort(!s ? { col: c, dir: 1 } : s > 0 ? { col: c, dir: -1 } : null)}
                >
                  <span class="tv-hname">{hasHeader ? cellText(names[c]) || colName(c) : colName(c)}</span>
                  {s !== 0 && <span aria-hidden="true">{s > 0 ? '▲' : '▼'}</span>}
                </button>
              );
            })}
            {visCols.map((c) => (
              <span
                key={`g${c}`}
                class="tv-grip"
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize column ${colName(c)}`}
                ref={(el) => {
                  if (el) el.style.left = `${NUM_W + offsets[c + 1] - 4}px`;
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  const el = e.currentTarget as HTMLElement;
                  el.setPointerCapture(e.pointerId);
                  const x0 = e.clientX;
                  const w0 = widths[c];
                  const move = (m: PointerEvent) => setSized((o) => ({ ...o, [c]: Math.round(Math.max(40, Math.min(1200, w0 + m.clientX - x0))) }));
                  const up = () => {
                    el.removeEventListener('pointermove', move);
                    el.removeEventListener('pointerup', up);
                    el.removeEventListener('pointercancel', up);
                  };
                  el.addEventListener('pointermove', move);
                  el.addEventListener('pointerup', up);
                  el.addEventListener('pointercancel', up);
                }}
              />
            ))}
          </div>
          {Array.from({ length: Math.max(0, last - first) }, (_, k) => {
            const i = first + k;
            const r = rowAt(i);
            return (
              <div key={i} class="tv-r" role="row" ref={place(HEAD_H + i * rowH, rowH)}>
                <div class="tv-num" role="rowheader">
                  {(order ? order[i] : i + bodyStart) + 1}
                </div>
                {visCols.map((c) => {
                  const v = cellText(r[c]);
                  return (
                    <div
                      key={c}
                      role="cell"
                      class={`tv-c${isNumeric(v) ? ' num' : ''}${picked?.r === i && picked.c === c ? ' on' : ''}`}
                      ref={at(c)}
                      onClick={() => setPicked({ r: i, c })}
                    >
                      {v}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {picked && pickedRow && (
        <div class="tv-cell-full" data-testid="table-cell">
          <span class="muted small">
            Row {(order ? order[picked.r] : picked.r + bodyStart) + 1}, {hasHeader ? cellText(names[picked.c]) || colName(picked.c) : colName(picked.c)}
          </span>
          <div class="tv-cell-text">{cellText(pickedRow[picked.c])}</div>
        </div>
      )}
    </div>
  );
}
