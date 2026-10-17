import asyncio
import json
from dataclasses import replace

import httpx
import pytest
from starlette.testclient import TestClient

from portal import updates
from portal.app import create_app
from portal.updates import Paths

COMPOSE_NEW = """services:
  litellm:
    image: ghcr.io/berriai/litellm:1.106.0
  open-webui:
    image: ghcr.io/open-webui/open-webui:v0.12.0-slim
  portal:
    image: ${COMPOSE_PROJECT_NAME:-bedrock-now}/portal:local   # per project
"""


@pytest.fixture
def paths(tmp_path):
    p = Paths(update_dir=tmp_path / "update-check", status_dir=tmp_path / "status")
    p.update_dir.mkdir()
    p.status_dir.mkdir()
    return p


def write_version(paths, version="v0.2.1", images=("ghcr.io/berriai/litellm:1.105.0", "ghcr.io/open-webui/open-webui:v0.12.0-slim")):
    paths.version.write_text(json.dumps({"version": version, "commit": "abc1234", "images": list(images)}))


def release(tag="v0.3.0", body="## Changes\n- **Faster** updates\n<script>alert(1)</script>", **kw):
    return {"tag_name": tag, "name": f"bedrock-now {tag}", "body": body, "draft": False, "prerelease": False,
            "html_url": f"https://github.com/JongoDB-Labs/bedrock-now/releases/tag/{tag}",
            "published_at": "2026-10-20T10:00:00Z", **kw}


class GitHub:
    """Mock api.github.com (the release list) + raw.githubusercontent.com; records requests."""

    def __init__(self, rel=None, status=200, etag='W/"abc"', compose=COMPOSE_NEW, raw=None, rels=None):
        self.rels = rels if rels is not None else [rel or release()]
        self.status, self.etag, self.compose, self.raw = status, etag, compose, raw
        self.seen = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        if request.url.host == "api.github.com":
            assert request.url.path == "/repos/JongoDB-Labs/bedrock-now/releases"
            if self.etag and request.headers.get("if-none-match") == self.etag:
                return httpx.Response(304, headers={"etag": self.etag})
            if self.raw is not None:
                return httpx.Response(self.status, content=self.raw)
            return httpx.Response(self.status, json=self.rels, headers={"etag": self.etag} if self.etag else {})
        if request.url.host == "raw.githubusercontent.com":
            return httpx.Response(200, text=self.compose)
        raise AssertionError(f"unexpected host {request.url}")


def github_or_503(gh):
    """The portal's whole transport: GitHub's hosts to the mock, everything else (LiteLLM, Open WebUI…) a 503."""
    def route(request):
        if request.url.host in ("api.github.com", "raw.githubusercontent.com"):
            return gh(request)
        return httpx.Response(503)
    return route


def run_check(paths, gh):
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(gh)) as c:
            return await updates.check(c, paths)
    return asyncio.run(go())


def test_versions_compare_as_releases():
    assert updates.newer("v0.3.0", "v0.2.1") is True
    assert updates.newer("v0.2.1", "v0.2.1") is False
    assert updates.newer("v0.2.1", "v0.2.1-5-gabcdef0") is False  # a branch after the tag
    assert updates.newer("v0.2.2", "v0.2.1-5-gabcdef0") is True
    assert updates.newer("v0.10.0", "v0.9.9") is True
    assert updates.newer("v0.3.0", "abc1234") is None  # not a release: unknown
    assert updates.newer("v0.3.0-rc1", "v0.2.1") is None


