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
    (GitHub(status=302), "HTTP 302"),  # a redirect without a Location (any but GitHub's for the renamed repository) is not followed
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


class Renamed:
    """GitHub after the repository's rename (JongoDB-Labs/bedrock-now -> JongoDB-Labs/devos-ade): the old name answers
    `status` with a Location — the API's to api_to, the raw host's to raw_to — and the new places answer. Records
    requests; anything else is a 404."""

    def __init__(self, api_to="https://api.github.com/repositories/1415949652/releases?per_page=30",
                 raw_to="https://raw.githubusercontent.com/JongoDB-Labs/devos-ade/v0.3.0/compose.yaml", status=301,
                 new_redirects_to=None):
        self.api_to, self.raw_to, self.status, self.new_redirects_to = api_to, raw_to, status, new_redirects_to
        self.seen = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        host, path = request.url.host, request.url.path
        if host == "api.github.com" and path == "/repos/JongoDB-Labs/bedrock-now/releases":
            return httpx.Response(self.status, headers={"location": self.api_to} if self.api_to is not None else {})
        if host == "api.github.com" and path.lower() in ("/repositories/1415949652/releases", "/repos/jongodb-labs/devos-ade/releases"):
            if self.new_redirects_to:
                return httpx.Response(301, headers={"location": self.new_redirects_to})
            return httpx.Response(200, json=[release(html_url="https://github.com/JongoDB-Labs/devos-ade/releases/tag/v0.3.0")])
        if host == "raw.githubusercontent.com" and path == "/JongoDB-Labs/bedrock-now/v0.3.0/compose.yaml":
            return httpx.Response(301, headers={"location": self.raw_to})
        if host == "raw.githubusercontent.com" and path == "/JongoDB-Labs/devos-ade/v0.3.0/compose.yaml":
            return httpx.Response(200, text=COMPOSE_NEW)
        return httpx.Response(404)


@pytest.mark.parametrize("api_to,status", [
    ("https://api.github.com/repositories/1415949652/releases?per_page=30", 301),    # what GitHub's API answers
    ("/repositories/1415949652/releases?per_page=30", 301),                          # ... relative
    ("https://api.github.com/repositories/1415949652/releases?per_page=30", 307),
    ("https://api.github.com/repos/JongoDB-Labs/devos-ade/releases?per_page=30", 301),  # the new name
    ("https://api.github.com/repos/jongodb-labs/DevOS-ADE/releases?per_page=30", 301),  # ... in any case, as GitHub takes it
])
def test_one_redirect_to_the_renamed_repository_is_followed(paths, api_to, status):
    write_version(paths)
    gh = Renamed(api_to=api_to, status=status)
    rec = run_check(paths, gh)
    assert rec["error"] is None and rec["tag"] == "v0.3.0"
    assert [(r.url.host, r.url.path) for r in gh.seen] == [
        ("api.github.com", "/repos/JongoDB-Labs/bedrock-now/releases"), ("api.github.com", httpx.URL(api_to).path),
        ("raw.githubusercontent.com", "/JongoDB-Labs/bedrock-now/v0.3.0/compose.yaml"),
        ("raw.githubusercontent.com", "/JongoDB-Labs/devos-ade/v0.3.0/compose.yaml")]
    assert all(r.url.scheme == "https" for r in gh.seen)
    st = updates.status(paths, True)
    # the release page under the new name is kept (not replaced by the generic link)
    assert st["url"] == "https://github.com/JongoDB-Labs/devos-ade/releases/tag/v0.3.0"
    assert [r["url"] for r in st["releases"]] == ["https://github.com/JongoDB-Labs/devos-ade/releases/tag/v0.3.0"]
    assert st["estimate"]["images"] == ["ghcr.io/berriai/litellm:1.106.0"]


