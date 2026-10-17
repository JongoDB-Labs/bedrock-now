"""Activity (the portal's notification centre) and the global search (Ctrl/⌘+K), in Chromium against the throwaway:
the bell and its panel from what the status files say (a ./stack command typed in a terminal, the Code page turned on
by an update nobody watched) and from the summary (a budget past BUDGET_ALERT_PCT and one used up: the summary is
answered with those numbers, nothing is spent); read, dismiss, Keep; links into Settings; the phone's sheet under More;
browser notifications only after they are turned on, never for what was there already, never while the page has the
focus. Search: a setting by its key (Enter opens it), a walkthrough step, the docs index built into the portal's image,
a Chat conversation through Open WebUI's own search, the Code tab's frame asked for a workspace file (opened in its
editor) — and its status report turned into an Activity item, while the same report from another origin is ignored;
hostile input timed. No Bedrock calls. Screenshots: desktop and phone, light and dark."""

from __future__ import annotations

import json
import re
import secrets
import time
from pathlib import Path

from common import ENV, Skip, check, expect, need, origin
from checks_browser import STATE, _write_json, chat_frame, login, owui_api, shot

ST = STATE / "status"
TERM_JOB = ST / "terminal-job.json"
CODE_DEFAULT = ST / "code-default.json"
CODE_ON = ENV.get("CODE_ENABLED") == "true" and ENV.get("TERMINAL_ENABLED") == "true"
MOD = "Control"   # Linux Chromium: Ctrl+K (⌘K on a Mac)


class Saved:
    """The status files a check writes, put back as they were afterwards."""

    def __init__(self, *paths: Path):
        self.saved = {p: (p.read_bytes() if p.exists() else None) for p in paths}

    def restore(self):
        for p, b in self.saved.items():
            if b is None:
                p.unlink(missing_ok=True)
            else:
                p.write_bytes(b)
                p.chmod(0o644)


def _terminal_job(command: str, phase: str, message: str, ago: int = 60) -> str:
    now = int(time.time())
    jid = f"t-{now - ago - 30}-{secrets.randbelow(90000) + 10000}"
    _write_json(TERM_JOB, {"id": jid, "action": command.split()[0], "command": command, "phase": phase, "message": message,
                           "started_at": now - ago - 30, "updated_at": now - ago, "finished_at": now - ago, "version": "", "pid": 1})
    return jid


def _over_budget(page):
    """/api/summary answered with the Chat key at 92 % of its budget and the setup key used up (BUDGET_ALERT_PCT as set)."""
    def handle(route):
        resp = route.fetch()
        data = resp.json()
        for k in data["spend"]["keys"]:
            if k["alias"] == "open-webui":
                k.update(spend=18.4, max_budget=20.0, error=None)
            elif k["alias"] == "setup":
                k.update(spend=5.0, max_budget=5.0, error=None)
        route.fulfill(response=resp, json=data)
    page.route(re.compile(re.escape(origin()) + r"/api/summary$"), handle)


def _items(page) -> list[dict]:
    return page.evaluate("() => window.bnActivity.items()")


