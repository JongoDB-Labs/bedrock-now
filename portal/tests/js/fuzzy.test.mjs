// static/fuzzy.js: what ranks first, and that hostile candidates and queries stay fast (linear-time scoring: one
// greedy pass and a Knuth–Morris–Pratt substring search, inputs capped) — earlier reviews found catastrophic regular
// expressions twice; none of these scripts builds one from input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, plain, source } from "./load.mjs";

const { bnFuzzy: F } = load("fuzzy.js");
const top = (items, q) => { const r = F.rank(items, q, (x) => x); return r.length ? r[0].item : undefined; };

test("ranking: substring and word starts first, characters in order still match, nothing else does", () => {
  const items = ["Spending & budgets", "BUDGET_TERMINAL", "Session length", "Owner email", "Automatic updates", "Back up now", "Costs & budgets"];
  assert.equal(top(items, "spend"), "Spending & budgets");
  assert.equal(top(items, "sesl"), "Session length");
  assert.equal(top(items, "auto upd"), "Automatic updates");
  assert.equal(top(items, "budget_t"), "BUDGET_TERMINAL");
  assert.equal(F.rank(items, "qqqz", (x) => x).length, 0);
  assert.equal(F.rank(items, "", (x) => x).length, items.length, "nothing typed: everything, in order");
  const m = plain(F.fuzzy(F.prepare("sl"), "Session length"));
  assert.deepEqual(m.hits, [0, 8]);
  // alt text matches too, a little lower, highlighting nothing
  const r = plain(F.rank([{ t: "Monthly limit", k: "BUDGET_SETUP" }], "budget_setup", (x) => x.t, (x) => x.k));
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].hits, []);
  // alt text by whole words only: letters scattered through a long summary are no match
  const long = { t: "Claude Code", k: "The Code page (Claude Code in the browser), the browser Terminal, and the models it uses" };
  assert.equal(F.rank([long], "costs budgets", (x) => x.t, (x) => x.k).length, 0);
  assert.equal(F.rank([long], "browser terminal", (x) => x.t, (x) => x.k).length, 1);
});

test("KMP finds substrings; the empty query matches at 0", () => {
  assert.equal(F.kmpFind("abcabcabd", F.prepare("abcabd")), 3);
  assert.equal(F.kmpFind("aaaa", F.prepare("aab")), -1);
  assert.equal(F.kmpFind("x", F.prepare("")), 0);
});

test("inputs are capped: the query at 64 characters, candidates at 256, 5,000 candidates per search", () => {
  assert.equal(F.prepare("x".repeat(10000)).q.length, 64);
  const far = "a".repeat(300) + "needle";
  assert.equal(F.fuzzy(F.prepare("needle"), far), null, "past 256 characters nothing is looked at");
  const many = Array.from({ length: 6000 }, (_, i) => `item ${i}`);
  assert.equal(F.rank(many, "item", (x) => x, null, 10000).length, 5000);
});

test("hostile input stays fast: 5,000 long near-miss candidates, a long query of one letter", () => {
  const cands = Array.from({ length: 5000 }, (_, i) => `${"a".repeat(1024)}${i}`);
  const t0 = Date.now();
  F.rank(cands, "a".repeat(200) + "b", (x) => x, (x) => x);
  F.rank(cands, "a".repeat(63) + "b", (x) => x);
  F.rank(cands, "a".repeat(64), (x) => x);
  F.rank(cands.map((c) => c.replace(/a/g, "ab")), "abababababababababababababababababababababababababababababababac", (x) => x);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `${ms} ms`);
  // a lower-cased string can be longer (İ): no hit past the candidate
  const m = plain(F.fuzzy(F.prepare("i"), "İİİİi"));
  assert.ok(m && m.hits.every((h) => h < 5));
});

test("no regular expression is built from input in the portal's scripts", () => {
  for (const f of ["fuzzy.js", "activity.js", "search.js", "code.js", "app.js", "settings.js", "tour.js", "updatecheck.js"]) {
    assert.ok(!/new RegExp\s*\(/.test(source(f)), `${f} builds a RegExp`);
  }
});
