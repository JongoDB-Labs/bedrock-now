// static/activity.js's pure parts: budgets against BUDGET_ALERT_PCT, failed OpenRouter requests, Code sessions that
// wait for you, the server's items checked again, and this browser's read/dismissed state (ids and times only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, plain } from "./load.mjs";

const A = load("activity.js").bnActivity._pure;
const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";

const key = (alias, spend, max, extra = {}) => ({ alias, label: alias, spend, max_budget: max, reset_at: "2026-11-01T00:00:00Z", period_start: "2026-10-01", error: null, ...extra });

test("budgets: at BUDGET_ALERT_PCT a warning, at 100 % used up; one item per key, period and level", () => {
  const items = plain(A.budgetItems({ alert_pct: 80, keys: [key("open-webui", 17, 20), key("claude-code", 50, 50), key("setup", 0.01, 5),
    key("x", 9, null), key("y", 9, 10, { error: "LiteLLM did not answer" }), key("claude-code-terminal", 40, 50)] }));
  assert.deepEqual(items.map((i) => i.id), ["budget:open-webui:2026-10-01:warn", "budget:claude-code:2026-10-01:over", "budget:claude-code-terminal:2026-10-01:warn"]);
  assert.equal(items[0].level, "warn");
  assert.equal(items[0].title, "open-webui: 85% of its budget used");
  assert.match(items[0].text, /\$17\.00 of \$20\.00 this period · resets Nov 1/);
  assert.equal(items[0].link, "#settings/BUDGET_OPENWEBUI");
  assert.equal(items[1].level, "bad");
  assert.match(items[1].text, /^Requests with this key are refused/);
  assert.equal(items[2].link, "#settings/BUDGET_TERMINAL");
  // a higher alert threshold: 85 % says nothing yet; an odd one falls back to 80
  assert.equal(A.budgetItems({ alert_pct: 90, keys: [key("open-webui", 17, 20)] }).length, 0);
  assert.equal(A.budgetItems({ alert_pct: "x", keys: [key("open-webui", 17, 20)] }).length, 1);
  assert.equal(A.budgetItems(null).length, 0);
  // ids carry no odd characters, whatever the summary says
  const odd = plain(A.budgetItems({ keys: [key("a<b>/c", 10, 10, { period_start: "2026-10-01\"><x" })] }));
  assert.match(odd[0].id, /^[A-Za-z0-9:._@+-]+$/);
});

test("OpenRouter: failed requests of the last hours as one item, keyed by the newest", () => {
  const spend = { openrouter_usage: { failures: { hours: 24, groups: [
    { label: "rate limited", count: 3, last_at: "2026-10-17T10:00:00+00:00", fix: "Wait a minute." },
    { label: "no credits", count: 1, last_at: "2026-10-17T11:00:00+00:00" }] } } };
  const [it] = plain(A.openrouterItems(spend));
  assert.equal(it.title, "4 failed OpenRouter requests in the last 24 hours");
  assert.equal(it.id, "openrouter:2026-10-17T11:00:0000:00");
  assert.match(it.text, /3× rate limited; 1× no credits\. Wait a minute\./);
  assert.equal(A.openrouterItems({ openrouter_usage: { failures: { groups: [] } } }).length, 0);
  assert.equal(A.openrouterItems({ openrouter_usage: { failures: { error: "x", groups: [{ count: 1 }] } } }).length, 0);
});

test("Code sessions: each wait is an item of its own, kept across reports while it lasts", () => {
  const now = 1_800_000_000_000;
  const report = { sessions: [{ id: U1, state: "waiting", title: "Fix the login" }, { id: U2, state: "working", title: "x" }, { id: "nope", state: "waiting" }] };
  const a = plain(A.codeItems(report, {}, now));
  assert.deepEqual(a.items.map((i) => i.id), [`code:${U1}:${now / 1000}`]);
  assert.deepEqual(a.episodes, { [U1]: now });
  assert.equal(a.items[0].text, "Fix the login");
  assert.equal(a.items[0].data.session, U1);
  // still waiting later: the same item; answered: gone, and the next wait is new
  const b = plain(A.codeItems(report, a.episodes, now + 60000));
  assert.equal(b.items[0].id, a.items[0].id);
  assert.deepEqual(plain(A.codeItems({ sessions: [{ id: U1, state: "idle" }] }, b.episodes, now + 120000)).episodes, {});
  const c = plain(A.codeItems(report, {}, now + 180000));
  assert.notEqual(c.items[0].id, a.items[0].id);
  assert.equal(A.codeItems(null, {}, now).items.length, 0);
});

test("Git hosts' uses: Claude's git and gh each said as theirs, worth a notification; yours plain", () => {
  const now = 1_800_000_000_000;
  const git = [{ id: "aaaaaaaaaaaa", at: now, who: "claude", action: "credential", host: "GitHub", target: "github.com/o/r.git", ok: true },
    { id: "bbbbbbbbbbbb", at: now, who: "claude", action: "gh", host: "GitHub", target: "github.com: gh pr create", ok: true },
    { id: "cccccccccccc", at: now, who: "claude", action: "gh", host: "GitHub", target: "github.com", ok: false },
    { id: "dddddddddddd", at: now, who: "you", action: "push", host: "GitHub", target: "github.com/o/r", ok: true }];
  const items = plain(A.codeItems({ sessions: [], git }, {}, now)).items;
  assert.deepEqual(items.map((i) => i.title), ["Claude's git used the Git host GitHub", "Claude's gh used the Git host GitHub",
    "Claude's gh was refused the Git host GitHub", "Pushed (GitHub)"]);
  assert.deepEqual(items.map((i) => i.notify), [true, true, true, false]);
  assert.equal(items[1].text, "github.com: gh pr create");
});

