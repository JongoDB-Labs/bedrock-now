"""Browser checks for the Code page against the mock backend (dev/mock-server.mjs), in the pinned Playwright image.

Runs two mocks inside the container (normal on :8195, hostile on :8196) with the Node binary that ships with the
Playwright driver, then walks the page on desktop (light and dark), tablet and phone: streaming, permission
prompts (the rules Always applies, the workspace option, partially shown prompts, padded commands, default-to-no,
MultiEdit), plan approval, diffs in the editor, the slash and @ pickers, uploads, background tasks, interrupt,
prompts queued below the stream and refused ones taken back, /clear and a reset from the CLI, fork from a prompt,
"load earlier", reconnect with replay and close codes, an expired unlock, the budget banner, save conflicts, layout
memory, a hostile session (markup, bidi, control characters, giant strings, bad ids), and previews of dev servers (the
"Preview :5173" chip, the preview tab with viewports, its address field and a new tab, the Ports panel with Stop and
.claude/launch.json's Start, the phone's sheet, a hostile port list) against the mock's fake preview site.
Every page runs under the CSP the main Caddy will send (the mock sets it); any CSP violation, page error or dialog
fails the check. Screenshots go to /out. Exit code 0 only when every check passed.
"""
import json
import os
import re
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
        # (and the 401s of an expired unlock)
        errs = [e for e in self.errors if "ERR_CONNECTION_REFUSED" not in e and "WebSocket" not in e and "status of 409" not in e and "status of 401" not in e]
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
    # the terminal through the code host's hand-off (one unlock): /.bn/terminal, here redirected to the mock terminal
    expect(page.locator("iframe.term-frame")).to_have_attribute("src", "/.bn/terminal")
    expect(page.frame_locator("iframe.term-frame").locator("pre")).to_contain_text("mock", timeout=10_000)
    expect(page.locator(".messages-inner[role=log]")).to_have_count(1)
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
    # Always: the rule as the backend will write it, in the sandbox's own settings; the workspace file only as a
    # separate, explicit choice with its warning
    expect(page.get_by_test_id("perm-rules")).to_contain_text("Bash(npm:*)")
    expect(page.get_by_test_id("perm-rules")).to_contain_text("sandbox's Claude Code settings")
    expect(page.get_by_test_id("perm-always-project")).to_be_visible()
    expect(page.get_by_test_id("perm-project-note")).to_contain_text(".claude/settings.local.json")
    expect(page.get_by_test_id("perm-project-note")).to_contain_text("Claude Code on your computer")
    page.mouse.move(0, 0)
    expect(page.get_by_test_id("perm-once")).to_be_enabled()
    p.shot("desktop-permission-rules.png")
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


@check("AskUserQuestion: one choice, several choices and Other go back as answers")
def ask_question(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "question", **DESKTOP)
    page = p.open()
    send(page, "ask me which policy to use")
    perm = page.get_by_test_id("permission")
    expect(perm).to_contain_text("Claude has a question for you", timeout=10_000)
    expect(perm).to_contain_text("Which retry policy should get() use?")
    expect(page.get_by_test_id("q-send")).to_be_disabled()
    perm.get_by_text("Aggressive (5 attempts)").click()
    page.get_by_test_id("q-send").click()
    wait_turns(page, 1)
    expect(page.locator(".msg-claude").last).to_contain_text("Aggressive (5 attempts)")
    expect(page.locator(".tool[data-tool='AskUserQuestion'] .tool-status")).to_have_attribute("title", "done")
    # two questions: several choices plus your own ("Other"), and one choice
    send(page, "ask me two questions about retries")
    expect(page.get_by_test_id("question")).to_have_count(2, timeout=10_000)
    q1, q2 = page.get_by_test_id("question").nth(0), page.get_by_test_id("question").nth(1)
    expect(q1).to_contain_text("choose any")
    q1.get_by_text("GET", exact=True).click()
    q1.get_by_text("POST", exact=True).click()
    q1.get_by_test_id("q-other").check()
    expect(q1.get_by_test_id("q-other-text")).to_be_focused()
    q1.get_by_test_id("q-other-text").fill("PATCH")
    expect(page.get_by_test_id("q-send")).to_be_disabled()   # the second question has no answer yet
    q2.get_by_text("In a config file").click()
    page.mouse.move(0, 0)
    p.shot("desktop-question.png")
    page.get_by_test_id("q-send").click()
    wait_turns(page, 2)
    expect(page.locator(".msg-claude").last).to_contain_text("retry GET, POST, PATCH; the policy goes: In a config file")
    # Decline: Claude hears no
    send(page, "ask me which policy to use")
    page.get_by_test_id("q-decline").click(timeout=10_000)
    wait_turns(page, 3)
    expect(page.locator(".msg-claude").last).to_contain_text("sensible default")
    p.assert_clean()
    p.close()


@check("plugins: marketplace from the workspace, install, a command shown with its SHA-256 before it runs, palette")
def plugins(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "plugins", **DESKTOP)
    page = p.open()
    send(page, "/cost")   # a session, so a change reloads its plugins
    expect(page.get_by_test_id("local").last).to_contain_text("Total cost", timeout=10_000)
    page.get_by_test_id("more-menu").click()
    page.get_by_test_id("menu-plugins").click()
    dlg = page.get_by_test_id("plugins-dialog")
    expect(dlg.locator("[data-plugin='commit-commands@claude-code-plugins']")).to_be_visible()
    dlg.get_by_test_id("plugins-tab-marketplaces").click()
    dlg.get_by_test_id("marketplace-source").fill("/workspace/e2e-mkt")
    dlg.get_by_test_id("marketplace-add").click()
    expect(dlg.get_by_test_id("plugins-note")).to_contain_text("Successfully added marketplace: e2e-mkt")
    expect(dlg.locator("[data-marketplace='e2e-mkt']")).to_be_visible()
    dlg.get_by_test_id("plugins-tab-discover").click()
    dlg.get_by_test_id("plugins-search").fill("hello")
    expect(dlg.get_by_test_id("plugins-available").locator(".plg-row")).to_have_count(2)
    dlg.locator("[data-plugin='hello-local@e2e-mkt'] [data-testid=plugin-install]").click()
    expect(dlg.get_by_test_id("plugins-note")).to_contain_text("Successfully installed plugin: hello-local@e2e-mkt")
    expect(dlg.get_by_test_id("plugins-note")).to_contain_text("Reloaded in 1 open session")
    # a command-installed plugin: nothing runs until the command and its SHA-256 are accepted
    expect(dlg.locator("[data-plugin='hello-cmd@e2e-mkt']")).to_contain_text("installs by running a command")
    dlg.locator("[data-plugin='hello-cmd@e2e-mkt'] [data-testid=plugin-install]").click()
    confirm = dlg.get_by_test_id("plugin-confirm")
    expect(confirm).to_contain_text("is installed by running a command from the marketplace e2e-mkt")
    expect(dlg.get_by_test_id("plugin-confirm-command")).to_have_text("printf '%s\\n' /workspace/e2e-mkt/plugins/hello-cmd")
    sha = dlg.get_by_test_id("plugin-confirm-sha").inner_text()
    assert len(sha) == 64 and all(c in "0123456789abcdef" for c in sha), sha
    p.shot("desktop-plugins-confirm.png")
    confirm.get_by_role("button", name="Cancel").click()
    expect(dlg.get_by_test_id("plugin-confirm")).to_have_count(0)
    expect(dlg.locator("[data-plugin='hello-cmd@e2e-mkt'] [data-testid=plugin-install]")).to_be_visible()
    dlg.locator("[data-plugin='hello-cmd@e2e-mkt'] [data-testid=plugin-install]").click()
    dlg.get_by_test_id("plugin-confirm-accept").click()
    expect(dlg.get_by_test_id("plugins-note")).to_contain_text("Successfully installed plugin: hello-cmd@e2e-mkt")
    # installed: switch one off and on, update one, uninstall one
    dlg.get_by_test_id("plugins-tab-installed").click()
    row = dlg.locator("[data-plugin='hello-local@e2e-mkt']")
    row.get_by_test_id("plugin-toggle").click()
    expect(row).to_contain_text("off")
    row.get_by_test_id("plugin-toggle").click()
    expect(row.get_by_test_id("plugin-toggle")).to_have_attribute("aria-checked", "true")
    dlg.locator("[data-plugin='commit-commands@claude-code-plugins'] [data-testid=plugin-update]").click()
    expect(dlg.get_by_test_id("plugins-note")).to_contain_text("already at the latest version")
    dlg.locator("[data-plugin='commit-commands@claude-code-plugins'] [data-testid=plugin-uninstall]").click()
    dlg.locator("[data-plugin='commit-commands@claude-code-plugins'] [data-testid=plugin-uninstall-confirm]").click()
    expect(dlg.locator("[data-plugin='commit-commands@claude-code-plugins']")).to_have_count(0)
    page.mouse.move(0, 0)
    p.shot("desktop-plugins.png")
    dlg.get_by_role("button", name="Close").click()
    # the session reloaded its plugins: the new commands are in the palette, the uninstalled ones are gone
    box = page.get_by_test_id("prompt")
    box.click()
    box.type("/hel")
    pal = page.get_by_test_id("palette")
    expect(pal).to_contain_text("/hello-local:hello")
    box.press("Control+a")
    box.press("Backspace")
    box.type("/h")
    expect(pal).to_contain_text("/hello-cmd:hi")
    box.press("Control+a")
    box.press("Backspace")
    box.type("/commit")
    page.wait_for_timeout(300)
    expect(page.locator("[data-testid=palette]", has_text="commit-commands:commit")).to_have_count(0)
    p.assert_clean()
    p.close()


