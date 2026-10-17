"""Activity, the portal's notification centre: /api/activity (portal/activity.py) derives its items from the status files
that exist already — the update helper's and the terminal's last jobs, the release check, the Code page's default
notice, the last model check — every field type-checked; and the page (static/activity.js) builds nodes as text only,
keeps read/dismissed in this browser, and asks for browser notifications only when you turn them on."""

import json
import time
from dataclasses import replace
from html.parser import HTMLParser
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from portal import activity
from portal.app import STATIC, create_app

ORIGIN = {"Origin": "http://bedrock-now.localhost"}
API = {"X-Requested-With": "bedrock-now"}


def offline(request):
    raise httpx.ConnectError("offline in tests")


@pytest.fixture
def s(settings, tmp_path):
    st, up = tmp_path / "status", tmp_path / "update-check"
    st.mkdir()
    up.mkdir()
    return replace(settings, status_dir=st, update_dir=up)


def client(s):
    c = TestClient(create_app(s, transport=httpx.MockTransport(offline)), base_url="http://bedrock-now.localhost", follow_redirects=False)
    c.__enter__()
    c.post("/login", data={"password": "correct horse"}, headers=ORIGIN)
    return c


def write(d: Path, name: str, data) -> None:
    (d / name).write_text(data if isinstance(data, str) else json.dumps(data))


def job(**kw) -> dict:
    now = int(time.time())
    return {"id": "a" * 32, "action": "update", "phase": "done", "message": "Updated to v0.11.0", "started_at": now - 300,
            "updated_at": now - 60, "finished_at": now - 60, "version": "v0.11.0", **kw}


def test_needs_a_session_and_the_custom_header(s):
    with TestClient(create_app(s, transport=httpx.MockTransport(offline)), base_url="http://bedrock-now.localhost") as c:
        assert c.get("/api/activity", headers=API).status_code == 401
    c = client(s)
    assert c.get("/api/activity").status_code == 400
    r = c.get("/api/activity", headers=API)
    assert r.status_code == 200 and r.json()["items"] == [] and r.headers["cache-control"] == "no-store"


def test_the_helpers_last_job_while_it_runs_and_its_result_for_a_week(s):
    now = time.time()
    write(s.status_dir, "helper-status.json", job())
    [it] = activity.items(s, False, now)
    assert it["id"] == f"job:helper:{'a' * 32}:done" and it["level"] == "good" and it["notify"] is True
    assert it["title"] == "Update finished" and it["text"] == "Updated to v0.11.0" and it["link"] == "#home"
    assert it["data"] == {"origin": "helper", "action": "update", "phase": "done"}
    # running: a state, not counted; its result gets an id of its own (new again)
    write(s.status_dir, "helper-status.json", job(phase="downloading", finished_at=None, updated_at=int(now)))
    [it] = activity.items(s, False, now)
    assert it["id"].endswith(":running") and it["notify"] is False and it["title"] == "Update in progress"
    write(s.status_dir, "helper-status.json", job(phase="failed", message="The smoke test failed"))
    [it] = activity.items(s, False, now)
    assert it["level"] == "bad" and it["title"] == "Update failed" and it["id"].endswith(":failed")
    write(s.status_dir, "helper-status.json", job(phase="skipped", trigger="auto", message="Busy"))
    assert activity.items(s, False, now)[0]["title"] == "Automatic update skipped"
    # older than a week, from the future, stale while "running": nothing
    for bad in (job(finished_at=int(now) - 8 * 86400), job(finished_at=int(now) + 3600),
                job(phase="restarting", finished_at=None, updated_at=int(now) - 4 * 3600)):
        write(s.status_dir, "helper-status.json", bad)
        assert activity.items(s, False, now) == [], bad


@pytest.mark.parametrize("action,title,link", [
    ("settings", "Settings change finished", "#settings"), ("backup-nightly", "Nightly backup finished", "#settings/+backups"),
    ("check-aws", "AWS key check finished", "#settings/diagnostics"), ("restart-litellm", "Restart of litellm finished", "#settings/diagnostics"),
    ("models-recheck", "Model check finished", "#settings/+models"), ("rollback", "Rollback finished", "#home"),
    ("whatever", "Request finished", "#home")])
def test_each_job_is_named_and_leads_where_it_belongs(s, action, title, link):
    write(s.status_dir, "helper-status.json", job(action=action, message=""))
    [it] = activity.items(s, False)
    assert (it["title"], it["link"]) == (title, link)


