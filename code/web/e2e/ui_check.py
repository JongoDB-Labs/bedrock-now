"""Browser checks for the Code page against the mock backend (dev/mock-server.mjs), in the pinned Playwright image.

Runs two mocks inside the container (normal on :8195, hostile on :8196) with the Node binary that ships with the
Playwright driver, then walks the page on desktop (light and dark), tablet and phone: streaming, permission
prompts, diffs in the editor, the slash and @ pickers, uploads, background tasks, interrupt, reconnect with replay,
save conflicts, layout memory, and a hostile session (markup, bidi, control characters, giant strings, bad ids).
Every page runs under the CSP the main Caddy will send (the mock sets it); any CSP violation, page error or dialog
fails the check. Screenshots go to /out. Exit code 0 only when every check passed.
"""
import json
import os
import subprocess
import sys
import time
import traceback
import urllib.request

import playwright
from playwright.sync_api import sync_playwright, expect

OUT = os.environ.get("E2E_OUT_DIR", "/out")
WEB = os.environ.get("E2E_WEB_DIR", "/web")
ONLY = os.environ.get("E2E_ONLY", "")
NORMAL = "http://127.0.0.1:8195"
HOSTILE = "http://127.0.0.1:8196"
results = []


def node_bin():
    return os.path.join(os.path.dirname(playwright.__file__), "driver", "node")


def start_mocks():
    procs = []
    env = dict(os.environ, MOCK_QUIET="1")
    for port, extra in ((8195, []), (8196, ["--hostile", "--fast"])):
        procs.append(subprocess.Popen([node_bin(), f"{WEB}/dev/mock-server.mjs", "--port", str(port), "--host", "127.0.0.1", *extra], env=env))
    for url in (NORMAL, HOSTILE):
        for _ in range(100):
            try:
                urllib.request.urlopen(url + "/api/state", timeout=1).read()
                break
            except Exception:
                time.sleep(0.1)
        else:
            raise SystemExit(f"mock at {url} did not start")
    return procs


def post(url):
    urllib.request.urlopen(urllib.request.Request(url, method="POST", data=b""), timeout=5).read()


GUARD = """
window.__csp = [];
document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || '')));
"""


class Page:
    """A fresh browser context + page with the safety listeners attached."""

    def __init__(self, browser, base, name, **ctx):
        self.base = base
        self.name = name
        self.ctx = browser.new_context(**ctx)
        self.ctx.add_init_script(GUARD)
        self.page = self.ctx.new_page()
        self.errors, self.dialogs, self.requests = [], [], []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.on("console", lambda m: m.type == "error" and "favicon" not in m.text and self.errors.append("console: " + m.text))
        self.page.on("dialog", lambda d: (self.dialogs.append(d.message), d.dismiss()))
        self.page.on("request", lambda r: self.requests.append(r.url))

    def open(self):
        self.page.goto(self.base + "/")
        expect(self.page.get_by_test_id("conn")).to_have_text("Connected", timeout=10_000)
        return self.page

    def shot(self, file, **kw):
        self.page.screenshot(path=f"{OUT}/{file}", **kw)

    def assert_clean(self):
        csp = self.page.evaluate("window.__csp")
        # expected: the WebSocket dropped on purpose; the 409 of a save that found the file changed on disk
        errs = [e for e in self.errors if "ERR_CONNECTION_REFUSED" not in e and "WebSocket" not in e and "status of 409" not in e]
        assert not csp, f"CSP violations: {csp[:5]}"
        assert not errs, f"page errors: {errs[:5]}"
        assert not self.dialogs, f"dialogs: {self.dialogs}"

    def close(self):
        self.ctx.close()


def send(page, text):
    box = page.get_by_test_id("prompt")
    box.fill(text)
    box.press("Enter")


def wait_turns(page, n, timeout=30_000):
    expect(page.get_by_test_id("turn-end")).to_have_count(n, timeout=timeout)


