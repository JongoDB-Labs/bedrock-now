"""The Code page's Run & test (code/web/src/components/Run.tsx; bn-coded's run.* ops; tests/e2e/run.sh --code turns it
on with the Code page). No model calls: a package.json at the workspace's top with a script that fails and one that
passes, each run from the page's Run panel — shown in full first, then run by bn-coded as `npm run -- <name>` in a new
window of the terminal's tmux, through its runner — and their exit status and output in the Problems list; a row opens
its window in the terminal panel; a script changed after the page showed it is refused (409); the Makefile's targets
are listed, and offered only where the sandbox has make (its image has none). The workspace's own package.json and
Makefile, if any, are put back afterwards."""

from __future__ import annotations

import json
import re

from playwright.sync_api import expect as see

from common import check, expect
from checks_browser import shot
from checks_code import Code, csp_clean, need_on, ui_page

PKG = {"name": "bn-e2e-run", "private": True, "scripts": {
    "bn-e2e-fails": "echo 'bn-e2e: 1 test failed' >&2; exit 1",
    "bn-e2e-passes": "echo 'bn-e2e: all good'",
}}
MAKEFILE = "bn-e2e-target:\n\techo bn-e2e from make\n"


def _read(c: Code, path: str):
    r = c.api("GET", f"/api/fs/file?path={path}")
    return r["json"]["text"] if r["status"] == 200 and r["json"] and isinstance(r["json"].get("text"), str) else None


def _write(c: Code, path: str, text: str):
    r = c.api("PUT", f"/api/fs/file?path={path}", {"text": text})
    expect(r["status"] == 200, f"write {path}: {r['status']} {r['text'][:200]}")


def _run_from_panel(page, name: str):
    """The Run panel's Run on the task `name`, then the confirmation's "Run it" (its full argv checked)."""
    if not page.get_by_test_id("run-panel").is_visible():
        page.get_by_test_id("run-status").click()
    row = page.locator(f"[data-testid=run-panel] [data-testid=run-task][data-name='{name}']")
    see(row).to_be_visible(timeout=20000)
    row.get_by_test_id("run-start").click()
    dlg = page.get_by_test_id("run-confirm")
    see(dlg.get_by_test_id("run-argv").locator("li")).to_have_count(4)
    argv = dlg.get_by_test_id("run-argv").locator("li").all_inner_texts()
    expect(argv == ["npm", "run", "--", name], f"the confirmation's arguments: {argv}")
    return dlg


def _problem(page, name: str, status: str, timeout=90000):
    if not page.get_by_test_id("run-panel").is_visible():
        page.get_by_test_id("run-status").click()
    prob = page.locator(f"[data-testid=run-panel] [data-testid=problem][data-name='{name}']").first
    see(prob.get_by_test_id("problem-status")).to_have_text(status, timeout=timeout)
    return prob


