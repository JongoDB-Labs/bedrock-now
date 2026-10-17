// A tiny external store: one immutable state object, selector subscriptions, and notifications coalesced to one per
// animation frame (a streaming answer sends dozens of deltas per second; the UI repaints at most once a frame).
import { useEffect, useReducer, useRef } from 'preact/hooks';

export interface Store<T> {
  get(): T;
  set(fn: (s: T) => T): void;
  subscribe(fn: () => void): () => void;
  /** Deliver pending notifications now (tests). */
  flush(): void;
}

export function createStore<T>(initial: T, schedule: (cb: () => void) => void = defaultSchedule): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  let pending = false;
  const notify = () => {
    pending = false;
    for (const f of [...subs]) f();
  };
  return {
    get: () => state,
    set(fn) {
      const next = fn(state);
      if (next === state) return;
      state = next;
      if (!pending) {
        pending = true;
        schedule(() => {
          if (pending) notify();
        });
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    flush() {
      if (pending) notify();
    },
  };
}

function defaultSchedule(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && document.visibilityState === 'visible') {
    // rAF does not run in background tabs; a timeout keeps state flowing there
    let done = false;
    const run = () => {
      if (!done) {
        done = true;
        cb();
      }
    };
    requestAnimationFrame(run);
    setTimeout(run, 100);
  } else setTimeout(cb, 16);
}

/** Subscribe a component to `sel(state)`; re-renders only when the selected value changes (Object.is). */
export function useSel<T, R>(store: Store<T>, sel: (s: T) => R): R {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const selRef = useRef(sel);
  selRef.current = sel;
  const value = sel(store.get());
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    const check = () => {
      const next = selRef.current(store.get());
      if (!Object.is(next, valueRef.current)) force(0);
    };
    const off = store.subscribe(check);
    // a change between this render and the subscription (effects run after paint) is not missed
    check();
    return off;
  }, [store]);
  return value;
}