@check("MCP panel: status, off/on for the session, reconnect, a server of your own (sandbox-only note), restart")
def mcp_panel(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "mcp", **DESKTOP)
    page = p.open()
    send(page, "/cost")
    expect(page.get_by_test_id("local").last).to_contain_text("Total cost", timeout=10_000)
    page.get_by_test_id("more-menu").click()
    page.get_by_test_id("menu-mcp").click()
    dlg = page.get_by_test_id("mcp-dialog")
    srv = dlg.locator("[data-server='bedrock-shared']")
    expect(srv.get_by_test_id("mcp-status")).to_have_text("connected")
    expect(srv).to_contain_text("5 tools")
    expect(srv).to_contain_text("http://terminal-gateway:8091/mcp")
    srv.get_by_test_id("mcp-toggle").click()
    expect(srv.get_by_test_id("mcp-status")).to_have_text("disabled")
    srv.get_by_test_id("mcp-toggle").click()
    expect(srv.get_by_test_id("mcp-status")).to_have_text("connected")
    srv.get_by_test_id("mcp-reconnect").click()
    expect(srv.get_by_test_id("mcp-status")).to_have_text("connected")
    expect(srv.get_by_test_id("mcp-remove")).to_have_count(0)   # the stack's own server is not yours to remove
    expect(dlg.get_by_test_id("mcp-sandbox-note")).to_contain_text("inside the sandbox only")
    dlg.get_by_test_id("mcp-name").fill("my-tools")
    dlg.get_by_test_id("mcp-command").fill("npx")
    dlg.get_by_test_id("mcp-args").fill("-y\nsome-mcp-server@1.2.3")
    dlg.get_by_test_id("mcp-add-submit").click()
    expect(dlg.get_by_test_id("mcp-note")).to_contain_text("Added stdio MCP server my-tools")
    page.mouse.move(0, 0)
    p.shot("desktop-mcp.png")
    dlg.get_by_test_id("mcp-restart").click()
    mine = dlg.locator("[data-server='my-tools']")
    expect(mine.get_by_test_id("mcp-status")).to_have_text("connected", timeout=10_000)
    expect(mine).to_contain_text("npx -y some-mcp-server@1.2.3")
    mine.get_by_test_id("mcp-remove").click()
    mine.get_by_test_id("mcp-remove-confirm").click()
    expect(mine).to_contain_text("Removed from your configuration")
    # bad input stays in the form
    dlg.get_by_test_id("mcp-name").fill("bedrock-shared")
    dlg.get_by_test_id("mcp-command").fill("x")
    dlg.get_by_test_id("mcp-add-submit").click()
    expect(dlg.get_by_test_id("mcp-note")).to_contain_text("not bedrock-shared")
    p.assert_clean()
    p.close()


@check("sessions: opening a session that is open already attaches to it (no second copy)")
def existing(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "existing", **DESKTOP)
    page = p.open()
    send(page, "Explain how this project is organised")
    wait_turns(page, 1)
    sid = page.evaluate("JSON.parse(localStorage.getItem('bn.code.v1')).lastSession")
    # a second page (another tab) resumes the same session from the list: the backend answers existing, it attaches
    p2 = Page(browser, NORMAL, "existing-2", **DESKTOP)
    page2 = p2.open()
    page2.get_by_test_id("side-sessions").click()
    page2.get_by_test_id("session-row").filter(has_text="Explain how this project").first.locator(".sess-main").click()
    page2.wait_for_function("(sid) => (JSON.parse(localStorage.getItem('bn.code.v1') || '{}').lastSession) === sid", arg=sid, timeout=5000)
    expect(page2.get_by_test_id("msg-user")).to_have_count(1, timeout=10_000)
    expect(page2.locator(".msg-claude table")).to_have_count(1)
    send(page2, "/cost")
    expect(page.get_by_test_id("local").last).to_contain_text("Total cost", timeout=10_000)   # the first tab sees it too
    expect(page.get_by_test_id("msg-user")).to_have_count(2)
    expect(page2.get_by_test_id("msg-user")).to_have_count(2)
    # a new session, and a prompt typed while it opens: it goes to the new session, not the one shown before
    page2.get_by_test_id("chat-new").click()
    send(page2, "/context")
    expect(page2.locator(".chat-head .pane-title")).to_have_text("New session", timeout=10_000)
    expect(page2.get_by_test_id("local").last).to_contain_text("Context usage", timeout=10_000)
    expect(page2.get_by_test_id("msg-user")).to_have_count(1)
    page.wait_for_timeout(500)
    expect(page.get_by_test_id("msg-user")).to_have_count(2)   # the first session got nothing
    p.assert_clean()
    p2.assert_clean()
    p2.close()
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
    expect(page.get_by_test_id("turn-end")).to_have_count(2)   # the live replay, not only the transcript
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
    # (Markdown opens in Preview: its Source is the editor)
    page.locator(".pane:not(.hidden) [data-testid=view-source]").click()
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
    page.get_by_role("button", name="Plugins & marketplaces").click()
    expect(page.get_by_test_id("plugins-dialog")).to_be_visible()
    expect(page.get_by_test_id("plugins-dialog").locator("[data-plugin='commit-commands@claude-code-plugins']")).to_be_visible()
    p.shot("phone-plugins.png")
    assert page.evaluate("(() => { const d = document.querySelector('dialog[open]').getBoundingClientRect(); return d.left >= 0 && d.right <= innerWidth; })()"), "dialog wider than the phone"
    page.get_by_test_id("plugins-dialog").get_by_role("button", name="Close").click()
    page.get_by_test_id("phone-menu-btn").click()
    page.get_by_role("button", name="MCP servers").click()
    expect(page.get_by_test_id("mcp-dialog").locator("[data-server='bedrock-shared']")).to_be_visible()
    p.shot("phone-mcp.png")
    page.get_by_test_id("mcp-dialog").get_by_role("button", name="Close").click()
    page.get_by_test_id("phone-menu-btn").click()
    page.get_by_test_id("phone-menu-memory").click()
    expect(page.get_by_test_id("memory-dialog")).to_contain_text("/workspace/CLAUDE.md")
    p.shot("phone-memory.png")
    assert page.evaluate("(() => { const d = document.querySelector('dialog[open]').getBoundingClientRect(); return d.left >= 0 && d.right <= innerWidth; })()"), "memory dialog wider than the phone"
    page.get_by_test_id("memory-dialog").get_by_role("button", name="Close").first.click()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "horizontal overflow"
    p.assert_clean()
    p.close()


ARM = """() => {
  window.__armed = undefined;
  const seen = (n) => n.querySelector && (n.matches('[data-testid=permission]') ? n : n.querySelector('[data-testid=permission]'));
  const mo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { const c = seen(n); if (c) {
    const b = c.querySelector('[data-testid=perm-once]'); mo.disconnect(); window.__armed = b ? b.disabled : null; return; } } });
  mo.observe(document.body, { childList: true, subtree: true });
}"""


