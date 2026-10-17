import json
import re
import time
from dataclasses import replace
from html.parser import HTMLParser
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from portal import admin
from portal.app import create_app

ORIGIN = {"Origin": "http://bedrock-now.localhost"}
API = {"X-Requested-With": "bedrock-now"}
H = {**ORIGIN, **API}


def offline(request):
    raise httpx.ConnectError("offline in tests")


@pytest.fixture
def dirs(tmp_path):
    st, rq = tmp_path / "status", tmp_path / "requests"
    st.mkdir()
    rq.mkdir()
    return st, rq


AUTO = {"on": False, "hour": 3, "state": "off", "target": "", "reason": "Off: new releases wait for you.",
        "next_window": 1800000000, "last": {"version": "", "result": "", "at": None}}


def beat(st, age=1, rollback=True, to="v0.2.1", auto=AUTO, **extra):
    d = {"heartbeat": int(time.time()) - age, "pid": 1, "poll_s": 3, "version": "v0.3.0",
         "rollback": {"available": rollback, "to": to, "backup": "backups/20261012-000000-auto"}, **extra}
    if auto is not None:
        d["auto"] = auto
    (st / "helper.json").write_text(json.dumps(d))


def job(st, phase, **kw):
    now = int(time.time())
    (st / "helper-status.json").write_text(json.dumps({
        "id": "a" * 32, "action": "update", "phase": phase, "message": "m", "started_at": now - 60,
        "updated_at": now, "finished_at": None, "freed_bytes": None, "version": "v0.3.0", **kw}))


@pytest.fixture
def make_client(settings, dirs):
    def make(**over):
        st, rq = dirs
        s = replace(settings, status_dir=st, request_dir=rq, **over)
        app = create_app(s, transport=httpx.MockTransport(offline))
        c = TestClient(app, base_url="http://bedrock-now.localhost", follow_redirects=False)
        c.__enter__()
        c.post("/login", data={"password": "correct horse"}, headers=ORIGIN)
        return c
    return make


def ask(c, action="clean", password="correct horse", headers=H):
    return c.post("/api/admin/request", content=json.dumps({"action": action, "password": password}),
                  headers={"Content-Type": "application/json", **headers})


# The one request format lib/helper.sh accepts (helper_check_request)
HELPER_FORMAT = r'\{"action":"(update|rollback|clean|auto-on|auto-off)","requested_at":[0-9]{1,12},"nonce":"[0-9a-f]{32}"\}'


def requests_in(rq):
    return sorted(p.name for p in rq.iterdir())


def test_a_valid_request_writes_exactly_one_strict_file(make_client, dirs):
    st, rq = dirs
    beat(st)
    c = make_client()
    r = ask(c, "clean")
    assert r.status_code == 202, r.text
    nonce = r.json()["id"]
    files = requests_in(rq)
    assert files == [f"req-{nonce}.json"]
    body = (rq / files[0]).read_text()
    # exactly the format the helper's validator accepts (lib/helper.sh)
    assert re.fullmatch(HELPER_FORMAT, body)
    assert json.loads(body)["nonce"] == nonce
    assert abs(json.loads(body)["requested_at"] - time.time()) < 5
    assert oct((rq / files[0]).stat().st_mode & 0o777) == "0o640"  # group (your gid on Linux) reads it


def test_needs_a_session(settings, dirs):
    st, rq = dirs
    beat(st)
    app = create_app(replace(settings, status_dir=st, request_dir=rq), transport=httpx.MockTransport(offline))
    with TestClient(app, base_url="http://bedrock-now.localhost") as c:
        assert ask(c).status_code == 401
        assert c.get("/api/admin/status", headers=API).status_code == 401
    assert requests_in(rq) == []


def test_needs_x_requested_with_and_same_origin(make_client, dirs):
    st, rq = dirs
    beat(st)
    c = make_client()
    assert ask(c, headers=ORIGIN).status_code == 400
    assert ask(c, headers={**API, "Origin": "http://evil.example"}).status_code == 403
    assert ask(c, headers={**API, "Origin": "http://chat.bedrock-now.localhost"}).status_code == 403
    assert ask(c, headers=API).status_code == 403  # no Origin, no Referer
    assert requests_in(rq) == []