@pytest.mark.parametrize("api_to", [
    "https://evil.example/repositories/1415949652/releases",                   # another host
    "http://api.github.com/repositories/1415949652/releases",                  # not https
    "https://api.github.com:8443/repositories/1415949652/releases",            # another port
    "https://someone@api.github.com/repositories/1415949652/releases",         # credentials in it
    "https://api.github.com/repos/someone/fork/releases",                  # another repository
    "https://api.github.com/repos/JongoDB-Labs/bedrock-now-x/releases",    # ... a longer name
    "https://api.github.com/repositories/1415949652/tags",                     # another resource
    "https://api.github.com/repositories/1415949652/releases/../../user",      # ... by dot segments
    "https://api.github.com/repositories/12ab/releases",                   # not a repository id
    "https://api.github.com/repositories/123456/releases",                 # another repository's id
    "https://api.github.com/repositories/14159496520/releases",            # ... ours with a digit more
    "https://api.github.com/repositories/1415949652/Releases",             # the rest of the path: exact
    "https://api.github.com/repos/JongoDB-Labs/devos-ade/Releases",        # ... also under the new name
    "https://api.github.com/repos/JongoDB-Labs/bedroc%E2%84%AA-now/releases",  # the Kelvin sign (lower() is "k")
    "https://raw.githubusercontent.com/JongoDB-Labs/devos-ade/releases",   # the raw host from the API
    "javascript:alert(1)",
    "",                                                                    # an empty Location
    None,                                                                  # none at all
])
def test_any_other_redirect_is_refused_and_not_asked(paths, api_to):
    write_version(paths)
    gh = Renamed(api_to=api_to)
    rec = run_check(paths, gh)
    # (a malformed Location: some httpx versions refuse the answer themselves)
    assert "HTTP 301" in rec["error"] or (api_to == "javascript:alert(1)" and "did not answer (InvalidURL)" in rec["error"])
    assert rec.get("tag") is None
    assert len(gh.seen) == 1  # the place it pointed to was never asked


def test_a_second_redirect_is_not_followed(paths):
    write_version(paths)
    gh = Renamed(api_to="https://api.github.com/repos/JongoDB-Labs/devos-ade/releases?per_page=30",
                 new_redirects_to="https://api.github.com/repositories/1415949652/releases?per_page=30")
    rec = run_check(paths, gh)
    assert "HTTP 301" in rec["error"]
    assert [r.url.path for r in gh.seen] == ["/repos/JongoDB-Labs/bedrock-now/releases", "/repos/JongoDB-Labs/devos-ade/releases"]


def test_a_refused_raw_redirect_only_loses_the_estimate(paths):
    write_version(paths)
    gh = Renamed(raw_to="https://raw.githubusercontent.com/someone/fork/v0.3.0/compose.yaml")
    rec = run_check(paths, gh)
    assert rec["tag"] == "v0.3.0"
    assert len(gh.seen) == 3  # the fork's compose file was never asked for


def test_release_pages_of_either_name_are_the_projects():
    for url in ("https://github.com/JongoDB-Labs/bedrock-now/releases/tag/v1.0.0",
                "https://github.com/JongoDB-Labs/devos-ade/releases/tag/v1.0.0",
                "https://github.com/jongodb-labs/DEVOS-ADE/releases/tag/v1.0.0",   # owner and name in any case
                "https://github.com/JongoDB-Labs/devos-ade/releases/tag/v1.0.0?x=/../y",  # (a query is not a path)
                "https://github.com/JongoDB-Labs/devos-ade/blob/main/a.b/..c/x..md"):
        assert updates.repo_page(url), url
    for url in ("https://github.com/JongoDB-Labs/devos-ade-x/releases", "https://github.com/someone/devos-ade/releases",
                "http://github.com/JongoDB-Labs/devos-ade/releases", "https://github.com/JongoDB-Labs/devos-ade",
                "https://GitHub.com/JongoDB-Labs/devos-ade/releases",                # the rest: exact
                "https://github.com/JongoDB-Labs/bedroc" + chr(0x212A) + "-now/releases",  # Kelvin sign: lower() is "k"
                "https://github.com/JongoDB-Labs/devos-ade/../../someone/x/releases",  # out of the repository
                "https://github.com/JongoDB-Labs/devos-ade/releases/../../../x",
                "https://github.com/JongoDB-Labs/devos-ade/./releases",
                "https://github.com/JongoDB-Labs/devos-ade/releases/..",
                "https://github.com/JongoDB-Labs/devos-ade/%2e%2e/%2E%2E/someone/x",   # ... percent-encoded
                "https://github.com/JongoDB-Labs/devos-ade/.%2e/x",
                "https://github.com/JongoDB-Labs/devos-ade/..\\..\\someone",           # a browser reads a backslash as /
                None, 3):
        assert not updates.repo_page(url), url