def test_a_command_typed_in_a_terminal_and_the_helpers_job_both(s):
    now = int(time.time())
    write(s.status_dir, "helper-status.json", job(finished_at=now - 600))
    write(s.status_dir, "terminal-job.json", {"id": f"t-{now - 100}-42", "action": "code", "command": "code enable", "phase": "done",
                                               "message": "", "started_at": now - 100, "updated_at": now - 30, "finished_at": now - 30})
    items = activity.items(s, False)
    assert [i["id"] for i in items] == [f"job:terminal:t-{now - 100}-42:done", f"job:helper:{'a' * 32}:done"]   # newest first
    assert items[0]["title"] == "./stack code enable finished" and items[0]["data"]["origin"] == "terminal"


def test_what_the_files_say_is_checked_and_shown_as_text(s):
    now = int(time.time())
    write(s.status_dir, "helper-status.json", job(id="../../etc <b>", message="line\x00one\nline two\x1b[31m" + "x" * 2000,
                                                 started_at=now - 50))
    write(s.status_dir, "terminal-job.json", {"id": "t", "action": "<script>", "command": "<script>", "phase": "done", "finished_at": now})
    items = {i["data"]["origin"]: i for i in activity.items(s, False)}
    h = items["helper"]
    assert h["id"] == f"job:helper:{now - 50}:done"   # a malformed id: the job's start time names it instead
    assert "\x00" not in h["text"] and "\n" not in h["text"] and "\x1b" not in h["text"] and len(h["text"]) <= activity.MAX_TEXT
    assert items["terminal"]["title"] == "./stack command finished"   # not a word of what the file claimed
    for junk in ("{not json", "[]", json.dumps({"phase": 5}), "x" * 100000):
        write(s.status_dir, "helper-status.json", junk)
        write(s.status_dir, "terminal-job.json", junk)
        assert activity.items(s, False) == [], junk


def test_an_update_from_the_release_check(s):
    s = replace(s, update_check=True)
    write(s.status_dir, "version.json", {"version": "v0.10.0", "images": []})
    rel = lambda tag, head: {"tag": tag, "name": tag, "headline": head, "notes": "", "published_at": "2026-10-20T10:00:00Z",  # noqa: E731
                             "url": f"https://github.com/JongoDB-Labs/bedrock-now/releases/tag/{tag}"}
    write(s.update_dir, "latest.json", {"tag": "v0.11.1", "name": "v0.11.1", "notes": "", "published_at": "2026-10-20T10:00:00Z",
                                        "checked_at": "2026-10-20T11:00:00+00:00",
                                        "releases": [rel("v0.11.1", "Fixes"), rel("v0.11.0", "Activity and search")]})
    [it] = activity.items(s, False)
    assert it["id"] == "update:v0.11.1" and it["kind"] == "update" and it["title"] == "v0.11.1 available"
    assert it["text"] == "You have v0.10.0 (2 releases since yours). Fixes" and it["at"] == 1792490400
    write(s.status_dir, "version.json", {"version": "v0.11.1", "images": []})
    assert activity.items(s, False) == []
    assert activity.items(replace(s, update_check=False), False) == []


def test_the_code_page_turned_on_by_an_update_nobody_watched(s):
    now = int(time.time())
    write(s.status_dir, "code-default.json", {"at": now - 60, "workspace": "/home/me/bedrock-now-workspace", "egress": True, "terminal": True})
    assert activity.items(s, False) == []   # the Code page is off here: nothing to say
    cs = replace(s, terminal=True, code=True)
    [it] = activity.items(cs, False)
    assert it["id"] == f"code-default:{now - 60}" and it["link"] == "#settings/CODE_ENABLED"
    assert it["data"] == {"at": now - 60, "workspace": "/home/me/bedrock-now-workspace", "egress": True, "terminal": True}
    assert "and its sandbox (workspace /home/me/bedrock-now-workspace, internet on)" in it["text"]
    assert activity.items(cs, True) == []   # remote, without REMOTE_TERMINAL: the Code page is not here


def test_a_model_check_that_could_not_check_every_model(s):
    now = time.time()
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 3600))
    rows = ["claude-sonnet-5-5\tchat\tENABLED\tok\t$3\t" + stamp,
            "claude-haiku-5\tchat\tENABLED\tunverified: no response within 30s\t$1\t" + stamp,
            "nova-pro\tchat\tDISABLED\tunverified (aws exit 255)\t$1\t" + stamp,
            "titan-embed\tembed\tDISABLED\tnot subscribed\t-\t" + stamp]
    (s.litellm_dir / "probe-results.tsv").write_text("\n".join(rows) + "\n")
    [it] = activity.items(s, False, now)
    assert it["title"] == "Model check: 2 models could not be checked" and it["level"] == "warn" and it["link"] == "#settings/+models"
    assert "claude-haiku-5, nova-pro" in it["text"] and "timeout" in it["text"] and "aws exit 255" in it["text"]
    assert activity.items(s, False, now + 8 * 86400) == []   # a week later: old news
    (s.litellm_dir / "probe-results.tsv").write_text(rows[0] + "\n")
    assert activity.items(s, False, now) == []


