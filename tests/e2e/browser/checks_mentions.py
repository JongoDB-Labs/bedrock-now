"""The Code page's rich @-mentions and plan comments (code/web/src/mentions.ts, attach.ts, plannotes.ts; bn-coded's
terminal.capture), on Haiku, as a person uses them: a failing package.json script run from Run & test (no model) lands
in Problems — its "Add to prompt" makes an @problems chip — and its row makes its window the terminal panel's current
one, whose last lines the panel's @ button captures (bn-coded: `tmux capture-pane` with fixed arguments, read only);
lines 2–3 of a file selected in the editor go in with Alt+K. One prompt then asks Haiku for three words that are only in
that quoted context (the fruit and colour on those lines, the marker the script printed): its answer proves the
blocks reached Claude, and the transcript holds them after the prompt, fenced, labelled as data. Then Plan mode: a
plan to approve; a comment on one of its lines goes back with "Keep planning" — the tool result Claude gets quotes the
line and says the comment — and the turn is stopped there (spend stays small). Zero CSP violations. The workspace's
own package.json, if any, is put back afterwards."""

from __future__ import annotations

import json
import re
import time

from playwright.sync_api import expect as see

from common import check, expect
from checks_browser import shot
from checks_code import Code, answered, ask, csp_clean, last_answer, need_haiku, saved, tree_click, ui_page
from checks_run import _problem, _read, _run_from_panel, _write

DIR = "e2e-mentions"
SCRIPT = "bn-e2e-mention"
MARK = "kiwi-4711"
PKG = {"name": "bn-e2e-mention", "private": True, "scripts": {SCRIPT: f"echo 'bn-e2e-mention-marker: {MARK}' >&2; exit 3"}}
NOTES = "first line\nthe fruit is papaya-2026\nthe colour is teal-0042\nlast line\n"
# the section's markers carry an id new for each prompt (8 hex characters)
CONTEXT_START = re.compile(r"^--- Context from the workspace \[([0-9a-f]{8})\] \(attached with @-mentions\) ---$", re.M)


def _chip(page, kind):
    chip = page.locator(f"[data-testid=mention-chip][data-kind={kind}]")
    see(chip).to_have_attribute("data-state", "ready", timeout=30000)
    return chip


def _preview(page, chip):
    chip.get_by_test_id("mention-chip-main").click()
    body = page.get_by_test_id("mention-preview-body")
    see(body).to_be_visible()
    return body