def test_a_release_link_out_of_the_repository_is_replaced(paths):
    write_version(paths)
    run_check(paths, GitHub(rel=release(html_url="https://github.com/JongoDB-Labs/devos-ade/../../evil/x/releases")))
    assert updates.status(paths, True)["url"] == "https://github.com/JongoDB-Labs/bedrock-now/releases"


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

    async def fake_loop(paths, transport=None, refresher=None):
        assert isinstance(refresher, updates.Refresher)   # the portal's one check at a time
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


# --- Check for updates: a click (POST /api/update/check; static/updatecheck.js) ---

XRW = {"X-Requested-With": "bedrock-now"}
ORIGIN = {"Origin": "http://bedrock-now.localhost"}
PREVIEW = "bedrock-now-preview.localhost"


class Slow:
    """A GitHub that holds its answer until release() (a check that is still running), in the portal's event loop."""

    def __init__(self, gh):
        import threading
        self.gh, self.go = gh, threading.Event()

    def release(self):
        self.go.set()

    async def __call__(self, request):
        if request.url.host == "api.github.com":
            for _ in range(500):
                if self.go.is_set():
                    break
                await asyncio.sleep(0.01)
        return self.gh(request)


def portal(settings, paths, gh, check=True, **kw):
    s = replace(settings, update_check=check, update_dir=paths.update_dir, status_dir=paths.status_dir, **kw)
    return TestClient(create_app(s, transport=httpx.MockTransport(github_or_503(gh))),
                      base_url="http://bedrock-now.localhost", follow_redirects=False)


def sign_in(c):
    assert c.post("/login", data={"password": "correct horse"}, headers=ORIGIN).status_code == 303


def asked(gh):
    return len([q for q in gh.seen if q.url.host == "api.github.com"])


def wait_done(c):
    import time
    for _ in range(100):
        u = c.get("/api/summary", headers=XRW).json()["update"]
        if not u["checking"]:
            return u
        time.sleep(0.05)
    raise AssertionError("the check never ended")


def test_check_for_updates_asks_github_now_and_answers_the_result(settings, paths):
    write_version(paths, "v0.4.1")
    run_check(paths, GitHub(rels=releases(order=("v0.4.1",))))   # just checked: up to date (Home would not ask again)
    gh = GitHub(rels=releases(), etag=None)
    with portal(settings, paths, gh) as c:
        sign_in(c)
        assert c.get("/api/summary", headers=XRW).json()["update"]["available"] is False and asked(gh) == 0
        r = c.post("/api/update/check", headers={**XRW, **ORIGIN})
        assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
        d = r.json()
        assert d["started"] is True and d["checking"] is False   # the answer, within MANUAL_WAIT_S
        u = d["update"]
        assert u["available"] is True and u["latest"] == "v0.9.0" and u["behind"] == 5 and u["by"] == "manual"
        assert u["error"] is None and u["limited"] is False and u["retry_at"] is None
        assert c.get("/api/summary", headers=XRW).json()["update"]["latest"] == "v0.9.0"
    assert asked(gh) == 1
    # nothing about this install is sent: no cookie, no version, no token
    q = next(q for q in gh.seen if q.url.host == "api.github.com")
    assert "cookie" not in q.headers and "authorization" not in q.headers and "v0.4.1" not in str(q.url)


@pytest.mark.parametrize("headers,status", [
    ({}, 400),                                                        # no X-Requested-With
    ({**XRW}, 403),                                                   # no Origin, no Referer
    ({**XRW, "Origin": "http://evil.example"}, 403),                  # another site
    ({**XRW, "Origin": "http://chat.bedrock-now.localhost"}, 403),    # another host of the site (an app's script)
    ({**XRW, "Origin": f"http://p3000-abc123.{PREVIEW}"}, 403),       # a preview of the sandbox (Caddy refuses it first)
    ({**XRW, "Origin": "null"}, 403),                                 # an opaque origin (a sandboxed frame)
    ({**XRW, "Referer": "http://evil.example/http://bedrock-now.localhost/"}, 403),
])
def test_check_for_updates_needs_the_portals_own_page(settings, paths, headers, status):
    write_version(paths, "v0.4.1")
    run_check(paths, GitHub())   # (checked just now: the daily loop does not ask at start)
    before = paths.json.read_bytes()
    gh = GitHub(rels=releases(), etag=None)
    with portal(settings, paths, gh, preview_domain=PREVIEW) as c:
        assert c.post("/api/update/check", headers={**XRW, **ORIGIN}).status_code == 401   # signed out
        sign_in(c)
        r = c.post("/api/update/check", headers=headers)
        assert r.status_code == status, r.text
        assert c.get("/api/update/check", headers={**XRW, **ORIGIN}).status_code == 405   # a POST only
    assert gh.seen == [] and paths.json.read_bytes() == before   # nobody asked GitHub