def test_check_finds_a_newer_release_and_estimates_the_download(paths):
    write_version(paths)
    gh = GitHub()
    rec = run_check(paths, gh)
    assert rec["tag"] == "v0.3.0" and rec["error"] is None
    assert [r.url.host for r in gh.seen] == ["api.github.com", "raw.githubusercontent.com"]
    assert all(r.url.scheme == "https" for r in gh.seen)
    assert str(gh.seen[1].url).endswith("/JongoDB-Labs/bedrock-now/v0.3.0/compose.yaml")
    # nothing about this install is sent
    assert "abc1234" not in str(gh.seen[0].url) and "cookie" not in gh.seen[0].headers
    assert paths.txt.read_text().startswith("latest=v0.3.0\n")
    st = updates.status(paths, True)
    assert st["available"] is True and st["installed"] == "v0.2.1" and st["latest"] == "v0.3.0"
    assert st["estimate"]["images"] == ["ghcr.io/berriai/litellm:1.106.0"]
    assert st["estimate"]["download_mb"] == 1750
    assert st["estimate"]["downtime_min"] == updates.DOWNTIME_MIN
    assert st["command"] == "./stack update"
    assert "<script>" in st["notes"]  # raw text: Home renders it with textContent only


def test_second_check_uses_the_etag(paths):
    write_version(paths)
    gh = GitHub()
    run_check(paths, gh)
    rec = run_check(paths, gh)
    assert gh.seen[2].headers["if-none-match"] == 'W/"abc"'
    assert rec["tag"] == "v0.3.0" and rec["error"] is None
    assert len(gh.seen) == 3  # 304, and the compose file is not fetched again


def test_no_update_when_installed_is_current(paths):
    write_version(paths, "v0.3.0")
    gh = GitHub()
    run_check(paths, gh)
    st = updates.status(paths, True)
    assert st["available"] is False and st["latest"] == "v0.3.0"
    assert [r.url.host for r in gh.seen] == ["api.github.com"]  # no compose download when it cannot matter


@pytest.mark.parametrize("gh,err", [
    (GitHub(status=500), "HTTP 500"),
    (GitHub(status=302), "HTTP 302"),  # redirects are not followed
    (GitHub(raw=b"not json"), "not JSON"),
    (GitHub(raw=b"x" * (updates.MAX_JSON + 10)), "larger than"),
    (GitHub(rel=release(tag="latest")), "has a vX.Y.Z tag"),
    (GitHub(rel=release(prerelease=True)), "has a vX.Y.Z tag"),
    (GitHub(raw=b'{"tag_name": "v9.9.9"}'), "unexpected format"),   # the list, not one release
])
def test_errors_are_recorded_and_keep_the_last_good_answer(paths, gh, err):
    write_version(paths)
    run_check(paths, GitHub())
    gh.etag = None  # a full answer, not 304
    rec = run_check(paths, gh)
    assert err in rec["error"]
    assert rec["tag"] == "v0.3.0"  # the last good answer stays
    assert updates.status(paths, True)["available"] is True


def test_network_failure_is_an_error_not_a_crash(paths):
    def boom(request):
        raise httpx.ConnectError("offline")
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(boom)) as c:
            return await updates.check(c, paths)
    rec = asyncio.run(go())
    assert "did not answer" in rec["error"]
    assert paths.txt.read_text().startswith("latest=\n")


def test_untrusted_release_fields_are_bounded(paths):
    write_version(paths)
    rel = release(body="x" * 50000, html_url="https://evil.example/")
    run_check(paths, GitHub(rel=rel))
    st = updates.status(paths, True)
    assert len(st["notes"]) == updates.MAX_NOTES
    assert st["url"] == "https://github.com/JongoDB-Labs/bedrock-now/releases"


def test_disabled_reports_nothing(paths):
    write_version(paths)
    run_check(paths, GitHub())
    st = updates.status(paths, False)
    assert st["enabled"] is False and st["available"] is False and st["latest"] is None


def test_unknown_install_version_never_claims_an_update(paths):
    paths.version.write_text('{"version": "$(rm -rf /)", "images": ["ok/img:1", "bad img"]}')
    run_check(paths, GitHub())
    st = updates.status(paths, True)
    assert st["installed"] is None and st["available"] is False
    assert updates.installed(paths)["images"] == ["ok/img:1"]