@check("permission cards: armed after a moment; partially shown; padded command; default-to-no; focus stays in the prompt box; MultiEdit")
def permission_cards(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "perm-cards", **DESKTOP)
    page = p.open()
    # a card's Allow is off for its first moments (a keystroke meant for the prompt box must not approve)
    page.evaluate(ARM)
    send(page, "run the tests")
    page.wait_for_function("() => window.__armed !== undefined", timeout=10_000)
    assert page.evaluate("window.__armed") is True, "Allow once was enabled the moment the card appeared"
    expect(page.get_by_test_id("perm-once")).to_be_enabled()
    page.get_by_test_id("perm-once").click()
    wait_turns(page, 1)
    # too large to show in full: says so, can only be denied
    send(page, "write the huge command fixture")
    perm = page.get_by_test_id("permission")
    expect(page.get_by_test_id("perm-partial")).to_be_visible(timeout=10_000)
    page.wait_for_timeout(600)
    expect(page.get_by_test_id("perm-once")).to_be_disabled()
    expect(page.get_by_test_id("perm-always")).to_be_disabled()
    page.mouse.move(0, 0)
    p.shot("desktop-permission-partial.png", clip=perm.bounding_box())
    page.get_by_test_id("perm-deny").click()
    page.get_by_test_id("perm-deny-send").click()
    wait_turns(page, 2)
    # a command whose end is pushed out of sight: a warning with the counts
    send(page, "show the padded listing")
    expect(page.get_by_test_id("perm-command-warning")).to_contain_text("characters", timeout=10_000)
    expect(page.get_by_test_id("perm-command-warning")).to_contain_text("240 spaces")
    page.mouse.move(0, 0)
    p.shot("desktop-permission-padded.png", clip=page.get_by_test_id("permission").bounding_box())
    page.get_by_test_id("perm-deny").click()
    page.get_by_test_id("perm-deny-send").click()
    wait_turns(page, 3)
    # default to no: Deny has the focus (sent with the Send button: no text field has it), no one-key approve, no Always
    page.get_by_test_id("prompt").fill("risky cleanup")
    page.get_by_test_id("send").click()
    expect(page.get_by_test_id("permission")).to_be_visible(timeout=10_000)
    expect(page.get_by_test_id("perm-deny")).to_be_focused()
    expect(page.get_by_test_id("perm-always")).to_have_count(0)
    expect(page.get_by_test_id("perm-always-project")).to_have_count(0)
    page.wait_for_timeout(600)
    page.keyboard.press("1")
    page.wait_for_timeout(300)
    expect(page.get_by_test_id("permission")).to_have_count(1)
    page.keyboard.press("Enter")
    expect(page.locator(".perm-deny textarea")).to_be_focused()
    page.keyboard.press("Enter")
    wait_turns(page, 4)
    expect(page.locator(".msg-claude").last).to_contain_text("Left it alone")
    # a card that appears while the (empty) prompt box has the focus leaves it there: "1" is typed, nothing approved;
    # once you go to the card yourself (a click), "1" answers it
    send(page, "run the tests")
    perm = page.get_by_test_id("permission")
    expect(perm).to_be_visible(timeout=10_000)
    expect(page.get_by_test_id("prompt")).to_be_focused()
    page.wait_for_timeout(600)
    page.keyboard.press("1")
    page.wait_for_timeout(300)
    expect(page.get_by_test_id("prompt")).to_have_value("1")
    expect(perm).to_have_count(1)
    page.get_by_test_id("prompt").fill("")
    perm.locator(".perm-head").click()
    expect(perm).to_have_attribute("data-engaged", "true")
    page.keyboard.press("1")
    wait_turns(page, 5)
    expect(page.locator(".tool[data-tool='Bash'] .tool-status").last).to_have_attribute("title", "done")
    # MultiEdit: the edits a card lists, the rest counted; replace_all said
    send(page, "rename with many edits")
    expect(page.get_by_test_id("perm-more-edits")).to_contain_text("and 4 more edits", timeout=10_000)
    expect(page.get_by_test_id("perm-replace-all")).to_be_visible()
    # (more edits than a card lists: not shown in full, so it can only be denied)
    expect(page.get_by_test_id("perm-partial")).to_be_visible()
    expect(page.get_by_test_id("perm-once")).to_be_disabled()
    page.get_by_test_id("perm-deny").click()
    page.get_by_test_id("perm-deny-send").click()
    wait_turns(page, 6)
    expect(page.locator(".tool[data-tool='MultiEdit']")).to_be_visible()
    # "Always, in this workspace's settings": allowed from then on, as Always is
    send(page, "run the tests again")
    page.get_by_test_id("perm-always-project").click(timeout=10_000)
    wait_turns(page, 7)
    send(page, "run the tests a third time")
    wait_turns(page, 8)
    expect(page.get_by_test_id("permission")).to_have_count(0)
    p.assert_clean()
    p.close()


@check("plan approval: approve with accepted edits; keep planning with a message")
def plan_approval(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "plan", **DESKTOP)
    page = p.open()
    page.get_by_test_id("mode-picker").click()
    page.get_by_test_id("mode-plan").click()
    send(page, "fix get() so it retries")
    perm = page.get_by_test_id("permission")
    expect(perm).to_contain_text("Claude has a plan", timeout=10_000)
    expect(perm.locator("h2")).to_contain_text("Route get() through retry()")
    page.mouse.move(0, 0)
    expect(page.get_by_test_id("plan-approve-edits")).to_be_enabled()
    p.shot("desktop-plan.png")
    page.get_by_test_id("plan-approve-edits").click()
    wait_turns(page, 1)
    expect(page.get_by_test_id("mode-picker")).to_contain_text("Accept edits")
    expect(page.locator(".tool[data-tool='Edit'] .tool-status")).to_have_attribute("title", "done")
    expect(page.get_by_test_id("permission")).to_have_count(0)
    page.get_by_test_id("mode-picker").click()
    page.get_by_test_id("mode-plan").click()
    send(page, "and the post() method?")
    page.get_by_test_id("plan-keep").click(timeout=10_000)
    page.locator(".perm-plan textarea").fill("also cover post() with a timeout")
    page.get_by_test_id("plan-keep-send").click()
    wait_turns(page, 2)
    expect(page.locator(".msg-claude").last).to_contain_text("also cover post() with a timeout")
    expect(page.get_by_test_id("mode-picker")).to_contain_text("Plan")
    p.assert_clean()
    p.close()


@check("models: by full id (picker, /model typed); Plan on Haiku stays on Haiku; a turn on another model says so")
def models_full_id(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "models", **DESKTOP)
    page = p.open()

    def models():
        st = json.loads(urllib.request.urlopen(NORMAL + "/api/state", timeout=5).read())
        return [x["model"] for x in st["sessions"]]

    def wait_model(want):
        for _ in range(50):
            if models() == [want]:
                return
            page.wait_for_timeout(100)
        raise AssertionError(f"the session's model: {models()} (want {want})")

    send(page, "hello there")
    wait_turns(page, 1)
    wait_model("claude-sonnet-5-5")   # bedrock-now's default named by an alias ("sonnet"): sent by its id
    page.get_by_test_id("model-picker").click()
    page.get_by_test_id("model-haiku").click()
    wait_model("claude-haiku-5-5")
    # /model with an alias: switched by the full id, not sent to Claude Code
    n = page.get_by_test_id("msg-user").count()
    send(page, "/model sonnet")
    expect(page.locator(".toast").last).to_contain_text("Model: Claude Sonnet 5.5")
    wait_model("claude-sonnet-5-5")
    expect(page.get_by_test_id("msg-user")).to_have_count(n)
    # Plan mode on Haiku, picked by its id: planned on Haiku (with the alias Claude Code plans on Sonnet)
    page.get_by_test_id("model-picker").click()
    page.get_by_test_id("model-haiku").click()
    page.get_by_test_id("mode-picker").click()
    page.get_by_test_id("mode-plan").click()
    send(page, "and the post() method?")
    page.get_by_test_id("plan-keep").click(timeout=10_000)
    page.locator(".perm-plan textarea").fill("not yet")
    page.get_by_test_id("plan-keep-send").click()
    wait_turns(page, 2)
    expect(page.get_by_test_id("turn-model")).to_have_count(0)
    # a turn Claude Code ran on a model other than the one picked: its line says which (bedrock-now's name)
    page.get_by_test_id("mode-picker").click()
    page.get_by_test_id("mode-default").click()
    send(page, "answer on another model")
    wait_turns(page, 3)
    expect(page.get_by_test_id("turn-model")).to_have_count(1)
    expect(page.get_by_test_id("turn-model")).to_contain_text("ran on Claude Sonnet 5.5")
    page.mouse.move(0, 0)
    p.shot("desktop-turn-model.png")
    p.assert_clean()
    p.close()