def test_a_click_while_a_check_runs_gets_that_ones_answer_not_a_second_request(settings, paths, monkeypatch):
    monkeypatch.setattr(updates, "MANUAL_WAIT_S", 0.05)
    write_version(paths, "v0.4.1")
    run_check(paths, GitHub(rels=releases(order=("v0.4.1",))))
    slow = Slow(GitHub(rels=releases(), etag=None))
    with portal(settings, paths, slow) as c:
        sign_in(c)
        first = c.post("/api/update/check", headers={**XRW, **ORIGIN}).json()
        assert first["started"] is True and first["checking"] is True and first["update"]["checking"] is True
        again = c.post("/api/update/check", headers={**XRW, **ORIGIN})
        assert again.status_code == 200 and again.json()["started"] is False and again.json()["checking"] is True
        _age(paths, 5)   # Home opens: a check is due, but one runs already
        assert c.get("/api/summary", headers=XRW).json()["update"]["checking"] is True
        slow.release()
        u = wait_done(c)
    assert u["latest"] == "v0.9.0" and u["by"] == "manual"
    assert asked(slow.gh) == 1


def test_clicks_are_at_most_every_30_s_and_20_an_hour(settings, paths):
    write_version(paths, "v0.4.1")
    gh = GitHub(rels=releases())   # (the ETag: the second check is a 304)
    clock = [5000.0]
    r = updates.Refresher(paths, httpx.MockTransport(gh), clock=lambda: clock[0], auto=False)

    async def go():
        assert r.manual() == {"started": True, "reason": "", "wait": 0}
        assert r.manual()["reason"] == "checking"
        await r.task
        clock[0] += 10
        assert r.manual() == {"started": False, "reason": "again", "wait": updates.MANUAL_MIN_S - 10}
        clock[0] += updates.MANUAL_MIN_S
        assert r.manual()["started"] is True
        await r.task
        for _ in range(updates.MANUAL_PER_HOUR - 2):
            clock[0] += updates.MANUAL_MIN_S
            assert r.manual()["started"] is True
            await r.task
        clock[0] += updates.MANUAL_MIN_S
        got = r.manual()   # the 21st within the hour: a reason of its own (the page says it in minutes)
        assert got["reason"] == "hourly" and 0 < got["wait"] <= 3600 - updates.MANUAL_MIN_S * (updates.MANUAL_PER_HOUR - 1)
        clock[0] += got["wait"]
        assert r.manual()["started"] is True
        await r.task
    asyncio.run(go())
    assert asked(gh) == updates.MANUAL_PER_HOUR + 1
    assert gh.seen[-1].headers.get("if-none-match") == 'W/"abc"'   # a 304 when nothing changed
    # through the portal: a second click at once is told when, and nothing is asked
    gh2 = GitHub(rels=releases(), etag=None)
    with portal(settings, paths, gh2) as c:
        sign_in(c)
        assert c.post("/api/update/check", headers={**XRW, **ORIGIN}).status_code == 200
        r2 = c.post("/api/update/check", headers={**XRW, **ORIGIN})
        d = r2.json()
        assert r2.status_code == 429 and d["reason"] == "again" and 0 < d["retry_after"] <= updates.MANUAL_MIN_S
        assert r2.headers["retry-after"] == str(d["retry_after"]) and d["update"]["latest"] == "v0.9.0"
        assert "try again in" in d["error"] and d["retry_at"].endswith("+00:00")
    assert asked(gh2) == 1


