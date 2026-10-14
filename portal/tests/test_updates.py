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
    """Mock api.github.com + raw.githubusercontent.com; records requests."""

    def __init__(self, rel=None, status=200, etag='W/"abc"', compose=COMPOSE_NEW, raw=None):
        self.rel, self.status, self.etag, self.compose, self.raw = rel or release(), status, etag, compose, raw
        self.seen = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        if request.url.host == "api.github.com":
            if self.etag and request.headers.get("if-none-match") == self.etag:
                return httpx.Response(304, headers={"etag": self.etag})
            if self.raw is not None:
                return httpx.Response(self.status, content=self.raw)
            return httpx.Response(self.status, json=self.rel, headers={"etag": self.etag} if self.etag else {})
        if request.url.host == "raw.githubusercontent.com":
            return httpx.Response(200, text=self.compose)
        raise AssertionError(f"unexpected host {request.url}")


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
    (GitHub(rel=release(tag="latest")), "no vX.Y.Z tag"),
    (GitHub(rel=release(prerelease=True)), "no vX.Y.Z tag"),
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
