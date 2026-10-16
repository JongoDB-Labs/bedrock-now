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
    # a region (it sits inside the sidebar's Apps navigation), named by its heading
    assert '<div id="tour" class="tour" role="region" aria-labelledby="tour-title" hidden></div>' in page


@pytest.mark.parametrize("path,ctype", [("/static/tour.js", "javascript"), ("/static/tour.css", "text/css")])
def test_walkthrough_files_are_served_with_their_type_and_security_headers(client, path, ctype):
    r = client.get(path)  # the portal serves it; Caddy asks for the session first
    assert r.status_code == 200
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



def test_one_sign_in_wording():
    # Single sign-on: the portal's is the only sign-in; Admin and Files are "Automatic", their own sign-ins folded away
    # under the same heading as on Home, and nothing tells you to sign in to each app or paste a password.
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    assert 'title: "Your apps (one sign-in)"' in js and "Sign in to each app" not in js
    for sid in ("signin-chat", "signin-admin", "signin-files"):
        block = js[js.index(f'"{sid}": {{'):]
        assert 'badges: ["Sign-in: Automatic"]' in block[:200], sid
    assert "Own sign-in" not in js and "Paste them into" not in js and "own sign-in form" not in js
    assert 'text: "Credentials (for the API or if automatic sign-in fails)"' in js
    home = (STATIC / "index.html").read_text(encoding="utf-8")
    assert "<summary>Credentials (for the API or if automatic sign-in fails)</summary>" in home
    assert "sign in, try each app" not in js + home


def test_claude_steps_name_the_lean_config_folder():
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    setup = js[js.index('"claude-setup": {'):js.index("budgets: {")]
    for words in ("~/.claude-bedrock", "CLAUDE_BEDROCK_USE_MY_CONFIG=1", "claude-bedrock plugin install", "claude-bedrock mcp add",
                  "#a-lean-config-folder-for-bedrock"):
        assert words in setup, words
    assert "resume: claude-bedrock --resume <id>" in js[js.index("    claude: {"):]


def test_claude_steps_point_at_the_code_tab_or_at_settings():
    # On (and usable here): both Claude Code steps open the Code tab, and spend on its key (the terminal's) counts.
    # Off: Settings → Code page (or ./stack code enable). On but not over remote access: the switch that would allow it.
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    assert "document.querySelector('meta[name=\"bn-code\"]')" in js and "c.here === true && Boolean(APP_URLS.code)" in js
    setup = js[js.index('"claude-setup": {'):js.index("budgets: {")]
    use = js[js.index("    claude: {"):js.index("    shared: {")]
    for block in (setup, use):
        assert "codeLine(" in block and "actions: () => (CODE.here ? [openCode()] : [])" in block
    line = js[js.index("function codeLine(use)"):js.index("// Chat, Admin and Files sign you in")]
    assert 'b("Code"), " tab' in line and 'settings("Code page")' in line and 'code("./stack code enable")' in line
    assert 'code("REMOTE_TERMINAL=true")' in line
    opener = js[js.index("function openCode()"):js.index("function codeLine(use)")]
    assert 'showTab("code")' in opener and 'appUrl("code")' in opener and 'rel: "noopener"' in opener
    assert 'spendAlso: CODE.here ? "claude-code-terminal" : null' in use
    assert '["open-webui", "claude-code", "claude-code-terminal"]' in js   # its baseline survives a reload too


def test_home_card_points_at_settings_while_the_code_page_is_off():
    js = (STATIC / "code.js").read_text(encoding="utf-8")
    off = js[js.index("    } else {\n      line ="):]
    assert 'el("a", { href: "#settings", text: "Settings → Code page" })' in off and "./stack code enable" in off
