// static/updatecheck.js's pure part: what the Check for updates line says (Home's header, Settings' Daily release check
// row) for each state of the release check, a click waiting for its answer, and that answer's "not yet".
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, plain, source } from "./load.mjs";

const U = load("updatecheck.js").bnUpdateCheck._pure;
const NOW = Date.parse("2026-10-18T13:51:00Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const base = { enabled: true, installed: "v0.9.0", latest: "v0.9.0", available: false, checked_at: iso(12 * 60000),
  error: null, limited: false, retry_at: null, checking: false };
const say = (u, busy = false, note = null) => plain(U.describe(u, NOW, busy, note));

test("up to date: when it checked, and the button; Details say why, GitHub's public list and that nothing is sent", () => {
  const d = say(base);
  assert.equal(d.state, "current");
  assert.equal(d.text, "Up to date");
  assert.equal(d.when, "checked 12 min ago");
  assert.equal(d.disabled, false);
  assert.equal(d.why, "v0.9.0 is the newest release, and this install has it. Check for updates asks GitHub's public list of bedrock-now releases now. It sends nothing about this install.");
  assert.equal(say({ ...base, checked_at: iso(20000) }).when, "checked just now");
  assert.equal(say({ ...base, checked_at: iso(3 * 3600000) }).when, "checked 3 h ago");
  assert.equal(say({ ...base, checked_at: iso(26 * 3600000) }).when, "checked yesterday");
  assert.equal(say({ ...base, checked_at: iso(4 * 86400000) }).when, "checked 4 days ago");
});

test("checking: from a click waiting for its answer, or a check the portal runs; the button waits", () => {
  for (const d of [say(base, true), say({ ...base, checking: true }), say(null, true)]) {
    assert.equal(d.state, "checking");
    assert.equal(d.text, "Checking for updates…");
    assert.equal(d.disabled, true);
  }
});

test("a newer release: 'Update available — <tag>' (a link to Home's card), with when it checked", () => {
  const d = say({ ...base, installed: "v0.8.0", available: true });
  assert.equal(d.state, "available");
  assert.equal(d.link, "v0.9.0");
  assert.equal(d.when, "checked 12 min ago");
  // only a release tag is shown as one
  assert.equal(say({ ...base, available: true, latest: "v1<script>" }).link, "");
});