def test_needs_the_password_again_and_counts_failures(make_client, dirs):
    st, rq = dirs
    beat(st)
    c = make_client()
    r = ask(c, password="wrong")
    assert r.status_code == 403 and "password" in r.json()["error"]
    assert ask(c, password=None).status_code == 403
    for _ in range(5):
        ask(c, password="wrong")
    r = ask(c)  # the shared throttle now locks, even for the right password
    assert r.status_code == 429 and "Retry-After" in r.headers
    assert requests_in(rq) == []


def test_only_allowlisted_actions(make_client, dirs):
    st, rq = dirs
    beat(st)
    c = make_client()
    for bad in ("restore", "uninstall", "update --to x", "", None, ["update"]):
        r = c.post("/api/admin/request", content=json.dumps({"action": bad, "password": "correct horse"}), headers=H)
        assert r.status_code == 400
    assert c.post("/api/admin/request", content=b"not json", headers=H).status_code == 400
    assert c.post("/api/admin/request", content=b"x" * 2000, headers=H).status_code == 413
    assert requests_in(rq) == []


def test_refused_when_the_helper_is_not_running(make_client, dirs):
    st, rq = dirs
    c = make_client()
    r = ask(c)
    assert r.status_code == 503 and "./stack helper install" in r.json()["error"]
    beat(st, age=admin.HEARTBEAT_MAX_AGE_S + 5)
    assert ask(c).status_code == 503
    assert requests_in(rq) == []


def test_the_refusal_says_whether_the_helper_was_ever_seen(make_client, dirs):
    st, rq = dirs
    c = make_client()
    assert ask(c).json()["error"].startswith("The update helper is not running. Start it with ./stack helper install")
    beat(st, age=admin.HEARTBEAT_MAX_AGE_S + 600)
    e = ask(c).json()["error"]
    assert "last seen 10 min ago" in e and "./stack helper install" in e and "./stack clean" in e
    beat(st, age=-(admin.HEARTBEAT_SKEW_S + 50))   # dated a minute ahead: Docker's clock is behind
    e = ask(c).json()["error"]
    assert re.search(r"heartbeat is (59|60) s ahead of the portal's clock", e) and "restarting Docker Desktop" in e
    assert requests_in(rq) == []


def test_a_heartbeat_a_little_ahead_of_dockers_clock_counts(dirs):
    st, _ = dirs
    beat(st, age=0)
    hb = json.loads((st / "helper.json").read_text())["heartbeat"]
    # the container's clock trails the computer's by up to HEARTBEAT_SKEW_S: still running
    assert admin.helper_state(st, now=hb - 0.4)["running"] is True
    assert admin.helper_state(st, now=hb - admin.HEARTBEAT_SKEW_S)["running"] is True
    assert admin.helper_state(st, now=hb - admin.HEARTBEAT_SKEW_S - 1)["running"] is False
    assert admin.helper_state(st, now=hb + admin.HEARTBEAT_MAX_AGE_S + 1)["running"] is False


def test_home_keeps_the_helper_and_its_job_while_the_files_are_replaced(make_client, dirs, just_replaced):
    st, rq = dirs
    beat(st)
    job(st, "restarting")
    c = make_client()
    just_replaced(st / "helper.json", st / "helper-status.json")
    s = c.get("/api/admin/status", headers=API).json()
    assert s["running"] is True and s["job"]["phase"] == "restarting" and s["in_progress"] is True
    just_replaced(st / "helper.json")
    assert ask(c).status_code == 409   # "another action is still running", never "not running"


def test_one_action_at_a_time_and_rate_limited(make_client, dirs):
    st, rq = dirs
    beat(st)
    c = make_client()
    job(st, "downloading")
    assert ask(c).status_code == 409
    job(st, "done")
    assert ask(c).status_code == 202
    r = ask(c)
    assert r.status_code == 429 and int(r.headers["Retry-After"]) > 0
    assert len(requests_in(rq)) == 1


def test_a_stuck_old_job_does_not_block_forever():
    st = {"job": {"phase": "restarting", "updated_at": int(time.time()) - admin.JOB_STALE_S - 10}}
    assert admin.job_in_progress(st) is False


def test_rollback_only_when_there_is_something_to_roll_back(make_client, dirs):
    st, rq = dirs
    beat(st, rollback=False)
    c = make_client()
    assert ask(c, "rollback").status_code == 409
    beat(st, rollback=True)
    assert ask(c, "rollback").status_code == 202