@check("prompts: queued below the stream; a refused one comes back; /clear, /resume; a reset from the CLI")
def prompts(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "prompts", **DESKTOP)
    page = p.open()
    send(page, "long answer please")
    expect(page.locator(".msg-claude.streaming")).to_have_count(1, timeout=10_000)
    send(page, "/cost")
    queued = page.locator(".msg-user.queued")
    expect(queued).to_have_count(1)
    assert page.evaluate("() => document.querySelector('.messages-inner').lastElementChild.matches('.msg-user.queued')"), "the queued prompt is not pinned below the stream"
    page.mouse.move(0, 0)
    p.shot("desktop-queued.png")
    wait_turns(page, 2, timeout=60_000)
    expect(queued).to_have_count(0)
    expect(page.get_by_test_id("msg-user")).to_have_count(2)
    # refused by the backend: not in the list, back in the box, said in a toast that stays off the Send button
    send(page, "please refuse this prompt")
    expect(page.locator(".toast")).to_contain_text("Not sent", timeout=5000)
    expect(page.get_by_test_id("prompt")).to_have_value("please refuse this prompt")
    expect(page.get_by_test_id("msg-user")).to_have_count(2)
    t, s = page.locator(".toast").first.bounding_box(), page.get_by_test_id("send").bounding_box()
    assert t["y"] + t["height"] <= s["y"] or t["x"] + t["width"] <= s["x"], f"toast over the Send button: {t} {s}"
    # /clear: a new session with the same mode (the old one stays in the list); /resume opens the list
    sid = page.evaluate("JSON.parse(localStorage.getItem('bn.code.v1')).lastSession")
    page.get_by_test_id("mode-picker").click()
    page.get_by_test_id("mode-acceptEdits").click()
    send(page, "/clear")
    page.wait_for_function("(sid) => JSON.parse(localStorage.getItem('bn.code.v1')).lastSession !== sid", arg=sid, timeout=10_000)
    expect(page.get_by_test_id("msg-user")).to_have_count(0)
    expect(page.get_by_test_id("mode-picker")).to_contain_text("Accept edits")
    send(page, "/resume")
    expect(page.get_by_test_id("sessions")).to_be_visible()
    # Claude Code reset the conversation itself: the page follows to the new session
    send(page, "/cost")
    expect(page.get_by_test_id("local").last).to_contain_text("Total cost", timeout=10_000)
    sid = page.evaluate("JSON.parse(localStorage.getItem('bn.code.v1')).lastSession")
    new = json.loads(urllib.request.urlopen(urllib.request.Request(f"{NORMAL}/__mock/clear?session={sid}", method="POST", data=b""), timeout=5).read())["new_session"]
    page.wait_for_function("(n) => JSON.parse(localStorage.getItem('bn.code.v1')).lastSession === n", arg=new, timeout=10_000)
    expect(page.get_by_test_id("msg-user")).to_have_count(0)
    send(page, "/context")
    expect(page.get_by_test_id("local").last).to_contain_text("Context usage", timeout=10_000)
    p.assert_clean()
    p.close()


@check("sessions: fork from a prompt; a long transcript opens at its end, 'load earlier' the rest; its export is whole")
def fork_and_history(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "fork", **DESKTOP)
    page = p.open()
    send(page, "Explain how this project is organised")
    wait_turns(page, 1)
    send(page, "Add a README section about setup")
    wait_turns(page, 2)
    # a fork before the second prompt: the conversation up to its answer, the prompt back in the box (the CLI's rewind)
    second = page.get_by_test_id("msg-user").nth(1)
    second.hover()
    second.get_by_test_id("msg-fork").click()
    expect(page.locator(".chat-head .pane-title")).to_contain_text("Fork of", timeout=10_000)
    expect(page.get_by_test_id("msg-user")).to_have_count(1)
    expect(page.get_by_test_id("msg-user").first).to_contain_text("Explain how this project is organised")
    expect(page.get_by_test_id("prompt")).to_have_value("Add a README section about setup")
    # the fork button is reachable from the keyboard; before the first prompt: an empty session, the prompt in the box
    page.get_by_test_id("prompt").fill("")
    page.get_by_test_id("msg-user").first.get_by_test_id("msg-fork").focus()
    expect(page.get_by_test_id("msg-user").first.get_by_test_id("msg-fork")).to_be_visible()
    page.keyboard.press("Enter")
    expect(page.get_by_test_id("msg-user")).to_have_count(0, timeout=10_000)
    expect(page.get_by_test_id("prompt")).to_have_value("Explain how this project is organised")
    page.get_by_test_id("prompt").fill("")
    page.get_by_test_id("side-sessions").click()
    page.get_by_test_id("session-row").filter(has_text="Refactor the HTTP layer").locator(".sess-main").click()
    expect(page.get_by_test_id("load-earlier")).to_contain_text("60 more", timeout=10_000)
    expect(page.get_by_test_id("msg-user")).to_have_count(150)
    expect(page.get_by_test_id("msg-user").first).to_contain_text("Step 31:")
    # an export has all of it, also what the page has not loaded
    with page.expect_download() as dl:
        page.get_by_test_id("more-menu").click()
        page.get_by_test_id("menu-export").click()
    with open(dl.value.path(), encoding="utf-8") as f:
        text = f.read()
    assert "Step 1:" in text and "Step 180:" in text and "earlier messages not included" not in text, text[:400]
    page.get_by_test_id("load-earlier").click()
    page.get_by_role("button", name="Show earlier messages (60)").click()
    expect(page.get_by_test_id("msg-user")).to_have_count(180)
    expect(page.get_by_test_id("msg-user").first).to_contain_text("Step 1:")
    p.assert_clean()
    p.close()


@check("connection: close codes re-attach at once; an expired unlock says so; budget banner; tree trash and caps")
def connection(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "connection", **DESKTOP)
    page = p.open()
    send(page, "Explain how this project is organised")
    wait_turns(page, 1)
    before = page.locator(".messages-inner > *").count()
    post(NORMAL + "/__mock/close?code=4008")
    expect(page.get_by_test_id("conn")).to_have_text("Connected", timeout=3000)
    page.wait_for_timeout(500)
    assert page.locator(".messages-inner > *").count() == before, "items changed after a 4008 re-attach"
    # the key's budget is spent: the turn fails, the banner names the setting; the meter's tooltip names the key
    post(NORMAL + "/__mock/budget?spend=50&max=50")
    send(page, "hello again")
    wait_turns(page, 2)
    expect(page.get_by_test_id("turn-end").last).to_contain_text("Failed")
    expect(page.get_by_test_id("budget-banner")).to_contain_text("BUDGET_TERMINAL", timeout=10_000)
    page.mouse.move(0, 0)
    p.shot("desktop-budget.png")
    expect(page.get_by_test_id("cost")).to_have_attribute("title", re.compile("claude-code-terminal"))
    post(NORMAL + "/__mock/budget?spend=1&max=50")
    page.get_by_test_id("cost").click()
    expect(page.get_by_test_id("budget-banner")).to_have_count(0, timeout=10_000)
    # the tree: the trash stays out of sight; a folder with more entries than listed says so
    urllib.request.urlopen(urllib.request.Request(f"{NORMAL}/api/fs?path=README.md", method="DELETE"), timeout=5).read()
    page.reload()
    expect(page.get_by_test_id("conn")).to_have_text("Connected", timeout=10_000)
    expect(page.locator(".tree-row[data-path='logs']")).to_be_visible()
    expect(page.locator(".tree-row[data-path='.bedrock-now-trash']")).to_have_count(0)
    page.locator(".tree-row[data-path='logs']").click()
    expect(page.locator(".tree-row[data-path='logs/run-0001.log']")).to_be_visible(timeout=5000)
    page.locator(".tree-scroll").evaluate("(s) => { s.scrollTop = s.scrollHeight; }")
    expect(page.get_by_test_id("tree-truncated")).to_be_visible(timeout=5000)
    # the unlock expired: the page stops reconnecting and says so
    post(NORMAL + "/__mock/lock")
    expect(page.get_by_test_id("unlock-expired")).to_be_visible(timeout=20_000)
    page.mouse.move(0, 0)
    p.shot("desktop-unlock-expired.png")
    post(NORMAL + "/__mock/unlock")
    page.reload()
    expect(page.get_by_test_id("conn")).to_have_text("Connected", timeout=10_000)
    expect(page.get_by_test_id("unlock-expired")).to_have_count(0)
    p.assert_clean()
    p.close()


@check("to-do list pinned above the prompt; the conversation exported as Markdown; notifications opt-in")
def todos_export(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "todos", permissions=["notifications"], **DESKTOP)
    page = p.open()
    send(page, "make a todo list")
    wait_turns(page, 1)
    panel = page.get_by_test_id("todo-panel")
    expect(panel).to_contain_text("1/3")
    expect(panel).to_contain_text("Routing get() through retry()")
    panel.locator(".todos-head").click()
    expect(panel.locator(".todo")).to_have_count(3)
    page.mouse.move(0, 0)
    p.shot("desktop-todos.png")
    # a download made in the page (a blob), under the page's CSP
    with page.expect_download() as dl:
        page.get_by_test_id("more-menu").click()
        page.get_by_test_id("menu-export").click()
    d = dl.value
    assert d.suggested_filename == "make-a-todo-list.md", d.suggested_filename
    with open(d.path(), encoding="utf-8") as f:
        text = f.read()
    assert text.startswith("# make a todo list") and "## You\n\nmake a todo list" in text and "- **TodoWrite**" in text and "## Claude" in text, text[:400]
    # notifications: off until asked for; remembered per browser when the browser allows them, else said so (headless
    # Chromium never does)
    page.get_by_test_id("more-menu").click()
    expect(page.get_by_test_id("menu-notify")).to_have_attribute("aria-checked", "false")
    page.get_by_test_id("menu-notify").click()
    if page.evaluate("Notification.permission") == "granted":
        page.wait_for_function("() => JSON.parse(localStorage.getItem('bn.code.v1')).notify === true", timeout=5000)
        page.get_by_test_id("more-menu").click()
        expect(page.get_by_test_id("menu-notify")).to_have_attribute("aria-checked", "true")
    else:
        expect(page.locator(".toast")).to_contain_text("does not allow notifications")
        page.get_by_test_id("more-menu").click()
        expect(page.get_by_test_id("menu-notify")).to_have_attribute("aria-checked", "false")
    page.keyboard.press("Escape")
    p.assert_clean()
    p.close()