test("the server's items are checked again: ids, levels, links (a place in the portal, nothing else)", () => {
  const ok = { id: "job:helper:abc:done", kind: "job", level: "good", title: "Update finished", text: "Updated to v0.11.0", at: 1800000000, link: "#home", notify: true,
    data: { origin: "helper", action: "update", phase: "done" } };
  assert.deepEqual(plain(A.takeServerItem(ok)), { ...ok, data: { origin: "helper", action: "update", phase: "done" } });
  for (const bad of [{ ...ok, id: "a b" }, { ...ok, id: "" }, { ...ok, level: "loud" }, null, "x"]) assert.equal(A.takeServerItem(bad), null);
  for (const link of ["javascript:alert(1)", "https://evil.example/", "#home/../x", "//evil", "#settings/a/b/c/d"]) {
    assert.equal(A.takeServerItem({ ...ok, link }).link, "", link);
  }
  assert.equal(A.takeServerItem({ ...ok, notify: false }).notify, false);
  assert.equal(A.takeServerItem({ ...ok, at: "soon" }).at, null);
  const cd = plain(A.takeServerItem({ ...ok, kind: "code-default", data: { at: 5, workspace: "/w", egress: "yes", terminal: true, extra: 1 } }));
  assert.deepEqual(cd.data, { at: 5, workspace: "/w", egress: false, terminal: true });
});

test("this browser's state: anything odd dropped, old entries pruned, the newest 300 kept", () => {
  const s = plain(A.loadState(JSON.stringify({ notify: true, read: { "a:1": 5, "bad id": 6, "b:2": "x" }, dismissed: [1, 2], first: null, extra: 1 })));
  assert.deepEqual(s, { v: 1, notify: true, read: { "a:1": 5 }, dismissed: {}, first: {}, notified: {}, codeEp: {} });
  assert.equal(A.loadState("{not json").notify, false);
  const now = 1_800_000_000_000;
  const big = A.loadState("{}");
  for (let i = 0; i < 400; i++) big.read[`id:${i}`] = now - i * 1000;
  big.read.old = now - 50 * 86400000;
  big.codeEp[U1] = now - 90 * 86400000;   // a session that waits for weeks keeps its episode
  const p = plain(A.prune(big, now));
  assert.equal(Object.keys(p.read).length, 300);
  assert.ok(!("old" in p.read) && "id:0" in p.read && !("id:399" in p.read));
  assert.ok(U1 in p.codeEp);
});

test("merge: newest first, an item without a time takes when this browser first saw it; unread excludes states", () => {
  const server = [{ id: "s:1", at: 100, notify: true }, { id: "s:2", at: 300, notify: false }];
  const local = [{ id: "l:1", at: null, notify: true }, { id: "s:1", at: 999, notify: true }];
  const m = plain(A.merge(server, local, { "l:1": 200000 }, 0));
  assert.deepEqual(m.map((i) => [i.id, i.at]), [["s:1", 999], ["s:2", 300], ["l:1", 200]]);
  const st = { read: { "l:1": 1 }, dismissed: {} };
  assert.equal(A.unreadCount(m, st), 1, "s:2 only shows a state (a job running); l:1 is read");
});

test("a browser notification says fixed words only: no session title, prompt, job message or error on a lock screen", () => {
  const now = 1_800_000_000_000;
  const secret = "SECRET-prompt: deploy with key sk-live-123";
  const code = A.codeItems({ sessions: [{ id: U1, state: "waiting", title: secret }] }, {}, now).items[0];
  const job = A.takeServerItem({ id: "job:terminal:t-1-2:failed", kind: "job", level: "bad", title: `./stack config set failed ${secret}`,
    text: secret, at: 5, link: "#home", data: { origin: "terminal", action: "config", phase: "failed" } });
  const done = A.takeServerItem({ id: "job:helper:a:done", kind: "job", level: "good", title: "Update finished", text: secret, at: 5, link: "#home",
    data: { phase: "done" } });
  const [warn, over] = A.budgetItems({ alert_pct: 80, keys: [key("claude-code", 42.5, 50, { label: "Claude Code" }), key("setup", 9, 5, { label: "Setup and tests" })] });
  const or = A.openrouterItems({ openrouter_usage: { failures: { groups: [{ label: secret, count: 2, last_at: "2026-10-17T10:00:00+00:00", fix: secret }] } } })[0];
  const other = A.takeServerItem({ id: "models:5", kind: "models", level: "warn", title: secret, text: secret, at: 5, link: "" });
  const voice = A.takeServerItem({ id: "stt-notice:5", kind: "voice", level: "warn", title: secret, text: secret, at: 5, link: "#settings/STT_PROVIDER" });
  const got = [code, job, done, warn, over, or, other, voice].map((it) => plain(A.notificationText(it)));
  assert.deepEqual(got.map((n) => n.title), ["A Code session needs you", "A job failed", "A job finished", "Budget alert: Claude Code at 85 %",
    "Budget used up: Setup and tests", "OpenRouter requests failed", "A model check could not check every model",
    "Voice changed to browser speech"]);
  for (const n of got) {
    assert.equal(n.body, "Details in Activity, in the bedrock-now portal.");
    assert.ok(!JSON.stringify(n).includes("SECRET") && !JSON.stringify(n).includes("sk-live"), JSON.stringify(n));
  }
  assert.equal(A.notificationText({ kind: "whatever", title: secret }).title, "Something new in Activity");
});
