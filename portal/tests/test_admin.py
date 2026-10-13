import json
import re
import time
from dataclasses import replace

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


def beat(st, age=1, rollback=True, to="v0.2.1"):
    (st / "helper.json").write_text(json.dumps({
        "heartbeat": int(time.time()) - age, "pid": 1, "poll_s": 3, "version": "v0.3.0",
        "rollback": {"available": rollback, "to": to, "backup": "backups/20261012-000000-auto"}}))


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
    assert re.fullmatch(r'\{"action":"(update|rollback|clean)","requested_at":[0-9]{1,12},"nonce":"[0-9a-f]{32}"\}', body)
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
    assert s["running"] is True and s["rollback"] == {"available": True, "to": "v0.2.1", "backup": "backups/20261012-000000-auto"}
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


def test_home_does_not_ask_for_a_reload_after_an_update_that_found_nothing_new():
    from pathlib import Path
    js = (Path(__file__).parent.parent / "portal" / "static" / "app.js").read_text()
    assert f'!msg.startsWith("{NOTHING_NEW_PREFIX}")) note = "Reload this page' in js