@check("memory: the project and user CLAUDE.md; '#' adds a line; a change meanwhile is not overwritten unasked")
def memory(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "memory", **DESKTOP)
    page = p.open()
    page.get_by_test_id("more-menu").click()
    page.get_by_test_id("menu-memory").click()
    dlg = page.get_by_test_id("memory-dialog")
    expect(dlg).to_contain_text("/workspace/CLAUDE.md")
    expect(dlg.get_by_test_id("memory-save")).to_have_text("Create")
    dlg.get_by_test_id("memory-text").fill("# Notes for Claude\n\n- Use pnpm, not npm")
    dlg.get_by_test_id("memory-save").click()
    expect(page.locator(".toast").last).to_contain_text("Saved /workspace/CLAUDE.md")
    # changed meanwhile (the terminal, Claude): Save says so; Overwrite is a choice
    post(NORMAL + "/__mock/touch?path=CLAUDE.md")
    dlg.get_by_test_id("memory-text").fill("# Notes for Claude\n\n- Use pnpm, not npm\n- Tabs, not spaces")
    dlg.get_by_test_id("memory-save").click()
    expect(dlg.get_by_test_id("memory-conflict")).to_be_visible()
    page.mouse.move(0, 0)
    p.shot("desktop-memory.png")
    dlg.get_by_test_id("memory-overwrite").click()
    expect(dlg.get_by_test_id("memory-conflict")).to_have_count(0)
    # the user one, in the sandbox
    dlg.get_by_test_id("memory-tab-user").click()
    expect(dlg).to_contain_text("~/.claude/CLAUDE.md")
    dlg.get_by_test_id("memory-text").fill("- I prefer short answers")
    dlg.get_by_test_id("memory-save").click()
    expect(dlg.get_by_test_id("memory-save")).to_have_text("Save")
    dlg.get_by_role("button", name="Close").first.click()
    expect(dlg).to_have_count(0)
    # "#" on one line: a line in the project's CLAUDE.md, not a prompt for Claude
    send(page, "# Always run the tests before committing")
    expect(page.locator(".toast").last).to_contain_text("Added to /workspace/CLAUDE.md")
    expect(page.get_by_test_id("msg-user")).to_have_count(0)
    mem = json.loads(urllib.request.urlopen(f"{NORMAL}/api/memory?scope=project", timeout=5).read())
    assert mem["text"].endswith("- Tabs, not spaces\n- Always run the tests before committing\n"), mem["text"]
    p.assert_clean()
    p.close()


@check("@ picker: the whole workspace is searched, not only the folders listed")
def mention_search(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "mention", **DESKTOP)
    page = p.open()
    expect(page.locator(".tree-row[data-path='src/http/retry.ts']")).to_have_count(0)
    box = page.get_by_test_id("prompt")
    box.click()
    box.type("look at @retr")
    pal = page.get_by_test_id("palette")
    expect(pal).to_contain_text("src/http/retry.ts", timeout=5000)
    box.press("Tab")
    expect(box).to_have_value("look at @src/http/retry.ts ")
    p.assert_clean()
    p.close()


@check("checkpoints: restore files to a prompt (a dry run first); nothing to restore; after the process ended; a turn since the check")
def checkpoints(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "rewind", **DESKTOP)
    page = p.open()
    page.get_by_test_id("mode-picker").click()
    page.get_by_test_id("mode-acceptEdits").click()
    send(page, "fix get() please")
    wait_turns(page, 1)
    send(page, "/cost")
    wait_turns(page, 2)
    second = page.get_by_test_id("msg-user").nth(1)
    second.hover()
    second.get_by_test_id("msg-rewind").click()
    expect(page.get_by_test_id("rewind-preview")).to_contain_text("Nothing to restore")
    page.get_by_test_id("rewind-preview").get_by_role("button", name="Close").click()
    first = page.get_by_test_id("msg-user").first
    first.hover()
    first.get_by_test_id("msg-rewind").click()
    preview = page.get_by_test_id("rewind-preview")
    expect(preview).to_contain_text("src/http/client.ts")
    expect(preview).to_contain_text("Put back 1 file")
    page.mouse.move(0, 0)
    p.shot("desktop-rewind.png")
    page.get_by_test_id("rewind-confirm").click()
    expect(page.locator(".toast").last).to_contain_text("Restored 1 file")
    expect(page.get_by_test_id("rewind-preview")).to_have_count(0)
    f = json.loads(urllib.request.urlopen(f"{NORMAL}/api/fs/file?path=src/http/client.ts", timeout=5).read())
    assert "return retry(async" not in f["text"], "client.ts was not restored"
    # after the session's process ended: it starts again (no prompt) for the check
    send(page, "fix get() please")
    wait_turns(page, 3)
    sid = page.evaluate("JSON.parse(localStorage.getItem('bn.code.v1')).lastSession")
    urllib.request.urlopen(urllib.request.Request(f"{NORMAL}/api/sessions/{sid}", method="DELETE"), timeout=5).read()
    expect(page.get_by_test_id("session-state")).to_contain_text("closed", timeout=10_000)
    third = page.get_by_test_id("msg-user").nth(2)
    third.hover()
    third.get_by_test_id("msg-rewind").click()
    preview = page.get_by_test_id("rewind-preview")
    expect(preview).to_contain_text("Put back 1 file", timeout=10_000)
    # a turn after the check: Restore checks again first (what it puts back is what it listed)
    send(page, "/cost")
    expect(page.get_by_test_id("turn-end").last).to_be_visible()
    page.wait_for_timeout(500)
    page.get_by_test_id("rewind-confirm").click()
    expect(page.get_by_test_id("rewind-note")).to_contain_text("since the check", timeout=10_000)
    expect(preview).to_contain_text("Put back 1 file")
    page.get_by_test_id("rewind-confirm").click()
    # (the first restore's toast may still show: the panel closing is what says this one is done)
    expect(page.get_by_test_id("rewind-preview")).to_have_count(0, timeout=10_000)
    expect(page.locator(".toast").last).to_contain_text("Restored 1 file", timeout=10_000)
    f = json.loads(urllib.request.urlopen(f"{NORMAL}/api/fs/file?path=src/http/client.ts", timeout=5).read())
    assert "return retry(async" not in f["text"], "client.ts was not restored the second time"
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
        if vp["width"] > 1000:
            # plugins and MCP servers from a hostile sandbox: text only, the command shown verbatim (bidi visible)
            page.get_by_test_id("more-menu").click()
            page.get_by_test_id("menu-plugins").click()
            dlg = page.get_by_test_id("plugins-dialog")
            dlg.get_by_test_id("plugins-tab-marketplaces").click()
            dlg.get_by_test_id("marketplace-source").fill("/workspace/evil-mkt")
            dlg.get_by_test_id("marketplace-add").click()
            expect(dlg.get_by_test_id("plugins-note")).to_contain_text("Successfully added")
            dlg.get_by_test_id("plugins-tab-discover").click()
            dlg.locator("[data-plugin='evil@evil-mkt'] [data-testid=plugin-install]").click()
            cmd = dlg.get_by_test_id("plugin-confirm-command")
            expect(cmd).to_contain_text("⟨U+202E⟩")
            expect(cmd).to_contain_text("<script>")
            d = page.evaluate("""() => { const d = document.querySelector('dialog[open]');
              return { imgs: d.querySelectorAll('img, svg:not(.ic):not(.spin), script, iframe').length, on: [...d.querySelectorAll('*')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length,
                       over: d.scrollWidth - d.clientWidth }; }""")
            assert d["imgs"] == 0 and d["on"] == 0 and d["over"] <= 1, d
            p.shot("hostile-plugins.png")
            dlg.get_by_role("button", name="Cancel").click()
            dlg.get_by_role("button", name="Close").click()
            page.get_by_test_id("more-menu").click()
            page.get_by_test_id("menu-mcp").click()
            mdlg = page.get_by_test_id("mcp-dialog")
            expect(mdlg.get_by_test_id("mcp-server")).to_have_count(2)
            d = page.evaluate("() => document.querySelector('dialog[open]').querySelectorAll('img, svg:not(.ic):not(.spin), script, iframe').length")
            assert d == 0, d
            mdlg.get_by_role("button", name="Close").click()
        assert page.title() == title0 or "pwned" not in page.title()
        p.assert_clean()
        p.close()


# --- file previews (src/preview): every format on the code origin, under the page's CSP and Trusted Types ---------

BEACONS = NORMAL + "/__mock/beacons"


def beacons():
    return json.loads(urllib.request.urlopen(BEACONS, timeout=5).read())["beacons"]