def test_remote_requests_are_off_by_default(make_client, dirs):
    st, rq = dirs
    beat(st)
    c = make_client()
    remote = {**H, "X-Portal-Remote": "1"}
    r = ask(c, headers=remote)
    assert r.status_code == 403 and "REMOTE_ADMIN_ACTIONS" in r.json()["error"]
    s = c.get("/api/admin/status", headers={**API, "X-Portal-Remote": "1"}).json()
    assert s["allowed"] is False and s["remote"] is True
    assert requests_in(rq) == []
    c2 = make_client(remote_admin_actions=True)
    assert ask(c2, headers=remote).status_code == 202


def test_status_reports_helper_and_job_with_types_checked(make_client, dirs):
    st, rq = dirs
    c = make_client()
    s = c.get("/api/admin/status", headers=API).json()
    assert s["running"] is False and s["job"] is None and s["allowed"] is True
    beat(st)
    job(st, "done", message="Updated to v0.3.0 · freed 3.1 GB", freed_bytes=3100000000, finished_at=int(time.time()),
        phase_extra="<b>")
    s = c.get("/api/admin/status", headers=API).json()
    assert s["running"] is True and s["rollback"] == {"available": True, "to": "v0.2.1", "backup": "backups/20261012-000000-auto",
                                                "unfinished": False}
    assert s["job"]["phase"] == "done" and s["job"]["freed_bytes"] == 3100000000
    assert "phase_extra" not in s["job"] and s["in_progress"] is False
    (st / "helper-status.json").write_text(json.dumps({"phase": ["x"], "freed_bytes": "lots", "message": 5}))
    s = c.get("/api/admin/status", headers=API).json()
    assert s["job"]["phase"] == "" and s["job"]["freed_bytes"] is None and s["job"]["message"] == ""


def test_symlinked_or_huge_status_files_are_ignored(make_client, dirs, tmp_path):
    st, rq = dirs
    (tmp_path / "x.json").write_text(json.dumps({"heartbeat": int(time.time())}))
    (st / "helper.json").symlink_to(tmp_path / "x.json")
    (st / "helper-status.json").write_text('{"message": "' + "x" * 70000 + '"}')
    c = make_client()
    s = c.get("/api/admin/status", headers=API).json()
    assert s["running"] is False and s["job"] is None


def test_write_request_refuses_other_actions(tmp_path):
    with pytest.raises(ValueError):
        admin.write_request(tmp_path, "restore")
    assert list(tmp_path.iterdir()) == []


def test_the_request_folder_is_the_only_new_place_written(make_client, dirs, tmp_path):
    st, rq = dirs
    beat(st)
    before = {p for p in tmp_path.rglob("*")}
    c = make_client()
    assert ask(c).status_code == 202
    new = {p for p in tmp_path.rglob("*")} - before
    assert all(p.parent == rq for p in new), new


# The status message the host helper writes when ./stack update found nothing new (tests/test_helper.sh checks
# that lib/helper.sh writes exactly this prefix); Home then has no new version to reload.
NOTHING_NEW_PREFIX = "Already up to date"


def test_home_shows_no_steps_and_no_reload_after_an_update_that_found_nothing_new():
    from pathlib import Path
    js = (Path(__file__).parent.parent / "portal" / "static" / "app.js").read_text()
    assert f'const nothingNew = job.phase === "done" && msg.startsWith("{NOTHING_NEW_PREFIX}");' in js
    assert "list.hidden = !steps.length || nothingNew" in js  # no step ran: no ticked-off step list
    assert '!nothingNew) note = "Reload this page' in js


# --- automatic updates: the switch on Home (auto-on / auto-off) and what the heartbeat says ---

def test_the_switch_is_a_request_like_the_others(make_client, dirs):
    st, rq = dirs
    beat(st)
    c = make_client()
    r = ask(c, "auto-on")
    assert r.status_code == 202, r.text
    body = (rq / f"req-{r.json()['id']}.json").read_text()
    assert re.fullmatch(HELPER_FORMAT, body) and json.loads(body)["action"] == "auto-on"
    # the same rate limit as Update / Rollback / Clean
    r = ask(c, "auto-off")
    assert r.status_code == 429 and int(r.headers["Retry-After"]) > 0
    assert len(requests_in(rq)) == 1