test("GitHub unreachable: try again later (the reason in the tooltip); the button stays", () => {
  const d = say({ ...base, error: "api.github.com did not answer (ConnectError)", checked_at: iso(3 * 60000) });
  assert.equal(d.state, "error");
  assert.equal(d.text, "GitHub could not be reached — try again later");
  assert.equal(d.when, "checked 3 min ago");
  assert.equal(d.disabled, false);
  assert.match(d.why, /^The last check failed: api\.github\.com did not answer \(ConnectError\)\. Check for updates asks GitHub's public list/);
});

test("GitHub's rate limit: try again after HH:MM, the button off until then; past it, try again now", () => {
  const at = new Date(NOW + 14 * 60000).toISOString();
  const d = say({ ...base, error: "api.github.com refused: … (HTTP 403)", limited: true, retry_at: at });
  assert.equal(d.state, "limit");
  assert.match(d.text, /^GitHub's limit for this hour — try again after \d{1,2}[:.]\d{2}/);
  assert.equal(d.text.endsWith(U.clock(at, NOW)), true);
  assert.equal(d.disabled, true);
  assert.match(d.why, /^GitHub answers 60 requests an hour from one address without an account/);
  const past = say({ ...base, error: "x (HTTP 403)", limited: true, retry_at: new Date(NOW - 1000).toISOString() });
  assert.equal(past.state, "error");
  assert.equal(past.disabled, false);
  // another day: the date too
  assert.match(U.clock(new Date(NOW + 30 * 3600000).toISOString(), NOW), /, /);
});

test("the click's answer: 'checked a moment ago' until then, then the status speaks again; the portal away", () => {
  const again = say(base, false, { kind: "again", wait: 25, until: NOW + 25000 });
  assert.equal(again.state, "again");
  assert.equal(again.text, "Checked a moment ago — try again in 25 s");
  assert.equal(again.disabled, false);
  assert.equal(again.when, "");
  assert.equal(say(base, false, { kind: "again", wait: 25, until: NOW - 1 }).state, "current");
  // said once, as answered: no countdown in the announced text
  assert.equal(say(base, false, { kind: "again", wait: 25, until: NOW + 3000 }).text, again.text);
  const failed = say(base, false, { kind: "failed", until: NOW + 60000 });
  assert.equal(failed.text, "The portal could not be reached — try again");
});

test("no answer yet, the daily check off, an unknown installed version", () => {
  assert.equal(say({ ...base, latest: null, checked_at: null }).text, "Not checked yet");
  const off = say({ ...base, enabled: false, latest: null, checked_at: null });
  assert.equal(off.text, "Daily release check is off");
  assert.match(off.why, /^The daily release check is off \(Settings › Updates & backups\): a click asks once\. Check for updates asks/);
  assert.match(say({ ...base, enabled: false }).why, /this install has it\. The daily release check is off/);
  // with the check off, a click's answer is shown as any other
  assert.equal(say({ ...base, enabled: false }).text, "Up to date");
  assert.equal(say({ ...base, installed: null }).text, "Newest release: v0.9.0");
  // before Home's summary: only the button
  assert.deepEqual([say(null).state, say(null).text, say(null).disabled], ["", "", false]);
});

test("GitHub refused otherwise (no rate-limit headers): said as such, the button waits for the time given", () => {
  const at = new Date(NOW + 50 * 60000).toISOString();
  const d = say({ ...base, error: "api.github.com refused the request (HTTP 403)", refused: true, limited: false, retry_at: at });
  assert.equal(d.state, "refused");
  assert.equal(d.text, `GitHub refused the request — try again after ${U.clock(at, NOW)}`);
  assert.equal(d.disabled, true);
  assert.match(d.why, /^GitHub refused the last check \(api\.github\.com refused the request \(HTTP 403\)\), so the portal waits up to an hour/);
  assert.equal(say({ ...base, error: "x", refused: true, retry_at: null }).disabled, false);
});

test("the clicks' hourly cap: said with the time, in minutes' terms; the button waits", () => {
  const at = new Date(NOW + 59 * 60000).toISOString();
  const d = say(base, false, { kind: "hourly", wait: 3540, at, until: NOW + 3540000 });
  assert.equal(d.state, "hourly");
  assert.equal(d.text, `Checked many times this hour — try again after ${U.clock(at, NOW)}`);
  assert.ok(!/\d{3,} s/.test(d.text));
  assert.equal(d.disabled, true);
});

test("a summary asked mid-check landing after the click's answer: the answer stays, for a short while only", () => {
  const answer = { ...base, checked_at: iso(1000) };
  const stale = { ...base, latest: "v0.8.0", checked_at: iso(3600000), checking: true };
  const answered = { u: answer, at: NOW - 2000 };
  assert.equal(U.fresher(stale, answered, NOW), answer);
  assert.equal(U.fresher({ ...stale, checked_at: null }, answered, NOW), answer);
  const newer = { ...base, checked_at: iso(0) };
  assert.equal(U.fresher(newer, answered, NOW), newer);
  // later (or a clock set back): whatever the summary says
  assert.equal(U.fresher(stale, { u: answer, at: NOW - 60000 }, NOW), stale);
  assert.equal(U.fresher(stale, null, NOW), stale);
});

test("the page script: text only, the result announced, POST with the portal's header", () => {
  const js = source("updatecheck.js");
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "new RegExp"]) {
    assert.ok(!js.includes(sink), sink);
  }
  assert.match(js, /"aria-live": "polite"/);
  assert.match(js, /"aria-describedby": why\.id/);   // the reason and the privacy note: the button's description
  assert.match(js, /if \(d\.disabled\) \{ if \(typeof toast === "function"\) toast\(d\.text\); return; \}/);   // ⌘K honours it
  assert.match(js, /fetch\("\/api\/update\/check", \{ method: "POST", credentials: "same-origin"/);
});