def tree_click(page, path):
    """Click a row of the explorer (drawn virtually: scrolled until the row exists)."""
    row = page.locator(f".tree-row[data-path='{path}']")
    page.evaluate("() => { const s = document.querySelector('.tree-scroll'); if (s) s.scrollTop = 0; }")
    for _ in range(150):
        if row.count():
            row.click()
            return
        # down a screen at a time; from the top again at the end (the folder may still be loading)
        page.evaluate("() => { const s = document.querySelector('.tree-scroll'); if (s.scrollTop + s.clientHeight >= s.scrollHeight - 2) s.scrollTop = 0; else s.scrollTop += s.clientHeight * 0.7; }")
        page.wait_for_timeout(60)
    raise AssertionError(f"no row {path} in the explorer")


def expand(page, *dirs):
    for d in dirs:
        page.evaluate("() => { const s = document.querySelector('.tree-scroll'); if (s) s.scrollTop = 0; }")
        if page.locator(f".tree-row[data-path='{d}'][aria-expanded='true']").count() == 0:
            tree_click(page, d)
            page.wait_for_timeout(300)


def preview(page, path, kind, timeout=20_000):
    """Open a workspace file by its tree row; its pane once the preview of `kind` shows."""
    tree_click(page, path)
    pane = page.locator(f".pane:not(.hidden)[data-path='{path}']")
    expect(pane.locator(f"[data-testid=preview][data-kind='{kind}']")).to_be_visible(timeout=timeout)
    return pane


def no_outside_requests(p):
    """Nothing went anywhere but the page's own origin (a hostile file's references point at 127.0.0.1:9)."""
    out = [u for u in p.requests if not (u.startswith(NORMAL + "/") or u.startswith("blob:") or u.startswith("data:"))]
    assert not out, f"requests outside the page's origin: {out[:5]}"
    assert not beacons(), f"beacons: {beacons()}"


@check("previews: every format renders (Markdown + Split, images, SVG, audio, video, PDF, CSV/TSV, JSON, YAML, notebook), 0 CSP violations")
def previews_desktop(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "previews", **DESKTOP)
    page = p.open()
    expand(page, "previews", "previews/img")
    # Markdown: a document with the workspace's own images (blob:, revoked once decoded); a web image stays a link
    pane = preview(page, "previews/README.md", "markdown")
    md = pane.get_by_test_id("preview-md")
    expect(md.locator("h1")).to_have_text("Previews")
    page.wait_for_function("(n) => [...document.querySelectorAll('.pane:not(.hidden) .md-img')].filter((i) => i.complete && i.naturalWidth > 0).length === n", arg=2, timeout=10_000)
    assert md.locator("a[href='http://127.0.0.1:9/md-remote.png']").count() == 1, "the web image is a link"
    assert md.locator("img[src^='http']").count() == 0
    p.shot("preview-markdown.png")
    pane.get_by_test_id("view-split").click()
    page.wait_for_function("() => { const h = document.querySelector('.pane:not(.hidden) .cm-host'); return h && h.shadowRoot && h.shadowRoot.querySelector('.cm-content'); }", timeout=10_000)
    pane.locator(".cm-content").click()
    page.keyboard.press("Control+Home")
    page.keyboard.type("## Typed in Split\n\n")
    expect(md.locator("h2", has_text="Typed in Split")).to_be_visible(timeout=5000)
    p.shot("preview-markdown-split.png")
    # images by their bytes: JPEG, WebP, GIF, BMP, ICO, a PNG named .txt; the SVG as an image
    for path, w in (("previews/photo.jpg", 48), ("previews/pic.webp", 48), ("previews/dot.gif", 1), ("previews/checks.bmp", 24), ("previews/favicon.ico", 16), ("previews/misnamed.txt", 160), ("previews/img/chart.png", 160)):
        pane = preview(page, path, "image")
        expect(pane.get_by_test_id("image-dims")).to_contain_text(f"{w} ×", timeout=10_000)
    pane.get_by_role("button", name="Zoom in").click()
    pane.get_by_role("button", name="Zoom in").click()
    expect(pane.get_by_test_id("image-dims")).to_contain_text("%")
    p.shot("preview-image.png")
    pane = preview(page, "previews/img/logo.svg", "svg")
    expect(pane.get_by_test_id("image-dims")).to_contain_text("64 × 64", timeout=10_000)
    # audio and video from blob: (media-src blob:)
    pane = preview(page, "previews/tone.wav", "audio")
    page.wait_for_function("() => { const a = document.querySelector('.pane:not(.hidden) audio'); return a && a.readyState >= 1 && a.duration > 0.3; }", timeout=10_000)
    pane = preview(page, "previews/clip.webm", "video")
    page.wait_for_function("() => { const v = document.querySelector('.pane:not(.hidden) video'); return v && v.readyState >= 1 && v.videoWidth === 64; }", timeout=10_000)
    p.shot("preview-video.png")
    pane = preview(page, "previews/tone.mp3", "audio")
    page.wait_for_function("() => { const a = document.querySelector('.pane:not(.hidden) audio'); const m = document.querySelector('.pane:not(.hidden) [data-testid=preview-msg]'); return (a && a.readyState >= 1) || !!m; }", timeout=10_000)
    # PDF: pages drawn with a text layer; a link to the web opens a new tab (noopener); find; a link inside the document
    pane = preview(page, "previews/report.pdf", "pdf")
    expect(pane.get_by_test_id("pdf-page")).to_have_count(3)
    expect(pane.locator(".textLayer").first).to_contain_text("Quarterly report", timeout=15_000)
    assert page.evaluate("() => { const c = document.querySelector('.pane:not(.hidden) .pdf-page canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++; return n; }") > 200, "page 1 has no ink"
    link = pane.locator("a.pdf-link")
    expect(link).to_have_count(1, timeout=10_000)
    assert link.get_attribute("href") == "https://example.com/docs" and link.get_attribute("target") == "_blank" and "noopener" in link.get_attribute("rel")
    p.shot("preview-pdf.png")
    pane.get_by_test_id("pdf-find").fill("margin")
    pane.get_by_test_id("pdf-find").press("Enter")
    expect(pane.get_by_test_id("pdf-hits")).to_contain_text("1 on 1 page · page 2", timeout=10_000)
    expect(pane.locator(".pdf-hit")).to_have_count(1, timeout=10_000)
    pane.locator(".pdf-scroll").evaluate("(e) => { e.scrollTop = 0; }")
    pane.locator("button.pdf-link").click(timeout=10_000)
    expect(pane.get_by_test_id("pdf-pagebox")).to_have_value("3", timeout=5000)
    # CSV: a header found, sorting, a filter, a semicolon file, TSV; a 3 MiB file (more than the editor reads) as bytes
    pane = preview(page, "previews/data.csv", "csv")
    expect(pane.get_by_test_id("table-size")).to_have_text("2,000 rows × 5 columns", timeout=10_000)
    expect(pane.get_by_test_id("table-header")).to_be_checked()
    pane.locator(".tv-h", has_text="amount").click()
    expect(pane.locator(".tv-r").first.locator(".tv-c.num").last).to_have_text("0.5")
    p.shot("preview-csv.png")
    pane.get_by_test_id("table-filter").fill("2026-12-24")
    want = sum(1 for i in range(1, 2001) if i % 12 == 11 and i % 28 == 23)
    expect(pane.get_by_test_id("table-size")).to_contain_text(f"{want} rows of 2,000")
    pane = preview(page, "previews/semicolons.csv", "csv")
    expect(pane.locator(".pv-tools")).to_contain_text("semicolon-separated")
    pane = preview(page, "previews/table.tsv", "tsv")
    expect(pane.get_by_test_id("table-size")).to_have_text("2 rows × 2 columns")
    pane = preview(page, "previews/bigcell.csv", "csv")
    pane.locator(".tv-c").first.click()
    expect(pane.get_by_test_id("table-cell")).to_contain_text("xxxx…", timeout=10_000)
    # JSON, JSON Lines, YAML, a notebook (as JSON)
    pane = preview(page, "previews/config.json", "json")
    expect(pane.get_by_test_id("preview-tree")).to_contain_text("__proto__")
    pane.get_by_role("button", name="Expand").click()
    expect(pane.get_by_test_id("preview-tree")).to_contain_text("26214400")
    p.shot("preview-json.png")
    pane = preview(page, "previews/events.jsonl", "jsonl")
    expect(pane.get_by_test_id("tree-errors")).to_contain_text("line 3")
    pane = preview(page, "previews/config.yaml", "yaml")
    expect(pane.get_by_test_id("preview-tree")).to_contain_text("service")
    p.shot("preview-yaml.png")
    pane = preview(page, "previews/notebook.ipynb", "notebook")
    expect(pane.get_by_test_id("preview-tree")).to_contain_text("cells")
    # past a cap, part 2 formats: download only
    pane = preview(page, "previews/too-big.pdf", "pdf")
    expect(pane.get_by_test_id("preview-msg")).to_contain_text("previews of PDF documents stop at 25.0 MB")
    pane = preview(page, "previews/sheet.xlsx", "later")
    expect(pane.get_by_test_id("preview-msg")).to_contain_text("later version")
    # Claude writes a Markdown file: its card offers Preview
    send(page, "Please write a markdown report")
    page.get_by_test_id("perm-once").click(timeout=15_000)
    wait_turns(page, 1)
    page.locator(".tool[data-tool='Write']").get_by_test_id("tool-preview").click()
    expect(page.locator(".pane:not(.hidden)[data-path='docs/report.md'] [data-testid=preview-md] h1")).to_have_text("Weekly report")
    # one worker per preview job: none left running for a closed tab's parse, none restarted on every render
    workers = page.evaluate("() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/workers/')).map((e) => e.name.split('/').pop())")
    assert len(workers) <= 30, f"{len(workers)} worker loads: {workers}"
    no_outside_requests(p)
    p.assert_clean()
    p.close()


