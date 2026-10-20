// static/nav.js's pure parts: the stored choice read back (bn.nav: collapsed, or anything else — expanded), the key
// that switches it (Ctrl+\ or ⌘\, not a held key, not \ alone) and what the button says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, plain } from "./load.mjs";

const N = load("nav.js").bnNav._pure;

test("the stored choice: only \"collapsed\" collapses; nothing stored, blocked storage or junk is expanded", () => {
  assert.equal(N.KEY, "bn.nav");
  assert.equal(N.parse("collapsed"), true);
  for (const v of [null, undefined, "", "expanded", "Collapsed", "true", "1", "{\"collapsed\":true}"]) assert.equal(N.parse(v), false, String(v));
});

test("the key: Ctrl+\\ or ⌘\\ (by the key, or the key where \\ is on a US keyboard), never a held key or \\ alone", () => {
  const k = (o) => N.isToggleKey({ key: "\\", code: "Backslash", ctrlKey: false, metaKey: false, repeat: false, ...o });
  assert.equal(k({ ctrlKey: true }), true);
  assert.equal(k({ metaKey: true }), true);
  assert.equal(k({ ctrlKey: true, code: "IntlBackslash" }), true, "a layout's own \\ key");
  assert.equal(k({ ctrlKey: true, key: "#" }), true, "the US \\ key on another layout");
  assert.equal(k({ ctrlKey: true, shiftKey: true, key: "|" }), true, "Shift does not matter");
  assert.equal(k({}), false, "\\ alone types a backslash");
  assert.equal(k({ ctrlKey: true, repeat: true }), false, "held down: one switch");
  assert.equal(k({ ctrlKey: true, key: "b", code: "KeyB" }), false, "Ctrl/⌘+B is the Code page's (its explorer)");
  assert.equal(k({ metaKey: true, key: "k", code: "KeyK" }), false, "Ctrl/⌘+K is Search");
  assert.equal(N.isToggleKey(null), false);
});

test("the button's tooltip says what a click does and the key for it; aria-keyshortcuts in its own spelling", () => {
  assert.deepEqual(plain(N.labels(false, false)), { title: "Collapse the sidebar (Ctrl+\\)", keys: "Control+\\" });
  assert.deepEqual(plain(N.labels(true, false)), { title: "Expand the sidebar (Ctrl+\\)", keys: "Control+\\" });
  assert.deepEqual(plain(N.labels(true, true)), { title: "Expand the sidebar (⌘\\)", keys: "Meta+\\" });
});