def test_symlinked_state_files_are_ignored(paths, tmp_path):
    (tmp_path / "elsewhere.json").write_text(json.dumps({"version": "v0.0.1"}))
    paths.version.symlink_to(tmp_path / "elsewhere.json")
    assert updates.installed(paths)["version"] == ""


def test_summary_carries_the_update_card(settings, paths):
    write_version(paths)
    run_check(paths, GitHub())
    s = replace(settings, update_check=True, update_dir=paths.update_dir, status_dir=paths.status_dir)
    app = create_app(s, transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    with TestClient(app, base_url="http://bedrock-now.localhost", follow_redirects=False) as c:
        c.post("/login", data={"password": "correct horse"}, headers={"Origin": "http://bedrock-now.localhost"})
        d = c.get("/api/summary", headers={"X-Requested-With": "bedrock-now"}).json()
    u = d["update"]
    assert u["enabled"] and u["available"] and u["latest"] == "v0.3.0" and u["installed"] == "v0.2.1"
    assert u["estimate"]["download_mb"] == 1750


def test_the_daily_loop_starts_only_when_enabled(settings, monkeypatch):
    started = []

    async def fake_loop(paths, transport=None):
        started.append(paths.update_dir)

    monkeypatch.setattr(updates, "daily_loop", fake_loop)
    for enabled in (False, True):
        app = create_app(replace(settings, update_check=enabled), transport=httpx.MockTransport(lambda r: httpx.Response(503)))
        with TestClient(app):
            pass
    assert started == [settings.update_dir]


def test_from_env_reads_the_switch():
    from portal.config import from_env
    base = {"PORTAL_PASSWORD": "p", "PORTAL_SECRET": "s" * 40}
    assert from_env(base).update_check is True
    assert from_env({**base, "UPDATE_CHECK": "false"}).update_check is False
    assert str(from_env(base).update_dir) == "/data/update-check"


def test_home_renders_release_notes_without_html_parsing():
    from pathlib import Path
    js = (Path(__file__).parent.parent / "portal" / "static" / "app.js").read_text()
    for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "DOMParser", "eval("):
        assert sink not in js
    assert "function renderNotes" in js and "https:\\/\\/" in js  # links: https only
    html = (Path(__file__).parent.parent / "portal" / "static" / "index.html").read_text()
    assert 'id="update-card"' in html and 'id="copy-update"' in html


def test_app_frames_may_keep_the_screen_awake_during_a_call():
    import re
    from pathlib import Path
    js = (Path(__file__).parent.parent / "portal" / "static" / "app.js").read_text()
    allow = re.search(r'allow: "([^"]*)"', js).group(1).split("; ")
    assert {"microphone", "screen-wake-lock"} <= set(allow)


def test_only_identity_encoding_is_accepted(paths):
    write_version(paths)
    seen = []

    def gz(request):
        seen.append(request.headers.get("accept-encoding"))
        return httpx.Response(200, content=b"\x1f\x8b...", headers={"content-encoding": "gzip"})
    rec = run_check(paths, gz)
    # refused either by our check or (MockTransport reads eagerly) by httpx; never decompressed into an answer
    assert "unexpected content encoding gzip" in rec["error"] or "DecodingError" in rec["error"]
    assert rec.get("tag") is None
    assert seen == ["identity"]


def test_a_slow_server_hits_the_total_timeout(paths):
    write_version(paths)

    async def slow(request):
        await asyncio.sleep(5)
        return httpx.Response(200, json=release())

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(slow)) as c:
            return await updates.check(c, paths, total_timeout=0.2)
    rec = asyncio.run(go())
    assert "no answer within" in rec["error"]


def test_oversized_state_files_are_ignored(paths):
    paths.version.write_text('{"version": "v0.2.1", "pad": "' + "x" * (updates.MAX_STATE + 10) + '"}')
    assert updates.installed(paths)["version"] == ""


