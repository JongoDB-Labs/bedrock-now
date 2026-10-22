// Small building blocks: a dropdown (fixed-position panel, so no pane clips it), a modal dialog, a phone sheet and
// a splitter. Positions are set through the CSSOM (element.style), which the page's CSP allows; no inline style
// attributes, no innerHTML.
import { Component, h, type ComponentChildren, type FunctionComponent } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons';

let tipSeq = 0;
/** A small styled tooltip for the control inside: what it does and its shortcut. It shows on hover (after a short
 *  delay) and on keyboard focus, above the control (below it near the top of the window), kept on screen; Escape, a
 *  click or leaving hides it. Positioned through the CSSOM (position: fixed, so no pane or the status bar clips it). The
 *  control names itself (aria-label) and points at the tip (aria-describedby: `tipId(id)`). */
export function Tip(props: { text: string; keys?: string; id: string; children: ComponentChildren; class?: string; off?: boolean }) {
  const [want, setOpen] = useState(false);
  const open = want && !props.off;   // (off: its panel is open)
  const wrap = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = (delay: number) => {
    clear();
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clear();
    setOpen(false);
  };
  useEffect(() => clear, []);
  useLayoutEffect(() => {
    if (!open || !wrap.current || !tip.current) return;
    const r = wrap.current.getBoundingClientRect();
    const t = tip.current;
    const w = Math.min(t.offsetWidth, innerWidth - 16);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
    t.style.left = `${left}px`;
    // (one of top and bottom: what the last showing set is cleared first — the tip stays mounted between showings)
    t.style.top = '';
    t.style.bottom = '';
    if (r.top > t.offsetHeight + 12) t.style.bottom = `${innerHeight - r.top + 6}px`;
    else t.style.top = `${r.bottom + 6}px`;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);
  return (
    <span
      ref={wrap}
      class={`tip-wrap${props.class ? ' ' + props.class : ''}`}
      onMouseEnter={() => show(350)}
      onMouseLeave={hide}
      onFocusIn={(e) => {
        // keyboard focus only (a click focuses too: its own panel or action follows, not a tip)
        if ((e.target as HTMLElement).matches?.(':focus-visible')) show(0);
      }}
      onFocusOut={hide}
      onPointerDown={hide}
    >
      {props.children}
      <span ref={tip} id={tipId(props.id)} role="tooltip" class="tip" hidden={!open} data-testid={`tip-${props.id}`}>
        <span class="tip-text">{props.text}</span>
        {props.keys && <kbd class="tip-keys">{props.keys}</kbd>}
      </span>
    </span>
  );
}
/** The id of a Tip's tooltip (for aria-describedby). */
export const tipId = (id: string): string => `tip-${id}`;
export const nextTipId = (): string => `t${++tipSeq}`;

export function Dropdown(props: {
  trigger: ComponentChildren;
  title: string;
  /** a styled tooltip instead of the browser's title: what it does and its shortcut (keys) */
  tip?: { id: string; text: string; keys?: string };
  children: (close: () => void) => ComponentChildren;
  class?: string;
  panelClass?: string;
  align?: 'left' | 'right';
  disabled?: boolean;
  testid?: string;
  /** a change opens it (a keyboard shortcut elsewhere) */
  openSignal?: number;
  /** a class on the trigger button itself */
  triggerClass?: string;
  /** what gets the focus when it opens (a selector in the panel; default: the checked item, else the first) */
  focus?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const signal = useRef(props.openSignal);
  useEffect(() => {
    if (props.openSignal === signal.current) return;
    signal.current = props.openSignal;
    if (!props.disabled) setOpen(true);
  }, [props.openSignal]);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !btn.current || !panel.current) return;
    const r = btn.current.getBoundingClientRect();
    const p = panel.current;
    const vw = innerWidth;
    const vh = innerHeight;
    const w = Math.min(p.offsetWidth, vw - 16);
    let left = props.align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    const below = vh - r.bottom;
    const h = p.offsetHeight;
    p.style.left = `${left}px`;
    if (below >= Math.min(h, 320) + 8 || below > r.top) {
      p.style.top = `${r.bottom + 4}px`;
      p.style.maxHeight = `${Math.max(160, below - 12)}px`;
    } else {
      p.style.bottom = `${vh - r.top + 4}px`;
      p.style.maxHeight = `${Math.max(160, r.top - 12)}px`;
    }
    const first = (props.focus ? p.querySelector<HTMLElement>(props.focus) : null) ?? p.querySelector<HTMLElement>('[aria-checked="true"], [role=menuitem], [role=menuitemradio], input, button');
    first?.focus({ preventScroll: true });
    // the item checked in a long list: in view
    p.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled]), [role=menuitemradio]:not([disabled])') ?? [])];
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement as HTMLElement);
        const n = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[n].focus();
      }
    };
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
      removeEventListener('resize', resize);
    };
  }, [open]);

  const button = (
    <button
      ref={btn}
      type="button"
      class={`dd-trigger${props.triggerClass ? ' ' + props.triggerClass : ''}`}
      title={props.tip ? undefined : props.title}
      aria-label={props.title}
      aria-describedby={props.tip ? tipId(props.tip.id) : undefined}
      aria-keyshortcuts={props.tip?.keys ? ariaKeys(props.tip.keys) : undefined}
      aria-haspopup="true"
      aria-expanded={open}
      disabled={props.disabled}
      data-testid={props.testid}
      onClick={() => setOpen(!open)}
    >
      {props.trigger}
    </button>
  );
  return (
    <div class={`dd${props.class ? ' ' + props.class : ''}`} onClick={(e) => e.stopPropagation()}>
      {props.tip ? (
        <Tip id={props.tip.id} text={props.tip.text} keys={props.tip.keys} off={open}>
          {button}
        </Tip>
      ) : (
        button
      )}
      {open && (
        <div ref={panel} class={`dd-panel${props.panelClass ? ' ' + props.panelClass : ''}`} role="menu">
          {props.children(close)}
        </div>
      )}
    </div>
  );
}