def test_at_most_twenty_newest_first_and_one_bad_source_hides_nothing(s, monkeypatch):
    many = [activity._item(f"x:{i}", "job", "info", "t", "", 1000 + i) for i in range(30)]
    monkeypatch.setattr(activity, "job_items", lambda d, now: many)
    monkeypatch.setattr(activity, "update_item", lambda s: (_ for _ in ()).throw(OSError("disk")))
    out = activity.items(s, False)
    assert len(out) == activity.MAX_ITEMS and out[0]["id"] == "x:29"
    for bad in (("a b", "info", ""), ("ok", "loud", ""), ("ok", "info", "javascript:alert(1)"), ("ok", "info", "https://evil.example")):
        assert activity._item(bad[0], "k", bad[1], "t", "", 1, bad[2]) is None, bad


# --- the page ---

def _page_tags(html: str) -> dict:
    found = {}

    class P(HTMLParser):
        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            if "id" in a:
                found[a["id"]] = (tag, a)
    P().feed(html)
    return found


def test_home_has_the_bell_the_panel_and_the_more_entry_hidden_until_the_script_runs(s):
    page = client(s).get("/").text
    tags = _page_tags(page)
    for hook in ("activity-btn", "activity", "more-activity", "search-btn", "more-search"):
        assert "hidden" in tags[hook][1], hook
    assert tags["activity"][1]["role"] == "dialog" and tags["activity-btn"][1]["aria-controls"] == "activity"
    assert tags["activity-count"][0] == "span" and "hidden" in tags["activity-count"][1]
    order = [page.index(f'src="/static/{f}"') for f in ("app.js", "mobile.js", "code.js", "tour.js", "settings.js", "fuzzy.js", "activity.js", "search.js")]
    assert order == sorted(order)
    assert '<link rel="stylesheet" href="/static/activity.css">' in page
    # the More sheet's links stay what the phone layout expects: Activity and Search are no app links
    more = page[page.index('id="more-sheet"'):page.index("</div>\n</div>", page.index('id="more-sheet"'))]
    assert 'id="more-activity"' in more and "data-app" not in more[more.index('class="sheet-tools"'):]


def test_the_page_builds_text_only_and_asks_for_notifications_only_when_turned_on():
    js = (STATIC / "activity.js").read_text(encoding="utf-8")
    for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"):
        assert sink not in js, sink
    # Notification.requestPermission: only in setNotify(true), which only the chip's click calls
    assert js.count("Notification.requestPermission(") == 1
    i = js.index("Notification.requestPermission(")
    assert js.rindex("async function setNotify(on)", 0, i) > js.rindex("\n  }\n", 0, i)
    assert 'chip.addEventListener("click", () => setNotify(!state.notify))' in js
    # nothing about an item but its id and times goes into localStorage
    assert 'localStorage.setItem(STORE, JSON.stringify(state))' in js and 'const MAPS = ["read", "dismissed", "first", "notified", "codeEp"]' in js
    # a notification says fixed words only (notificationText): never an item's title or text (a Code session's title, a
    # job's message, an error) — those stay in the panel
    show = js[js.index("function showNotification(it)"):js.index("function maybeNotify()")]
    assert "const t = notificationText(it);" in show and "it.title" not in show and "it.text" not in show
    note = js[js.index("function notificationText(it)"):js.index("const isUnread")]
    assert "it.title" not in note and "it.text" not in note
    # what was there when the page opened is never a notification; none while the page has the focus
    assert "if (!primed) { primed = true; return; }" in js and 'document.visibilityState === "visible" && document.hasFocus()' in js
    # the Code page's report: only through code.js's checked event
    code = (STATIC / "code.js").read_text(encoding="utf-8")
    assert 'new CustomEvent("bn:code-status", { detail: { waiting: reported.waiting, sessions: reported.sessions.map' in code
    sw = (STATIC / "sw.js").read_text(encoding="utf-8")
    assert 'addEventListener("notificationclick"' in sw and "push" not in sw.replace("no push", "")
