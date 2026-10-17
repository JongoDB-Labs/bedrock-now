"""Settings page: per-key policy equivalence, in a real Chromium (run.sh: the e2e suite's pinned Playwright image; no
stack, no AWS, no helper).

A stub serves portal/portal/static under the portal's own CSP and answers /api/settings from the real
catalog/settings.tsv and catalog/settings-layout.tsv through the portal's own code (portal.settings.snapshot and
.layout), with every switch off and with every switch on, on this computer (here.remote false) and on a remote
device (here.remote true, REMOTE_ADMIN_ACTIONS on). It opens every section and every "More settings" from the
section list, then each remaining setting by its address (#settings/<KEY>: the ones under a switch that is off), and
lists each setting's enabled controls. It checks, for every key of settings.tsv:

  - a control that changes something only where the policy is edit, local, on-only, widen-local or regen (never for
    ro, derived or companion keys), and none for a local key on a remote device;
  - on this computer, every changeable key has one (an on-only switch that is on: none, turning it off is a terminal
    step); the keys shown inside another row (a pair's second half, a pin's automatic choice) through that row;
  - a widen-local switch is disabled on a remote device exactly when its next value protects less
    (portal.settings.weakens, the server's own rule), and an on-only switch whenever it is on; the nightly backups
    kept: an option is disabled exactly when it is fewer, remotely;
  - a form with a less protective value on a remote device (a higher budget, a longer session) says so before the
    password is asked for; the same value on this computer reaches the password dialog;
  - without a layout file (a damaged checkout) every changeable key still has its control;
  - no page error and no CSP violation anywhere.
Prints a summary, writes /out/settings-policy.json, exits 1 on any failure.
"""
import http.server
import json
import os
import re
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path

REPO = Path(os.environ.get("BN_REPO_DIR", "/repo"))
OUT = Path(os.environ.get("E2E_OUT_DIR", "/out"))
sys.path.insert(0, str(REPO / "portal"))
from portal import settings as st  # noqa: E402  (the portal's own snapshot reader, layout reader and rules)

from playwright.sync_api import sync_playwright  # noqa: E402

STATIC = REPO / "portal" / "portal" / "static"
PORT = 18301
BASE = f"http://127.0.0.1:{PORT}"
# portal/portal/app.py _security_headers (no app origins here)
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
       "frame-src 'none'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'")
CHANGE_POLICIES = ("edit", "local", "on-only", "widen-local", "regen")
ON = {"bool": "true", "on_off": "on", "true_blank": "true"}
OFF = {"bool": "false", "on_off": "off", "true_blank": ""}
SAMPLE = {"budget": "5", "days": "30", "pct": "80", "hour": "3", "keep": "7", "email": "owner@example.com",
          "login": "you@example.com", "stt_provider": "bedrock"}
# read-only switches and modes the page treats as parents (TERMINAL_ENABLED, REMOTE_TERMINAL, REMOTE_MODE …)
RO_ON = {"TERMINAL_ENABLED": "true", "REMOTE_TERMINAL": "true", "REMOTE_MODE": "tailscale",
         "REMOTE_PREVIEW_HOST": "bn-preview.tail1234.ts.net", "TERMINAL_WORKSPACE": "/home/you/work"}


def table():
    rows = []
    for line in (REPO / "catalog" / "settings.tsv").read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        c = line.split("\t")
        if c[0] == "key" or len(c) < 9:
            continue
        rows.append(dict(zip(("key", "group", "secret", "policy", "validator", "apply", "label", "note", "cli"), c)))
    return rows


TABLE = table()
BY_KEY = {r["key"]: r for r in TABLE}


def raw_value(r, state):
    """The .env value of key R with every switch off or on (plain keys only)."""
    v = r["validator"]
    if v in ON:
        return ON[v] if state == "on" else OFF[v]
    if r["key"] in RO_ON:
        return RO_ON[r["key"]] if state == "on" else ""
    return SAMPLE.get(v, "")