def check(name):
    def deco(fn):
        def run(browser):
            if ONLY and ONLY not in name:
                return
            t0 = time.time()
            try:
                fn(browser)
                results.append(("PASS", name, time.time() - t0, ""))
                print(f"PASS  {name} ({time.time() - t0:.1f}s)", flush=True)
            except Exception as e:
                msg = f"{type(e).__name__}: {e}".splitlines()[0][:400]
                results.append(("FAIL", name, time.time() - t0, msg))
                print(f"FAIL  {name}: {msg}", flush=True)
                traceback.print_exc()
        run.__name__ = name
        CHECKS.append(run)
        return run
    return deco


CHECKS = []
DESKTOP = dict(viewport={"width": 1440, "height": 900}, color_scheme="light")


@check("desktop: stream, permission, diff, terminal (light + dark screenshots)")
def desktop_flow(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "desktop", **DESKTOP)
    page = p.open()
    page.get_by_role("button", name="Explain how this project is organised").click()
    wait_turns(page, 1)
    expect(page.locator(".msg-claude table")).to_have_count(1)
    expect(page.locator(".msg-claude a[href^='https://developer.mozilla.org']")).to_have_attribute("rel", "noopener noreferrer nofollow")
    send(page, "Please fix get() so it uses the retry policy")
    perm = page.get_by_test_id("permission")
    expect(perm).to_be_visible(timeout=15_000)
    expect(perm).to_contain_text("Claude wants to edit a file")
    expect(perm).to_contain_text("src/http/client.ts")
    expect(page.get_by_test_id("statusbar")).to_contain_text("1 waiting for you")
    assert page.title().startswith("(1) "), page.title()
    p.shot("desktop-permission-light.png")
    page.get_by_test_id("perm-once").click()
    wait_turns(page, 2)
    edit = page.locator(".tool[data-tool='Edit']")
    expect(edit).to_contain_text("+7")
    edit.get_by_role("button", name="Open diff").click()
    expect(page.locator(".pane:not(.hidden) .cm-host")).to_be_visible()
    page.wait_for_function("() => { const h = document.querySelector('.pane:not(.hidden) .cm-host'); return h && h.shadowRoot && h.shadowRoot.querySelector('.cm-mergeView'); }", timeout=10_000)
    # explorer: open src/http and see Claude's change marked
    page.locator(".tree-row[data-path='src']").click()
    page.locator(".tree-row[data-path='src/http']").click()
    expect(page.locator(".tree-row[data-path='src/http/client.ts'] .tree-mark")).to_have_text("M")
    page.keyboard.press("Control+Backquote")
    expect(page.get_by_test_id("terminal")).to_be_visible()
    page.wait_for_timeout(2500)  # spend rows arrive, the meter fills in
    expect(page.get_by_test_id("cost")).not_to_contain_text("…", timeout=10_000)
    page.mouse.move(0, 0)
    p.shot("desktop-light.png")
    page.emulate_media(color_scheme="dark")
    page.wait_for_timeout(300)
    p.shot("desktop-dark.png")
    page.emulate_media(color_scheme="light")
    # the file itself in the editor
    page.locator(".tree-row[data-path='src/http/retry.ts']").click()
    page.wait_for_function("() => { const h = document.querySelector('.pane:not(.hidden) .cm-host'); return h && h.shadowRoot && h.shadowRoot.querySelector('.cm-content'); }", timeout=10_000)
    expect(page.get_by_test_id("statusbar")).to_contain_text("TypeScript")
    p.assert_clean()
    p.close()