def test_the_hourly_cap_on_clicks_is_said_in_minutes(settings, paths, monkeypatch):
    monkeypatch.setattr(updates, "MANUAL_MIN_S", 0)
    monkeypatch.setattr(updates, "MANUAL_PER_HOUR", 2)
    write_version(paths, "v0.4.1")
    run_check(paths, GitHub(rels=releases(order=("v0.4.1",))))
    gh = GitHub(rels=releases())
    with portal(settings, paths, gh) as c:
        sign_in(c)
        for _ in range(2):
            assert c.post("/api/update/check", headers={**XRW, **ORIGIN}).status_code == 200
        r = c.post("/api/update/check", headers={**XRW, **ORIGIN})
        d = r.json()
        assert r.status_code == 429 and d["reason"] == "hourly" and 3500 < d["retry_after"] <= 3600
        assert d["error"] == "2 checks in the last hour: try again in 60 min."
    assert asked(gh) == 2


def test_githubs_rate_limit_says_when_to_try_again_and_nothing_is_asked_before(settings, paths, monkeypatch):
    import time
    monkeypatch.setattr(updates, "MANUAL_MIN_S", 0)   # (the floor between clicks is the test above)
    write_version(paths, "v0.4.1")
    run_check(paths, GitHub(rels=releases(order=("v0.4.1",))))
    reset = int(time.time()) + 14 * 60

    class Limited(GitHub):
        def __call__(self, request):
            self.seen.append(request)
            return httpx.Response(403, json={"message": "API rate limit exceeded"},
                                  headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(reset)})
    gh = Limited()
    with portal(settings, paths, gh) as c:
        sign_in(c)
        u = c.post("/api/update/check", headers={**XRW, **ORIGIN}).json()["update"]
        assert u["limited"] is True and "HTTP 403" in u["error"] and u["latest"] == "v0.4.1"   # the last answer stays
        assert abs(updates._epoch(u["retry_at"]) - reset) <= 2
        r = c.post("/api/update/check", headers={**XRW, **ORIGIN})
        d = r.json()
        assert r.status_code == 429 and d["reason"] == "limit" and abs(d["retry_after"] - 14 * 60) <= 2
        assert int(r.headers["retry-after"]) == d["retry_after"] and "limit" in d["error"]
    assert asked(gh) == 1
    # nor does Home, though its last check is old: GitHub said when
    _age(paths, 4)
    home = updates.Refresher(paths, httpx.MockTransport(gh), wall=lambda: reset - 60)
    assert home.due() is False and home.manual_wait()[0] == "limit"
    assert updates.Refresher(paths, httpx.MockTransport(gh), wall=lambda: reset + 1).due() is True


@pytest.mark.parametrize("status,headers,limited,wait", [
    (429, {"retry-after": "90"}, True, 90),                                   # a secondary limit: Retry-After
    (403, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "SOON"}, True, 60),   # the hourly limit: its reset
    (403, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "FAR"}, True, updates.RETRY_AFTER_ERROR),   # never past 1 h
    (403, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "999999999999"}, True, updates.RETRY_AFTER_ERROR),  # year 33658
    (403, {"x-ratelimit-remaining": "0"}, True, updates.RETRY_AFTER_ERROR),  # no reset: RETRY_AFTER_ERROR
    (403, {"retry-after": "99999999"}, True, updates.RETRY_AFTER_ERROR),
    (403, {}, False, updates.RETRY_AFTER_ERROR),                           # not the limit: GitHub refused the request
    (429, {}, False, updates.RETRY_AFTER_ERROR),
    (403, {"retry-after": "\u0661\u0662".encode()}, False, updates.RETRY_AFTER_ERROR),   # (ASCII digits only)
    (403, {"x-ratelimit-remaining": "3", "x-ratelimit-reset": "SOON"}, False, updates.RETRY_AFTER_ERROR),  # requests left
])
def test_githubs_refusals_say_when_to_ask_again_never_past_an_hour(paths, status, headers, limited, wait):
    import time
    now = time.time()
    headers = {k: (str(int(now) + 9 * 3600) if v == "FAR" else str(int(now) + 60) if v == "SOON" else v) for k, v in headers.items()}

    def refuse(request):
        return httpx.Response(status, headers=headers)
    rec = run_check(paths, refuse)   # (never raises, and saves: a reset past year 9999 has no time, not a crash)
    assert json.loads(paths.json.read_text())["error"] == rec["error"] and f"HTTP {status}" in rec["error"]
    assert rec["refused"] is True and rec["limited"] is limited
    assert ("limit of requests" in rec["error"]) is limited and ("refused the request" in rec["error"]) is (not limited)
    assert abs(updates.retry_wait(rec, now) - wait) <= 2
    assert updates.retry_wait(rec, now + wait + 1) == 0
    st = updates.status(paths, True)
    assert st["limited"] is limited and st["refused"] is (not limited) and st["retry_at"]
    r = updates.Refresher(paths, httpx.MockTransport(GitHub()), wall=lambda: now)
    assert r.manual_wait()[0] == ("limit" if limited else "refused") and r.due() is False
    # a check that is not refused: no wait, whatever came before
    ok = run_check(paths, GitHub())
    assert ok["limited"] is False and ok["refused"] is False and ok["retry_at"] is None and updates.retry_wait(ok) == 0
    # another failure (GitHub unreachable) is no reason to wait: a click may try again
    assert updates.retry_wait(run_check(paths, GitHub(status=500))) == 0