def test_the_switch_needs_the_password_and_is_off_for_remote_access(make_client, dirs):
    st, rq = dirs
    beat(st)
    c = make_client()
    assert ask(c, "auto-on", password="wrong").status_code == 403
    r = ask(c, "auto-on", headers={**H, "X-Portal-Remote": "1"})
    assert r.status_code == 403 and "REMOTE_ADMIN_ACTIONS" in r.json()["error"]
    assert requests_in(rq) == []
    c2 = make_client(remote_admin_actions=True)
    assert ask(c2, "auto-off", headers={**H, "X-Portal-Remote": "1"}).status_code == 202


def test_the_switch_needs_a_helper_that_knows_it(make_client, dirs):
    st, rq = dirs
    c = make_client()
    r = ask(c, "auto-on")
    assert r.status_code == 503 and "./stack helper auto on" in r.json()["error"]
    beat(st, auto=None)  # a helper from before automatic updates
    r = ask(c, "auto-on")
    assert r.status_code == 409 and "./stack helper install" in r.json()["error"]
    job(st, "downloading")
    beat(st)
    assert ask(c, "auto-off").status_code == 409  # one thing at a time
    assert requests_in(rq) == []
    for bad in ("auto", "auto-on --hour 1", "auto_on", "AUTO-ON"):
        assert ask(c, bad).status_code == 400


def test_status_reports_the_automatic_update_with_types_checked(make_client, dirs):
    st, rq = dirs
    c = make_client()
    beat(st, auto={"on": True, "hour": 2, "state": "tried", "target": "v0.4.0", "reason": "v0.4.0 failed …",
                   "next_window": 1800003600, "last": {"version": "v0.4.0", "result": "failed", "at": 1800000000},
                   "rolled_back": "v0.3.9", "unfinished": True,
                   "skipped": {"window": "2027-01-15", "reason": "./stack backup is running", "at": 1800000100},
                   "switch": {"id": "a" * 32, "action": "auto-on", "result": "done", "message": "on", "at": 1800000200}},
         rollback=True)
    job(st, "failed", trigger="auto", message="Automatic update to v0.4.0 failed at 03:06: x")
    s = c.get("/api/admin/status", headers=API).json()
    assert s["auto"] == {"supported": True, "on": True, "hour": 2, "state": "tried", "target": "v0.4.0",
                         "reason": "v0.4.0 failed …", "next_window": 1800003600,
                         "last": {"version": "v0.4.0", "result": "failed", "at": 1800000000},
                         "rolled_back": "v0.3.9", "unfinished": True,
                         "skipped": {"window": "2027-01-15", "reason": "./stack backup is running", "at": 1800000100},
                         "switch": {"id": "a" * 32, "action": "auto-on", "result": "done", "message": "on", "at": 1800000200}}
    assert s["job"]["trigger"] == "auto" and s["rollback"]["unfinished"] is False
    assert "auto-on" in s["actions"] and "auto-off" in s["actions"]
    beat(st, auto={"on": "yes", "hour": 99, "state": ["x"], "reason": 5, "next_window": "soon", "last": "x",
                   "skipped": [1], "switch": "x", "unfinished": "yes", "rolled_back": 4},
         rollback=True)
    (st / "helper.json").write_text((st / "helper.json").read_text().replace(
        '"backup": "backups/20261012-000000-auto"}', '"backup": "b", "unfinished": true}'))
    job(st, "failed", trigger="<script>")
    s = c.get("/api/admin/status", headers=API).json()
    a = s["auto"]
    assert a["on"] is False and a["hour"] == 3 and a["state"] == "" and a["reason"] == "" and a["unfinished"] is False
    assert a["next_window"] is None and a["last"] == {"version": "", "result": "", "at": None} and a["rolled_back"] == ""
    assert a["skipped"] == {"window": "", "reason": "", "at": None} and a["switch"]["id"] == "" and a["switch"]["at"] is None
    assert s["job"]["trigger"] == "request" and s["rollback"]["unfinished"] is True
    beat(st, auto=None)
    s = c.get("/api/admin/status", headers=API).json()
    assert s["auto"]["supported"] is False and s["auto"]["on"] is False