@check("slash palette, /context, @ file picker")
def palette(browser):
    p = Page(browser, NORMAL, "palette", **DESKTOP)
    page = p.open()
    page.get_by_test_id("chat-new").click()
    expect(page.get_by_test_id("session-state")).to_be_visible()
    box = page.get_by_test_id("prompt")
    box.click()
    box.type("/")
    pal = page.get_by_test_id("palette")
    expect(pal).to_be_visible()
    expect(pal).to_contain_text("/compact")
    box.type("comm")
    expect(pal).to_contain_text("/commit-commands:commit")
    p.shot("desktop-palette.png")
    box.press("Control+a")
    box.press("Backspace")
    box.type("/conte")
    expect(pal.locator(".palette-item.on")).to_contain_text("/context")
    box.press("Enter")
    expect(box).to_have_value("/context ")
    box.press("Enter")
    expect(page.get_by_test_id("local").last).to_contain_text("Context usage", timeout=10_000)
    expect(page.get_by_test_id("local").last.locator("table")).to_have_count(1)
    box.type("look at @src/http/re")
    expect(pal).to_contain_text("src/http/retry.ts", timeout=5000)
    p.shot("desktop-mention.png")
    box.press("Tab")
    expect(box).to_have_value("look at @src/http/retry.ts ")
    p.assert_clean()
    p.close()


@check("modes: Shift+Tab cycles; Accept edits skips the edit prompt")
def modes(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "modes", **DESKTOP)
    page = p.open()
    box = page.get_by_test_id("prompt")
    box.click()
    box.press("Shift+Tab")
    expect(page.get_by_test_id("mode-picker")).to_contain_text("Accept edits")
    send(page, "fix get() please")
    wait_turns(page, 1)
    expect(page.get_by_test_id("permission")).to_have_count(0)
    expect(page.locator(".tool[data-tool='Edit'] .tool-status")).to_have_attribute("title", "done")
    page.get_by_test_id("mode-picker").click()
    page.get_by_test_id("mode-plan").click()
    expect(page.get_by_test_id("mode-picker")).to_contain_text("Plan")
    p.assert_clean()
    p.close()


@check("deny with a reason; always allow; model switch note")
def deny_always(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "deny", **DESKTOP)
    page = p.open()
    send(page, "run the tests")
    expect(page.get_by_test_id("permission")).to_contain_text("Claude wants to run a command", timeout=10_000)
    expect(page.get_by_test_id("permission")).to_contain_text("npm test")
    expect(page.get_by_test_id("permission")).to_contain_text("Allow Bash(npm:*)")
    page.get_by_test_id("perm-deny").click()
    page.locator(".perm-deny textarea").fill("use pnpm instead")
    page.get_by_test_id("perm-deny-send").click()
    wait_turns(page, 1)
    expect(page.locator(".tool[data-tool='Bash']")).to_have_class("tool tool-error")
    send(page, "run the tests again")
    page.get_by_test_id("perm-always").click(timeout=10_000)
    wait_turns(page, 2)
    send(page, "run the tests a third time")
    wait_turns(page, 3)
    expect(page.get_by_test_id("permission")).to_have_count(0)
    page.get_by_test_id("model-picker").click()
    expect(page.locator(".model-panel")).to_contain_text("$4.40 / $22")
    expect(page.locator(".model-panel")).to_contain_text("writes the prompt cache again")
    p.shot("desktop-model-picker.png")
    page.get_by_test_id("model-haiku").click()
    expect(page.get_by_test_id("model-picker")).to_contain_text("Claude Haiku 5.5")
    p.assert_clean()
    p.close()


@check("AskUserQuestion: the choice goes back to Claude")
def ask_question(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "question", **DESKTOP)
    page = p.open()
    send(page, "ask me which policy to use")
    perm = page.get_by_test_id("permission")
    expect(perm).to_contain_text("Claude has a question for you", timeout=10_000)
    expect(perm).to_contain_text("Which retry policy should get() use?")
    perm.get_by_role("button", name="Aggressive (5 attempts)").click()
    wait_turns(page, 1)
    expect(page.locator(".msg-claude").last).to_contain_text("Aggressive (5 attempts)")
    p.assert_clean()
    p.close()