def test_a_clock_set_back_never_stretches_the_wait_past_an_hour(paths):
    import time
    from datetime import datetime, timedelta, timezone
    later = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(timespec="seconds")
    rec = {"error": "x (HTTP 403)", "error_at": later, "checked_at": later, "refused": True, "limited": False, "retry_at": None}
    assert updates.retry_wait(rec, time.time()) == updates.RETRY_AFTER_ERROR   # (87000 s without the cap)
    rec.update(limited=True, retry_at=(datetime.now(timezone.utc) + timedelta(days=2)).isoformat(timespec="seconds"))
    assert updates.retry_wait(rec, time.time()) == updates.RETRY_AFTER_ERROR


def test_another_refusal_is_said_as_such_and_a_click_waits_for_it(settings, paths):
    import time
    write_version(paths, "v0.4.1")
    run_check(paths, GitHub(rels=releases(order=("v0.4.1",))))

    class Refuses(GitHub):
        def __call__(self, request):
            self.seen.append(request)
            return httpx.Response(403, json={"message": "Forbidden"})
    gh = Refuses()
    with portal(settings, paths, gh) as c:
        sign_in(c)
        u = c.post("/api/update/check", headers={**XRW, **ORIGIN}).json()["update"]
        assert u["refused"] is True and u["limited"] is False and "refused the request (HTTP 403)" in u["error"]
        assert abs(updates._epoch(u["retry_at"]) - (time.time() + updates.RETRY_AFTER_ERROR)) <= 5
    assert asked(gh) == 1
    # after the floor between clicks: the portal says why, and asks nothing
    clock = [10_000.0]
    r = updates.Refresher(paths, httpx.MockTransport(gh), clock=lambda: clock[0])
    assert r.manual()["reason"] == "refused" and asked(gh) == 1


def test_with_the_daily_check_off_a_click_still_checks_and_the_rest_stays_off(settings, paths, monkeypatch):
    started = []

    async def fake_loop(*a, **kw):
        started.append(1)
    monkeypatch.setattr(updates, "daily_loop", fake_loop)
    write_version(paths, "v0.4.1")
    run_check(paths, GitHub(rels=releases(order=("v0.6.0", "v0.4.1"))))   # an answer from before it was turned off
    _age(paths, 30)
    gh = GitHub(rels=releases(), etag=None)
    with portal(settings, paths, gh, check=False) as c:
        sign_in(c)
        u = c.get("/api/summary", headers=XRW).json()["update"]
        assert u["enabled"] is False and u["latest"] is None and u["checking"] is False   # the old answer is not shown
        assert asked(gh) == 0                                                              # nor does Home ask
        d = c.post("/api/update/check", headers={**XRW, **ORIGIN}).json()
        assert d["started"] is True and d["update"]["enabled"] is False
        assert d["update"]["latest"] == "v0.9.0" and d["update"]["available"] is True and d["update"]["by"] == "manual"
        _age(paths, 5)
        u = c.get("/api/summary", headers=XRW).json()["update"]
        assert u["latest"] == "v0.9.0" and u["checking"] is False   # the click's answer shows; Home asks nothing
    assert asked(gh) == 1 and started == []   # no daily loop
    # latest.txt says it too, and ./stack ignores it while UPDATE_CHECK=false (lib/version.sh latest_release_seen)
    assert paths.txt.read_text().startswith("latest=v0.9.0\n")