def _wait_items(page, pred, what, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        its = _items(page)
        if pred(its):
            return its
        page.wait_for_timeout(300)
    raise AssertionError(f"Activity: no {what}; items {[(i['id'], i['unread']) for i in _items(page)]}")


@check("browser", "activity-centre")
def activity_centre(ctx):
    saved = Saved(TERM_JOB, CODE_DEFAULT)
    page, rec = ctx.page("activity")
    try:
        jid = _terminal_job("config set", "failed", "BUDGET_OPENWEBUI: not a number (e2e)")
        if CODE_ON:
            _write_json(CODE_DEFAULT, {"at": int(time.time()) - 120, "workspace": "/home/e2e/bedrock-now-workspace", "egress": True, "terminal": True})
        _over_budget(page)
        login(page)
        page.wait_for_selector("#activity-btn:not([hidden])")
        its = _wait_items(page, lambda xs: any(x["id"].startswith("budget:setup:") for x in xs) and any(x["id"] == f"job:terminal:{jid}:failed" for x in xs),
                          "budget and job items")
        ids = [x["id"] for x in its]
        expect(any(re.fullmatch(r"budget:open-webui:[0-9A-Za-z:.-]+:warn", i) for i in ids), f"no Chat budget warning: {ids}")
        expect(any(re.fullmatch(r"budget:setup:[0-9A-Za-z:.-]+:over", i) for i in ids), f"no used-up setup budget: {ids}")
        if CODE_ON:
            expect(any(i.startswith("code-default:") for i in ids), f"no Code page notice: {ids}")
        unread = sum(1 for x in its if x["unread"])
        count = page.inner_text("#activity-count")
        expect(count == (str(unread) if unread < 10 else "9+") and page.locator("#activity-btn.has-bad").count() == 1, f"bell says {count!r}, {unread} unread")
        expect(page.locator("#code-default-notice").count() == 0, "the old Home banner is back")
        page.click("#activity-btn")
        page.wait_for_selector("#activity:not([hidden]) .act-item")
        expect(page.evaluate("document.activeElement.id") == "activity-title", "focus is not on the panel's heading")
        text = page.inner_text("#activity")
        for words in ("92% of its budget used", "budget used up", "./stack config set failed", "BUDGET_OPENWEBUI: not a number (e2e)"):
            expect(words in text, f"panel lacks {words!r}")
        shot(page, "60-activity-desktop")
        page.emulate_media(color_scheme="dark")
        page.wait_for_timeout(200)
        shot(page, "60b-activity-desktop-dark")
        page.emulate_media(color_scheme="light")
        # mark one read, dismiss another (Show dismissed brings it back), Keep the Code page's notice
        job_item = page.locator(f'.act-item[data-id="job:terminal:{jid}:failed"]')
        job_item.locator("button.act-read").click()
        expect(job_item.locator("button.act-read").inner_text() == "Mark as unread", "not marked read")
        budget_item = page.locator('.act-item[data-kind="budget"]').first
        bid = budget_item.get_attribute("data-id")
        budget_item.locator("button.act-x").click()
        expect(page.locator(f'.act-item[data-id="{bid}"]').count() == 0, "dismissed item still listed")
        page.click("#activity-show-dismissed")
        expect(page.locator(f'.act-item.gone[data-id="{bid}"]').count() == 1, "Show dismissed does not show it")
        page.click("#activity-show-dismissed")
        if CODE_ON:
            page.locator('.act-item[data-kind="code-default"] button', has_text="Keep").click()
            expect(page.evaluate("localStorage.getItem('bn.code.defaultNotice')") is not None, "Keep is not remembered for the old banner")
        stored = page.evaluate("localStorage.getItem('bn.activity')") or ""
        expect("config set" not in stored and "budget used up" not in stored and "92%" not in stored, "an item's text in localStorage")
        # read and dismissed survive a reload (this browser); the count follows
        before = page.inner_text("#activity-count")
        page.reload()
        page.wait_for_selector("#activity-btn:not([hidden])")
        _wait_items(page, lambda xs: any(x["id"] == f"job:terminal:{jid}:failed" and not x["unread"] for x in xs), "read state after a reload")
        # a budget item leads to its setting (Settings › Spending & budgets, the setting lit up)
        page.click("#activity-btn")
        page.locator('.act-item[data-kind="budget"] button', has_text="Change the budget").first.click()
        page.wait_for_selector("#settings:not([hidden]) .set-row[data-key=BUDGET_SETUP], #settings:not([hidden]) .set-row[data-key=BUDGET_OPENWEBUI]", timeout=20000)
        expect(page.locator("#activity").is_hidden(), "the panel stayed open")
        expect(re.fullmatch(r"#settings/BUDGET_(SETUP|OPENWEBUI)", page.evaluate("location.hash")), f"address {page.evaluate('location.hash')}")
        # Escape and a click outside close it
        page.click("#activity-btn")
        page.wait_for_selector("#activity:not([hidden])")
        page.keyboard.press("Escape")
        expect(page.locator("#activity").is_hidden() and page.evaluate("document.activeElement.id") == "activity-btn", "Escape")
        probs = rec.problems()
        rec.save()
        expect(not probs, f"errors: {probs}")
        return f"bell {count} → panel: budgets warn/used up (from the summary), ./stack config set failed, " \
               f"{'the Code page notice (Keep), ' if CODE_ON else ''}read/dismiss/show dismissed kept per browser (ids only); " \
               f"{before} unread after; a budget item opens its setting; Escape closes"
    finally:
        page.unroute(re.compile(re.escape(origin()) + r"/api/summary$"))
        saved.restore()


@check("browser", "activity-phone")
def activity_phone(ctx):
    saved = Saved(TERM_JOB)
    try:
        _terminal_job("code enable", "done", "The Code page is on")
        page, rec = ctx.page("activity-phone", device="phone")
        login(page)
        page.wait_for_selector(".shell")
        expect(page.locator("#activity-btn").is_hidden() and page.locator("#search-btn").is_hidden(), "the sidebar's bell or search on a phone")
        page.locator("#more-dot:not([hidden])").wait_for(state="attached", timeout=20000)
        expect("unread in Activity" in (page.get_attribute("#more-btn", "aria-label") or ""), "More does not say what waits")
        page.click("#more-btn")
        page.wait_for_selector("#more-sheet:not([hidden]) #more-activity")
        expect(page.locator("#more-activity-count").is_visible(), "no count in More")
        shot(page, "61-activity-phone-more")
        page.click("#more-activity")
        page.wait_for_selector("#activity:not([hidden]) .act-item")
        expect(page.locator("#more-sheet").is_hidden(), "More stayed open")
        box = page.locator(".act-panel").bounding_box()
        expect(box and box["width"] >= 380 and box["y"] + box["height"] >= 840, f"not a bottom sheet: {box}")
        page.wait_for_timeout(300)
        shot(page, "61b-activity-phone")
        page.emulate_media(color_scheme="dark")
        page.wait_for_timeout(200)
        shot(page, "61c-activity-phone-dark")
        page.emulate_media(color_scheme="light")
        page.click(".act-close")
        expect(page.locator("#activity").is_hidden(), "the sheet did not close")
        # Search from More: full screen
        page.click("#more-btn")
        page.click("#more-search")
        page.wait_for_selector("#search[open]")
        page.fill("#search-input", "budget")
        page.wait_for_selector("#search-list .search-opt")
        sbox = page.locator("#search").bounding_box()
        expect(sbox and sbox["width"] >= 388, f"search not full width on a phone: {sbox}")
        expect("Workspace files: search them in the Code page itself" in page.inner_text("#search-notes") or not CODE_ON, "phone note on files")
        shot(page, "63-search-phone")
        page.emulate_media(color_scheme="dark")
        page.wait_for_timeout(200)
        shot(page, "63b-search-phone-dark")
        page.emulate_media(color_scheme="light")
        page.keyboard.press("Escape")
        probs = rec.problems()
        rec.save()
        expect(not probs, f"errors: {probs}")
        return "phone: no bell in the bar; More shows Activity with its count and a dot on More; Activity a bottom sheet; Search full screen from More"
    finally:
        saved.restore()


# The browser's Notification, recorded: its permission starts at "default" and becomes what window.__answer says once
# the page asks (the headless browser's own answer is not what is under test here — the page's use of it is)
NOTIFY_JS = """() => {
  window.__notes = []; window.__asked = 0; window.__answer = 'granted';
  let perm = 'default';
  function Fake(title, opts) { window.__notes.push({ title, body: opts && opts.body, tag: opts && opts.tag }); }
  Fake.prototype.close = function () {};
  Object.defineProperty(Fake, 'permission', { get: () => perm });
  Fake.requestPermission = () => { window.__asked++; perm = window.__answer; return Promise.resolve(perm); };
  window.Notification = Fake;
}"""


@check("browser", "activity-notifications")
def activity_notifications(ctx):
    saved = Saved(TERM_JOB)
    try:
        _terminal_job("backup", "done", "Backed up (e2e, before)", ago=300)
        page, rec = ctx.page("activity-notify")
        page.add_init_script(f"({NOTIFY_JS})()")
        login(page)
        page.wait_for_selector("#activity-btn:not([hidden])")
        _wait_items(page, lambda xs: any(x["id"].startswith("job:terminal:") for x in xs), "the first job")
        page.wait_for_timeout(500)
        expect(page.evaluate("window.__notes.length") == 0 and page.evaluate("window.__asked") == 0, "asked or notified without a click")
        # refused by the browser: off, and the panel says where to allow them
        page.click("#activity-btn")
        page.evaluate("window.__answer = 'denied'")
        page.click("#activity-notify")
        page.locator("#activity-notify-note", has_text="blocks notifications").wait_for(timeout=5000)
        expect(page.get_attribute("#activity-notify", "aria-pressed") == "false", "on although the browser refused")
        page.keyboard.press("Escape")
        # allowed (a new page: the permission is the browser's, asked again from "default")
        page.reload()
        page.wait_for_selector("#activity-btn:not([hidden])")
        page.click("#activity-btn")
        page.click("#activity-notify")
        page.locator("#activity-notify[aria-pressed=true]").wait_for(timeout=5000)
        expect(page.evaluate("window.__asked") == 1, "the permission was not asked exactly once")
        expect("while a portal tab is open" in page.inner_text("#activity-notify-note"), "the note does not say how it works")
        expect(page.evaluate("window.__notes.length") == 0, "a notification for what was there already")
        page.keyboard.press("Escape")
        # a new item while the page is not looked at: one notification
        page.evaluate("() => { document.hasFocus = () => false; }")
        jid = _terminal_job("update", "failed", "Could not download (e2e)", ago=5)
        page.evaluate("() => window.bnActivity.refresh()")
        page.wait_for_function("() => window.__notes.length > 0", timeout=15000)
        notes = page.evaluate("window.__notes")
        # fixed words only: nothing of the job's message (it could be on a lock screen)
        expect(len(notes) == 1 and notes[0]["title"] == "A job failed" and notes[0]["body"] == "Details in Activity, in the bedrock-now portal."
               and notes[0]["tag"] == f"bn-job:terminal:{jid}:failed" and "e2e" not in json.dumps(notes), f"notifications {notes}")
        # the same item again (another poll): no second one; with the focus: none
        page.evaluate("() => window.bnActivity.refresh()")
        page.wait_for_timeout(800)
        page.evaluate("() => { document.hasFocus = () => true; }")
        _terminal_job("clean", "done", "Removed old images (e2e)", ago=1)
        page.evaluate("() => window.bnActivity.refresh()")
        page.wait_for_timeout(1500)
        expect(page.evaluate("window.__notes.length") == 1, f"more notifications: {page.evaluate('window.__notes')}")
        probs = rec.problems()
        rec.save()
        expect(not probs, f"errors: {probs}")
        return ("nothing asked until the click; refused → stays off and says where to allow them; allowed → asked once, none for "
                "what was there, one (fixed words, no job message) for a new job while unfocused, none again, none while focused")
    finally:
        saved.restore()


# --- the global search ---

def _search(page, text: str):
    if not page.locator("#search[open]").count():
        page.keyboard.press(f"{MOD}+k")
        page.wait_for_selector("#search[open]", timeout=5000)
    page.fill("#search-input", text)


def _option(page, group: str, has_text: str, timeout=15000):
    loc = page.locator(f'#search-list .search-sec:has(#sg-{group}) .search-opt', has_text=has_text).first
    loc.wait_for(timeout=timeout)
    return loc


@check("browser", "global-search")
def global_search(ctx):
    page, rec = ctx.page("search")
    login(page)
    page.wait_for_selector("#search-btn:not([hidden])")
    idx = page.evaluate("() => fetch('/api/search/index', {headers: {'X-Requested-With': 'bedrock-now'}}).then(r => r.json())")
    pages = {p["file"]: p for p in idx["docs"]["pages"]}
    expect("README.md" in pages and len(pages["README.md"]["sections"]) >= 20 and "docs/security.md" in pages,
           f"the docs index built into the image: {list(pages)}")
    expect(len(idx["settings"]["rows"]) > 100 and len(idx["settings"]["sections"]) == 11, "the Settings index")
    # Ctrl+K from Home: a setting by its key, Enter opens it
    page.keyboard.press(f"{MOD}+k")
    page.wait_for_selector("#search[open]")
    expect(page.evaluate("document.activeElement.id") == "search-input", "focus not in the box")
    page.fill("#search-input", "BUDGET_TERMINAL")
    opt = _option(page, "settings", "BUDGET_TERMINAL")
    expect(page.get_attribute("#search-input", "aria-activedescendant") == opt.get_attribute("id"), "the first result is not active")
    shot(page, "62-search-desktop")
    page.keyboard.press("Enter")
    page.wait_for_selector("#settings:not([hidden]) .set-row[data-key=BUDGET_TERMINAL]", timeout=20000)
    expect(page.evaluate("location.hash") == "#settings/BUDGET_TERMINAL" and page.locator("#search[open]").count() == 0, "Enter did not open the setting")
    # the docs: the installed release's README section on GitHub
    _search(page, "costs budgets")
    d = _option(page, "docs", "Costs & budgets")
    expect(d.locator(".so-ext").count() == 1, "a doc result is not marked as leaving the portal")
    # keyboard: ↓ moves, Esc closes and gives the focus back
    first = page.get_attribute("#search-input", "aria-activedescendant")
    page.keyboard.press("ArrowDown")
    expect(page.get_attribute("#search-input", "aria-activedescendant") != first, "ArrowDown did not move")
    page.emulate_media(color_scheme="dark")
    page.wait_for_timeout(200)
    shot(page, "62b-search-desktop-dark")
    page.emulate_media(color_scheme="light")
    page.keyboard.press("Escape")
    expect(page.locator("#search[open]").count() == 0, "Escape did not close")
    # a walkthrough step opens the walkthrough there
    _search(page, "One store for both")
    _option(page, "tour", "One store for both").click()
    page.wait_for_selector('#tour:not([hidden]) .tour-step.cur[data-step="shared"]', timeout=10000)
    page.click("#tour .tour-x")
    # the sidebar's box opens it too, with the last query selected (typing replaces it); nothing typed: the pages
    page.click("#search-btn")
    page.wait_for_selector("#search[open]")
    expect(page.evaluate("(() => { const i = document.querySelector('#search-input'); return i.value === 'One store for both' && i.selectionStart === 0 && i.selectionEnd === i.value.length; })()"),
           "the last query is not kept, selected")
    page.fill("#search-input", "")
    page.wait_for_selector("#search[open] #sg-pages")
    page.keyboard.press("Escape")
    result = ["setting by key → #settings/BUDGET_TERMINAL", "docs index in the image (README, docs/*)", "walkthrough step", "↑↓ Esc"]
    # Chat: a conversation found by Open WebUI's own search, opened in the Chat tab
    try:
        need("open-webui")
        fl, f = chat_frame(page)
        tag = f"bnsearch{secrets.token_hex(4)}"
        r = owui_api(f, "/api/v1/chats/new", "POST", {"chat": {"title": f"Trip planning {tag}", "messages": []}})
        expect(r["status"] == 200, f"new chat {r['status']}")
        cid = json.loads(r["body"])["id"]
        try:
            page.click(".tab[data-tab=home]")
            _search(page, tag)
            o = _option(page, "chats", f"Trip planning {tag}", timeout=20000)
            o.click()
            page.wait_for_function("id => document.querySelector('iframe[data-app=chat]').src.endsWith('/c/' + id)", arg=cid, timeout=10000)
            expect(page.locator(".tab[data-tab=chat][aria-current=page]").count() == 1, "the Chat tab is not shown")
            result.append("a Chat conversation through Open WebUI's search → /c/<id>")
        finally:
            owui_api(f, f"/api/v1/chats/{cid}", "DELETE")
    except Skip as e:
        result.append(f"chat skipped ({e})")
    probs = rec.problems(allow=[r"^401 GET " + re.escape(origin("files")) + r"/rustfs/admin/v3/", r"console\.error .*No token found in localStorage"])
    rec.save()
    expect(not probs, f"errors: {probs}")
    return "; ".join(result)


@check("browser", "global-search-code")
def global_search_code(ctx):
    """The Code tab's frame answers the search (a workspace file, opened in its editor) and its status report becomes an
    Activity item (Answer); the same report from the portal's own window (another origin) is ignored."""
    if not CODE_ON:
        raise Skip("the Code page is off in this throwaway")
    from checks_code import LOCKED_OK, code_frame, unlock_page
    page, rec = ctx.page("search-code")
    login(page)
    page.click(".tab[data-tab=code]")
    f = code_frame(page)
    unlock_page(f)
    f = code_frame(page)
    f.wait_for_function("() => document.querySelector('meta[name=bn-csp-nonce]') !== null", timeout=20000)
    page.wait_for_function("() => window.bnCode && window.bnCode.ready()", timeout=30000)
    name = f"bn-e2e-zebra-{secrets.token_hex(3)}.md"
    st = f.evaluate("""n => fetch('/api/fs/file?path=' + encodeURIComponent(n), {method: 'PUT', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({text: '# zebra\\n', create: true})}).then(r => r.status)""", name)
    expect(st == 200, f"PUT {name}: {st}")
    try:
        page.click(".tab[data-tab=home]")
        page.click("#search-btn")
        page.wait_for_selector("#search[open]")
        page.fill("#search-input", name[:-3])
        o = _option(page, "files", name, timeout=20000)
        expect("Workspace file" in o.inner_text(), "not a workspace file")
        o.click()
        page.wait_for_selector('iframe[data-app="code"]:not([hidden])')
        f = code_frame(page)
        f.locator(f'.etab.on[title="{name}"]').wait_for(timeout=15000)   # the editor's active tab: that file
        # the frame's status report, a session waiting: an Activity item with Answer; from another origin: nothing
        sid = "5e55a0b1-0c2d-4e3f-8a9b-0c1d2e3f4a5b"
        page.evaluate("""s => window.postMessage({type: 'bn-code-status', pending: 1, waiting: 1, sessions: [{id: s, title: 'forged', state: 'waiting'}]}, '*')""", sid)
        page.wait_for_timeout(500)
        expect(not any(x["id"].startswith(f"code:{sid}") for x in _items(page)), "a report from the portal's own window made an item")
        f.evaluate("""([s, o]) => parent.postMessage({type: 'bn-code-status', pending: 1, waiting: 1, busy: false, bypass: false,
            sessions: [{id: s, title: 'Fix the login page \\u202Egpj.exe', state: 'waiting', waiting: 1}]}, o)""", [sid, origin()])
        its = _wait_items(page, lambda xs: any(x["id"].startswith(f"code:{sid}:") for x in xs), "Code session item", timeout=10)
        it = next(x for x in its if x["id"].startswith(f"code:{sid}:"))
        expect(it["text"] == "Fix the login page ⟨U+202E⟩gpj.exe", f"title not shown as text: {it['text']!r}")
        page.click("#activity-btn")
        expect(page.locator(f'.act-item[data-id="{it["id"]}"] button', has_text="Answer").count() == 1, "no Answer")
        shot(page, "64-activity-code-session")
        page.keyboard.press("Escape")
    finally:
        f = code_frame(page)
        f.evaluate("n => fetch('/api/fs?path=' + encodeURIComponent(n), {method: 'DELETE'}).then(r => r.status)", name)
    probs = rec.problems(allow=LOCKED_OK)
    rec.save()
    expect(not probs, f"errors: {probs}")
    return f"file {name} found through the Code tab's frame and opened in its editor; its waiting session → Activity (Answer), title as text; a forged report from another origin ignored"


@check("browser", "global-search-timing")
def global_search_timing(ctx):
    page, rec = ctx.page("search-timing")
    login(page)
    page.wait_for_selector("#search-btn:not([hidden])")
    ms = page.evaluate("""() => {
      const F = window.bnFuzzy, S = window.bnSearch._pure;
      const cands = Array.from({length: 5000}, (_, i) => 'a'.repeat(1024) + i);
      const t0 = performance.now();
      F.rank(cands, 'a'.repeat(63) + 'b', (x) => x, (x) => x);
      F.rank(cands.map((c) => c.replace(/a/g, 'ab')), 'ab'.repeat(31) + 'c', (x) => x);
      S.shownText('\\u202E'.repeat(200000), 120);
      return performance.now() - t0;
    }""")
    expect(ms < 2000, f"hostile matching took {ms:.0f} ms")
    page.keyboard.press(f"{MOD}+k")
    page.wait_for_selector("#search[open]")
    t0 = time.time()
    page.fill("#search-input", "a" * 63 + "b")
    page.wait_for_selector("#search-status:has-text('result')", timeout=5000)
    page.fill("#search-input", "x" * 500)
    expect(len(page.input_value("#search-input")) == 64, "the box takes more than 64 characters")
    took = time.time() - t0
    expect(took < 3, f"typing hostile queries took {took:.1f} s")
    rec.save()
    return f"5,000 × 1 KiB near-misses and a 200,000-character title: {ms:.0f} ms; the box caps at 64 characters"