@check("sessions: resume shows the transcript and continues; fork; rename")
def resume(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "resume", **DESKTOP)
    page = p.open()
    page.get_by_test_id("side-sessions").click()
    rows = page.get_by_test_id("session-row")
    expect(rows.first).to_contain_text("Add jitter to the retry backoff")
    p.shot("desktop-sessions.png")
    rows.filter(has_text="Add jitter").locator(".sess-main").click()
    expect(page.get_by_test_id("msg-user").first).to_contain_text("The retry backoff is too regular")
    expect(page.locator(".tool[data-tool='Edit']")).to_contain_text("+1")
    send(page, "/cost")
    expect(page.get_by_test_id("local").last).to_contain_text("Total cost", timeout=10_000)
    expect(page.get_by_test_id("msg-user")).to_have_count(2)
    # fork the other one from its menu
    other = rows.filter(has_text="Why does CI fail")
    other.hover()
    other.get_by_role("button", name="Session actions").click()
    page.get_by_role("menuitem", name="Fork (new session from here)").click()
    expect(page.get_by_test_id("msg-user").first).to_contain_text("Why does CI fail", timeout=10_000)
    expect(page.locator(".chat-head .pane-title")).to_contain_text("Fork of")
    # rename the open one
    cur = page.locator(".sess.active")
    cur.hover()
    cur.get_by_role("button", name="Session actions").click()
    page.get_by_role("menuitem", name="Rename").click()
    page.get_by_label("Session name").fill("CI investigation")
    page.get_by_label("Session name").press("Enter")
    expect(page.locator(".sess.active")).to_contain_text("CI investigation")
    p.assert_clean()
    p.close()


@check("background task: listed, stoppable; interrupt with Esc")
def tasks(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "tasks", **DESKTOP)
    page = p.open()
    page.get_by_test_id("mode-picker").click()
    page.get_by_test_id("mode-acceptEdits").click()
    send(page, "start the dev server in the background")
    page.get_by_test_id("perm-once").click(timeout=10_000)
    wait_turns(page, 1)
    t = page.get_by_test_id("tasks")
    expect(t).to_contain_text("1 background task running")
    t.locator(".tasks-head").click()
    t.get_by_test_id("task-stop").click()
    expect(t).to_contain_text("finished", timeout=5000)
    send(page, "long answer please")
    expect(page.locator(".msg-claude.streaming")).to_have_count(1, timeout=10_000)
    page.get_by_test_id("prompt").press("Escape")
    expect(page.get_by_test_id("turn-end").last).to_contain_text("Stopped", timeout=10_000)
    p.assert_clean()
    p.close()


@check("reconnect re-attaches with since: nothing duplicated, nothing lost")
def reconnect(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "reconnect", **DESKTOP)
    page = p.open()
    send(page, "Explain how this project is organised")
    wait_turns(page, 1)
    before = page.locator(".messages-inner > *").count()
    post(NORMAL + "/__mock/drop")
    expect(page.get_by_test_id("conn")).not_to_have_text("Connected", timeout=5000)
    expect(page.get_by_test_id("conn")).to_have_text("Connected", timeout=20_000)
    page.wait_for_timeout(500)
    assert page.locator(".messages-inner > *").count() == before, "items changed after re-attach"
    send(page, "/cost")
    expect(page.get_by_test_id("local").last).to_contain_text("Total cost", timeout=10_000)
    # a reload re-attaches from scratch: history + live, no duplicates
    page.reload()
    expect(page.get_by_test_id("conn")).to_have_text("Connected", timeout=10_000)
    expect(page.get_by_test_id("msg-user")).to_have_count(2, timeout=10_000)
    # the backend closes the session (idle timeout, restart): the next prompt reopens it, the conversation stays
    sid = page.evaluate("JSON.parse(localStorage.getItem('bn.code.v1')).lastSession")
    urllib.request.urlopen(urllib.request.Request(f"{NORMAL}/api/sessions/{sid}", method="DELETE"), timeout=5).read()
    expect(page.get_by_test_id("session-state")).to_contain_text("closed", timeout=5000)
    send(page, "/cost")
    expect(page.get_by_test_id("local")).to_have_count(2, timeout=10_000)
    expect(page.get_by_test_id("msg-user")).to_have_count(3)
    expect(page.get_by_test_id("session-state")).to_contain_text("idle")
    p.assert_clean()
    p.close()