def test_status_names_a_branch_install(paths):
    paths.version.write_text(json.dumps({"version": "v0.2.1-3-gabcdef0", "branch": "main", "images": []}))
    run_check(paths, GitHub())
    st = updates.status(paths, True)
    assert st["branch"] == "main" and st["available"] is True
    paths.version.write_text(json.dumps({"version": "v0.2.1", "branch": "bad branch;rm", "images": []}))
    assert updates.status(paths, True)["branch"] is None


# --- Home's version label: the installed version in every state, and where a click leads ---

def test_status_always_names_the_installed_version_and_its_page(paths):
    paths.version.write_text(json.dumps({"version": "v0.3.0", "commit": "1a2b3c4", "commit_date": "2026-10-13T09:15:00-04:00",
                                         "images": []}))
    for enabled in (False, True):  # the check off, or on with no answer yet (no network)
        st = updates.status(paths, enabled)
        assert st["installed"] == "v0.3.0" and st["commit"] == "1a2b3c4" and st["commit_date"] == "2026-10-13T09:15:00-04:00"
        assert st["release_url"] == "https://github.com/JongoDB-Labs/bedrock-now/releases/tag/v0.3.0"
    run_check(paths, GitHub(status=500))  # a failed check changes nothing about it
    assert updates.status(paths, True)["installed"] == "v0.3.0"
    paths.version.write_text(json.dumps({"version": "v0.3.0-7-g1a2b3c4", "branch": "main", "images": []}))
    st = updates.status(paths, True)
    assert st["installed"] == "v0.3.0-7-g1a2b3c4" and st["branch"] == "main"
    assert st["release_url"] == "https://github.com/JongoDB-Labs/bedrock-now/blob/main/CHANGELOG.md"  # a dev build
    assert st["commit"] is None and st["commit_date"] is None  # an older ./stack wrote no date


def test_untrusted_commit_fields_are_dropped(paths):
    paths.version.write_text(json.dumps({"version": "v0.3.0", "commit": "<b>xyz</b>", "commit_date": "tomorrow; rm",
                                         "images": []}))
    st = updates.status(paths, False)
    assert st["commit"] is None and st["commit_date"] is None
    paths.version.write_text('{"version": "x y"}')
    st = updates.status(paths, False)
    assert st["installed"] is None and st["release_url"].endswith("/CHANGELOG.md")