@check("previews: hostile files do nothing (SVG script/onload/external refs, PDF JavaScript/launch/javascript: links, bombs, __proto__)")
def previews_hostile(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "previews-hostile", **DESKTOP)
    page = p.open()
    expand(page, "previews")
    popups = []
    p.ctx.on("page", lambda pg: popups.append(pg.url))
    # SVG: shown only as an image (240 × 160); its URL revoked once decoded; nothing it references is fetched
    pane = preview(page, "previews/hostile.svg", "svg")
    expect(pane.get_by_test_id("image-dims")).to_contain_text("240 × 160", timeout=10_000)
    src = pane.locator(".pv-canvas img").get_attribute("src")
    assert src.startswith("blob:")
    # (loaded again as an image: a revoked blob: URL fails — the URL cannot be opened as a document either)
    assert page.evaluate("(u) => new Promise((ok) => { const i = new Image(); i.onload = () => ok('loaded'); i.onerror = () => ok('revoked'); i.src = u; })", src) == "revoked", "the SVG's blob: URL can still be opened"
    page.wait_for_timeout(200)
    p.errors = [e for e in p.errors if "ERR_FILE_NOT_FOUND" not in e]   # (that probe's own failed load)
    assert page.evaluate("() => document.querySelectorAll('svg script, foreignObject, iframe, object, embed').length") == 0
    pane.get_by_test_id("view-source").click()
    expect(pane.locator(".cm-content")).to_contain_text("svg script", timeout=10_000)
    p.shot("preview-hostile-svg-source.png")
    pane.get_by_test_id("view-preview").click()
    p.shot("preview-hostile-svg.png")
    # PDF: JavaScript (open action, page and link actions), launch, javascript:/file: links, submit, remote go-to → no
    # element at all; the one http link opens in a new tab only when clicked
    pane = preview(page, "previews/hostile.pdf", "pdf")
    expect(pane.locator(".textLayer").first).to_contain_text("A hostile PDF", timeout=15_000)
    links = pane.locator(".pdf-link")
    expect(links).to_have_count(1, timeout=10_000)
    assert links.first.evaluate("(a) => a.tagName") == "A" and links.first.get_attribute("href") == "http://127.0.0.1:9/pdf-link"
    assert links.first.get_attribute("rel") == "noopener noreferrer nofollow" and links.first.get_attribute("target") == "_blank"
    # click on every hostile line (layout: HOSTILE_PDF_LINES in code/web/dev/preview-fixtures.mjs — text at
    # y = 700 - 30 i on a 792-point page; the last line is the allowed link): nothing happens
    box = pane.locator(".pdf-page").first.bounding_box()
    for i in range(18):
        page.mouse.click(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * (792 - (700 - 30 * i + 5)) / 792)
    page.wait_for_timeout(800)
    assert page.url.startswith(NORMAL), page.url
    assert not popups, f"popups: {popups}"
    p.shot("preview-hostile-pdf.png")
    # Markdown: raw HTML is text, javascript:/data: links are text, images only from the workspace (an HTML "png": text)
    pane = preview(page, "previews/hostile.md", "markdown")
    md = pane.get_by_test_id("preview-md")
    expect(md).to_contain_text("<script>alert('md')</script>")
    assert md.locator("script, iframe, img[src^='http'], a[href^='javascript'], a[href^='data']").count() == 0
    expect(md.locator(".md-badlink", has_text="a \"png\" that is HTML")).to_be_visible(timeout=10_000)
    # a "PNG" that is HTML: the editor, never an image; a PNG claiming 50,000 × 50,000 pixels: refused
    tree_click(page, "previews/fake.png")
    expect(page.locator(".pane:not(.hidden)[data-path='previews/fake.png'] .cm-content")).to_contain_text("a png that is HTML", timeout=10_000)
    assert page.locator(".pane:not(.hidden)[data-path='previews/fake.png'] [data-testid=preview]").count() == 0
    pane = preview(page, "previews/bomb.png", "image")
    expect(pane.get_by_test_id("preview-msg")).to_contain_text("50,000 × 50,000 pixels")
    # parsers: a line of 300,000 commas, 5,000 levels of JSON, a billion laughs, python tags, __proto__ keys
    pane = preview(page, "previews/wide.csv", "csv")
    expect(pane.get_by_test_id("table-notes")).to_contain_text("only the first 200 columns", timeout=10_000)
    pane = preview(page, "previews/deep.json", "json")
    expect(pane.get_by_test_id("tree-cut")).to_be_visible(timeout=10_000)
    pane = preview(page, "previews/laughs.yaml", "yaml")
    expect(pane.get_by_test_id("tree-errors")).to_contain_text("Excessive alias count", timeout=10_000)
    pane = preview(page, "previews/tags.yaml", "yaml")
    expect(pane.get_by_test_id("tree-errors")).to_contain_text("Unresolved tag")
    pane = preview(page, "previews/config.json", "json")
    expect(pane.get_by_test_id("preview-tree")).to_contain_text("polluted")
    assert page.evaluate("() => ({}).polluted === undefined && Object.prototype.polluted === undefined && !('polluted' in Function.prototype)")
    pane = preview(page, "previews/notebook.ipynb", "notebook")
    assert page.evaluate("() => document.querySelectorAll('script:not([type=module]), iframe').length") == 0
    # the worker policy: no other URL becomes a worker, and no second policy can be made
    tt = page.evaluate("""() => { const r = {};
      try { trustedTypes.createPolicy('other', { createHTML: (s) => s }); r.second = 'created'; } catch (e) { r.second = e.name; }
      try { new Worker('/workers/evil.js'); r.raw = 'started'; } catch (e) { r.raw = e.name; }
      return r; }""")
    assert tt == {"second": "TypeError", "raw": "TypeError"}, tt
    # (the two refusals above are CSP / Trusted Types violations on purpose)
    page.evaluate("window.__csp = window.__csp.filter((v) => !/trusted-types|require-trusted-types-for/.test(v))")
    p.errors = [e for e in p.errors if not re.search(r"Trusted ?Type|trusted-types|TrustedScriptURL|evil\.js|'other'", e)]
    no_outside_requests(p)
    assert not p.dialogs, p.dialogs
    p.assert_clean()
    p.close()


@check("previews (phone 390×844): Markdown, PDF, CSV and an image in the editor sheet, no horizontal overflow")
def previews_phone(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "previews-phone", viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme="light")
    page = p.open()
    for path, kind, shot, ready in (
        ("previews/README.md", "markdown", "phone-preview-markdown.png", "[data-testid=preview-md] h1"),
        ("previews/report.pdf", "pdf", "phone-preview-pdf.png", ".textLayer span"),
        ("previews/data.csv", "csv", "phone-preview-csv.png", ".tv-c"),
        ("previews/photo.jpg", "image", "phone-preview-image.png", "[data-testid=image-dims]:not(:empty)"),
        ("previews/config.yaml", "yaml", "phone-preview-yaml.png", ".tv li"),
    ):
        page.get_by_test_id("phone-files").click()
        expect(page.get_by_test_id("sheet-files")).to_be_visible()
        expand(page, "previews")
        tree_click(page, path)
        sheet = page.get_by_test_id("sheet-editor")
        expect(sheet).to_be_visible()
        expect(sheet.locator(f".pane:not(.hidden) [data-testid=preview][data-kind='{kind}']")).to_be_visible(timeout=20_000)
        expect(sheet.locator(f".pane:not(.hidden) {ready}").first).to_be_visible(timeout=20_000)
        assert sheet.locator(".pane:not(.hidden) [data-testid=view-split]").count() == 0, "no Split on a phone"
        page.wait_for_timeout(400)
        p.shot(shot)
        over = page.evaluate("document.documentElement.scrollWidth - innerWidth")
        assert over <= 0, f"{path}: {over}px wider than the phone"
        sheet.get_by_role("button", name="Close", exact=True).click()
    p.assert_clean()
    p.close()


# --- dev-server previews (components/DevPreview.tsx): the mock's fake preview site, ports, launch.json ---------

def devpreview_frame(page):
    return page.frame_locator("[data-testid=preview-pane]:not(.hidden) iframe[data-testid=preview-frame]")