def snapshot(state):
    """The snapshot ./stack would write (lib/settings.sh settings_snapshot_write), read back by the portal's code."""
    keys = []
    for r in TABLE:
        row = {k: r[k] for k in ("key", "group", "secret", "policy", "validator", "apply", "label", "note", "cli")}
        if r["secret"] in ("-", "s"):
            row["value"] = raw_value(r, state)
            row["present"], row["set"] = True, bool(row["value"])
        else:   # a secret: set while the switches are on (the OpenRouter key turns its options on), never its value
            is_set = state == "on" or r["key"] in ("PORTAL_PASSWORD", "LITELLM_UI_PASSWORD", "RUSTFS_ACCESS_KEY",
                                                   "RUSTFS_SECRET_KEY", "SHARED_MCP_TOKEN", "LITELLM_KEY_SETUP")
            row["present"], row["set"] = True, is_set
            if is_set and r["secret"] in ("k", "h", "u"):
                row["hint"] = "…abcd"
        keys.append(row)
    d = tempfile.mkdtemp()
    Path(d, "settings.json").write_text(json.dumps({
        "version": 1, "written_at": int(time.time()), "base": "a" * 64, "remote_on": state == "on", "last_change": None,
        "choices": {"stt_models": {"bedrock": ["voxtral-small"], "openai": ["gpt-4o-mini-transcribe"], "groq": []},
                    "stt_bedrock_ready": ["voxtral-small"], "restart": ["litellm"],
                    "chat_models": [["claude-haiku-5-5", "Claude Haiku 5.5"], ["claude-opus-5-5", "Claude Opus 5.5"]],
                    "code_workspace": "/home/you/work",
                    # Settings › Claude Code › Models: [id, name, provider, vendor, compat, free, listed]
                    "code_models": [["claude-opus-5-5", "Claude Opus 5.5", "Bedrock", "Anthropic", "works", False, True],
                                    ["claude-haiku-5-5", "Claude Haiku 5.5", "Bedrock", "Anthropic", "works", False, True],
                                    ["llama-3-3-70b", "Llama 3.3 70B", "Bedrock", "Meta", "chat-only", False, True],
                                    ["mistral-large-3", "Mistral Large 3", "Bedrock", "Mistral", "works", False, True],
                                    ["or/google/gemma-4-31b-it:free", "Gemma 4 31B (free)", "OpenRouter", "Google", "untested", True, True],
                                    ["or/meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B Instruct", "OpenRouter", "Meta", "untested", False, True]]},
        "keys": keys}))
    snap = st.snapshot(Path(d))
    assert snap and len(snap["keys"]) == len(TABLE), "the portal did not read the snapshot"
    return snap


SNAP = {"off": snapshot("off"), "on": snapshot("on")}
LAYOUT = st.layout(REPO / "catalog")
assert LAYOUT["sections"] and LAYOUT["rows"], "the portal did not read catalog/settings-layout.tsv"
MODE = {"state": "off", "remote": False, "layout": True}


def settings_json():
    on = MODE["state"] == "on"
    return {"available": True, "snapshot": SNAP[MODE["state"]], "layout": LAYOUT if MODE["layout"] else {"sections": [], "rows": []},
            "helper": {"running": True, "heartbeat_at": int(time.time()), "settings": True, "diagnostics": list(st.DIAG_ACTIONS),
                       "in_progress": False, "job": None},
            "here": {"remote": MODE["remote"], "allowed": True}, "apps": {}, "user": "owner@example.com",
            "backups": {"written_at": None, "backups": [], "nightly": {"on": on, "hour": 2, "keep": 7}},
            "remote": {"on": on, "mode": "tailscale" if on else "off", "url": "https://bn.tail1234.ts.net" if on else ""}}


TYPES = {".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html"}


