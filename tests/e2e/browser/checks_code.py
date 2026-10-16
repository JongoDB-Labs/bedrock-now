"""The optional Code page (./stack code; tests/e2e/run.sh --code turns it on in the throwaway, with the terminal): the
Code tab sits under Chat (under More on a phone) and follows the setting; the code host is locked until the portal
password is typed again, sends the main Caddy's policy whoever answers, and refuses other sites' Origins; then, through
the page's own API and WebSocket (so these checks hold for any frontend build, not only the plain page): a session
streams an answer (Haiku), a Bash permission prompt is allowed (the file appears in the workspace) or denied (it does
not), the Code tab's badge counts a waiting prompt, the model switches, a turn is interrupted, a slash command runs at
$0, a reload re-attaches and a closed session resumes, the workspace's files are listed, read, written (with the
"changed on disk" check), uploaded and deleted, and the session's spend comes from LiteLLM. Then the page itself (the
frontend build, code/web), driven like a person would: Haiku chosen, an answer streams, a Bash prompt allowed in its
card, Accept edits mode and an @-mentioned file edited (the diff opens in the editor), the / palette, an upload, a
model switch (no turn on the other model), an interrupt, the terminal panel, a reload without duplicates,
AskUserQuestion answered in its card, plugins from a marketplace in the workspace (one installed by a command shown
with its SHA-256 first; its commands in the palette), the MCP panel, and a phone — each with zero CSP violations
(Trusted Types enforced). With E2E_CODE_HOSTILE=1 (run.sh, after the suite: a stand-in on bn-coded's socket, as code
in the sandbox could start one) the page stays safe. Every check skips while the Code page is off (but the first two,
which check that state)."""

from __future__ import annotations

import json
import os
import re
import time
from urllib.parse import urlencode

from playwright.sync_api import expect as see

from common import ENV, HOST, PORT, SHOTS, Skip, check, expect, http, origin
from checks_browser import login, open_settings, shot

ON = ENV.get("CODE_ENABLED") == "true" and ENV.get("TERMINAL_ENABLED") == "true"
HOSTILE = os.environ.get("E2E_CODE_HOSTILE") == "1"
CODE = origin("code")
FORM = {"Content-Type": "application/x-www-form-urlencoded"}
HTML = {"Accept": "text/html,application/xhtml+xml"}
HAIKU = ENV.get("CLAUDE_BEDROCK_HAIKU_MODEL") or ""
# Expected while locked: the unlock page answers 401 (its forward_auth answer)
LOCKED_OK = [r"^401 (GET|POST) " + re.escape(CODE) + r"/(\.bn/unlock)?$", r"console.error Failed to load resource.*401"]


def need_on():
    if not ON:
        raise Skip("the Code page is off in this throwaway (tests/e2e/run.sh --code turns it on)")


def need_haiku():
    need_on()
    if not HAIKU:
        raise Skip("no Haiku model enabled (the Code page's checks use Haiku only)")


def csp_problems(csp: str) -> list[str]:
    """What the code host's Content-Security-Policy (the main Caddy's code_page) lacks."""
    want = ["default-src 'none'", "script-src 'self'", f"connect-src 'self' ws://code.{HOST}:* wss://code.{HOST}:*",
            "img-src 'self' data: blob:", "base-uri 'none'", "form-action 'none'", "object-src 'none'", f"frame-ancestors {origin()}",
            f"frame-src 'self' http://terminal.{HOST}:* https://terminal.{HOST}:*", "require-trusted-types-for 'script'", "trusted-types 'none'"]
    parts = [p.strip() for p in csp.split(";")]
    probs = [w for w in want if w not in parts]
    if not any(re.fullmatch(r"style-src 'self' 'nonce-[0-9a-f-]{36}'", p) for p in parts):
        probs.append("style-src: not 'self' plus one nonce")
    return probs


def unlock_page(page):
    """On the code host (top level or framed): the unlock form, then the page."""
    page.locator("h1", has_text="Unlock the Code page").wait_for(timeout=20000)
    page.fill("#password", ENV["PORTAL_PASSWORD"])
    page.click("form[action='/.bn/unlock'] button[type=submit]")