@check("dev-server previews: chip in Bash output, preview tab (chat | preview), viewports, path, new tab, Ports panel, Stop, launch.json")
def devpreviews(browser):
    post(NORMAL + "/__mock/reset")
    p = Page(browser, NORMAL, "previews", **DESKTOP)
    page = p.open()
    expect(page.get_by_test_id("ports-status")).to_contain_text("Ports")
    send(page, "start the vite dev server")
    expect(page.get_by_test_id("permission")).to_be_visible(timeout=15_000)
    page.get_by_test_id("perm-once").click()
    wait_turns(page, 1)
    # the Bash card offers the preview of the URL Vite printed; Claude's answer links to it as a preview too
    chip = page.locator(".tool[data-tool='Bash'] [data-testid=preview-chip]")
    expect(chip).to_have_text("Preview :5173")
    link = page.locator(".msg-claude a.md-preview")
    expect(link).to_have_attribute("href", "/.bn/preview?port=5173")
    # a new server appeared: the toast offers its preview
    expect(page.get_by_test_id("toast-action").first).to_have_text("Preview", timeout=10_000)
    chip.click()
    pane = page.locator("[data-testid=preview-pane]:not(.hidden)")
    expect(pane).to_have_attribute("data-port", "5173")
    frame = page.locator("[data-testid=preview-pane]:not(.hidden) iframe[data-testid=preview-frame]")
    # the frame: its own site, no top navigation, no referrer, nothing delegated
    sb = frame.get_attribute("sandbox")
    assert sb and "allow-top-navigation" not in sb and "allow-scripts" in sb and "allow-same-origin" in sb, sb
    assert frame.get_attribute("referrerpolicy") == "no-referrer"
    assert re.match(r"^http://p5173-[a-z2-7]{33}\.localhost:\d+/$", frame.get_attribute("src")), frame.get_attribute("src")
    expect(devpreview_frame(page).locator("h1")).to_have_text("Hello from the dev server on :5173", timeout=10_000)
    expect(page.locator(".etab.on")).to_contain_text(":5173")
    page.mouse.move(0, 0)
    p.shot("preview-desktop-split.png")
    # viewports: phone and tablet are drawn at their size (scaled to fit), Fit fills the pane again
    page.locator("[data-testid=preview-pane]:not(.hidden) [data-testid=viewport-phone]").click()
    expect(page.locator("[data-testid=preview-pane]:not(.hidden) .pv-foot")).to_contain_text("Phone 390 × 844")
    page.wait_for_timeout(200)
    box = page.evaluate("() => { const b = document.querySelector('[data-testid=preview-pane]:not(.hidden) .pv-box').getBoundingClientRect(); return [b.width, b.height]; }")
    assert 300 < box[0] <= 390 and 640 < box[1] <= 844, box
    p.shot("preview-desktop-phone-viewport.png")
    page.locator("[data-testid=preview-pane]:not(.hidden) [data-testid=viewport-tablet]").click()
    expect(page.locator("[data-testid=preview-pane]:not(.hidden) .pv-foot")).to_contain_text("Tablet 768 × 1024")
    page.locator("[data-testid=preview-pane]:not(.hidden) [data-testid=viewport-fill]").click()
    expect(page.locator("[data-testid=preview-pane]:not(.hidden) .pv-foot")).to_have_count(0)
    # a path on the server; something that is not a path is refused
    addr = page.locator("[data-testid=preview-pane]:not(.hidden) [data-testid=preview-path]")
    addr.fill("about?x=1")
    addr.press("Enter")
    expect(devpreview_frame(page).locator("code")).to_have_text("/about?x=1", timeout=10_000)
    addr.fill("http://evil.example/")
    addr.press("Enter")
    expect(page.locator(".pv-addr.bad")).to_have_count(1)
    expect(devpreview_frame(page).locator("code")).to_have_text("/about?x=1")
    page.locator("[data-testid=preview-pane]:not(.hidden) [data-testid=preview-reload]").click()
    expect(devpreview_frame(page).locator("h1")).to_be_visible()
    nt = page.locator("[data-testid=preview-pane]:not(.hidden) [data-testid=preview-new-tab]")
    expect(nt).to_have_attribute("href", "/.bn/preview?port=5173&path=%2Fabout%3Fx%3D1")
    expect(nt).to_have_attribute("target", "_blank")
    expect(nt).to_have_attribute("rel", "noopener noreferrer")
    with page.context.expect_page() as newp:
        nt.click()
    tab = newp.value
    tab.wait_for_load_state()
    assert re.match(r"^http://p5173-[a-z2-7]{33}\.localhost:\d+/about\?x=1$", tab.url), tab.url
    tab.screenshot(path=f"{OUT}/preview-new-tab.png")
    tab.close()
    # the Ports panel: the server, Preview / new tab / Stop, another port, launch.json's entries
    page.get_by_test_id("ports-status").click()
    panel = page.get_by_test_id("ports-panel")
    expect(panel.get_by_test_id("port-row")).to_have_count(1)
    expect(panel.get_by_test_id("port-row")).to_contain_text("vite")
    expect(panel.get_by_test_id("launch-row")).to_have_count(3)
    expect(panel.get_by_test_id("launch-row").nth(2)).to_contain_text("port: a number")
    p.shot("preview-ports-panel.png")
    # Start an entry of .claude/launch.json: its preview opens once its port listens
    panel.get_by_test_id("launch-start").nth(1).click()
    expect(page.locator("[data-testid=preview-pane]:not(.hidden)")).to_have_attribute("data-port", "8787", timeout=15_000)
    expect(devpreview_frame(page).locator("h1")).to_have_text("Hello from the dev server on :8787", timeout=10_000)
    # Stop asks once more, then the server is gone and the preview says nothing listens
    page.get_by_test_id("ports-status").click()
    row = page.locator("[data-testid=port-row][data-port='8787']")
    row.get_by_test_id("port-stop").click()
    expect(row.get_by_test_id("port-stop")).to_have_text("Stop it?")
    row.get_by_test_id("port-stop").click()
    expect(page.locator("[data-testid=port-row][data-port='8787']")).to_have_count(0, timeout=10_000)
    page.keyboard.press("Escape")
    expect(page.locator("[data-testid=preview-pane]:not(.hidden) [data-testid=preview-not-listening]")).to_be_visible(timeout=10_000)
    page.locator("[data-testid=preview-pane]:not(.hidden) [data-testid=preview-reload]").click()
    expect(devpreview_frame(page).locator("h1")).to_contain_text("Nothing is listening on port 8787", timeout=10_000)
    # another port by hand
    page.get_by_test_id("ports-status").click()
    page.get_by_test_id("port-other").fill("5173")
    page.get_by_test_id("port-other-go").click()
    expect(page.locator("[data-testid=preview-pane]:not(.hidden)")).to_have_attribute("data-port", "5173")
    page.emulate_media(color_scheme="dark")
    page.wait_for_timeout(300)
    p.shot("preview-desktop-dark.png")
    page.emulate_media(color_scheme="light")
    # (expected: the 502 of bn-preview's "nothing is listening" page, in the frame)
    p.errors = [e for e in p.errors if "status of 502" not in e]
    p.assert_clean()
    p.close()


@check("dev-server previews on a phone: Ports & previews sheet, previews open in a new tab")
def devpreviews_phone(browser):
    post(NORMAL + "/__mock/reset")
    post(NORMAL + "/__mock/port?port=3000&cmd=python3%20-m%20http.server%203000")
    p = Page(browser, NORMAL, "previews-phone", viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    page = p.open()
    page.get_by_test_id("phone-menu-btn").click()
    page.get_by_test_id("phone-menu-ports").click()
    sheet = page.get_by_test_id("sheet-ports")
    expect(sheet.get_by_test_id("port-row")).to_have_count(1, timeout=10_000)
    prev = sheet.get_by_test_id("port-preview")
    expect(prev).to_have_attribute("href", "/.bn/preview?port=3000")
    expect(prev).to_have_attribute("target", "_blank")
    p.shot("preview-phone-ports.png")
    with page.context.expect_page() as newp:
        prev.click()
    tab = newp.value
    tab.wait_for_load_state()
    assert re.match(r"^http://p3000-[a-z2-7]{33}\.localhost:\d+/$", tab.url), tab.url
    tab.screenshot(path=f"{OUT}/preview-phone-new-tab.png")
    tab.close()
    p.assert_clean()
    p.close()


@check("dev-server previews from a hostile sandbox: bad ports dropped, process names as text")
def devpreviews_hostile(browser):
    p = Page(browser, HOSTILE, "previews-hostile", **DESKTOP)
    page = p.open()
    page.get_by_test_id("ports-status").click()
    panel = page.get_by_test_id("ports-panel")
    rows = panel.get_by_test_id("port-row")
    expect(rows).to_have_count(1, timeout=10_000)
    expect(rows).to_contain_text("<script>")
    expect(rows.get_by_test_id("port-stop")).to_be_disabled()   # (pid 1 is never offered)
    n = page.evaluate("() => document.querySelector('[data-testid=ports-panel]').querySelectorAll('script, img, iframe').length")
    assert n == 0, n
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