def test_the_daily_check_waits_for_a_running_one_instead_of_asking_again(paths):
    write_version(paths, "v0.4.1")
    gh = GitHub(rels=releases(), etag=None)
    slow = Slow(gh)

    async def go():
        r = updates.Refresher(paths, httpx.MockTransport(slow), auto=True)
        assert r.manual()["started"] is True
        loop = asyncio.create_task(updates.daily_loop(paths, None, refresher=r))   # no answer yet: it wants one
        await asyncio.sleep(0.05)
        slow.release()
        await r.task
        await asyncio.sleep(0.05)
        loop.cancel()
        with pytest.raises(asyncio.CancelledError):
            await loop
    asyncio.run(go())
    assert asked(gh) == 1 and json.loads(paths.json.read_text())["by"] == "manual"


def test_check_for_updates_works_over_remote_access(settings, paths):
    from portal.security import REMOTE_COOKIE
    tn, proxy = "tail1234.ts.net", "p" * 64
    host, origin = f"bn.{tn}", f"https://bn.{tn}"
    remote = {"X-Portal-Remote": "1", "X-Portal-Proxy": proxy, "Tailscale-User-Login": "me@example.com"}
    write_version(paths, "v0.4.1")
    run_check(paths, GitHub(rels=releases(order=("v0.4.1",))))
    gh = GitHub(rels=releases(), etag=None)
    s = replace(settings, update_check=True, update_dir=paths.update_dir, status_dir=paths.status_dir,
                state_dir=settings.litellm_dir.parent, remote_mode="tailscale", remote_host=host,
                remote_app_hosts={"chat": f"bn-chat.{tn}", "admin": f"bn-admin.{tn}", "files": f"bn-files.{tn}"},
                tailscale_allowed_login="me@example.com", proxy_secret=proxy)
    with TestClient(create_app(s, transport=httpx.MockTransport(github_or_503(gh))), base_url=origin, follow_redirects=False) as c:
        assert c.post("/login", data={"password": "correct horse"}, headers={"Origin": origin, **remote}).status_code == 303
        assert c.cookies.get(REMOTE_COOKIE)
        assert c.post("/api/update/check", headers={**XRW, **remote, "Origin": "https://evil.example"}).status_code == 403
        assert c.post("/api/update/check", headers={**XRW, **remote, "Origin": f"https://bn-chat.{tn}"}).status_code == 403
        r = c.post("/api/update/check", headers={**XRW, **remote, "Origin": origin})
        assert r.status_code == 200 and r.json()["update"]["latest"] == "v0.9.0"   # reading releases is harmless
    assert asked(gh) == 1


def test_the_page_offers_check_for_updates_on_home_settings_and_search():
    from pathlib import Path
    static = Path(__file__).parent.parent / "portal" / "static"
    html = (static / "index.html").read_text()
    js = (static / "updatecheck.js").read_text()
    # Home's header: the line, its result announced
    assert 'id="release-line"' in html and 'src="/static/updatecheck.js"' in html
    assert html.index('src="/static/app.js"') < html.index('src="/static/updatecheck.js"') < html.index('src="/static/search.js"')
    assert '"aria-live": "polite"' in js and "Check for updates" in js
    assert 'fetch("/api/update/check"' in js and 'method: "POST"' in js and '"X-Requested-With": "bedrock-now"' in js
    for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"):
        assert sink not in js, sink
    # it sends nothing about this install: GitHub's public release list, the tooltip says so
    assert "sends nothing about this install" in js
    # Settings › Updates & backups › Daily release check, and Ctrl/⌘+K
    assert 'k.key === "UPDATE_CHECK"' in (static / "settings.js").read_text()
    assert "Check for updates" in (static / "search.js").read_text()
    assert "Check for updates" in (static / "tour.js").read_text()
    assert "bnUpdateCheck" in (static / "app.js").read_text()