def test_an_automatic_update_that_did_not_start_never_blocks_requests(make_client, dirs):
    st, rq = dirs
    beat(st)
    job(st, "skipped", trigger="auto", message="The automatic update to v0.4.0 did not start: Busy")
    c = make_client()
    s = c.get("/api/admin/status", headers=API).json()
    assert s["in_progress"] is False and s["job"]["phase"] == "skipped"
    assert ask(c, "clean").status_code == 202


def test_the_remote_refusal_names_the_switch_too(make_client, dirs):
    st, rq = dirs
    beat(st)
    c = make_client()
    r = ask(c, "auto-on", headers={**H, "X-Portal-Remote": "1"})
    assert r.status_code == 403 and "automatic-updates switch" in r.json()["error"]


class _Page(HTMLParser):
    """index.html as {id: (tag, attributes, text)}: what the page offers, without depending on its formatting."""

    def __init__(self, text):
        super().__init__()
        self.by_id, self._open = {}, []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("input", "img", "meta", "link", "br"):
            if a.get("id"):
                self.by_id[a["id"]] = (tag, a, "")
            return
        self._open.append([tag, a, ""])

    def handle_endtag(self, tag):
        while self._open:
            t, a, text = self._open.pop()
            if self._open:
                self._open[-1][2] += text
            if a.get("id"):
                self.by_id[a["id"]] = (t, a, " ".join(text.split()))
            if t == tag:
                break

    def handle_data(self, data):
        if self._open:
            self._open[-1][2] += data


def _page():
    return _Page((Path(__file__).parent.parent / "portal" / "static" / "index.html").read_text())


def test_home_has_the_switch_and_the_helper_missing_hint():
    p = _page().by_id
    # Maintenance: Off | Nightly, segmented like the model filter chips (aria-pressed), labelled as one group
    tag, attrs, text = p["auto-toggle"]
    assert tag == "div" and attrs["role"] == "group" and attrs["aria-labelledby"] == "auto-label" and p["auto-label"][2] == "Automatic updates"
    assert text == "Off Nightly (03:00–06:00)" and p["auto-window"][2] == "03:00–06:00"
    assert "hidden" in p["auto-row"][1]   # shown only with a helper that knows automatic updates
    # without the helper: the one command, a Copy button and why it needs a terminal once
    assert "hidden" in p["helper-off"][1] and p["helper-off-title"][2] == "One-click updates are off"
    assert p["helper-cmd"] == ("code", {"id": "helper-cmd"}, "./stack helper install")
    assert p["copy-helper"][0] == "button" and p["copy-helper"][2] == "Copy"
    assert p["helper-off-why"][2].startswith("The portal cannot install software on your computer (by design), so this one step runs in a terminal")
    assert "update-helper-slot" in p and "maint-helper-slot" in p   # the hint moves into the update card when one is available
    # Roll back right in the progress card after a failed update
    assert p["job-rollback"][0] == "button" and p["job-rollback"][1]["data-action"] == "rollback"
    assert "hidden" in p["job-actions"][1]


def test_home_scripts_say_what_the_helper_reports():
    js = (Path(__file__).parent.parent / "portal" / "static" / "app.js").read_text()
    # (no JavaScript runtime in this image: the wording Home builds is checked as text)
    assert "Will install automatically ${" in js and "(this computer's time) — or Update now." in js
    assert '"auto-on": ["Turn on automatic updates?", "Turn on"]' in js
    assert '{ failed: " failed", done: " finished", skipped: " skipped" }' in js   # a skipped automatic update is no failure
    assert "awaiting.toggle ? sw.id === awaiting.id" in js   # a switch change answers in the heartbeat, not the job status
    # while a job runs, the helper sees its own update as "unfinished": Home does not say so then
    assert '!(a.in_progress && auto.state === "unfinished")' in js and 'a.in_progress && auto.state === "unfinished" ? "On."' in js
    assert "innerHTML" not in js


# --- the last job of any origin: the helper's, or a ./stack command run in a terminal (lib/lock.sh) ---

def term_job(st, phase, age=0, **kw):
    now = int(time.time()) - age
    (st / "terminal-job.json").write_text(json.dumps({
        "id": f"t-{now - 30}-123", "action": "code", "command": "code enable", "phase": phase, "message": "Finished",
        "started_at": now - 30, "updated_at": now, "finished_at": now if phase in ("done", "failed") else None,
        "version": "v0.9.0", "pid": 123, **kw}))


