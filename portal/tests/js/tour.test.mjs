// static/tour.js's pure parts: the saved state read back (bn.tour) with the steps this browser has opened — none new on
// a first visit, the old walkthrough's steps seen by a browser that went through it —, what the API step takes from
// /api/settings, and its snippets (the real port, YOUR_KEY, never a key).
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, plain, source } from "./load.mjs";

const T = load("tour.js").bnTour._pure;
// the ids of the walkthrough as it is now (tour.js's STEPS)
const ids = [...source("tour.js").matchAll(/^ {4}"?([a-z][a-z-]*)"?: \{\n/gm)].map((m) => m[1]);

test("the step ids: every one of the old walkthrough's still there but its Code page step, and the new ones", () => {
  for (const id of T.BEFORE.filter((x) => x !== "code")) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes("code"), "the old Code page step is split into the new ones");
  const fresh = ids.filter((x) => !T.BEFORE.includes(x));
  for (const id of ["git-hosts", "code-open", "code-modes", "code-models", "code-workspace", "code-context", "code-clone", "code-review",
    "code-run", "sandbox", "code-plugins", "api", "activity", "updates", "phone", "code-off"]) assert.ok(fresh.includes(id), id);
});

test("a first visit: nothing stored (or nothing readable) — no step is new", () => {
  for (const text of [null, "", "{", "5", "[]", "null"]) {
    const s = plain(T.parse(text, ids));
    assert.equal(s.first, true, String(text));
    assert.deepEqual(s.seen, []);
    assert.equal(s.cur, "welcome");
  }
});

test("a browser that went through an older walkthrough (no seen list): its steps are seen, the rest are new", () => {
  const old = JSON.stringify({ open: false, cur: "code", done: ["welcome", "aws", "signin-portal", "code"], skipped: ["openrouter"], base: { "open-webui": 0.01 } });
  const s = plain(T.parse(old, ids));
  assert.equal(s.first, false);
  assert.equal(s.open, false);
  assert.equal(s.cur, "welcome");   // (its old Code page step is gone)
  assert.deepEqual(s.done, ["welcome", "aws", "signin-portal"]);
  assert.deepEqual(s.base, { "open-webui": 0.01 });
  for (const id of T.BEFORE.filter((x) => x !== "code")) assert.ok(s.seen.includes(id), id);
  const fresh = T.unseen(ids, s.seen);
  assert.ok(fresh.includes("git-hosts") && fresh.includes("api") && fresh.includes("code-clone"), fresh.join(","));
  assert.ok(!fresh.includes("welcome") && !fresh.includes("shared"), fresh.join(","));
  // a step done or skipped counts as seen whatever the list says
  const s2 = plain(T.parse(JSON.stringify({ seen: [], done: ["api"], skipped: ["phone"] }), ids));
  assert.deepEqual(s2.seen.sort(), ["api", "phone"]);
});

test("a state of this version: its own seen list, unknown and odd ids dropped", () => {
  const s = plain(T.parse(JSON.stringify({ open: true, cur: "api", seen: ["api", "constructor", "__proto__", 5, "git-hosts", "api"] }), ids));
  assert.deepEqual(s.seen, ["api", "git-hosts"]);
  assert.equal(s.cur, "api");
  const h = plain(T.parse(JSON.stringify({ cur: "constructor", done: "x", base: { "open-webui": "1e9", toString: 1 }, seen: "x" }), ids));
  assert.equal(h.cur, "welcome");
  assert.deepEqual(h.done, []);
  assert.deepEqual(h.base, {});
  assert.ok(h.seen.includes("welcome") && !h.seen.includes("api"));   // (no list: the old walkthrough's)
});

test("what the walkthrough takes from /api/settings: plain values only, each checked", () => {
  const snap = (keys, helper = false) => ({ snapshot: { keys: keys.map(([key, value]) => ({ key, value })) }, helper: { running: helper } });
  assert.deepEqual(plain(T.cfgFrom(snap([["LITELLM_PORT", "4123"], ["TERMINAL_WORKSPACE", "~/ws"], ["TERMINAL_EGRESS", "host"], ["AUTO_UPDATE", "on"]], true))),
    { port: "4123", workspace: "~/ws", egress: "host", helper: true, auto: true, nightly: false });
  for (const bad of ["", "0", "65536", "4000; rm -rf", "40 00", "-1", "123456"]) assert.equal(T.cfgFrom(snap([["LITELLM_PORT", bad]])).port, "", bad);
  assert.equal(T.cfgFrom(snap([["TERMINAL_EGRESS", ""]])).egress, "internet");
  assert.equal(T.cfgFrom(snap([["TERMINAL_EGRESS", "false"]])).egress, "off");
  assert.equal(T.cfgFrom(snap([["TERMINAL_EGRESS", "OFF"]])).egress, "off");
  assert.equal(T.cfgFrom(snap([["LITELLM_PORT", 4000]])).port, "");   // (a value that is not text: not taken)
  assert.deepEqual(plain(T.cfgFrom(null)), { port: "", workspace: "", egress: "internet", helper: false, auto: false, nightly: false });
});

test("the API step's snippets: the address given, YOUR_KEY, an enabled model — nothing else", () => {
  const ex = T.snippets("http://127.0.0.1:4123", "claude-haiku-5-5");
  assert.match(ex.curl, /^curl http:\/\/127\.0\.0\.1:4123\/v1\/chat\/completions /);
  assert.match(ex.curl, /Authorization: Bearer YOUR_KEY/);
  assert.match(ex.openai, /OpenAI\(base_url="http:\/\/127\.0\.0\.1:4123\/v1", api_key="YOUR_KEY"\)/);
  assert.match(ex.anthropic, /anthropic\.Anthropic\(base_url="http:\/\/127\.0\.0\.1:4123", api_key="YOUR_KEY"\)/);
  for (const t of Object.values(ex)) {
    assert.ok(t.includes('"claude-haiku-5-5"'), t);
    assert.ok(!/sk-[A-Za-z0-9]/.test(t), t);
  }
  const rows = (names) => ({ models: { rows: names.map(([name, enabled, kind = "chat", provider = "Bedrock"]) => ({ name, enabled, kind, provider })) } });
  assert.equal(T.snippetModel(rows([["claude-sonnet-5-5", true], ["claude-haiku-5-5", true]])), "claude-haiku-5-5");
  assert.equal(T.snippetModel(rows([["claude-haiku-5-5", false], ["claude-sonnet-5-5", true]])), "claude-sonnet-5-5");
  assert.equal(T.snippetModel(rows([["titan-embed-v2", true, "embedding"], ["mistral-large-3", true]])), "mistral-large-3");
  assert.equal(T.snippetModel(rows([["or/x", true, "chat", "OpenRouter"]])), "claude-haiku-5-5");
  assert.equal(T.snippetModel(rows([['x"; import os', true]])), "claude-haiku-5-5");
  assert.equal(T.snippetModel(null), "claude-haiku-5-5");
});