@check("editor: save, changed on disk → conflict → overwrite")
def save_conflict(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "save", **DESKTOP)
    page = p.open()
    page.locator(".tree-row[data-path='README.md']").click()
    page.wait_for_function("() => { const h = document.querySelector('.pane:not(.hidden) .cm-host'); return h && h.shadowRoot && h.shadowRoot.querySelector('.cm-content'); }", timeout=10_000)
    content = page.locator(".pane:not(.hidden) .cm-host .cm-content")
    content.click()
    page.keyboard.press("Control+End")
    page.keyboard.type("\nA new line.")
    expect(page.locator(".etab.on")).to_have_class("etab on dirty")
    page.keyboard.press("Control+s")
    expect(page.locator(".etab.on")).to_have_class("etab on")
    post(NORMAL + "/__mock/touch?path=README.md")
    page.keyboard.type(" More.")
    page.keyboard.press("Control+s")
    expect(page.get_by_test_id("conflict")).to_be_visible()
    expect(page.locator(".etab.on")).to_have_class("etab on dirty")
    p.shot("desktop-conflict.png")
    page.get_by_test_id("overwrite").click()
    expect(page.get_by_test_id("conflict")).to_have_count(0)
    expect(page.locator(".etab.on")).to_have_class("etab on")
    p.assert_clean()
    p.close()


@check("uploads: a file into the workspace + mention; an image as an attachment")
def uploads(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "upload", **DESKTOP)
    page = p.open()
    page.get_by_test_id("file-input").set_input_files(files=[{"name": "notes.txt", "mimeType": "text/plain", "buffer": b"hello"}])
    expect(page.get_by_test_id("prompt")).to_have_value("@notes.txt ", timeout=5000)
    expect(page.locator(".tree-row[data-path='notes.txt']")).to_be_visible()
    png = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082")
    page.get_by_test_id("file-input").set_input_files(files=[{"name": "shot.png", "mimeType": "image/png", "buffer": png}])
    expect(page.locator(".att img")).to_have_count(1)
    page.get_by_test_id("prompt").press("Enter")
    expect(page.get_by_test_id("msg-user").last).to_contain_text("1 image")
    wait_turns(page, 1)
    expect(page.locator(".msg-claude").last).to_contain_text("image/png")
    p.assert_clean()
    p.close()


@check("layout: pane sizes and panels are remembered per browser")
def layout(browser):
    p = Page(browser, NORMAL, "layout", **DESKTOP)
    page = p.open()
    split = page.get_by_test_id("split-right")
    box = split.bounding_box()
    page.mouse.move(box["x"] + 1, box["y"] + 300)
    page.mouse.down()
    page.mouse.move(box["x"] - 120, box["y"] + 300, steps=6)
    page.mouse.up()
    w = page.locator(".col-right").bounding_box()["width"]
    page.keyboard.press("Control+b")
    expect(page.locator(".col-left")).to_have_count(0)
    page.wait_for_timeout(400)
    page.reload()
    expect(page.get_by_test_id("conn")).to_have_text("Connected", timeout=10_000)
    assert abs(page.locator(".col-right").bounding_box()["width"] - w) < 2, "chat width not restored"
    expect(page.locator(".col-left")).to_have_count(0)
    page.keyboard.press("Control+b")
    # broken storage must not break the page
    page.evaluate("localStorage.setItem('bn.code.v1', '{\"layout\":{\"left\":-5,\"right\":\"x\"},\"model\":\"<img>\",\"mode\":\"bypassPermissions\"}')")
    page.reload()
    expect(page.get_by_test_id("conn")).to_have_text("Connected", timeout=10_000)
    expect(page.get_by_test_id("mode-picker")).to_contain_text("Ask")
    p.assert_clean()
    p.close()