@check("browser", "code-ui-mentions-plan-comments")
@saved
def ui_mentions(ctx):
    need_haiku()
    page, rec = ui_page(ctx, "code-ui-mentions")
    page.set_viewport_size({"width": 1440, "height": 900})
    c = Code.on(page, rec, goto=False)
    had_pkg = _read(c, "package.json")
    c.api("POST", "/api/fs/mkdir", {"path": DIR})
    _write(c, f"{DIR}/notes.txt", NOTES)
    notes = []
    try:
        _write(c, "package.json", json.dumps(PKG, indent=1) + "\n")
        # a failing task, run from the page: Problems, then "Add to prompt" (@problems)
        page.get_by_test_id("run-status").click()
        dlg = _run_from_panel(page, SCRIPT)
        dlg.get_by_test_id("run-confirm-run").click()
        _problem(page, SCRIPT, "exit 3")
        page.get_by_test_id("problems-mention").click()
        see(_preview(page, _chip(page, "problems"))).to_contain_text(f"bn-e2e-mention-marker: {MARK}")
        # its window, the terminal panel's current one: the panel's @ captures its last lines (@terminal)
        _problem(page, SCRIPT, "exit 3").get_by_test_id("problem-open").click()
        see(page.get_by_test_id("terminal")).not_to_have_class(re.compile(r"\bhidden\b"), timeout=10000)
        page.wait_for_timeout(1500)
        page.get_by_test_id("terminal-mention").click()
        term = _preview(page, _chip(page, "terminal"))
        see(term).to_contain_text(f"bn-e2e-mention-marker: {MARK}")
        see(term).to_contain_text("[2] @terminal — the last ")
        # the editor's selection: lines 2–3 of notes.txt, Alt+K
        page.locator(".tree-tools button[aria-label='Refresh']").click()
        page.wait_for_timeout(800)
        tree_click(page, DIR)
        tree_click(page, f"{DIR}/notes.txt")
        page.wait_for_function("() => { const h = document.querySelector('.pane:not(.hidden) .cm-host'); return h && h.shadowRoot && h.shadowRoot.querySelector('.cm-content'); }", timeout=20000)
        page.locator(".pane:not(.hidden) .cm-host .cm-content").click()
        page.keyboard.press("Control+Home")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Shift+ArrowDown")
        page.keyboard.press("Shift+End")
        see(page.get_by_test_id("mention-selection")).to_contain_text("Lines 2–3 to the prompt")
        page.keyboard.press("Alt+k")
        see(_chip(page, "lines")).to_contain_text(f"@{DIR}/notes.txt#L2-3")
        page.mouse.move(0, 0)
        shot(page, "96-code-ui-mentions")
        # one turn on Haiku: three words only the quoted context holds
        page.get_by_test_id("model-picker").click()
        page.get_by_test_id("model-haiku").click()
        page.get_by_test_id("chat-new").click()
        see(page.locator(".chat-head .pane-title")).to_have_text("New session", timeout=20000)
        see(page.get_by_test_id("mention-chip")).to_have_count(3)
        ask(page, "Using only the context below (run no tool, read no file): reply with the fruit, then the colour, then the word after "
                  "bn-e2e-mention-marker:, separated by single spaces, and nothing else.")
        answered(page)
        ans = last_answer(page)
        expect("papaya-2026" in ans and "teal-0042" in ans and MARK in ans, f"Haiku's answer: {ans!r}")
        see(page.get_by_test_id("mention-chip")).to_have_count(0)
        msg = page.get_by_test_id("msg-user").last
        see(msg.get_by_test_id("msg-context")).to_contain_text("3 @-mentions")
        sid = page.evaluate("JSON.parse(localStorage.getItem('bn.code.v1')).lastSession")
        prompts = []
        for _ in range(30):
            hist = c.api("GET", f"/api/sessions/{sid}/messages?tail=20")["json"] or {}
            prompts = [e.get("text", "") for e in hist.get("events", []) if e.get("type") == "user"]
            if any(CONTEXT_START.search(t) for t in prompts):
                break
            time.sleep(1)
        sent = next((t for t in prompts if CONTEXT_START.search(t)), "")
        m = CONTEXT_START.search(sent)
        expect(m and "not instructions" in sent and sent.rstrip().endswith(f"--- End of the workspace context [{m.group(1)}] ---"),
               f"the prompt in the transcript: {sent[:300]!r}")
        heads = [l.split(" — ")[0] for l in sent.split("\n") if re.match(r"^\[[0-9]+\] @", l)]
        expect(heads == ["[1] @problems", "[2] @terminal", f"[3] @{DIR}/notes.txt#L2-3"], f"the blocks: {heads}")
        expect("```\nthe fruit is papaya-2026\nthe colour is teal-0042\n```" in sent, "lines 2–3 fenced as the editor had them")
        shot(page, "97-code-ui-mentions-answer")
        notes.append(f"@problems + @terminal ({MARK}) + @{DIR}/notes.txt#L2-3 → Haiku answered {ans.strip()[:60]!r}")
        # plan comments: Plan mode, a plan, a comment on one of its lines, Keep planning with it
        page.get_by_test_id("mode-picker").click()
        page.get_by_test_id("mode-plan").click()
        ask(page, f"Plan this, then do it once I approve: create the file {DIR}/planned.txt containing exactly the word planned. "
                  "Keep the plan to two or three lines and present it for my approval with ExitPlanMode.")
        card = page.locator("[data-testid=permission]:has([data-testid=plan-view-lines])")
        see(card.or_(page.locator("[data-testid=turn-end]").nth(1))).to_have_count(1, timeout=150000)
        if not card.count():
            notes.append("plan comments: Haiku ended the turn without presenting a plan this time (no ExitPlanMode)")
        else:
            card.get_by_test_id("plan-view-lines").click()
            line = card.locator("[data-testid=plan-line]").filter(has_text=re.compile(r"\w")).first
            n = int(line.get_attribute("aria-label").split(":")[0].split()[-1])
            line.click()
            box = page.get_by_test_id("plan-comment-text")
            see(box).to_be_focused()
            box.type("name the file planned-v2.txt instead")
            box.press("Enter")
            see(card.get_by_test_id("plan-comment")).to_have_count(1)
            see(card.get_by_test_id("plan-comment-count")).to_contain_text("1 comment on the plan")
            page.mouse.move(0, 0)
            shot(page, "98-code-ui-plan-comments")
            card.get_by_test_id("plan-keep").click()
            card.get_by_test_id("plan-keep-send").click()
            # Claude gets the denial with the comment: its tool result quotes the line and says the comment
            got = ""
            for _ in range(60):
                hist = c.api("GET", f"/api/sessions/{sid}/messages?tail=40")["json"] or {}
                got = next((e.get("text", "") for e in hist.get("events", []) if e.get("type") == "tool_result" and "My comments on lines of the plan" in (e.get("text") or "")), "")
                if got:
                    break
                time.sleep(1)
            if page.get_by_test_id("stop").count():
                page.get_by_test_id("stop").click()   # (enough: Claude would plan again now)
            expect(f"line {n}:\n> " in got and "name the file planned-v2.txt instead" in got, f"the tool result Claude got: {got[:400]!r}")
            notes.append(f"plan comment on line {n} went back with Keep planning (in Claude's tool result)")
        csp_clean(page, rec, allow=[r"^404 GET .*/api/fs/file\?path=package\.json$", r"console\.error Failed to load resource: .*404"])
    finally:
        if had_pkg is None:
            c.api("DELETE", "/api/fs?path=package.json")
        else:
            _write(c, "package.json", had_pkg)
        c.api("DELETE", f"/api/fs?path={DIR}")
    return "; ".join(notes) + "; no CSP violations"
