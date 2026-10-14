"""The walkthrough (static/tour.js, tour.css): linked from Home, served safely, built without HTML parsing, every step
there."""

import re

import httpx
import pytest
from starlette.testclient import TestClient

from portal.app import STATIC, create_app

STEP_IDS = ("welcome", "aws", "openrouter", "voice", "claude-setup", "budgets", "extras",
            "signin-portal", "signin-chat", "signin-admin", "signin-files",
            "home", "chat", "voice-use", "docs", "claude", "shared", "admin", "done")


def offline(request):
    raise httpx.ConnectError("offline in tests")


@pytest.fixture
def client(settings):
    app = create_app(settings, transport=httpx.MockTransport(offline))
    with TestClient(app, base_url=f"http://{settings.origin()[7:]}", follow_redirects=False) as c:
        yield c


def signed_in(client):
    r = client.post("/login", data={"password": "correct horse"}, headers={"Origin": "http://bedrock-now.localhost"})
    assert r.status_code == 303


def test_home_loads_the_walkthrough_after_the_other_scripts(client):
    signed_in(client)
    page = client.get("/").text
    assert '<link rel="stylesheet" href="/static/tour.css">' in page
    assert '<script src="/static/tour.js" defer></script>' in page
    # deferred scripts run in order: tour.js uses app.js's helpers and mobile.js's window.bnMobile
    order = [page.index(f'src="/static/{f}"') for f in ("app.js", "mobile.js", "install.js", "tour.js")]
    assert order == sorted(order)
    assert page.index('href="/static/mobile.css"') < page.index('href="/static/tour.css"')
    # its hooks: the sidebar button (hidden until tour.js runs), the panel, the More sheet's entry
    for hook in ('id="tour-btn"', 'id="tour"', 'id="tour-count"', 'id="more-tour"', 'id="more-tour-note"'):
        assert hook in page, hook
    for tag in page.split("<")[1:]:
        if 'id="tour-btn"' in tag or 'id="tour"' in tag or 'id="more-tour"' in tag:
            assert " hidden" in tag, tag
    assert re.search(r'<aside id="tour" class="tour" aria-labelledby="tour-title"', page)


@pytest.mark.parametrize("path,ctype", [("/static/tour.js", "javascript"), ("/static/tour.css", "text/css")])
def test_walkthrough_files_are_served_with_their_type_and_security_headers(client, path, ctype):
    assert client.get(path).status_code == 200  # the portal serves it; Caddy asks for the session first
    r = client.get(path)
    assert ctype in r.headers["content-type"]
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "script-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-frame-options"] == "DENY"


def test_every_static_file_gets_nosniff(client):
    for f in ("app.js", "app.css", "mobile.js", "login.css", "logo.svg"):
        assert client.get(f"/static/{f}").headers["x-content-type-options"] == "nosniff", f


def test_walkthrough_never_parses_html_or_evaluates_code():
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "DOMParser", "eval(",
                 "new Function", "setTimeout(\"", "setTimeout('"):
        assert sink not in js, sink
    assert '"use strict"' in js
    # passwords only through Copy: the step shows the user name, never the password field as text
    assert "logins[app][field]" in js and ".password" not in js


def test_every_step_is_there_in_order():
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    sections = re.findall(r'steps: \[([^\]]*)\]', js)
    order = [s.strip().strip('"') for sec in sections for s in sec.split(",")]
    assert tuple(order) == STEP_IDS
    for sid in STEP_IDS:   # each one defined
        assert re.search(rf'(^|\s)"?{re.escape(sid)}"?: \{{', js, re.M), sid


def test_progress_is_stored_in_local_storage_defensively():
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    assert 'const KEY = "bn.tour"' in js
    # every storage access is inside try/catch: blocked storage must not break the page
    for m in re.finditer(r"localStorage\.\w+", js):
        before = js[:m.start()]
        assert before.rfind("try {") > before.rfind("}"), m.group(0)


def test_walkthrough_polls_no_faster_than_home():
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    assert "const POLL_MS = 30000" in js
    assert js.count('api("/api/summary")') == 1