@check("tablet (1024×768): chat + editor, terminal drawer")
def tablet(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "tablet", viewport={"width": 1024, "height": 768}, has_touch=True, color_scheme="light")
    page = p.open()
    send(page, "Please fix get() so it uses the retry policy")
    page.get_by_test_id("perm-once").click(timeout=15_000)
    wait_turns(page, 1)
    page.locator(".tool[data-tool='Edit']").get_by_role("button", name="Open diff").click()
    page.wait_for_function("() => { const h = document.querySelector('.pane:not(.hidden) .cm-host'); return h && h.shadowRoot && h.shadowRoot.querySelector('.cm-editor'); }", timeout=10_000)
    p.shot("tablet.png")
    page.get_by_role("button", name="Files").click()
    expect(page.get_by_test_id("file-tree")).to_be_visible()
    page.get_by_test_id("toggle-terminal").click()
    expect(page.get_by_test_id("terminal")).to_be_visible()
    p.shot("tablet-files-terminal.png")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "horizontal overflow"
    p.assert_clean()
    p.close()


@check("phone (390×844): chat first, files/editor/diff as sheets")
def phone(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "phone", viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme="light")
    page = p.open()
    p.shot("phone-empty.png")
    send(page, "Please fix get() so it uses the retry policy")
    expect(page.get_by_test_id("permission")).to_be_visible(timeout=15_000)
    p.shot("phone-permission.png")
    page.get_by_test_id("perm-once").click()
    wait_turns(page, 1)
    p.shot("phone.png")
    page.locator(".tool[data-tool='Edit']").get_by_role("button", name="Open diff").click()
    expect(page.get_by_test_id("sheet-editor")).to_be_visible()
    page.wait_for_function("() => { const h = document.querySelector('.sheet .pane:not(.hidden) .cm-host'); return h && h.shadowRoot && h.shadowRoot.querySelector('.cm-editor'); }", timeout=10_000)
    p.shot("phone-diff.png")
    page.get_by_test_id("sheet-editor").get_by_role("button", name="Close", exact=True).click()
    page.get_by_test_id("phone-files").click()
    expect(page.get_by_test_id("sheet-files")).to_be_visible()
    p.shot("phone-files.png")
    page.locator(".tree-row[data-path='README.md']").click()
    expect(page.get_by_test_id("sheet-editor")).to_be_visible()
    page.wait_for_timeout(600)
    p.shot("phone-editor.png")
    page.get_by_test_id("sheet-editor").get_by_role("button", name="Close", exact=True).click()
    page.get_by_test_id("phone-menu-btn").click()
    expect(page.get_by_test_id("phone-menu")).to_contain_text("Model")
    p.shot("phone-menu.png")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "horizontal overflow"
    p.assert_clean()
    p.close()