class Stub(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            page = (STATIC / "index.html").read_text(encoding="utf-8")
            meta = ('<meta name="bn-apps" content="{}">\n<meta name="bn-app-scheme" content="">\n'
                    '<meta name="bn-terminal" content="{&quot;enabled&quot;: false, &quot;here&quot;: false}">\n'
                    '<meta name="bn-code" content="{&quot;enabled&quot;: false, &quot;here&quot;: false}">')
            return self.send(200, page.replace("</head>", meta + "\n</head>", 1), "text/html; charset=utf-8")
        if path == "/api/settings":
            return self.send(200, json.dumps(settings_json()), "application/json")
        if path.startswith("/static/"):
            f = (STATIC / path[len("/static/"):]).resolve()
            if STATIC.resolve() in f.parents and f.is_file():
                return self.send(200, f.read_bytes(), TYPES.get(f.suffix, "application/octet-stream"))
        if path.startswith("/api/"):
            return self.send(503, json.dumps({"error": "a stub: only /api/settings answers"}), "application/json")
        return self.send(404, "not here", "text/plain")


# --- the page ---

COLLECT = """(sel) => {
  const one = (r) => {
    const acts = r.querySelector(':scope > .set-actions');
    const env = r.querySelector('.set-envkey code');   // "In .env: KEY · the keys shown inside the row"
    const o = { key: r.dataset.key, switch: null, selects: [], change: [], diag: [], reveal: [], visible: r.offsetParent !== null,
      inside: env ? env.textContent.split(' · ').slice(1) : [] };
    if (!acts) return o;
    for (const sw of acts.querySelectorAll('[role=switch]')) o.switch = { enabled: !sw.disabled, on: sw.getAttribute('aria-checked') === 'true' };
    for (const s of acts.querySelectorAll('select')) o.selects.push({ enabled: !s.disabled, options: [...s.options].map((x) => [x.value, x.disabled]) });
    for (const b of acts.querySelectorAll('button.action')) (b.dataset.act ? o.diag : o.change).push([b.textContent, !b.disabled]);
    for (const b of acts.querySelectorAll('.set-seg button')) o.change.push([b.textContent, !b.disabled]);
    for (const b of acts.querySelectorAll('button.copy[data-reveal]')) o.reveal.push([b.dataset.reveal, !b.disabled]);
    return o;
  };
  return [...document.querySelectorAll(sel)].map(one);
}"""


def changes(o):
    return bool((o["switch"] and o["switch"]["enabled"]) or any(s["enabled"] for s in o["selects"]) or any(e for _, e in o["change"]))


def ctx_values(state):
    return {k["key"]: k.get("value", "") for k in SNAP[state]["keys"]}


def expected_switch(key, state, remote):
    """(enabled, on) of KEY's switch as the policy says (portal.settings.weakens is the server's rule)."""
    r = BY_KEY[key]
    vals = ctx_values(state)
    v = vals.get(key, "")
    on_v, off_v = ON[r["validator"]], OFF[r["validator"]]
    cur_on = bool(vals.get("REMOTE_PREVIEW_HOST")) if key == "REMOTE_PREVIEW" else v == on_v
    nxt = off_v if cur_on else on_v
    enabled = True
    if r["policy"] == "on-only" and cur_on:
        enabled = False
    if remote and r["policy"] == "widen-local" and st.weakens(key, nxt, v, vals):
        enabled = False
    if r["policy"] not in CHANGE_POLICIES:
        enabled = False
    return enabled, cur_on


def walk(page, failures, label):
    """Every section from the list and every More, then every setting not seen by its address. -> {KEY: controls}"""
    page.goto(BASE + "/#settings")
    page.wait_for_selector("#settings .set-card:not([hidden])", timeout=20000)
    seen = {}
    sections = page.eval_on_selector_all(".set-nav .set-nav-item", "els => els.map(e => e.dataset.section)")
    if MODE["layout"] and sections != [s["id"] for s in LAYOUT["sections"]]:
        failures.append(f"{label}: the section list is {sections}")
    for sid in sections:
        page.click(f".set-nav-item[data-section='{sid}']")
        page.wait_for_selector(f"#set-{sid}:not([hidden])")
        page.evaluate("() => document.querySelectorAll('#settings details.set-more').forEach((d) => { d.open = true; })")
        for o in page.evaluate(COLLECT, f"#set-{sid} .set-row[data-key], #set-{sid} .set-adv-item[data-key]"):
            if o["visible"]:
                seen[o["key"]] = o
    rows = [r for r in (LAYOUT["rows"] if MODE["layout"] else []) if not r["key"].startswith("+") and r["place"] != "with"]
    for r in rows:
        if r["key"] in seen:
            continue
        if not r["parent"]:
            failures.append(f"{label}: {r['key']} ({r['section']}, {r['place']}) not shown in its section")
        page.evaluate("k => { location.hash = '#settings'; location.hash = '#settings/' + k; }", r["key"])
        sel = f"#settings .set-row[data-key={r['key']}], #settings .set-adv-item[data-key={r['key']}]"
        page.wait_for_selector(sel, state="visible", timeout=10000)
        seen[r["key"]] = page.evaluate(COLLECT, sel)[0]
    return seen


def check_controls(seen, state, remote, failures, label, layout=True):
    # the keys a row shows inside it: as its "In .env:" line names them (and, with a layout, as the layout says)
    with_parent = {k: o["key"] for o in seen.values() for k in o["inside"]}
    if layout:
        for r in LAYOUT["rows"]:
            if r["place"] == "with" and with_parent.get(r["key"]) != r["parent"]:
                failures.append(f"{label}: {r['key']} is not listed inside {r['parent']}'s row")
    for key, r in BY_KEY.items():
        if key in with_parent and key not in seen:
            host = seen.get(with_parent[key])
            if host is None:
                failures.append(f"{label}: {key}: neither its row nor {with_parent[key]}'s is on the page")
            elif not remote and r["policy"] in CHANGE_POLICIES and not changes(host):
                failures.append(f"{label}: {key} ({r['policy']}): {with_parent[key]}'s row has no control for it")
            continue
        o = seen.get(key)
        if o is None:
            failures.append(f"{label}: {key} is not on the page")
            continue
        p, ch = r["policy"], changes(o)
        if ch and p not in CHANGE_POLICIES:
            failures.append(f"{label}: {key} ({p}) has a control that changes it: {o}")
        if ch and remote and p == "local":
            failures.append(f"{label}: {key} (local) can be changed from a remote device: {o}")
        if o["switch"]:
            want, cur_on = expected_switch(key, state, remote)
            if o["switch"]["enabled"] != want or o["switch"]["on"] != cur_on:
                failures.append(f"{label}: {key} ({p}) switch {o['switch']}, policy says enabled={want} on={cur_on}")
        elif not remote and p in CHANGE_POLICIES and not ch:
            failures.append(f"{label}: {key} ({p}) has no control on this computer: {o}")
        if key == "BACKUP_KEEP" and o["selects"]:
            cur = ctx_values(state)["BACKUP_KEEP"] or "7"
            for val, disabled in o["selects"][0]["options"]:
                want = remote and val != cur and st.weakens("BACKUP_KEEP", val, cur)
                if disabled != want:
                    failures.append(f"{label}: BACKUP_KEEP option {val} disabled={disabled}, policy says {want}")
        for rk, enabled in o["reveal"]:
            if rk not in st.REVEAL:
                failures.append(f"{label}: {key} offers to reveal {rk}, which the portal never reveals")


def check_forms(page, remote, failures, label):
    """A less protective value typed in a form: refused before the password remotely, asked for locally."""
    for key, weaker, safer in (("BUDGET_OPENWEBUI", "500", "1"), ("PORTAL_SESSION_DAYS", "60", "7"), ("BUDGET_ALERT_PCT", "95", "60")):
        page.evaluate("k => { location.hash = '#settings'; location.hash = '#settings/' + k; }", key)
        row = page.locator(f"#settings .set-row[data-key={key}]")
        row.wait_for(state="visible", timeout=10000)
        for value, refused in ((weaker, remote), (safer, False)):
            row.locator(".set-actions .action", has_text=re.compile("Change|Set")).first.click()
            form = row.locator(".set-form")
            form.locator("input").first.fill(value)
            form.locator("button[type=submit]").click()
            page.wait_for_timeout(150)
            dialog = page.locator("#set-confirm[open]").count() == 1
            err = form.locator(".error:not([hidden])")
            said = err.count() == 1 and "from the computer running bedrock-now" in err.inner_text()
            if refused and (dialog or not said):
                failures.append(f"{label}: {key}={value} remotely: dialog={dialog}, said={said}")
            if not refused and (not dialog or said):
                failures.append(f"{label}: {key}={value}: dialog={dialog}, refused={said}")
            if dialog:
                page.click("#set-confirm-cancel")
            if form.count():
                form.locator("button", has_text="Cancel").click()


def check_code_models(page, failures, label):
    """Settings › Claude Code › Models: All enabled · Anthropic only · Pick… (a filtered checklist in groups), and the
    default model's select in groups; screenshots for the record."""
    page.evaluate("k => { location.hash = '#settings'; location.hash = '#settings/' + k; }", "CODE_MODELS")
    row = page.locator("#settings .set-row[data-key=CODE_MODELS]")
    row.wait_for(state="visible", timeout=10000)
    chips = row.locator(".set-seg button").all_inner_texts()
    if chips != ["All enabled", "Anthropic only", "Pick…"]:
        failures.append(f"{label}: CODE_MODELS offers {chips}")
    if "6 enabled chat models, 3 of them checked" not in row.inner_text():
        failures.append(f"{label}: CODE_MODELS does not say how many models work: {row.inner_text()[:200]}")
    page.screenshot(path=str(OUT / "settings-code-models.png"), clip=row.bounding_box())
    row.locator(".set-seg button", has_text="Pick…").click()
    form = row.locator(".set-form")
    heads = form.locator(".set-code-head").all_text_contents()
    if heads != ["Anthropic (Bedrock)", "Other providers on Bedrock", "OpenRouter: free", "OpenRouter: paid"]:
        failures.append(f"{label}: the checklist's groups are {heads}")
    form.locator("input[type=search]").fill("free")
    visible = [x for x in form.locator("label.set-radio").all() if x.is_visible()]
    if len(visible) != 1 or "Gemma 4 31B (free)" not in visible[0].inner_text():
        failures.append(f"{label}: the filter 'free' shows {[x.inner_text() for x in visible]}")
    form.locator("input[type=search]").fill("")
    page.screenshot(path=str(OUT / "settings-code-models-pick.png"), clip=row.bounding_box())
    form.locator("button[type=submit]").click()
    page.wait_for_timeout(150)
    if "Pick at least one model" not in form.locator(".error").inner_text():
        failures.append(f"{label}: an empty list is not refused before the password")
    form.locator("label.set-radio", has_text="Llama 3.3 70B").first.locator("input").check()
    form.locator("button[type=submit]").click()
    page.wait_for_timeout(150)
    if page.locator("#set-confirm[open]").count() != 1:
        failures.append(f"{label}: a list with a model does not reach the password dialog")
    else:
        page.click("#set-confirm-cancel")
    if form.count():
        form.locator("button", has_text="Cancel").click()
    page.evaluate("k => { location.hash = '#settings'; location.hash = '#settings/' + k; }", "CODE_DEFAULT_MODEL")
    row = page.locator("#settings .set-row[data-key=CODE_DEFAULT_MODEL]")
    row.wait_for(state="visible", timeout=10000)
    row.locator(".set-actions .action", has_text=re.compile("Change|Set")).first.click()
    groups = row.locator(".set-form select optgroup").evaluate_all("els => els.map((e) => e.label)")
    if groups != ["Anthropic (Bedrock)", "Other providers on Bedrock", "OpenRouter: free", "OpenRouter: paid"]:
        failures.append(f"{label}: CODE_DEFAULT_MODEL's select groups are {groups}")
    row.locator(".set-form button", has_text="Cancel").click()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    failures, summary = [], {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        runs = [("off", False, True), ("on", False, True), ("off", True, True), ("on", True, True), ("off", False, False)]
        for state, remote, layout in runs:
            MODE.update(state=state, remote=remote, layout=layout)
            label = f"{'remote' if remote else 'local'}/{state}{'' if layout else '/no-layout'}"
            ctx = browser.new_context(viewport={"width": 1280, "height": 900})
            ctx.add_init_script("try { localStorage.setItem('bn.tour', JSON.stringify({open: false, cur: 'welcome', done: [], skipped: [], base: {}})); } catch (_) {}")
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e, errors=errors: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m, errors=errors: errors.append(f"console: {m.text}")
                    if m.type == "error" and ("Content Security Policy" in m.text or "Refused" in m.text) else None)
            try:
                seen = walk(page, failures, label)
                check_controls(seen, state, remote, failures, label, layout)
                if layout and state == "off":
                    check_forms(page, remote, failures, label)
                if layout and state == "off" and not remote:
                    check_code_models(page, failures, label)
                summary[label] = {"settings": len(seen), "changeable": sum(1 for o in seen.values() if changes(o))}
            except Exception:  # noqa: BLE001
                failures.append(f"{label}: {traceback.format_exc(limit=3)}")
                page.screenshot(path=str(OUT / f"settings-policy-{label.replace('/', '-')}.png"), full_page=True)
            failures += [f"{label}: {e}" for e in errors]
            ctx.close()
        browser.close()
    srv.shutdown()
    (OUT / "settings-policy.json").write_text(json.dumps({"summary": summary, "failures": failures}, indent=2))
    for k, v in summary.items():
        print(f"  {k:<18} {v['settings']} settings on the page, {v['changeable']} with a control that changes them")
    if failures:
        print(f"FAIL: {len(failures)}")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print(f"ok: every key of settings.tsv ({len(TABLE)}) has controls only where its policy allows, local and remote, "
          "switches off and on, and without the layout file")


if __name__ == "__main__":
    main()