/** "Alt+R" → "Alt+R", "Ctrl+`" → "Control+`", "⌘+K · Ctrl+Shift+P" → "Meta+K Control+Shift+P" (aria-keyshortcuts). */
export function ariaKeys(keys: string): string {
  return keys
    .split('·')
    .map((k) => k.trim().replace(/⌘/g, 'Meta').replace(/\bCtrl\b/g, 'Control'))
    .filter(Boolean)
    .join(' ');
}

export function MenuItem(props: {
  onSelect: () => void;
  checked?: boolean;
  disabled?: boolean;
  icon?: string;
  children: ComponentChildren;
  hint?: ComponentChildren;
  danger?: boolean;
  testid?: string;
}) {
  return (
    <button
      type="button"
      class={`mi${props.danger ? ' danger' : ''}`}
      role={props.checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={props.checked === undefined ? undefined : props.checked}
      disabled={props.disabled}
      data-testid={props.testid}
      onClick={props.onSelect}
    >
      {props.icon !== undefined && <span class="mi-icon">{props.icon ? <Icon name={props.icon} /> : null}</span>}
      <span class="mi-body">{props.children}</span>
      {props.hint !== undefined && <span class="mi-hint">{props.hint}</span>}
      {props.checked && <Icon name="check" class="mi-check" />}
    </button>
  );
}

export function Dialog(props: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean; testid?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      class={`dlg${props.wide ? ' wide' : ''}`}
      aria-label={props.title}
      data-testid={props.testid}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) props.onClose();
      }}
    >
      <div class="dlg-head">
        <h2>{props.title}</h2>
        <button type="button" class="icon-btn" title="Close" aria-label="Close" onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div class="dlg-body">{props.children}</div>
    </dialog>
  );
}

/** Phone: a full-height panel over the chat. */
export function Sheet(props: { title: ComponentChildren; onClose: () => void; children: ComponentChildren; actions?: ComponentChildren; testid?: string }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [props.onClose]);
  return (
    <section class="sheet" role="dialog" aria-modal="true" data-testid={props.testid}>
      <header class="sheet-head">
        <button type="button" class="icon-btn" title="Close" aria-label="Close" onClick={props.onClose}>
          <Icon name="chevronDown" size={20} />
        </button>
        <div class="sheet-title">{props.title}</div>
        <div class="sheet-actions">{props.actions}</div>
      </header>
      <div class="sheet-body">{props.children}</div>
    </section>
  );
}

/** A drag handle between panes. `axis` x resizes widths, y heights; `sign` flips the direction. */
export function Splitter(props: { axis: 'x' | 'y'; value: number; min: number; max: number; sign?: 1 | -1; onChange: (v: number) => void; label: string; testid?: string }) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  const sign = props.sign ?? 1;
  return (
    <div
      class={`split split-${props.axis}`}
      role="separator"
      aria-orientation={props.axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={props.label}
      aria-valuenow={props.value}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      data-testid={props.testid}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { pos: props.axis === 'x' ? e.clientX : e.clientY, value: props.value };
        document.body.classList.add(props.axis === 'x' ? 'resizing-x' : 'resizing-y');
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const d = (props.axis === 'x' ? e.clientX : e.clientY) - start.current.pos;
        props.onChange(Math.round(Math.min(props.max, Math.max(props.min, start.current.value + sign * d))));
      }}
      onPointerUp={() => {
        start.current = null;
        document.body.classList.remove('resizing-x', 'resizing-y');
      }}
      onPointerCancel={() => {
        start.current = null;
        document.body.classList.remove('resizing-x', 'resizing-y');
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        const dec = props.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        const inc = props.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        if (e.key === dec || e.key === inc) {
          e.preventDefault();
          const d = (e.key === inc ? step : -step) * sign;
          props.onChange(Math.min(props.max, Math.max(props.min, props.value + d)));
        }
      }}
    />
  );
}

/** Copy text to the clipboard; resolves false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    f();
    return () => mq.removeEventListener('change', f);
  }, [query]);
  return m;
}

/** Preact core has no memo(); this one skips re-rendering when the props are shallow-equal. */
export function memo<P extends object>(C: FunctionComponent<P>): FunctionComponent<P> {
  class Memo extends Component<P> {
    shouldComponentUpdate(next: P): boolean {
      const a = this.props as Record<string, unknown>;
      const b = next as Record<string, unknown>;
      for (const k in a) if (k !== 'children' && a[k] !== b[k]) return true;
      for (const k in b) if (k !== 'children' && !(k in a)) return true;
      return a.children !== b.children;
    }
    render(p: P) {
      return h(C, p);
    }
  }
  return Memo as unknown as FunctionComponent<P>;
}

/** A command line, with Copy (it says Copied once the browser took it). */
export function Cmd({ text, testid }: { text: string; testid: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <span class="np-cmd">
      <code data-testid={testid}>{text}</code>
      <button type="button" class="linkish small" onClick={() => void copyText(text).then(setCopied)} data-testid={`${testid}-copy`}>
        {copied === null ? 'Copy' : copied ? 'Copied' : 'Copy it by hand'}
      </button>
    </span>
  );
}