@check("hostile sandbox: everything is text, nothing runs, nothing overflows")
def hostile(browser):
    for scheme, vp, shot in (("light", {"width": 1440, "height": 900}, "hostile-desktop.png"), ("dark", {"width": 390, "height": 844}, "hostile-phone.png")):
        p = Page(browser, HOSTILE, "hostile", viewport=vp, color_scheme=scheme)
        page = p.open()
        title0 = page.title()
        send(page, "hostile")
        expect(page.get_by_test_id("permission")).to_be_visible(timeout=15_000)
        page.wait_for_timeout(800)
        r = page.evaluate("""() => {
          const all = [...document.querySelectorAll('*')];
          const content = document.querySelector('.messages');
          return {
            title: document.title,
            inlineScripts: document.querySelectorAll('script:not([src])').length,
            scripts: [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')).filter(s => !/^(\\.\\/)?(app|chunks\\/)[\\w.\\/]+\\.js$/.test(s)),
            styles: document.querySelectorAll('style, link[rel=stylesheet]:not([href^="app."])').length,
            onAttrs: all.filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).map(e => e.tagName),
            styleAttrsFromContent: [...content.querySelectorAll('[style]')].filter(e => !e.closest('.ctx-gauge')).map(e => e.getAttribute('style')).filter(s => /fixed|display/.test(s)),
            imgs: [...content.querySelectorAll('img')].length,
            svgs: [...content.querySelectorAll('svg:not(.ic):not(.spin)')].length,
            iframes: [...document.querySelectorAll('iframe')].filter(f => !f.classList.contains('term-frame')).length,
            forms: [...content.querySelectorAll('form')].filter(f => !f.classList.contains('perm-deny')).length,
            inputs: [...content.querySelectorAll('input')].filter(i => i.type !== 'checkbox').length,
            hrefs: [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')),
            pageOverflow: document.documentElement.scrollWidth - innerWidth,
            msgOverflow: content.scrollWidth - content.clientWidth,
            textLen: content.innerText.length,
            bidiShown: content.innerText.includes('⟨U+202E⟩'),
            rawBidi: /[\\u202a-\\u202e\\u2066-\\u2069]/.test(document.body.innerText),
            chromeText: [...document.querySelectorAll('.topbar, .statusbar')].map(e => e.innerText).join(' | '),
            sessionTexts: [...document.querySelectorAll('.sess-title')].map(e => e.textContent),
          };
        }""")
        assert "pwned" not in r["title"] and r["title"].endswith("Code · bedrock-now"), r["title"]
        assert r["inlineScripts"] == 0 and not r["scripts"], r
        assert r["styles"] == 0, r
        assert not r["onAttrs"], r["onAttrs"]
        assert not r["styleAttrsFromContent"], r["styleAttrsFromContent"]
        assert r["imgs"] == 0 and r["svgs"] == 0 and r["iframes"] == 0 and r["forms"] == 0 and r["inputs"] == 0, r
        bad = [h for h in r["hrefs"] if not (h.startswith("https://") or h.startswith("http://") or h == "#" or h.startswith("/api/"))]
        assert not bad, f"unsafe hrefs: {bad}"
        assert "https://bank.example@evil.example/login" not in r["hrefs"], "userinfo link kept"
        assert r["pageOverflow"] <= 0, f"page overflows by {r['pageOverflow']}px"
        assert r["msgOverflow"] <= 1, f"messages overflow by {r['msgOverflow']}px"
        assert r["bidiShown"] and not r["rawBidi"], r
        assert "<img" not in r["chromeText"] and "<svg" not in r["chromeText"], r["chromeText"]
        assert r["textLen"] < 1_500_000, r["textLen"]
        bad_req = [u for u in p.requests if "../" in u or "..%2F" in u.lower() or "%2E%2E" in u.upper()]
        assert not bad_req, bad_req
        if vp["width"] > 1000:
            page.evaluate("document.querySelector('.messages').scrollTop = 0")
            page.wait_for_timeout(200)
            p.shot("hostile-markdown.png")
        # the permission card must still be answerable, with a message
        page.get_by_test_id("perm-deny").click()
        page.locator(".perm-deny textarea").fill("<img src=x onerror=alert(1)>")
        page.get_by_test_id("perm-deny-send").click()
        expect(page.get_by_test_id("permission")).to_have_count(0)
        page.wait_for_timeout(300)
        p.shot(shot)
        assert page.title() == title0 or "pwned" not in page.title()
        p.assert_clean()
        p.close()


def main():
    os.makedirs(OUT, exist_ok=True)
    procs = start_mocks()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for c in CHECKS:
                c(browser)
            browser.close()
    finally:
        for pr in procs:
            pr.terminate()
    passed = sum(1 for r in results if r[0] == "PASS")
    print(f"\n{passed}/{len(results)} checks passed")
    with open(f"{OUT}/results.json", "w") as f:
        json.dump([{"result": r[0], "check": r[1], "seconds": round(r[2], 1), "detail": r[3]} for r in results], f, indent=1)
    sys.exit(0 if passed == len(results) and results else 1)


if __name__ == "__main__":
    main()