def test_summary_carries_the_version_label_without_the_check(settings, paths):
    paths.version.write_text(json.dumps({"version": "v0.3.0", "commit": "1a2b3c4", "images": []}))
    s = replace(settings, update_check=False, update_dir=paths.update_dir, status_dir=paths.status_dir)
    app = create_app(s, transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    with TestClient(app, base_url="http://bedrock-now.localhost", follow_redirects=False) as c:
        c.post("/login", data={"password": "correct horse"}, headers={"Origin": "http://bedrock-now.localhost"})
        u = c.get("/api/summary", headers={"X-Requested-With": "bedrock-now"}).json()["update"]
    assert u["installed"] == "v0.3.0" and u["available"] is False and u["release_url"].endswith("/releases/tag/v0.3.0")


def test_home_shows_the_version_under_the_brand_and_in_the_phone_header():
    from html.parser import HTMLParser
    from pathlib import Path
    static = Path(__file__).parent.parent / "portal" / "static"
    page = (static / "index.html").read_text()
    js = (static / "app.js").read_text()
    found = {}

    class P(HTMLParser):
        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            if a.get("id") in ("version", "home-version"):
                found[a["id"]] = (tag, a)
    P().feed(page)
    for i in ("version", "home-version"):   # links, filled in by app.js, hidden until it knows the version
        tag, a = found[i]
        assert tag == "a" and "version-label" in a["class"] and "hidden" in a and a["rel"] == "noopener noreferrer"
    # the label sits right under the brand, before the tabs; on phones in Home's header next to "Updated"
    assert page.index('class="brand"') < page.index('id="version"') < page.index('class="tabs"')
    assert page.index('class="updated"') < page.index('id="home-version"') < page.index('id="updated"')
    # "v0.3.0-7-g1a2b3c4" -> "v0.3.0" "+7" "(1a2b3c4)", text nodes only; a dot while an update is available
    assert "const BUILD = /^(v\\d+\\.\\d+\\.\\d+)(?:-(\\d+)-g([0-9a-f]{4,40}))?$/;" in js
    assert "tip.push(`update available: ${u.latest}`)" in js and "innerHTML" not in js


# --- a jump over several releases: every release between the installed one and the newest ---

NAMES = {"v0.9.0": "v0.9.0 — Git panel and Run & test", "v0.8.0": "v0.8.0 — Auto mode (opt-in), cost guardrails",
         "v0.7.0": "v0.7.0 — review changes, search", "v0.6.0": "v0.6.0 — permission modes, file previews",
         "v0.5.0": "v0.5.0 — Claude Code in the portal: the Code page", "v0.4.1": "v0.4.1 — one sign-in for every app",
         "v0.4.0": "v0.4.0 — Settings and updates from Home"}


def releases(order=("v0.7.0", "v0.9.0", "v0.8.0", "v0.6.0", "v0.5.0", "v0.4.1", "v0.4.0")):
    out = [release(tag=t, name=NAMES[t], body=f"Notes of {t}.\n\n## Highlights\n- **{t} thing**") for t in order]
    out.insert(1, release(tag="v1.0.0-rc1", name="rc", prerelease=True))
    out.insert(2, release(tag="v2.0.0", name="draft", draft=True))
    return out


def test_a_jump_over_several_releases_lists_each_newest_first(paths):
    write_version(paths, "v0.4.1")
    rec = run_check(paths, GitHub(rels=releases()))
    assert rec["tag"] == "v0.9.0"   # the highest vX.Y.Z tag (what ./stack update installs), whatever the list's order
    assert paths.txt.read_text().startswith("latest=v0.9.0\n")
    st = updates.status(paths, True)
    assert st["available"] and st["latest"] == "v0.9.0" and st["behind"] == 5 and st["more"] is False
    assert [r["tag"] for r in st["releases"]] == ["v0.9.0", "v0.8.0", "v0.7.0", "v0.6.0", "v0.5.0"]
    assert [r["headline"] for r in st["releases"]][:2] == ["Git panel and Run & test", "Auto mode (opt-in), cost guardrails"]
    assert st["releases"][4]["notes"].startswith("Notes of v0.5.0.")
    assert all(r["url"] == f"https://github.com/JongoDB-Labs/bedrock-now/releases/tag/{r['tag']}" for r in st["releases"])
    # the card's own fields are the newest release's
    assert st["name"] == NAMES["v0.9.0"] and st["notes"].startswith("Notes of v0.9.0.")
    # one release behind: just that one
    write_version(paths, "v0.8.0")
    assert [r["tag"] for r in updates.status(paths, True)["releases"]] == ["v0.9.0"]
    # a build after a release: the releases after its tag
    write_version(paths, "v0.6.0-3-gabcdef0")
    assert [r["tag"] for r in updates.status(paths, True)["releases"]] == ["v0.9.0", "v0.8.0", "v0.7.0"]
    # up to date: none
    write_version(paths, "v0.9.0")
    st = updates.status(paths, True)
    assert st["available"] is False and st["releases"] == [] and st["behind"] == 0


def test_older_releases_than_the_list_holds_are_said_to_be_missing(paths, monkeypatch):
    monkeypatch.setattr(updates, "PER_PAGE", 3)
    write_version(paths, "v0.4.0")
    run_check(paths, GitHub(rels=releases()))
    st = updates.status(paths, True)
    assert [r["tag"] for r in st["releases"]] == ["v0.9.0", "v0.8.0", "v0.7.0"] and st["more"] is True


def test_headlines_come_from_the_name_else_the_notes():
    h = updates.headline
    assert h("v0.9.0", "v0.9.0 — Git panel and Run & test", "x") == "Git panel and Run & test"
    assert h("v0.9.0", "bedrock-now v0.9.0", "") == ""
    assert h("v0.2.1", "v0.2.1", "\n### Changed\n\n- **Real provider logos** instead of badges") == "Real provider logos"
    assert h("v0.2.0", "v0.2.0", "\nOne portal with one login for everything, and `costs` [everywhere](https://x/y).") == \
        "One portal with one login for everything, and costs everywhere."
    long = h("v1.0.0", "v1.0.0", "word " * 100)
    assert len(long) <= updates.MAX_HEADLINE and long.endswith("…")


def test_release_fields_are_checked_and_bounded(paths, monkeypatch):
    monkeypatch.setattr(updates, "MAX_NOTES_TOTAL", 100)
    write_version(paths, "v0.4.1")
    rels = releases()
    rels[0]["html_url"] = "https://evil.example/x"
    rels[3]["name"] = None
    run_check(paths, GitHub(rels=rels))
    st = updates.status(paths, True)
    by = {r["tag"]: r for r in st["releases"]}
    assert by["v0.7.0"]["url"] == "https://github.com/JongoDB-Labs/bedrock-now/releases"
    # past the cap of all notes together: the headline and the link stay, the notes go
    assert by["v0.9.0"]["notes"] and not by["v0.5.0"]["notes"] and by["v0.5.0"]["headline"]
    # latest.json itself is re-checked when read (it is a file in a folder the portal writes)
    rec = json.loads(paths.json.read_text())
    rec["releases"] = [{"tag": "v0.9.0", "notes": 5, "url": "javascript:x"}, "junk", {"tag": "nope"}]
    paths.json.write_text(json.dumps(rec))
    st = updates.status(paths, True)
    assert st["releases"] == [{"tag": "v0.9.0", "name": "v0.9.0", "headline": "", "notes": "", "url": None, "published_at": None}]


def test_an_answer_from_before_the_list_still_shows_its_release_and_is_asked_again_in_full(paths):
    write_version(paths, "v0.2.1")
    paths.json.write_text(json.dumps({"tag": "v0.3.0", "name": "v0.3.0 — voice", "notes": "- **Voice** on Bedrock",
                                      "etag": 'W/"abc"', "checked_at": updates._now_iso(), "error": None}))
    st = updates.status(paths, True)
    assert [(r["tag"], r["headline"]) for r in st["releases"]] == [("v0.3.0", "voice")]
    gh = GitHub(rels=releases())
    run_check(paths, gh)
    assert "if-none-match" not in gh.seen[0].headers   # an old etag would answer 304 and keep the list away
    assert updates.status(paths, True)["latest"] == "v0.9.0"


# --- the check Home asks for when the last one is old ---

def _age(paths, hours, **extra):
    rec = json.loads(paths.json.read_text()) if paths.json.exists() else {}
    from datetime import datetime, timedelta, timezone
    rec.update({"checked_at": (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(timespec="seconds"), **extra})
    paths.json.write_text(json.dumps(rec))


def test_status_says_when_the_check_is_stale(paths):
    write_version(paths, "v0.2.1")
    run_check(paths, GitHub())
    st = updates.status(paths, True)
    assert st["stale"] is False and st["checked_at"]
    _age(paths, 4)
    assert updates.status(paths, True)["stale"] is True


def test_the_refresher_runs_one_check_when_due_and_rate_limits_itself(paths):
    write_version(paths, "v0.2.1")
    run_check(paths, GitHub())
    clock = [1000.0]
    gh = GitHub(rels=releases(), etag=None)
    r = updates.Refresher(paths, httpx.MockTransport(gh), clock=lambda: clock[0])

    async def go():
        assert r.kick() is False                 # checked just now
        _age(paths, 4)
        assert r.kick() is True and r.checking   # older than STALE_S: one check, in the background
        assert r.kick() is False                 # one at a time
        await r.task
        assert r.checking is False
        _age(paths, 4)
        clock[0] += updates.ON_DEMAND_MIN_S - 1
        assert r.kick() is False                 # at most every ON_DEMAND_MIN_S
        clock[0] += 2
        _age(paths, 0.5, error="api.github.com answered HTTP 403")
        assert r.kick() is False                 # not within an hour of a failed check (GitHub's limit)
        _age(paths, 1.5, error="api.github.com answered HTTP 403")
        assert r.kick() is False                 # (still fresh: 1.5 h < STALE_S)
        _age(paths, 4, error=None)
        assert r.kick() is True
        await r.task
    asyncio.run(go())
    assert [q.url.host for q in gh.seen if q.url.host == "api.github.com"] == ["api.github.com"] * 2
    assert updates.status(paths, True)["latest"] == "v0.9.0"


def test_home_asks_for_a_check_when_the_last_one_is_old(settings, paths):
    import time
    write_version(paths, "v0.4.1")
    run_check(paths, GitHub(rels=releases(order=("v0.6.0", "v0.5.0", "v0.4.1"))))
    _age(paths, 5)   # (the daily check would wait until 20 h)
    gh = GitHub(rels=releases(), etag=None)
    s = replace(settings, update_check=True, update_dir=paths.update_dir, status_dir=paths.status_dir)
    app = create_app(s, transport=httpx.MockTransport(github_or_503(gh)))
    with TestClient(app, base_url="http://bedrock-now.localhost", follow_redirects=False) as c:
        c.post("/login", data={"password": "correct horse"}, headers={"Origin": "http://bedrock-now.localhost"})
        u = c.get("/api/summary", headers={"X-Requested-With": "bedrock-now"}).json()["update"]
        # what Home shows at once: the old answer (or, on a fast machine, already the new one)
        assert u["latest"] in ("v0.6.0", "v0.9.0")
        for _ in range(50):
            u = c.get("/api/summary", headers={"X-Requested-With": "bedrock-now"}).json()["update"]
            if not u["checking"]:
                break
            time.sleep(0.1)
    assert u["latest"] == "v0.9.0" and u["stale"] is False and u["behind"] == 5
    assert len([q for q in gh.seen if q.url.host == "api.github.com"]) == 1


def test_no_check_from_home_when_the_check_is_off(settings, paths):
    write_version(paths, "v0.4.1")
    gh = GitHub()
    s = replace(settings, update_check=False, update_dir=paths.update_dir, status_dir=paths.status_dir)
    app = create_app(s, transport=httpx.MockTransport(github_or_503(gh)))
    with TestClient(app, base_url="http://bedrock-now.localhost", follow_redirects=False) as c:
        c.post("/login", data={"password": "correct horse"}, headers={"Origin": "http://bedrock-now.localhost"})
        u = c.get("/api/summary", headers={"X-Requested-With": "bedrock-now"}).json()["update"]
    assert u["checking"] is False and u["latest"] is None and gh.seen == []


def test_home_lists_every_release_and_says_when_it_checked():
    from pathlib import Path
    static = Path(__file__).parent.parent / "portal" / "static"
    js = (static / "app.js").read_text()
    html = (static / "index.html").read_text()
    assert 'id="update-releases"' in html and 'id="update-notes"' in html and 'id="update-notes-title"' in html
    assert "function renderReleases(u)" in js and "d.open = i === 0;" in js   # the newest open, the others folded
    assert "`What's new: ${rels.length} releases since ${u.installed}`" in js
    assert "Checked ${checked(u.checked_at)}." in js and "release check: ${" in js
    assert "if (u && u.checking) renderUpdate.again = setTimeout(refresh, 6000);" in js