def code_frame(page, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        for f in page.frames:
            if f.url.startswith(CODE):
                return f
        page.wait_for_timeout(250)
    raise AssertionError("no code frame")


# The page's own API and WebSocket, driven from inside a page on the code host (its cookies, its Origin).
CLIENT_JS = """() => {
  if (window.__bn) return true;
  const bn = window.__bn = { msgs: [], n: 0, ws: null };
  bn.open = () => new Promise((res, rej) => {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onmessage = (e) => bn.msgs.push(JSON.parse(e.data));
    ws.onopen = () => { bn.ws = ws; res(true); };
    ws.onerror = () => rej(new Error('websocket error'));
  });
  bn.send = (m) => bn.ws.send(JSON.stringify(m));
  bn.api = async (method, path, body, headers) => {
    const opts = { method, credentials: 'same-origin', headers: headers || {} };
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') opts.body = body; else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    }
    const r = await fetch(path, opts);
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, json, text: text.slice(0, 2000), headers: Object.fromEntries(r.headers.entries()) };
  };
  return true;
}"""


class Code:
    """A page on the code host, unlocked, with the in-page client."""

    def __init__(self, ctx, name, device="desktop"):
        self.page, self.rec = ctx.page(name, device)
        login(self.page)
        self.page.goto(CODE + "/")
        unlock_page(self.page)
        self.page.wait_for_load_state("domcontentloaded")
        self.page.wait_for_function("() => document.querySelector('meta[name=bn-csp-nonce]') !== null", timeout=20000)
        self.page.evaluate(CLIENT_JS)
        self.page.evaluate("() => window.__bn.open()")
        self.seen = 0

    @classmethod
    def on(cls, page, rec, goto=True):
        """The client in a page of a browser that is already signed in and unlocked."""
        c = cls.__new__(cls)
        c.page, c.rec, c.seen = page, rec, 0
        if goto:
            page.goto(CODE + "/")
        page.wait_for_function("() => document.querySelector('meta[name=bn-csp-nonce]') !== null", timeout=20000)
        page.evaluate(CLIENT_JS)
        page.evaluate("() => window.__bn.open()")
        return c

    def api(self, method, path, body=None, headers=None):
        return self.page.evaluate("([m, p, b, h]) => window.__bn.api(m, p, b, h)", [method, path, body, headers])

    def send(self, msg):
        self.page.evaluate("(m) => window.__bn.send(m)", msg)

    def msgs(self):
        return self.page.evaluate("() => window.__bn.msgs")

    def wait(self, pred, what, timeout=120, since=None):
        """The first message after `since` (default: everything not consumed yet) that matches pred."""
        start = self.seen if since is None else since
        t0 = time.time()
        while time.time() - t0 < timeout:
            ms = self.msgs()
            for i in range(start, len(ms)):
                if pred(ms[i]):
                    self.seen = i + 1
                    return ms[i]
            self.page.wait_for_timeout(200)
        raise AssertionError(f"no {what} within {timeout} s; last messages: {json.dumps(self.msgs()[-6:])[:600]}")

    def request(self, msg, timeout=60):
        req = f"r{time.time_ns()}"
        n = len(self.msgs())
        self.send({**msg, "req": req})
        r = self.wait(lambda m: m.get("type") == "reply" and m.get("req") == req, f"reply to {msg['type']}", timeout, since=n)
        expect(r.get("ok"), f"{msg['type']}: {r.get('error')}")
        return r.get("data")

    def events(self, session, since=0):
        return [m["ev"] for m in self.msgs()[since:] if m.get("type") == "event" and m.get("session") == session]

    def turn(self, session, text, timeout=150):
        """A prompt, then every event up to its result."""
        n = len(self.msgs())
        self.request({"type": "prompt", "session": session, "text": text})
        self.wait(lambda m: m.get("type") == "event" and m.get("session") == session and m["ev"]["type"] == "result", "result", timeout, since=n)
        return self.events(session, n)

    def new_session(self, model="haiku", mode="default"):
        r = self.api("POST", "/api/sessions", {"model": model, "mode": mode})
        expect(r["status"] == 200, f"POST /api/sessions: {r['status']} {r['text']}")
        sid = r["json"]["id"]
        self.request({"type": "attach", "session": sid, "since": 0})
        return sid


def text_of(evs):
    return "".join(e["text"] for e in evs if e["type"] == "text")


# --- the tab and the host (no Bedrock calls) ---

@check("browser", "code-tab-under-chat")
def tab(ctx):
    page, rec = ctx.page("code-tab")
    login(page)
    page.wait_for_selector("#home:not([hidden])")
    t = page.locator(".tab[data-tab=code]")
    line = page.inner_text("section.claude .code-line")
    if not ON:
        expect(t.count() == 0 and "./stack code enable" in line, f"off: tab {t.count()}, card {line!r}")
        page.evaluate("location.hash = '#code'")
        page.locator(".tab[data-tab=home][aria-current=page]").wait_for(timeout=10000)
        rec.save()
        return "off: no tab, #code falls back to Home, the card says ./stack code enable"
    order = page.eval_on_selector_all(".tabs > li > .tab", "els => els.map(e => e.dataset.tab)")
    expect(order[:3] == ["home", "chat", "code"], f"tab order {order}")
    expect(page.locator(".popout[data-app=code]").get_attribute("href") == CODE + "/", "pop-out")
    expect("Code tab" in line, f"card {line!r}")
    page.click(".tab[data-tab=code]")
    f = code_frame(page)
    unlock_page(f)
    f = code_frame(page)
    f.wait_for_function("() => document.querySelector('meta[name=bn-csp-nonce]') !== null", timeout=20000)
    page.wait_for_timeout(1500)
    shot(page, "50-code-tab")
    plain = f.locator("form#ask").count() == 1
    probs = rec.problems(allow=LOCKED_OK)
    rec.save()
    expect(not probs, f"errors (CSP violations included): {probs}")
    # a phone: not in the bottom bar; under More, full screen
    page, rec = ctx.page("code-phone", "phone")
    login(page)
    page.wait_for_selector(".shell")
    expect(not page.locator(".tab[data-tab=code]").is_visible(), "the Code tab in the phone's bottom bar")
    page.click("#more-btn")
    link = page.locator("#more-sheet .sheet-link[data-app=code]")
    link.wait_for(timeout=5000)
    expect(link.get_attribute("href") == CODE + "/", f"More → Code {link.get_attribute('href')}")
    shot(page, "51-code-phone-more")
    rec.save()
    return f"tabs {order[:3]}; framed {'plain page' if plain else 'frontend build'} after the unlock, no console errors or CSP violations; phone: under More"


@check("http", "code-host-locked-policy-origin")
def host(ctx):
    need_on()
    r = http("GET", "code", "/", HTML)
    expect(r.status == 302 and (r.header("location") or "").startswith(origin() + "/login?next="), f"no session: {r.status}")
    s = ctx.session()
    r = http("GET", "code", "/", HTML, cookie=s)
    expect(r.status == 401 and "Unlock the Code page" in r.text, f"session only: {r.status}")
    expect(f"frame-ancestors {origin()}" in (r.header("content-security-policy") or ""), "unlock page framing")
    body = urlencode({"password": ENV["PORTAL_PASSWORD"]})
    for o in ("http://evil.example", origin(), origin("terminal")):
        r = http("POST", "code", "/.bn/unlock", {**FORM, "Origin": o}, body, cookie=s)
        expect(r.status == 403, f"unlock from {o}: {r.status}")
    r = http("POST", "code", "/.bn/unlock", {**FORM, "Origin": CODE}, body, cookie=s)
    c = next((c for c in r.headers_all("set-cookie") if c.startswith("bn_code=")), "")
    expect(r.status == 303 and c and "HttpOnly" in c and "Domain" not in c, f"unlock: {r.status} {c[:40]}")
    jar = f"{s}; {c.split(';', 1)[0]}"
    r = http("GET", "code", "/", HTML, cookie=jar)
    expect(r.status == 200, f"unlocked: {r.status}")
    csp = r.header("content-security-policy") or ""
    expect(not csp_problems(csp), f"CSP lacks {csp_problems(csp)}: {csp}")
    nonce = re.search(r"'nonce-([0-9a-f-]{36})'", csp).group(1)
    expect(f'<meta name="bn-csp-nonce" content="{nonce}">' in r.text, "the page's nonce meta is not this response's CSP nonce")
    expect(f'<meta name="bn-portal-origin" content="{origin()}">' in r.text, "portal origin meta")
    expect(r.header("x-content-type-options") == "nosniff" and r.header("referrer-policy") == "same-origin", "headers")
    expect(not r.headers_all("set-cookie") and r.header("x-frame-options") is None, "cookies or X-Frame-Options from upstream")
    r2 = http("GET", "code", "/", HTML, cookie=jar)
    expect(re.search(r"'nonce-([0-9a-f-]{36})'", r2.header("content-security-policy")).group(1) != nonce, "the nonce is per request")
    # the portal's answers on the code host, after the check
    m = http("GET", "code", "/.bn/models", cookie=jar)
    expect(m.status == 200 and m.json()["models"] and all(x["id"].startswith("claude-") for x in m.json()["models"]), f"/.bn/models {m.status}")
    expect(http("GET", "code", "/.bn/models", cookie=s).status == 401, "/.bn/models without the unlock")
    expect(http("GET", "code", "/.bn/spend?session=../../etc", cookie=jar).status == 400, "/.bn/spend bad session")
    expect(http("GET", "code", "/.bn/whatever", cookie=jar).status == 404, "other /.bn/ paths")
    # state changes: only with the page's own Origin (the portal and the backend both check)
    for o in (None, "http://evil.example", origin()):
        h = {"Content-Type": "application/json", **({"Origin": o} if o else {})}
        r = http("POST", "code", "/api/sessions", h, "{}", cookie=jar)
        expect(r.status == 403, f"POST /api/sessions with Origin {o}: {r.status}")
    r = http("GET", "code", "/api/state", cookie=jar)
    st = r.json()
    expect(r.status == 200 and st["versions"]["claudeCode"] == "2.1.296" and st["limits"]["maxOpen"] == 4, f"/api/state {r.text[:200]}")
    return f"login → unlock form → (other Origins refused) → unlocked: CSP with a per-request nonce = the page's meta; /.bn/models {len(m.json()['models'])} models; Claude Code {st['versions']['claudeCode']} via SDK {st['versions']['sdk']}"


# --- a session (Haiku): stream, permissions, badge, model switch, interrupt, slash command, re-attach, resume ---

@check("browser", "code-session-streams-an-answer")
def stream(ctx):
    need_haiku()
    c = Code(ctx, "code-stream")
    sid = c.new_session("haiku", "default")
    evs = c.turn(sid, "Reply with exactly the word: pong")
    init = next((e for e in evs if e["type"] == "init"), None)
    res = [e for e in evs if e["type"] == "result"][-1]
    expect(init and "haiku" in init["model"] and init["cwd"] == "/workspace" and init["permissionMode"] == "default", f"init {init}")
    expect(init["cliVersion"] == "2.1.296" and any(s["name"] == "bedrock-shared" for s in init["mcp"]), f"init {init}")
    user = next((e for e in evs if e["type"] == "user"), None)
    expect(user and re.fullmatch(r"[0-9a-f-]{36}", user["uuid"] or ""), f"the prompt's echo: {user}")
    expect(any(e["type"] == "delta" for e in evs), "no streamed delta")
    expect("pong" in text_of(evs).lower() and res["subtype"] == "success", f"answer {text_of(evs)!r}, {res}")
    ctx.code_session = sid
    shot(c.page, "52-code-api-page")
    probs = c.rec.problems(allow=LOCKED_OK)
    c.rec.save()
    expect(not probs, f"errors: {probs}")
    ctx.code_prompt_uuid = user["uuid"]
    return f"session {sid[:8]}: init {init['model']}, {sum(e['type'] == 'delta' for e in evs)} deltas, answer {text_of(evs)!r}, result {res['subtype']} in {res['duration']} ms"


@check("browser", "code-permission-allow-deny-and-badge")
def permission(ctx):
    need_haiku()
    sid = getattr(ctx, "code_session", None)
    if not sid:
        raise Skip("needs the session of code-session-streams-an-answer")
    # the portal with the Code tab open (its badge), and a page on the code host driving the session
    portal, prec = ctx.page("code-badge")
    login(portal)
    portal.click(".tab[data-tab=code]")
    f = code_frame(portal)
    unlock_page(f)
    code_frame(portal).wait_for_function("() => document.querySelector('meta[name=bn-csp-nonce]') !== null", timeout=20000)
    drv = Code.on(portal.context.new_page(), prec)   # the same browser: the unlock in the frame counts there too
    drv.request({"type": "attach", "session": sid, "since": 0})
    drv.seen = len(drv.msgs())
    name = f"e2e-code-{int(time.time())}.txt"
    n = len(drv.msgs())
    drv.request({"type": "prompt", "session": sid, "text": f"Use the Bash tool to run exactly this command, then reply with the word done: echo hello-from-code > {name}"})
    p = drv.wait(lambda m: m.get("type") == "permission", "permission prompt", 120, since=n)
    expect(p["tool"] == "Bash" and name in json.dumps(p["input"]), f"prompt {p}")
    portal.locator(".tab[data-tab=code] .tab-badge:not([hidden])", has_text="1").wait_for(timeout=15000)
    shot(portal, "53-code-permission-badge")
    # an answer for another session's prompt is refused (answers carry the prompt's own session)
    wrong = drv.page.evaluate("(m) => { window.__bn.send(m); return true; }", {"type": "permission", "id": p["id"], "session": "00000000-0000-4000-8000-000000000000", "decision": "once", "req": "wrong"})
    expect(wrong and drv.wait(lambda m: m.get("type") == "reply" and m.get("req") == "wrong", "the refusal", 10, since=n).get("ok") is False, "an answer with another session was taken")
    drv.request({"type": "permission", "id": p["id"], "session": sid, "decision": "once"})
    drv.wait(lambda m: m.get("type") == "event" and m["session"] == sid and m["ev"]["type"] == "result", "result", 150, since=n)
    portal.locator(".tab[data-tab=code] .tab-badge[hidden]").wait_for(state="attached", timeout=15000)
    r = drv.api("GET", f"/api/fs/file?path={name}")
    expect(r["status"] == 200 and r["json"]["text"].strip() == "hello-from-code", f"the file after Allow: {r['status']} {r['text'][:100]}")
    tr = [e for e in drv.events(sid, n) if e["type"] == "tool_result"]
    # Deny: the command does not run
    denied = f"e2e-denied-{int(time.time())}.txt"
    n = len(drv.msgs())
    drv.request({"type": "prompt", "session": sid, "text": f"Use the Bash tool to run exactly this command: echo nope > {denied}"})
    p2 = drv.wait(lambda m: m.get("type") == "permission", "second permission prompt", 120, since=n)
    drv.request({"type": "permission", "id": p2["id"], "session": sid, "decision": "deny", "message": "not in this test"})
    drv.wait(lambda m: m.get("type") == "event" and m["session"] == sid and m["ev"]["type"] == "result", "result", 150, since=n)
    r = drv.api("GET", f"/api/fs/file?path={denied}")
    expect(r["status"] == 404, f"the denied file exists: {r['status']}")
    probs = prec.problems(allow=LOCKED_OK)
    prec.save()
    expect(not probs, f"errors: {probs}")
    return f"Allow once → {name} = hello-from-code ({len(tr)} tool result(s)); the Code tab's badge showed 1, then none; Deny → no {denied}"


@check("browser", "code-model-switch-interrupt-slash-command")
def switch(ctx):
    need_haiku()
    sid = getattr(ctx, "code_session", None)
    if not sid:
        raise Skip("needs the session of code-session-streams-an-answer")
    c = Code(ctx, "code-switch")
    c.request({"type": "attach", "session": sid, "since": 10 ** 9})
    c.request({"type": "set_model", "session": sid, "model": HAIKU})   # the alias → the explicit id: a cheap pairing
    evs = c.turn(sid, "Reply with exactly the word: ok")
    models = sorted({e.get("model") for e in evs if e["type"] == "text"})
    expect(models == [HAIKU], f"after set_model {HAIKU}: text from {models}")
    # interrupt after the first streamed text: the turn ends early, the process stays
    n = len(c.msgs())
    c.request({"type": "prompt", "session": sid, "text": "Count from 1 to 400, one number per line, nothing else."})
    c.wait(lambda m: m.get("type") == "event" and m["session"] == sid and m["ev"]["type"] == "delta", "first delta", 120, since=n)
    c.request({"type": "interrupt", "session": sid})
    res = c.wait(lambda m: m.get("type") == "event" and m["session"] == sid and m["ev"]["type"] == "result", "result after interrupt", 60, since=n)["ev"]
    expect(res["subtype"] != "success" or res["is_error"], f"interrupted turn: {res}")
    st = c.api("GET", "/api/state")["json"]
    expect(any(s["id"] == sid and s["open"] for s in st["sessions"]), "the process ended with the interrupt")
    # a slash command: Claude Code answers itself, no model call
    evs = c.turn(sid, "/cost", 60)
    local = [e for e in evs if e["type"] == "local"]
    expect(local, f"/cost gave no local output: {[e['type'] for e in evs]}")
    cmds = c.request({"type": "commands", "session": sid})
    names = {x["name"] for x in cmds}
    expect({"context", "compact"} <= names, f"commands: {sorted(names)[:20]}")
    # the answers also come as messages of their own type, with the session (what the frontend reads)
    typed = c.wait(lambda m: m.get("type") == "commands" and m.get("session") == sid, "a typed commands message", 10, since=0)
    expect(len(typed["commands"]) == len(cmds), "typed commands")
    ctxu = c.request({"type": "context", "session": sid})
    expect(ctxu["totalTokens"] > 0 and ctxu["maxTokens"] > 0 and ctxu["categories"], f"context {ctxu}")
    cli_models = c.request({"type": "models", "session": sid})
    expect(cli_models and all("supportedEffortLevels" in m for m in cli_models), f"models {cli_models[:2]}")
    c.rec.save()
    return f"set_model {HAIKU} → text from {models}; interrupt → {res['subtype']}, process kept; /cost → {local[0]['text'][:60]!r}; {len(cmds)} commands (also as a typed message); context {ctxu['totalTokens']}/{ctxu['maxTokens']}"


@check("browser", "code-reattach-and-resume")
def reattach(ctx):
    need_haiku()
    sid = getattr(ctx, "code_session", None)
    if not sid:
        raise Skip("needs the session of code-session-streams-an-answer")
    c = Code(ctx, "code-reattach")   # a new browser: nothing but the backend remembers
    c.request({"type": "attach", "session": sid, "since": 0})
    att = next(m for m in c.msgs() if m.get("type") == "attached")
    replay = c.events(sid)
    expect(any(e["type"] == "user" and "pong" in e["text"] for e in replay), "the replay lacks the first prompt")
    expect("pong" in text_of(replay).lower(), "the replay lacks the first answer")
    rows = c.api("GET", "/api/sessions")["json"]["sessions"]
    row = next((r for r in rows if r["id"] == sid), None)
    expect(row and row["title"] and "pong" in row["firstPrompt"], f"session list: {row}")
    hj = c.api("GET", f"/api/sessions/{sid}/messages")["json"]
    hist = hj["messages"]
    expect(any(e["type"] == "text" and "pong" in e["text"].lower() for e in hist), "history lacks the answer")
    expect(hj["total"] >= 2 and hj["offset"] == 0, f"history total {hj['total']}")
    # the prompt's uuid: the same in the live echo and in the transcript (pages de-duplicate by it)
    want = getattr(ctx, "code_prompt_uuid", None)
    hu = [e["uuid"] for e in hist if e["type"] == "user"]
    expect(want in hu, f"the first prompt's uuid {want} is not in the history's {hu[:4]}")
    # closed, then a prompt resumes it (--resume in the sandbox: it remembers the conversation)
    expect(c.api("DELETE", f"/api/sessions/{sid}")["status"] == 200, "close")
    c.wait(lambda m: m.get("type") == "session_state" and m["session"] == sid and m["state"] == "ended", "ended", 30)
    evs = c.turn(sid, "Which single word did you reply with to my very first message? Reply with that word only.")
    expect("pong" in text_of(evs).lower(), f"after resume: {text_of(evs)!r}")
    c.rec.save()
    return f"re-attach: {len(replay)} events replayed (from seq {att['from']}); listed as {row['title'][:40]!r}; history {len(hist)} events; closed → prompt resumed it → {text_of(evs)!r}"


@check("browser", "code-ask-user-question")
def ask_user_question(ctx):
    need_haiku()
    c = Code(ctx, "code-question")
    sid = c.new_session("haiku", "default")
    n = len(c.msgs())
    c.request({"type": "prompt", "session": sid, "text": "Use the AskUserQuestion tool to ask me one question: \"Tea or coffee?\" with the two "
               "options Tea and Coffee. After my answer, reply with exactly the option I chose and nothing else."})
    t0 = time.time()
    p = None
    while time.time() - t0 < 120 and p is None:
        ms = c.msgs()[n:]
        p = next((m for m in ms if m.get("type") == "permission" and m.get("tool") == "AskUserQuestion"), None)
        if p is None and any(m.get("type") == "event" and m["ev"]["type"] == "result" for m in ms):
            c.rec.save()
            raise Skip("Haiku answered without asking (no AskUserQuestion call this time)")
        c.page.wait_for_timeout(300)
    expect(p, "no AskUserQuestion prompt")
    q = p["input"]["questions"][0]["question"]
    bad = c.page.evaluate("(m) => { window.__bn.send(m); return true; }", {"type": "permission", "id": p["id"], "session": sid, "decision": "answer", "answers": {"not the question": "Tea"}, "req": "bad"})
    expect(bad and c.wait(lambda m: m.get("type") == "reply" and m.get("req") == "bad", "the refusal", 10, since=n).get("ok") is False, "answers to another question were taken")
    c.request({"type": "permission", "id": p["id"], "session": sid, "decision": "answer", "answers": {q: "Coffee"}})
    c.wait(lambda m: m.get("type") == "event" and m["session"] == sid and m["ev"]["type"] == "result", "result", 120, since=n)
    evs = c.events(sid, n)
    tr = next((e for e in evs if e["type"] == "tool_result"), None)
    expect("coffee" in text_of(evs).lower(), f"the answer did not reach Claude: {text_of(evs)!r} (tool result {tr and tr['text'][:120]!r})")
    c.rec.save()
    return f"AskUserQuestion {q!r} → permission {{decision: answer, answers}} → Claude got 'Coffee' ({text_of(evs)!r}); answers to another question refused"


@check("browser", "code-files-through-the-sandbox")
def files(ctx):
    need_on()
    c = Code(ctx, "code-files")
    d = f"e2e-files-{int(time.time())}"
    expect(c.api("POST", "/api/fs/mkdir", {"path": d})["status"] == 200, "mkdir")
    up = c.page.evaluate("""async (d) => { const r = await fetch('/api/fs/upload?dir=' + encodeURIComponent(d), { method: 'POST',
        headers: { 'X-Filename': encodeURIComponent('notes ü.txt') }, body: 'line one\\n' }); return { status: r.status, json: await r.json() }; }""", d)
    expect(up["status"] == 200 and up["json"]["path"] == f"{d}/notes ü.txt", f"upload {up}")
    up2 = c.page.evaluate("""async (d) => (await fetch('/api/fs/upload?dir=' + encodeURIComponent(d), { method: 'POST',
        headers: { 'X-Filename': encodeURIComponent('notes ü.txt') }, body: 'x' })).json()""", d)
    expect(up2["path"] == f"{d}/notes ü-1.txt", f"second upload {up2}")
    p = f"{d}/notes ü.txt"
    r = c.api("GET", f"/api/fs/file?path={p}")["json"]
    expect(r["text"] == "line one\n" and not r["binary"], f"read {r}")
    w = c.api("PUT", f"/api/fs/file?path={p}", {"text": "line two\n", "ifMtimeMs": r["mtimeMs"]})
    expect(w["status"] == 200, f"save {w}")
    stale = c.api("PUT", f"/api/fs/file?path={p}", {"text": "lost\n", "ifMtimeMs": r["mtimeMs"]})
    expect(stale["status"] == 409 and "changed on disk" in stale["json"]["error"], f"stale save {stale}")
    ls = c.api("GET", f"/api/fs?path={d}")["json"]
    expect(sorted(e["name"] for e in ls["entries"]) == ["notes ü-1.txt", "notes ü.txt"], f"list {ls}")
    expect(c.api("POST", "/api/fs/rename", {"from": f"{d}/notes ü-1.txt", "to": f"{d}/moved.txt"})["status"] == 200, "rename")
    dl = c.page.evaluate("async (p) => { const r = await fetch('/api/fs/download?path=' + encodeURIComponent(p)); return [r.status, r.headers.get('content-disposition'), await r.text()]; }", f"{d}/moved.txt")
    expect(dl[0] == 200 and dl[1].startswith("attachment;") and dl[2] == "x", f"download {dl}")
    for bad in ("../etc/passwd", "/etc/passwd", "../../home"):
        r = c.api("GET", f"/api/fs/file?path={bad}")
        expect(r["status"] in (400, 404), f"{bad}: {r['status']}")
    rm = c.api("DELETE", f"/api/fs?path={d}")
    expect(rm["status"] == 200 and rm["json"]["trash"].startswith(".bedrock-now-trash/"), f"delete {rm}")
    c.rec.save()
    return f"mkdir, upload (a second one → '-1'), read, save, stale save → 409, list, rename, download (attachment), ../ refused, delete → {rm['json']['trash'][:50]}"


@check("browser", "code-spend-from-litellm")
def spend(ctx):
    need_haiku()
    sid = getattr(ctx, "code_session", None)
    if not sid:
        raise Skip("needs the session of code-session-streams-an-answer")
    c = Code(ctx, "code-spend")
    t0, d = time.time(), {}
    while time.time() - t0 < 90:   # LiteLLM writes its spend logs in batches
        r = c.api("GET", f"/.bn/spend?session={sid}")
        expect(r["status"] == 200, f"/.bn/spend {r['status']} {r['text'][:200]}")
        d = r["json"]
        if d["requests"] >= 4:
            break
        c.page.wait_for_timeout(3000)
    expect(d["requests"] >= 1 and d["total"] > 0, f"spend {d}")
    expect(all("haiku" in x["model"] for x in d["rows"]), f"models {[x['model'] for x in d['rows']]}")
    expect(d["key"]["alias"] == "claude-code-terminal" and d["key"]["max_budget"], f"key {d['key']}")
    c.rec.save()
    return f"session {sid[:8]}: {d['requests']} requests, ${d['total']:.4f} (LiteLLM's logs, the terminal key's rows); key spend ${d['key']['spend']:.4f} of ${d['key']['max_budget']}"


@check("browser", "code-plain-page-chat")
def plain_page(ctx):
    need_haiku()
    page, rec = ctx.page("code-plain")
    login(page)
    page.goto(CODE + "/")
    unlock_page(page)
    page.wait_for_selector("body")
    if page.locator("form#ask").count() == 0:
        rec.save()
        raise Skip("this image serves the frontend build (code/web), not the plain page")
    page.wait_for_function("() => document.querySelector('#model option') !== null", timeout=20000)
    page.select_option("#model", "haiku")
    page.fill("#prompt", "Reply with exactly the word: pong")
    page.click("#ask button[type=submit]")
    page.locator("#log .assistant", has_text=re.compile("pong", re.I)).wait_for(timeout=120000)
    page.locator("#log .muted", has_text="— success").wait_for(timeout=60000)
    shot(page, "54-code-plain-page")
    injected = page.evaluate("() => document.querySelectorAll('#log img, #log script, #log svg, #log a, [onerror], [onload]').length")
    probs = rec.problems(allow=LOCKED_OK)
    rec.save()
    expect(injected == 0 and not probs, f"injected {injected}, errors {probs}")
    return "plain page: Haiku, prompt → streamed 'pong' → success; nothing but text in the log; no console errors or CSP violations"


# --- the page itself (code/web's build): what a person does, through the real Caddy, backend and sandbox ---

# Every CSP / Trusted Types violation on the code host is recorded (and fails the check)
CSP_GUARD = """(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) =>
  window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || ''))); })();"""
UI = "e2e-ui"
MKT = "e2e-mkt"


def built_page(page):
    if page.locator("form#ask").count():
        raise Skip("this image serves the plain page (no code/web build)")


def ui_page(ctx, name, device="desktop", session=None):
    """The Code page on the code host, signed in and unlocked, connected; `session`: the one it shows first."""
    page, rec = ctx.page(name, device)
    page.add_init_script(CSP_GUARD)
    if session:
        # the page shows this session first (what it remembers per browser: its lastSession)
        page.add_init_script(
            "(() => { try { if (location.hostname.startsWith('code.')) { const p = JSON.parse(localStorage.getItem('bn.code.v1') || '{}');"
            f" p.lastSession = {json.dumps(session)}; localStorage.setItem('bn.code.v1', JSON.stringify(p)); }} }} catch (e) {{}} }})();")
    login(page)
    page.goto(CODE + "/")
    unlock_page(page)
    page.wait_for_load_state("domcontentloaded")
    built_page(page)
    see(page.get_by_test_id("conn")).to_have_text("Connected", timeout=30000)
    if session:
        # its transcript merges in after the live replay: counts of turns taken before it settles would be short
        see(page.get_by_test_id("turn-end").first).to_be_visible(timeout=30000)
        settled(page, "turn-end")
    ctx.code_ui_rec, ctx.code_ui_page = rec, page
    return page, rec


def settled(page, testid, quiet=1.5, timeout=30):
    """How many [data-testid=testid] the page shows once that number has not changed for `quiet` seconds."""
    t0 = since = time.time()
    last = -1
    while time.time() - t0 < timeout:
        n = page.get_by_test_id(testid).count()
        if n != last:
            last, since = n, time.time()
        elif time.time() - since >= quiet:
            return n
        page.wait_for_timeout(250)
    return last


def csp_clean(page, rec, allow=()):
    v = page.evaluate("window.__csp || []")
    probs = rec.problems(allow=LOCKED_OK + list(allow))
    rec.save()
    expect(not v and not probs, f"CSP violations {v[:4]}, errors {probs[:6]}")


def turns(page, n, timeout=150000):
    see(page.get_by_test_id("turn-end")).to_have_count(n, timeout=timeout)


def saved(fn):
    """The check's network/console log is kept even when it fails (the Recorder of its last page); a failure also
    leaves a screenshot and what the page showed last (out/browser/shots/fail-*.png, out/browser/fail-*.txt)."""
    def run(ctx):
        try:
            return fn(ctx)
        except Exception:
            page = getattr(ctx, "code_ui_page", None)
            if page is not None:
                try:
                    page.screenshot(path=str(SHOTS / f"fail-{fn.__name__}.png"))
                    txt = page.evaluate("""() => [document.querySelector('[data-testid=statusbar]')?.innerText || '',
                      document.querySelector('[data-testid=chat]')?.innerText.slice(-3000) || ''].join('\\n----\\n')""")
                    (SHOTS.parent / f"fail-{fn.__name__}.txt").write_text(txt, encoding="utf-8")
                except Exception:  # noqa: BLE001 — diagnostics never hide the failure
                    pass
            raise
        finally:
            rec = getattr(ctx, "code_ui_rec", None)
            if rec is not None:
                rec.save()
                ctx.code_ui_rec = None
    run.__name__ = fn.__name__
    return run


def ask(page, text):
    box = page.get_by_test_id("prompt")
    box.fill(text)
    box.press("Enter")


def last_answer(page):
    return page.get_by_test_id("msg-claude").last.inner_text()


def fixtures(c):
    """Files in the workspace for these checks, through the page's own API: a file to edit, and a plugin marketplace
    (one plugin from a folder, one installed by a command that prints its folder)."""
    for d in (UI, MKT, f"{MKT}/.claude-plugin", f"{MKT}/plugins", f"{MKT}/plugins/hello-local", f"{MKT}/plugins/hello-local/.claude-plugin",
              f"{MKT}/plugins/hello-local/commands", f"{MKT}/plugins/hello-cmd", f"{MKT}/plugins/hello-cmd/.claude-plugin", f"{MKT}/plugins/hello-cmd/commands"):
        r = c.api("POST", "/api/fs/mkdir", {"path": d})
        expect(r["status"] in (200, 400, 409, 502) or "exists" in r["text"], f"mkdir {d}: {r['status']} {r['text'][:100]}")
    files = {
        f"{UI}/edit-me.txt": "value = 1\n",
        f"{MKT}/.claude-plugin/marketplace.json": json.dumps({"name": MKT, "owner": {"name": "bedrock-now e2e"}, "plugins": [
            {"name": "hello-local", "source": "./plugins/hello-local", "description": "A local test plugin with one command", "version": "1.0.0"},
            {"name": "hello-cmd", "source": {"source": "command", "command": f"printf '%s\\n' /workspace/{MKT}/plugins/hello-cmd"},
             "description": "Installed by running a command", "version": "1.0.0"}]}, indent=1),
        f"{MKT}/plugins/hello-local/.claude-plugin/plugin.json": json.dumps({"name": "hello-local", "version": "1.0.0", "description": "e2e"}),
        f"{MKT}/plugins/hello-local/commands/hello.md": "---\ndescription: Say hello (bedrock-now e2e plugin)\n---\nReply with exactly: hello from the e2e plugin\n",
        f"{MKT}/plugins/hello-cmd/.claude-plugin/plugin.json": json.dumps({"name": "hello-cmd", "version": "1.0.0", "description": "e2e"}),
        f"{MKT}/plugins/hello-cmd/commands/hi.md": "---\ndescription: Say hi (installed by a command)\n---\nReply with exactly: hi\n",
    }
    for path, text in files.items():
        r = c.api("PUT", f"/api/fs/file?path={path}", {"text": text})
        expect(r["status"] == 200, f"write {path}: {r['status']} {r['text'][:100]}")


def state_of(c, sid):
    st = c.api("GET", "/api/state")["json"]
    return next((s for s in st["sessions"] if s["id"] == sid), {})


def wait_state(c, sid, key, value, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if state_of(c, sid).get(key) == value:
            return
        c.page.wait_for_timeout(300)
    raise AssertionError(f"session {key} is {state_of(c, sid).get(key)!r}, not {value!r}")


@check("browser", "code-ui-desktop")
@saved
def ui_desktop(ctx):
    need_haiku()
    page, rec = ui_page(ctx, "code-ui-desktop")
    c = Code.on(page, rec, goto=False)
    fixtures(c)
    # Haiku for the new session (the picker before the first prompt), then an answer streams
    page.get_by_test_id("model-picker").click()
    page.get_by_test_id("model-haiku").click()
    see(page.get_by_test_id("model-picker")).to_contain_text("Haiku")
    old = page.evaluate("(JSON.parse(localStorage.getItem('bn.code.v1') || '{}').lastSession) || ''")
    page.get_by_test_id("chat-new").click()
    ask(page, "Reply with exactly the word: pong")   # (sent while the session opens: it goes to the new one)
    see(page.locator(".chat-head .pane-title")).to_have_text("Reply with exactly the word: pong", timeout=30000)
    turns(page, 1)
    expect("pong" in last_answer(page).lower(), f"answer {last_answer(page)!r}")
    page.wait_for_function("(old) => { const s = (JSON.parse(localStorage.getItem('bn.code.v1') || '{}').lastSession) || '';"
                           " return s.length === 36 && s !== old; }", arg=old, timeout=10000)
    sid = page.evaluate("JSON.parse(localStorage.getItem('bn.code.v1')).lastSession")
    ctx.code_ui_session = sid
    expect(state_of(c, sid).get("model") == "haiku", f"model {state_of(c, sid)}")
    # a Bash permission prompt in its card: Allow once, the command runs in the sandbox
    ask(page, f"Use the Bash tool to run exactly this command, then reply with the word done: echo ui-ok > {UI}/bash.txt")
    card = page.get_by_test_id("permission")
    see(card).to_contain_text("Claude wants to run a command", timeout=120000)
    see(card).to_contain_text(f"{UI}/bash.txt")
    shot(page, "56-code-ui-permission")
    page.get_by_test_id("perm-once").click()
    turns(page, 2)
    r = c.api("GET", f"/api/fs/file?path={UI}/bash.txt")
    expect(r["status"] == 200 and r["json"]["text"].strip() == "ui-ok", f"after Allow once: {r['status']} {r['text'][:80]}")
    # Accept edits (the mode picker), an @-mentioned file, Claude's Edit -> its diff in the editor
    page.get_by_test_id("mode-picker").click()
    page.get_by_test_id("mode-acceptEdits").click()
    wait_state(c, sid, "mode", "acceptEdits")
    box = page.get_by_test_id("prompt")
    box.click()
    box.type(f"In @{UI}/edi")
    see(page.get_by_test_id("palette")).to_contain_text(f"{UI}/edit-me.txt", timeout=10000)
    box.press("Tab")
    see(box).to_have_value(f"In @{UI}/edit-me.txt ")
    box.type("use the Edit tool to change `value = 1` to `value = 2`. Change nothing else, run nothing else, then reply with the word done.")
    box.press("Enter")
    turns(page, 3)
    r = c.api("GET", f"/api/fs/file?path={UI}/edit-me.txt")
    expect(r["json"]["text"] == "value = 2\n", f"the edited file: {r['json']['text']!r}")
    edit = page.locator(".tool[data-tool='Edit'], .tool[data-tool='MultiEdit'], .tool[data-tool='Write']").last
    see(edit).to_be_visible()
    expect(page.get_by_test_id("permission").count() == 0, "Accept edits still asked")
    edit.get_by_role("button", name="Open diff").click()
    page.wait_for_function("() => { const h = document.querySelector('.pane:not(.hidden) .cm-host');"
                           " return h && h.shadowRoot && h.shadowRoot.querySelector('.cm-mergeView, .cm-editor'); }", timeout=20000)
    page.mouse.move(0, 0)
    shot(page, "57-code-ui-diff")
    # the / palette: built-ins and skills from the session
    box.click()
    box.fill("")
    box.type("/con")
    see(page.get_by_test_id("palette")).to_contain_text("/context", timeout=10000)
    box.fill("")
    # an upload: into the workspace, mentioned in the composer
    up = f"e2e-ui-upload-{int(time.time())}.txt"
    page.get_by_test_id("file-input").set_input_files(files=[{"name": up, "mimeType": "text/plain", "buffer": b"uploaded from the page"}])
    see(box).to_have_value(re.compile(r"@(\S+/)?" + re.escape(up)), timeout=20000)
    up = re.search(r"@(\S*" + re.escape(up) + ")", box.input_value()).group(1)   # (into the folder selected in the explorer)
    r = c.api("GET", f"/api/fs/file?path={up}")
    expect(r["status"] == 200 and r["json"]["text"] == "uploaded from the page", f"upload: {r['status']}")
    box.fill("")
    # a model switch (Sonnet and back, no turn on Sonnet: free), then the next turn is Haiku's
    page.get_by_test_id("model-picker").click()
    if page.get_by_test_id("model-sonnet").count():
        page.get_by_test_id("model-sonnet").click()
        wait_state(c, sid, "model", "sonnet")
        see(page.get_by_test_id("model-picker")).to_contain_text("Sonnet")
        page.get_by_test_id("model-picker").click()
    page.get_by_test_id("model-haiku").click()
    wait_state(c, sid, "model", "haiku")
    # an interrupt: the stop button while it streams
    ask(page, "Count from 1 to 400, one number per line, nothing else.")
    see(page.locator(".msg-claude.streaming")).to_have_count(1, timeout=120000)
    page.get_by_test_id("stop").click()
    turns(page, 4, 60000)
    see(page.get_by_test_id("turn-end").last).to_contain_text("Stopped")
    # the terminal panel: the code unlock is enough (the portal hands it over to the terminal host): ttyd's xterm, no
    # second password
    page.get_by_test_id("toggle-terminal").click()
    see(page.get_by_test_id("terminal")).to_be_visible()
    t0 = time.time()
    term = None
    while time.time() - t0 < 30 and term is None:
        term = next((f for f in page.frames if f.url.startswith(origin("terminal")) and "/.bn/" not in f.url), None)
        page.wait_for_timeout(250)
    expect(term is not None, f"the terminal panel did not reach the terminal host: {[f.url for f in page.frames]}")
    term.locator(".xterm").wait_for(timeout=30000)
    expect(term.locator("h1", has_text="Unlock").count() == 0, "the terminal asked for a second unlock")
    page.wait_for_timeout(1000)
    shot(page, "58-code-ui-desktop")
    # a reload re-attaches: the same conversation, nothing twice
    n_user, n_tool = page.get_by_test_id("msg-user").count(), page.get_by_test_id("tool-card").count()
    page.reload()
    see(page.get_by_test_id("conn")).to_have_text("Connected", timeout=30000)
    see(page.get_by_test_id("msg-user")).to_have_count(n_user, timeout=30000)
    page.wait_for_timeout(2500)
    expect(page.get_by_test_id("msg-user").count() == n_user and page.get_by_test_id("tool-card").count() == n_tool,
           f"after the reload: {page.get_by_test_id('msg-user').count()} prompts (want {n_user}), {page.get_by_test_id('tool-card').count()} tools (want {n_tool})")
    page.evaluate(CLIENT_JS)   # (the reload took the in-page client along)
    c.api("DELETE", f"/api/fs?path={up}")
    csp_clean(page, rec, [r"^400 POST .*/api/fs/mkdir$"])   # (fixtures: a folder that is there already)
    # the hand-off unlocked the terminal host for this browser: the portal's Terminal tab opens without a password too
    from checks_terminal import terminal_frame
    portal = page.context.new_page()
    portal.goto(origin() + "/")
    portal.click(".tab[data-tab=terminal]")
    tf = terminal_frame(portal)
    tf.locator(".xterm").wait_for(timeout=30000)
    expect(tf.locator("h1", has_text="Unlock").count() == 0, "the Terminal tab asked for its password after the Code page's hand-off")
    portal.close()
    return (f"session {sid[:8]} (Haiku): pong streamed; Bash card → Allow once → {UI}/bash.txt; Accept edits + @{UI}/edit-me.txt → "
            f"edited, diff in the editor; / palette; upload → @{up}; Sonnet ⇄ Haiku switch; Stop → Stopped; terminal panel (xterm, no second unlock; the Terminal tab too); "
            f"reload: {n_user} prompts, {n_tool} tools, no duplicates; no CSP violations")


@check("browser", "code-ui-ask-user-question")
@saved
def ui_question(ctx):
    need_haiku()
    sid = getattr(ctx, "code_ui_session", None)
    if not sid:
        raise Skip("needs the session of code-ui-desktop")
    page, rec = ui_page(ctx, "code-ui-question", session=sid)
    n = page.get_by_test_id("turn-end").count()
    ask(page, "Use the AskUserQuestion tool to ask me one question: \"Tea or coffee?\" with the two options Tea and Coffee. "
              "After my answer, reply with exactly the option I chose and nothing else.")
    q = page.get_by_test_id("question")
    see(q.or_(page.get_by_test_id("turn-end").nth(n))).to_have_count(1, timeout=120000)
    if not q.count():
        rec.save()
        raise Skip("Haiku answered without asking (no AskUserQuestion call this time)")
    see(page.get_by_test_id("q-send")).to_be_disabled()
    try:
        q.locator(".q-label", has_text=re.compile(r"^\s*Coffee\s*$")).first.click()
        see(page.get_by_test_id("q-send")).to_be_enabled()
        shot(page, "59-code-ui-question")
        page.get_by_test_id("q-send").click()
        turns(page, n + 1)
    finally:
        # never leave the session waiting on a question (the later checks use it)
        if page.get_by_test_id("q-decline").count():
            page.get_by_test_id("q-decline").click()
        rec.save()
    expect("coffee" in last_answer(page).lower(), f"the answer did not reach Claude: {last_answer(page)!r}")
    single = last_answer(page)
    # several choices (multiSelect): the labels go back comma-separated
    n = page.get_by_test_id("turn-end").count()
    ask(page, "Use the AskUserQuestion tool to ask me one question, \"Which colors?\", with multiSelect true and the three options "
              "Red, Green and Blue. After my answer, reply with exactly the colors I chose, comma-separated, nothing else.")
    q = page.get_by_test_id("question")
    see(q.or_(page.get_by_test_id("turn-end").nth(n))).to_have_count(1, timeout=120000)
    multi = "(Haiku asked no multiple-choice question this time)"
    if q.count():
        try:
            expect(q.locator("input[type=checkbox]").count() >= 3, "a multiple-choice question without checkboxes")
            for label in ("Red", "Blue"):
                q.locator(".q-label", has_text=re.compile(rf"^\s*{label}\s*$")).first.click()
            shot(page, "59b-code-ui-question-multi")
            page.get_by_test_id("q-send").click()
            turns(page, n + 1)
        finally:
            if page.get_by_test_id("q-decline").count():
                page.get_by_test_id("q-decline").click()
        a = last_answer(page).lower()
        expect("red" in a and "blue" in a and "green" not in a, f"the multiple choice did not reach Claude: {last_answer(page)!r}")
        multi = f"Red + Blue → {last_answer(page)!r}"
    csp_clean(page, rec)
    return f"AskUserQuestion cards: Coffee → {single!r}; several choices: {multi}"


@check("browser", "code-ui-plugins-mcp")
@saved
def ui_plugins_mcp(ctx):
    need_haiku()
    sid = getattr(ctx, "code_ui_session", None)
    if not sid:
        raise Skip("needs the session of code-ui-desktop")
    page, rec = ui_page(ctx, "code-ui-plugins", session=sid)
    c = Code.on(page, rec, goto=False)
    see(page.get_by_test_id("turn-end").first).to_be_visible(timeout=30000)
    page.get_by_test_id("more-menu").click()
    page.get_by_test_id("menu-plugins").click()
    dlg = page.get_by_test_id("plugins-dialog")
    dlg.get_by_test_id("plugins-tab-marketplaces").click()
    dlg.get_by_test_id("marketplace-source").fill(f"/workspace/{MKT}")
    dlg.get_by_test_id("marketplace-add").click()
    see(dlg.get_by_test_id("plugins-note")).to_contain_text("marketplace", timeout=120000)
    see(dlg.locator(f"[data-marketplace='{MKT}']")).to_be_visible(timeout=20000)
    dlg.get_by_test_id("plugins-tab-discover").click()
    dlg.get_by_test_id("plugins-marketplace").select_option(MKT)
    see(dlg.get_by_test_id("plugins-available").locator(".plg-row")).to_have_count(2, timeout=30000)
    dlg.locator(f"[data-plugin='hello-local@{MKT}'] [data-testid=plugin-install]").click()
    see(dlg.get_by_test_id("plugins-note")).to_contain_text(f"hello-local@{MKT}", timeout=120000)
    note = dlg.get_by_test_id("plugins-note").inner_text()
    expect("Reloaded in" in note, f"no session reloaded: {note!r}")
    # installed by a command: the exact command and its SHA-256 first; nothing runs until it is accepted
    dlg.locator(f"[data-plugin='hello-cmd@{MKT}'] [data-testid=plugin-install]").click()
    see(dlg.get_by_test_id("plugin-confirm")).to_be_visible(timeout=120000)
    see(dlg.get_by_test_id("plugin-confirm-command")).to_have_text(f"printf '%s\\n' /workspace/{MKT}/plugins/hello-cmd")
    sha = dlg.get_by_test_id("plugin-confirm-sha").inner_text().strip()
    expect(re.fullmatch(r"[0-9a-f]{64}", sha), f"sha {sha!r}")
    inst = [p["id"] for p in c.api("GET", "/api/plugins")["json"]["installed"]]
    expect(f"hello-cmd@{MKT}" not in inst, f"installed before it was accepted: {inst}")
    shot(page, "60-code-ui-plugin-confirm")
    dlg.get_by_test_id("plugin-confirm-accept").click()
    see(dlg.get_by_test_id("plugins-note")).to_contain_text(f"hello-cmd@{MKT}", timeout=120000)
    dlg.get_by_test_id("plugins-tab-installed").click()
    see(dlg.locator(f"[data-plugin='hello-local@{MKT}']")).to_be_visible()
    see(dlg.locator(f"[data-plugin='hello-cmd@{MKT}']")).to_be_visible()
    page.mouse.move(0, 0)
    shot(page, "61-code-ui-plugins")
    dlg.get_by_role("button", name="Close").click()
    # the session reloaded its plugins: their commands are in the palette, and one runs (Haiku)
    box = page.get_by_test_id("prompt")
    box.click()
    box.type("/hello")
    see(page.get_by_test_id("palette")).to_contain_text("/hello-local:hello", timeout=30000)
    box.fill("")
    box.type("/hi")
    see(page.get_by_test_id("palette")).to_contain_text("/hello-cmd:hi", timeout=30000)
    box.fill("")
    n = page.get_by_test_id("turn-end").count()
    ask(page, "/hello-local:hello")
    turns(page, n + 1)
    expect("hello from the e2e plugin" in last_answer(page).lower(), f"plugin command: {last_answer(page)!r}")
    # the MCP panel: the stack's bedrock-shared connected; off and on for this session
    page.get_by_test_id("more-menu").click()
    page.get_by_test_id("menu-mcp").click()
    mdlg = page.get_by_test_id("mcp-dialog")
    srv = mdlg.locator("[data-server='bedrock-shared']")
    see(srv.get_by_test_id("mcp-status")).to_have_text("connected", timeout=30000)
    tools = srv.inner_text()
    see(mdlg.get_by_test_id("mcp-sandbox-note")).to_contain_text("inside the sandbox only")
    page.mouse.move(0, 0)
    shot(page, "62-code-ui-mcp")
    srv.get_by_test_id("mcp-toggle").click()
    see(srv.get_by_test_id("mcp-status")).to_have_text("disabled", timeout=30000)
    srv.get_by_test_id("mcp-toggle").click()
    see(srv.get_by_test_id("mcp-status")).to_have_text(re.compile("connected|pending"), timeout=30000)
    mdlg.get_by_role("button", name="Close").click()
    # tidy: the plugins and the marketplace go (the throwaway keeps nothing of this)
    for pid in (f"hello-local@{MKT}", f"hello-cmd@{MKT}"):
        c.api("POST", "/api/plugins/uninstall", {"name": pid})
    c.api("DELETE", f"/api/marketplaces?name={MKT}")
    csp_clean(page, rec)
    tools = " ".join(tools.split())[:60]
    return (f"marketplace /workspace/{MKT} added; hello-local installed (session reloaded); hello-cmd: command + SHA-256 {sha[:12]}… "
            f"shown, not installed until accepted, then installed; /hello-local:hello and /hello-cmd:hi in the palette, "
            f"/hello-local:hello answered; MCP: bedrock-shared connected ({tools}), off → disabled → on")


@check("browser", "code-ui-queue-and-clear")
@saved
def ui_queue_clear(ctx):
    need_haiku()
    sid = getattr(ctx, "code_ui_session", None)
    if not sid:
        raise Skip("needs the session of code-ui-desktop")
    page, rec = ui_page(ctx, "code-ui-queue", session=sid)
    n = page.get_by_test_id("turn-end").count()
    # a prompt typed while Claude works waits below the answer, then runs as its own turn
    ask(page, "Count from 1 to 300, one number per line, nothing else.")
    see(page.get_by_test_id("session-state")).to_contain_text("working", timeout=10000)
    ask(page, "Reply with exactly the word: queued")
    see(page.locator("[data-testid=msg-user].queued")).to_have_count(1, timeout=10000)
    shot(page, "66-code-ui-queued")
    turns(page, n + 2)
    see(page.locator("[data-testid=msg-user].queued")).to_have_count(0)
    order = page.evaluate("""() => [...document.querySelectorAll('[data-testid=msg-user], [data-testid=turn-end]')].slice(-4)
        .map(e => e.dataset.testid === 'turn-end' ? 'end' : e.innerText.trim().slice(0, 20))""")
    expect(order[0].startswith("Count from 1") and order[1] == "end" and order[2].startswith("Reply with exactly") and order[3] == "end",
           f"the queued prompt did not wait for the first turn: {order}")
    expect("queued" in last_answer(page).lower(), f"answer {last_answer(page)!r}")
    # /clear: a new session with the same model and mode (the old one stays in the list); /resume opens the list
    mode = page.get_by_test_id("mode-picker").inner_text()
    ask(page, "/clear")
    see(page.locator(".chat-head .pane-title")).to_have_text("New session", timeout=20000)
    see(page.get_by_test_id("msg-user")).to_have_count(0)
    see(page.get_by_test_id("model-picker")).to_contain_text("Haiku")
    expect(page.get_by_test_id("mode-picker").inner_text() == mode, f"mode {page.get_by_test_id('mode-picker').inner_text()!r}, was {mode!r}")
    page.wait_for_function("(old) => { const s = (JSON.parse(localStorage.getItem('bn.code.v1') || '{}').lastSession) || '';"
                           " return s.length === 36 && s !== old; }", arg=sid, timeout=10000)
    new = page.evaluate("JSON.parse(localStorage.getItem('bn.code.v1')).lastSession")
    c = Code.on(page, rec, goto=False)
    st = state_of(c, sid)
    expect(st, "the cleared session is gone from the backend")
    ask(page, "/resume")
    see(page.get_by_test_id("session-row").first).to_be_visible(timeout=10000)
    csp_clean(page, rec)
    return (f"a prompt typed while busy waited below the stream (queued), then ran as its own turn ({order}); /clear → a new "
            f"session {new[:8]} with Haiku and {mode!r}, the old one kept; /resume opens the session list")


@check("browser", "code-ui-plan-approval")
@saved
def ui_plan(ctx):
    need_haiku()
    page, rec = ui_page(ctx, "code-ui-plan")
    c = Code.on(page, rec, goto=False)
    page.get_by_test_id("model-picker").click()
    page.get_by_test_id("model-haiku").click()
    page.get_by_test_id("mode-picker").click()
    page.get_by_test_id("mode-plan").click()
    page.get_by_test_id("chat-new").click()
    see(page.locator(".chat-head .pane-title")).to_have_text("New session", timeout=20000)
    target = f"{UI}/planned-{int(time.time())}.txt"
    ask(page, f"Plan this, then do it once I approve: create the file {target} containing exactly the word planned. "
              "Keep the plan to one or two lines and present it for my approval with ExitPlanMode.")
    card = page.locator("[data-testid=permission]:has([data-testid=plan-approve-edits])")
    see(card.or_(page.get_by_test_id("turn-end"))).to_have_count(1, timeout=150000)
    if not card.count():
        csp_clean(page, rec)
        raise Skip("Haiku ended the turn without presenting a plan (no ExitPlanMode this time)")
    see(page.get_by_test_id("plan-approve-ask")).to_be_visible()
    see(page.get_by_test_id("plan-keep")).to_be_visible()
    shot(page, "67-code-ui-plan")
    page.get_by_test_id("plan-approve-edits").click()
    sid = page.evaluate("JSON.parse(localStorage.getItem('bn.code.v1')).lastSession")
    wait_state(c, sid, "mode", "acceptEdits", timeout=60)
    t0 = time.time()
    r = None
    while time.time() - t0 < 150:
        r = c.api("GET", f"/api/fs/file?path={target}")
        if r["status"] == 200:
            break
        if page.get_by_test_id("perm-once").count():   # (a tool other than an edit may still ask: allow it once)
            page.get_by_test_id("perm-once").click()
        page.wait_for_timeout(1000)
    expect(r and r["status"] == 200 and "planned" in r["json"]["text"], f"after approving the plan: {r and r['status']}")
    see(page.get_by_test_id("mode-picker")).to_contain_text("Accept edits")
    csp_clean(page, rec, [r"^404 GET .*/api/fs/file\?path=" + re.escape(target) + "$"])   # (polled until Claude wrote it)
    return f"Plan mode → the plan card (approve + accept edits / approve + ask / keep planning) → approved with Accept edits → {target} written, mode Accept edits"


@check("browser", "code-ui-fork-from-message")
@saved
def ui_fork(ctx):
    need_haiku()
    sid = getattr(ctx, "code_ui_session", None)
    if not sid:
        raise Skip("needs the session of code-ui-desktop")
    page, rec = ui_page(ctx, "code-ui-fork", session=sid)
    page.get_by_test_id("msg-user").first.wait_for(timeout=30000)
    total = page.get_by_test_id("msg-user").count()
    expect(total >= 2, f"the session has {total} prompts")
    second = page.get_by_test_id("msg-user").nth(1)
    second.hover()
    second.get_by_test_id("msg-fork").click()
    see(page.locator(".chat-head .pane-title")).to_contain_text("Fork of", timeout=30000)
    # the fork holds the conversation before that prompt (as the CLI's rewind), the prompt back in the box to change;
    # a new prompt continues from there
    see(page.get_by_test_id("msg-user").first).to_contain_text("Reply with exactly the word: pong", timeout=30000)
    see(page.get_by_test_id("msg-user")).to_have_count(1)
    see(page.get_by_test_id("prompt")).to_have_value(re.compile(r"^Use the Bash tool"))
    page.wait_for_function("(old) => { const s = (JSON.parse(localStorage.getItem('bn.code.v1') || '{}').lastSession) || '';"
                           " return s.length === 36 && s !== old; }", arg=sid, timeout=10000)
    fork = page.evaluate("JSON.parse(localStorage.getItem('bn.code.v1')).lastSession")
    n = page.get_by_test_id("turn-end").count()
    ask(page, "Which single word did you reply with to my first message? Reply with that word only.")
    turns(page, n + 1)
    expect("pong" in last_answer(page).lower(), f"the fork does not know the first answer: {last_answer(page)!r}")
    shot(page, "68-code-ui-fork")
    csp_clean(page, rec)
    return (f"Fork from the second prompt → a new session {fork[:8]} (Fork of …) with the conversation before it, the prompt "
            f"back in the box; it remembers the first answer ({last_answer(page)!r})")


@check("browser", "code-ui-memory-find-rewind")
@saved
def ui_memory_find_rewind(ctx):
    need_haiku()
    sid = getattr(ctx, "code_ui_session", None)
    if not sid:
        raise Skip("needs the session of code-ui-desktop")
    page, rec = ui_page(ctx, "code-ui-memory", session=sid)
    c = Code.on(page, rec, goto=False)
    see(page.get_by_test_id("turn-end").first).to_be_visible(timeout=30000)
    # CLAUDE.md of the workspace, from the memory dialog; then the `#` shortcut appends a line to it
    c.api("DELETE", "/api/fs?path=CLAUDE.md")
    page.get_by_test_id("more-menu").click()
    page.get_by_test_id("menu-memory").click()
    dlg = page.get_by_test_id("memory-dialog")
    dlg.get_by_test_id("memory-tab-project").click()
    dlg.get_by_test_id("memory-text").fill("# Notes for Claude\n- the e2e suite was here\n")
    dlg.get_by_test_id("memory-save").click()
    t0 = time.time()
    while time.time() - t0 < 20 and "the e2e suite was here" not in (c.api("GET", "/api/memory?scope=project")["json"] or {}).get("text", ""):
        page.wait_for_timeout(500)
    m = c.api("GET", "/api/memory?scope=project")["json"]
    expect(m["exists"] and "the e2e suite was here" in m["text"], f"memory after Save: {m}")
    shot(page, "71-code-ui-memory")
    dlg.locator(".dlg-head button[aria-label=Close]").click()
    see(page.locator("dialog[open]")).to_have_count(0)   # (until it is gone the page behind it is inert)
    ask(page, "# the e2e marker is blue")
    see(page.locator(".toast", has_text="Added to /workspace/CLAUDE.md")).to_be_visible(timeout=10000)
    t0 = time.time()
    while time.time() - t0 < 20 and "the e2e marker is blue" not in c.api("GET", "/api/memory?scope=project")["json"]["text"]:
        page.wait_for_timeout(500)
    m = c.api("GET", "/api/memory?scope=project")["json"]
    expect("the e2e marker is blue" in m["text"] and "the e2e suite was here" in m["text"], f"memory after #: {m['text']!r}")
    c.api("DELETE", "/api/fs?path=CLAUDE.md")
    # the @ picker finds a file the explorer has not opened (a search of the whole workspace)
    deep = f"{UI}/deep/a/b"
    for d in (f"{UI}/deep", f"{UI}/deep/a", deep):
        c.api("POST", "/api/fs/mkdir", {"path": d})
    needle = f"needle-{int(time.time())}.txt"
    c.api("PUT", f"/api/fs/file?path={deep}/{needle}", {"text": "found\n"})
    box = page.get_by_test_id("prompt")
    box.click()
    box.fill("")
    box.type(f"look at @{needle[:12]}")
    see(page.get_by_test_id("palette")).to_contain_text(f"{deep}/{needle}", timeout=15000)
    box.fill("")
    # file checkpoints: Claude edits a file; "Restore files to here" on that prompt puts it back
    c.api("PUT", f"/api/fs/file?path={UI}/rewind.txt", {"text": "rewind = 1\n"})
    if state_of(c, sid).get("mode") != "acceptEdits":
        page.get_by_test_id("mode-picker").click()
        page.get_by_test_id("mode-acceptEdits").click()
        wait_state(c, sid, "mode", "acceptEdits")
    n = page.get_by_test_id("turn-end").count()
    ask(page, f"In @{UI}/rewind.txt use the Edit tool to change `rewind = 1` to `rewind = 2`. Change nothing else, run nothing else, then reply with the word done.")
    turns(page, n + 1)
    expect(c.api("GET", f"/api/fs/file?path={UI}/rewind.txt")["json"]["text"] == "rewind = 2\n", "Claude did not edit the file")
    prompt = page.get_by_test_id("msg-user").last
    prompt.hover()
    prompt.get_by_test_id("msg-rewind").click()
    prev = page.get_by_test_id("rewind-preview")
    see(prev).to_contain_text("rewind.txt", timeout=30000)
    shot(page, "72-code-ui-rewind")
    page.get_by_test_id("rewind-confirm").click()
    t0 = time.time()
    while time.time() - t0 < 30 and c.api("GET", f"/api/fs/file?path={UI}/rewind.txt")["json"]["text"] != "rewind = 1\n":
        page.wait_for_timeout(500)
    after = c.api("GET", f"/api/fs/file?path={UI}/rewind.txt")["json"]["text"]
    expect(after == "rewind = 1\n", f"after Restore: {after!r}")
    csp_clean(page, rec, [r"^400 POST .*/api/fs/mkdir$", r"^404 DELETE .*/api/fs\?path=CLAUDE\.md$"])
    return (f"memory dialog → /workspace/CLAUDE.md written; `# …` appended a line; the @ picker found {deep}/{needle} unopened in the "
            f"explorer; Claude's Edit of {UI}/rewind.txt restored by \"Restore files to here\" (dry run listed it first)")


@check("browser", "code-ui-phone")
@saved
def ui_phone(ctx):
    need_haiku()
    sid = getattr(ctx, "code_ui_session", None)
    if not sid:
        raise Skip("needs the session of code-ui-desktop")
    page, rec = ui_page(ctx, "code-ui-phone", device="phone", session=sid)
    see(page.get_by_test_id("phone-sessions")).to_be_visible()
    n = page.get_by_test_id("turn-end").count()
    ask(page, "Reply with exactly the word: phone")
    turns(page, n + 1)
    expect("phone" in last_answer(page).lower(), f"answer {last_answer(page)!r}")
    over = page.evaluate("document.documentElement.scrollWidth - innerWidth")
    expect(over <= 0, f"the page is {over}px wider than the phone")
    shot(page, "63-code-ui-phone")
    page.get_by_test_id("phone-menu-btn").click()
    see(page.get_by_test_id("phone-menu")).to_contain_text("Model")
    shot(page, "64-code-ui-phone-menu")
    csp_clean(page, rec)
    return f"phone (390×844): chat-first, answer {last_answer(page)!r}, no horizontal overflow, the session sheet; no CSP violations"


@check("browser", "code-ui-tablet")
@saved
def ui_tablet(ctx):
    need_on()
    page, rec = ui_page(ctx, "code-ui-tablet", device="tablet", session=getattr(ctx, "code_ui_session", None))
    see(page.locator(".app.tablet")).to_be_visible()
    see(page.get_by_test_id("chat")).to_be_visible()
    page.get_by_role("button", name="Files", exact=True).click()
    see(page.get_by_test_id("file-tree")).to_be_visible()
    page.get_by_test_id("toggle-terminal").click()
    see(page.get_by_test_id("terminal")).to_be_visible()
    over = page.evaluate("document.documentElement.scrollWidth - innerWidth")
    expect(over <= 0, f"the page is {over}px wider than the tablet")
    page.wait_for_timeout(1500)
    shot(page, "69-code-ui-tablet")
    csp_clean(page, rec)
    return "tablet (820×1180): chat + files, the terminal drawer, no horizontal overflow; no CSP violations"


@check("browser", "code-ui-budget-exceeded")
@saved
def ui_budget(ctx):
    """The terminal key over its budget (its max_budget set below its spend for a moment, through LiteLLM's admin API with
    the throwaway's master key): a prompt is refused by LiteLLM ($0), the page says the budget is spent and where to
    raise it; the budget is restored afterwards."""
    need_haiku()
    from checks_api import lite
    key, master = ENV.get("LITELLM_KEY_TERMINAL"), ENV.get("LITELLM_MASTER_KEY")
    if not key or not master:
        raise Skip("no terminal key or master key in the throwaway's .env")
    info = lite("GET", "/key/info", key=key).json()["info"]
    budget = info.get("max_budget")
    r = lite("POST", "/key/update", key=master, body={"key": key, "max_budget": 0.000001})
    expect(r.status == 200, f"/key/update {r.status}")
    try:
        page, rec = ui_page(ctx, "code-ui-budget")
        page.get_by_test_id("model-picker").click()
        page.get_by_test_id("model-haiku").click()
        page.get_by_test_id("chat-new").click()
        see(page.locator(".chat-head .pane-title")).to_have_text("New session", timeout=20000)
        ask(page, "Reply with exactly the word: budget")
        see(page.get_by_test_id("budget-banner")).to_be_visible(timeout=120000)
        see(page.get_by_test_id("budget-banner")).to_contain_text("BUDGET_TERMINAL")
        shot(page, "70-code-ui-budget")
        text = page.get_by_test_id("budget-banner").inner_text()
        rec.save()
    finally:
        lite("POST", "/key/update", key=master, body={"key": key, "max_budget": budget})
    restored = lite("GET", "/key/info", key=key).json()["info"].get("max_budget")
    expect(restored == budget, f"the budget was not restored: {restored} != {budget}")
    return f"the terminal key over budget → the page's banner: {' '.join(text.split())[:120]!r}; budget restored to ${budget}"


@check("browser", "code-settings-row")
def settings_row(ctx):
    need_on()
    page, rec = ctx.page("code-settings")
    login(page)
    open_settings(page)
    card = page.locator("#set-code")
    card.wait_for(timeout=20000)
    on = card.locator(".chip[aria-pressed=true]").inner_text()
    ws = card.locator(".set-code-ws code").inner_text()
    cli = card.locator(".set-cli code").last.inner_text()
    expect(on == "On", f"the switch shows {on!r}")
    expect(ws == ENV.get("TERMINAL_WORKSPACE"), f"workspace shown {ws!r}")
    expect(cli == "./stack terminal enable --workspace DIR", f"cli {cli!r}")
    try:
        card.screenshot(path=str(SHOTS / "65-code-settings-row.png"), animations="disabled")
    except Exception:  # noqa: BLE001 — a screenshot never fails a check
        pass
    probs = rec.problems()
    rec.save()
    expect(not probs, f"errors: {probs}")
    return f"Settings → Code page: On, the workspace (…/{os.path.basename(ws)}) read-only, its CLI ({cli})"


# --- a stand-in on bn-coded's socket (run.sh starts it after the suite; E2E_CODE_HOSTILE=1) ---

@check("browser", "code-hostile-sandbox")
def hostile(ctx):
    need_on()
    if not HOSTILE:
        raise Skip("only with the stand-in on bn-coded's socket (tests/e2e/run.sh --code starts it after the suite)")
    page, rec = ctx.page("code-hostile")
    dialogs = []
    page.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    login(page)
    page.goto(CODE + "/")
    unlock_page(page)
    c = Code.on(page, rec, goto=False)
    rows = c.api("GET", "/api/sessions")
    expect(rows["status"] == 200, f"sessions {rows}")
    ids = [r["id"] for r in rows["json"]["sessions"]]
    expect(all(re.fullmatch(r"[0-9a-f-]{36}", i) for i in ids) and "../../etc" not in json.dumps(rows["json"]), f"ids {ids}")
    expect(any("<img" in r["title"] for r in rows["json"]["sessions"]), "the stand-in's markup title is not there as text")
    big = c.api("GET", "/api/fs?path=big")
    expect(big["status"] == 502, f"a 9 MiB answer: {big['status']}")
    sid = c.new_session("haiku", "default")
    n = len(c.msgs())
    c.request({"type": "prompt", "session": sid, "text": "hello"})
    end = c.wait(lambda m: m.get("type") == "session_state" and m["session"] == sid and m["state"] in ("error", "ended"), "the hostile session's end", 60, since=n)
    evs = c.events(sid, n)
    # the page shows what came as text: let the plain page (if it is the one) render the session
    if page.locator("form#ask").count():
        page.reload(); page.wait_for_selector("#sessions li", timeout=20000)
        page.wait_for_timeout(1500)
        page.evaluate(CLIENT_JS)   # (the reload took the in-page client along)
    built = page.locator("form#ask").count() == 0
    if built:
        # the frontend: the session list, the explorer and the plugins dialog with the stand-in's answers (markup in
        # every field, a "command" to confirm whose hash is not one)
        page.reload()
        see(page.get_by_test_id("conn")).to_have_text("Connected", timeout=30000)
        page.get_by_test_id("side-sessions").click()
        page.wait_for_timeout(1500)
        page.get_by_test_id("side-files").click()
        page.wait_for_timeout(1000)
        page.get_by_test_id("more-menu").click()
        page.get_by_test_id("menu-plugins").click()
        page.get_by_test_id("plugins-tab-discover").click()
        page.wait_for_timeout(1500)
        if page.locator("[data-testid=plugin-install]").count():
            page.locator("[data-testid=plugin-install]").first.click()
            page.wait_for_timeout(1500)
            expect(page.get_by_test_id("plugin-confirm").count() == 0, "a confirmation with a bogus hash was offered")
        page.evaluate(CLIENT_JS)
    injected = page.evaluate("() => document.querySelectorAll('img[src=\"x\"], [onerror], [onload], script:not([src]), a[href^=\"javascript:\"]').length")
    state = c.api("GET", "/api/state")
    shot(page, "55-code-hostile")
    probs = [p for p in rec.problems(allow=LOCKED_OK + [r"^50[24] GET .*/api/fs\?path=big$", r"console.error Failed to load resource.*50[24]"])]
    rec.save()
    expect(not dialogs and injected == 0 and state["status"] == 200 and not probs, f"dialogs {dialogs}, injected {injected}, state {state['status']}, errors {probs}")
    return f"bogus ids dropped, markup kept as text, 9 MiB answer refused (502), hostile session → {end['state']} ({[e['type'] for e in evs][:6]}); no dialogs, nothing injected, the backend answers"
