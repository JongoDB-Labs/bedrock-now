// JSON, JSON Lines, YAML and notebooks (as JSON) as a collapsible tree. The file is parsed in a worker
// (workers/data.worker.ts → tree.ts, with its caps); this draws only the open branches, PAGE children at a time, keys
// and values as text.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { runJob } from './run';
import { TREE_LIMITS, type TNode } from './limits';
import { PreviewMsg, errText, type ViewerProps } from './Preview';
import { Spinner } from '../components/icons';

const PAGE = 200;

interface Result {
  root: TNode;
  cut: boolean;
  errors: string[];
}

/** The worker's answer, checked: it is our own code, but its input is not. */
function result(m: Record<string, unknown>): Result {
  const errors = Array.isArray(m.errors) ? m.errors.slice(0, 5).map((e) => String(e).slice(0, 400)) : [];
  const root = m.root && typeof m.root === 'object' ? (m.root as TNode) : ({ t: 'x', v: '(nothing)' } as TNode);
  return { root, cut: m.cut === true, errors };
}

const count = (n: TNode): number => (n.t === 'o' || n.t === 'a' ? n.n : 0);

function summary(n: TNode): string {
  if (n.t === 'o') return `{${n.n} ${n.n === 1 ? 'key' : 'keys'}}`;
  if (n.t === 'a') return `[${n.n} ${n.n === 1 ? 'item' : 'items'}]`;
  return '';
}

function Value({ n }: { n: TNode }) {
  switch (n.t) {
    case 's':
      return (
        <span class="tv-s">
          "{n.v}"{n.len > n.v.length && <span class="muted"> … ({n.len.toLocaleString('en-US')} characters)</span>}
        </span>
      );
    case 'n':
      return <span class="tv-n">{n.v}</span>;
    case 'b':
      return <span class="tv-b">{n.v}</span>;
    case 'z':
      return <span class="tv-z">null</span>;
    case 'x':
      return <span class="tv-x">{n.v}</span>;
    default:
      return <span class="tv-sum muted">{summary(n)}</span>;
  }
}

interface Ctx {
  open: Set<string>;
  shown: Map<string, number>;
  toggle(path: string): void;
  more(path: string): void;
}

function Branch({ name, node, path, ctx, index }: { name: string | null; node: TNode; path: string; ctx: Ctx; index: boolean }) {
  const kids = node.t === 'o' || node.t === 'a';
  const open = kids && ctx.open.has(path);
  const label = name === null ? null : <span class={index ? 'tk tk-i' : 'tk'}>{name}</span>;
  if (!kids) {
    return (
      <li role="treeitem" class="tv-leaf">
        {label}
        {label && <span class="tv-colon">: </span>}
        <Value n={node} />
      </li>
    );
  }
  const list = node.t === 'o' ? node.v : node.v;
  const n = Math.min(list.length, ctx.shown.get(path) ?? PAGE);
  return (
    <li role="treeitem" aria-expanded={open}>
      <button type="button" class="tv-row" onClick={() => ctx.toggle(path)}>
        <span class={`tv-caret${open ? ' open' : ''}`} aria-hidden="true">
          ›
        </span>
        {label}
        {label && <span class="tv-colon">: </span>}
        <span class="tv-sum muted">{summary(node)}</span>
      </button>
      {open && (
        <ul role="group">
          {list.slice(0, n).map((c, i) => (
            <Branch key={i} name={node.t === 'o' ? node.k[i] : String(i)} index={node.t === 'a'} node={c} path={`${path}/${i}`} ctx={ctx} />
          ))}
          {n < list.length && (
            <li class="tv-more">
              <button type="button" class="linkish" onClick={() => ctx.more(path)}>
                Show {Math.min(PAGE, list.length - n)} more of {list.length - n}
              </button>
            </li>
          )}
          {list.length < count(node) && <li class="tv-more muted">… {(count(node) - list.length).toLocaleString('en-US')} more not shown (previews show {TREE_LIMITS.children.toLocaleString('en-US')} per level)</li>}
        </ul>
      )}
    </li>
  );
}

/** Paths of every open-able node down to `depth` levels (Expand: at most `max` of them). */
function paths(n: TNode, path: string, depth: number, out: Set<string>, max: number): void {
  if (depth < 0 || out.size >= max || !(n.t === 'o' || n.t === 'a')) return;
  out.add(path);
  n.v.forEach((c, i) => paths(c, `${path}/${i}`, depth - 1, out, max));
}

export function View({ tab, pv, data }: ViewerProps) {
  const [st, setSt] = useState<{ res?: Result; err?: string } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set(['r']));
  const [shown, setShown] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    setSt(null);
    const kind = pv.kind === 'yaml' ? 'yaml' : pv.kind === 'jsonl' ? 'jsonl' : 'json';
    const buf = data.buf ? data.buf.slice(0) : null;
    const job = runJob<Record<string, unknown>>('data', buf ? { kind, buf } : { kind, text: data.text ?? '' }, buf ? [buf] : [], { timeoutMs: 20_000 });
    job.promise.then(
      (m) => {
        const res = result(m);
        const o = new Set<string>();
        paths(res.root, 'r', 1, o, 1000);
        setOpen(o);
        setShown(new Map());
        setSt({ res });
      },
      (e) => errText(e) !== 'cancelled' && setSt({ err: errText(e) }),
    );
    return () => job.cancel();
  }, [data, pv.kind]);

  const ctx = useMemo<Ctx>(
    () => ({
      open,
      shown,
      toggle: (p) =>
        setOpen((s) => {
          const x = new Set(s);
          if (x.has(p)) x.delete(p);
          else x.add(p);
          return x;
        }),
      more: (p) => setShown((m) => new Map(m).set(p, (m.get(p) ?? PAGE) + PAGE)),
    }),
    [open, shown],
  );

  if (!st) {
    return (
      <div class="pane-msg">
        <Spinner /> Reading {pv.what}…
      </div>
    );
  }
  if (st.err || !st.res) return <PreviewMsg tab={tab} err>{st.err}</PreviewMsg>;
  const { root, cut, errors } = st.res;
  return (
    <div class="pv-tree" data-testid="preview-tree" data-kind={pv.kind}>
      <div class="pv-tools">
        <button type="button" class="btn small ghost" onClick={() => setOpen(((o) => (paths(root, 'r', 4, o, 2000), o))(new Set<string>()))}>
          Expand
        </button>
        <button type="button" class="btn small ghost" onClick={() => setOpen(new Set(['r']))}>
          Collapse
        </button>
        {cut && (
          <span class="muted small" data-testid="tree-cut">
            Part of it is not shown: previews show {TREE_LIMITS.nodes.toLocaleString('en-US')} values and {TREE_LIMITS.depth} levels at most.
          </span>
        )}
      </div>
      {errors.length > 0 && (
        <div class="banner warn" data-testid="tree-errors">
          <span>{errors.join(' · ')}</span>
        </div>
      )}
      <div class="pv-scroll">
        <ul class="tv" role="tree" aria-label={pv.what}>
          <Branch name={null} node={root} path="r" ctx={ctx} index={false} />
        </ul>
      </div>
    </div>
  );
}