def test_home_shows_the_newest_job_whatever_ran_it(make_client, dirs):
    st, rq = dirs
    beat(st)
    c = make_client()
    now = int(time.time())
    # the rehearsal: a Settings change failed (helper), later ./stack code enable in a terminal succeeded
    job(st, "failed", action="settings", message="setup failed", updated_at=now - 600, finished_at=now - 600)
    term_job(st, "done")
    s = c.get("/api/admin/status", headers=API).json()
    assert s["job"]["origin"] == "terminal" and s["job"]["command"] == "code enable" and s["job"]["phase"] == "done"
    assert s["job"]["trigger"] == "terminal" and s["in_progress"] is False
    # then a rollback from Home: newer, so it shows
    job(st, "done", action="rollback", message="Rolled back to v0.4.1", updated_at=now + 5, finished_at=now + 5)
    s = c.get("/api/admin/status", headers=API).json()
    assert s["job"]["origin"] == "helper" and s["job"]["action"] == "rollback"
    # a ./stack update running in a terminal now: it shows, and blocks a request like a helper job would
    term_job(st, "running", action="update", command="update", message="Running in a terminal")
    s = c.get("/api/admin/status", headers=API).json()
    assert s["job"]["origin"] == "terminal" and s["in_progress"] is True
    assert ask(c, "clean").status_code == 409
    # a helper job in progress wins over a newer terminal record (its progress is what Home follows)
    job(st, "backing-up", updated_at=now - 30)
    term_job(st, "done")
    s = c.get("/api/admin/status", headers=API).json()
    assert s["job"]["origin"] == "helper" and s["job"]["phase"] == "backing-up" and s["in_progress"] is True


def test_a_terminal_record_left_running_for_hours_does_not_block(dirs):
    st, rq = dirs
    term_job(st, "running", age=admin.JOB_STALE_S + 60)
    job(st, "done", updated_at=int(time.time()) - 10, finished_at=int(time.time()) - 10)
    s = admin.helper_state(st)
    assert admin.job_in_progress(s) is False and s["job"]["origin"] == "helper"


def test_terminal_records_are_type_checked(dirs):
    st, rq = dirs
    term_job(st, "done", command="config set; rm -rf /", action="config", message=["x"], version="<b>")
    j = admin.helper_state(st)["job"]
    assert j["command"] == "config" and j["message"] == "" and j["origin"] == "terminal"
    term_job(st, "done", command="code enable", action="<script>")
    j = admin.helper_state(st)["job"]
    assert j["command"] == "code enable"
    term_job(st, "done", command=5, action="<script>")
    assert admin.helper_state(st)["job"]["command"] == ""


def test_home_names_where_a_job_ran():
    js = (Path(__file__).parent.parent / "portal" / "static" / "app.js").read_text()
    assert 'const term = job.origin === "terminal";' in js and "`./stack ${job.command || job.action}`" in js
    assert '"Run in a terminal"' in js and '"Run by the update helper (from Home or Settings)"' in js
    # a terminal job is never mistaken for the helper's answer to a request just sent
    assert 'a.job.origin !== "terminal" && (a.job.id === awaiting.id' in js


def test_home_says_what_an_update_ends_and_reconnects_calmly():
    js = (Path(__file__).parent.parent / "portal" / "static" / "app.js").read_text()
    html = _page().by_id
    # Update and Roll back: the terminal's container is recreated, Code page sessions resume, a running turn is named
    assert "The Terminal's container is recreated: its tmux windows close" in js
    assert "Code page sessions resume from their transcripts" in js and "A Code page turn is running right now." in js
    assert js.count("${endsNote()} This page reconnects by itself.") == 2
    assert 'e.data.type !== "bn-code-status"' in js and "e.source !== f.contentWindow" in js
    # the gap while the portal restarts: a line with a spinner and the time so far, not an error banner
    assert html["job-reconnect"][1].get("role") == "status" and "hidden" in html["job-reconnect"][1]
    assert "job-reconnect-time" in html and "The portal is restarting as part of this — reconnecting…" in js
    assert "Reconnected: the portal was away for ${mmss(" in js
    assert "if (adminState && adminState.in_progress) { pollAdmin(); }" in js