@check("browser", "code-run-problems")
def run_problems(ctx):
    need_on()
    page, rec = ui_page(ctx, "code-run")
    page.set_viewport_size({"width": 1440, "height": 900})
    c = Code.on(page, rec, goto=False)
    had_pkg, had_mk = _read(c, "package.json"), _read(c, "Makefile")
    try:
        _write(c, "package.json", json.dumps(PKG, indent=1) + "\n")
        if had_mk is None:
            _write(c, "Makefile", MAKEFILE)
        listed = c.api("GET", "/api/run")
        expect(listed["status"] == 200, f"GET /api/run: {listed['status']} {listed['text'][:200]}")
        tasks = listed["json"]["tasks"]
        fails = next((t for t in tasks if t.get("name") == "bn-e2e-fails"), None)
        expect(fails and fails["argv"] == ["npm", "run", "--", "bn-e2e-fails"] and re.fullmatch(r"[0-9a-f]{64}", fails["digest"] or ""), f"the task listed: {fails}")
        make = [t for t in tasks if t["source"] == "make"]
        make_note = "make targets listed, not offered (no make in the sandbox)" if make and all(t.get("error") for t in make) else "make targets offered"
        # the page: Run shows the task in full, then runs it in the terminal; Problems gets its exit status and output
        page.get_by_test_id("run-status").click()
        see(page.get_by_test_id("run-panel")).to_be_visible()
        page.mouse.move(0, 0)
        shot(page, "code-run-panel")
        dlg = _run_from_panel(page, "bn-e2e-fails")
        see(dlg.get_by_test_id("run-detail")).to_contain_text("1 test failed")
        shot(page, "code-run-confirm")
        dlg.get_by_test_id("run-confirm-run").click()
        bad = _problem(page, "bn-e2e-fails", "exit 1")
        see(bad).to_have_attribute("data-outcome", "failed")
        see(bad.get_by_test_id("problem-tail")).to_contain_text("bn-e2e: 1 test failed")
        see(page.get_by_test_id("run-failing")).to_contain_text("1")
        page.mouse.move(0, 0)
        shot(page, "code-run-problems-failed")
        dlg = _run_from_panel(page, "bn-e2e-passes")
        dlg.get_by_test_id("run-confirm-run").click()
        ok = _problem(page, "bn-e2e-passes", "ok (exit 0)")
        see(ok).to_have_attribute("data-outcome", "ok")
        see(ok.get_by_test_id("problem-tail")).to_contain_text("bn-e2e: all good")
        page.mouse.move(0, 0)
        shot(page, "code-run-problems")
        # what bn-coded kept for the failing run (all of its output, the runner's status), through the API
        runs = c.api("GET", "/api/run/results")["json"]["runs"]
        mine = next(r for r in runs if r["name"] == "bn-e2e-fails")
        one = c.api("GET", f"/api/run/results?id={mine['id']}")["json"]["runs"][0]
        expect(one["exitCode"] == 1 and "bn-e2e: 1 test failed" in one["tail"] and re.fullmatch(r"@[0-9]+", one["window"] or ""), f"the run kept: {one}")
        # a row opens its window in the terminal panel
        _problem(page, "bn-e2e-fails", "exit 1").get_by_test_id("problem-open").click()
        see(page.get_by_test_id("terminal")).not_to_have_class(re.compile(r"\bhidden\b"), timeout=10000)
        page.wait_for_timeout(3000)
        shot(page, "code-run-terminal-window")
        # changed after it was shown (Claude, or any command in the sandbox, edits package.json): refused, nothing runs
        changed = json.loads(json.dumps(PKG))
        changed["scripts"]["bn-e2e-fails"] += " ; echo swapped"
        _write(c, "package.json", json.dumps(changed, indent=1) + "\n")
        r = c.api("POST", "/api/run/start", {"source": "npm", "name": "bn-e2e-fails", "digest": fails["digest"]})
        expect(r["status"] == 409 and "review it again" in (r["json"] or {}).get("error", ""), f"a changed script: {r['status']} {r['text'][:200]}")
        n = len(c.api("GET", "/api/run/results")["json"]["runs"])
        expect(n == len(runs), f"a refused run was started anyway ({n} runs, {len(runs)} before)")
        # (expected: the 404s of looking whether the workspace had a package.json or Makefile before, the 409 above)
        csp_clean(page, rec, allow=[r"409", r"404 GET .*/api/fs/file\?path=(package\.json|Makefile)$", r"console\.error Failed to load resource: .*(404|409)"])
    finally:
        if had_pkg is None:
            c.api("DELETE", "/api/fs?path=package.json")
        else:
            _write(c, "package.json", had_pkg)
        if had_mk is None:
            c.api("DELETE", "/api/fs?path=Makefile")
    return (f"package.json scripts run from the Run panel (shown in full first, then `npm run -- <name>` in a window of the terminal): "
            f"the failing one in Problems with exit 1 and its stderr, the passing one ok (exit 0); a row opened its window in the terminal panel; "
            f"a script changed after it was shown: 409, nothing ran; {make_note}")
