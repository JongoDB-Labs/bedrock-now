"""The walkthrough (static/tour.js, tour.css): linked from Home, served safely, built without HTML parsing, every step
there."""

import os
import re
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from portal.app import STATIC, create_app

STEP_IDS = ("welcome", "aws", "openrouter", "voice", "claude-setup", "git-hosts", "budgets", "extras",
            "signin-portal", "signin-chat", "signin-admin", "signin-files",
            "chat", "voice-use", "docs",
            "code-off", "code-open", "code-modes", "code-models", "code-workspace", "code-context", "code-clone", "code-review",
            "code-run", "terminal", "sandbox", "code-plugins",
            "claude", "api", "shared",
            "home", "activity", "admin", "updates", "phone", "done")
SECTION_TITLES = ("Set up", "Your apps (one sign-in)", "Chat", "Code with Claude", "Your own tools", "Keep it running")


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
    assert tuple(re.findall(r'\{ title: "([^"]+)", steps: \[', js)) == SECTION_TITLES
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
                  'doc("a-lean-config-folder-for-bedrock"'):
        assert words in setup, words
    assert "resume: claude-bedrock --resume <id>" in js[js.index("    claude: {"):]


def test_claude_steps_point_at_the_code_tab_or_at_settings():
    # On (and usable here): both Claude Code steps open the Code tab, and spend on its key (the terminal's) counts.
    # Off: the Code tab still (its page says what it is and how to turn it on), Settings › Claude Code or ./stack code
    # enable. On but not over remote access: the switch that would allow it.
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    assert "document.querySelector('meta[name=\"bn-code\"]')" in js and "c.here === true && Boolean(APP_URLS.code)" in js
    setup = js[js.index('"claude-setup": {'):js.index("budgets: {")]
    use = js[js.index("    claude: {"):js.index("    shared: {")]
    for block in (setup, use):
        assert "codeLine(" in block and "actions: () => [openCode()]," in block
    line = js[js.index("function codeLine(use)"):js.index("// Chat, Admin and Files sign you in")]
    assert 'b("Code"), " tab' in line and 'settings("Claude Code", "CODE_ENABLED")' in line and 'code("./stack code enable")' in line
    assert 'code("REMOTE_TERMINAL=true")' in line and "off for now" in line
    opener = js[js.index("function openCode()"):js.index("function codeLine(use)")]
    assert 'showTab("code")' in opener and 'appUrl("code")' in opener and 'rel: "noopener"' in opener
    # while off here: its tab's page (a page of the portal, on a phone too), never the code host
    off = opener[opener.index("if (!CODE.here)"):opener.index("if (PHONE.matches)")]
    assert 'button("About the Code tab", "open-code", () => { showTab("code"); away(); })' in off and "appUrl" not in off
    # each step its own spend baseline (spendState / withBaseline, tour.test.mjs): the Claude Code step watches
    # claude-bedrock's key only — the Code tab's spend is Open Code and ask's
    assert 'spendKey: "claude-code",' in use and "spendAlso" not in js
    assert 'spendKey: "claude-code-terminal"' in _step(js, "code-open")


def test_home_card_points_at_the_code_tab_and_settings_while_the_code_page_is_off():
    js = (STATIC / "code.js").read_text(encoding="utf-8")
    off = js[js.index("    } else {\n      line ="):]
    assert 'settingsLink("Settings › Claude Code")' in off and 'code("./stack code enable")' in off
    assert '"Or in the browser with a chat: the ", tab, ", off for now. "' in off
    # the Code page's switch by its address (settings.js opens its section and lights it up)
    assert 'const SWITCH = "#settings/CODE_ENABLED";' in js and "const settingsLink = (text) => el(\"a\", { href: SWITCH, text });" in js
    go = js[js.index("function toSettings()"):js.index("const settingsLink")]
    assert "location.hash = SWITCH" in go and "showTab(SWITCH.slice(1))" in go


def _step(js: str, sid: str) -> str:
    """The source of step SID's definition (up to the next step's)."""
    m = re.search(rf'^    "?{re.escape(sid)}"?: \{{\n', js, re.M)
    assert m, sid
    nxt = re.search(r'^    "?[a-z][a-z-]*"?: \{\n', js[m.end():], re.M)
    return js[m.start():m.end() + (nxt.start() if nxt else len(js))]


def test_terminal_and_code_steps_only_where_offered():
    # The browser terminal and the Code page get steps of their own, shown only on a site that offers them; where the
    # Code page is off here, one step says what it is and how to turn it on (or, over remote access, how to allow it).
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    assert "when: () => TERM.here" in _step(js, "terminal") and "openTerminal()" in _step(js, "terminal")
    for sid in ("git-hosts", "code-open", "code-modes", "code-models", "code-workspace", "code-context", "code-clone", "code-review",
                "code-run", "code-plugins"):
        assert "when: () => CODE.here" in _step(js, sid), sid
    assert "when: () => !CODE.here" in _step(js, "code-off") and "openCode()" in _step(js, "code-off")
    off = _step(js, "code-off")
    for words in ('settings("Claude Code", "CODE_ENABLED")', 'cmd("./stack code enable")', 'code("REMOTE_TERMINAL=true")'):
        assert words in off, words
    assert "when: () => CODE.here || TERM.here" in _step(js, "sandbox")
    assert "sec.steps = sec.steps.filter((id) => !STEPS[id].when || STEPS[id].when())" in js
    assert "document.querySelector('meta[name=\"bn-terminal\"]')" in js and "t.here === true && Boolean(APP_URLS.terminal)" in js


def test_the_code_steps_name_what_a_developer_uses():
    # every feature of the Code page a developer needs, by its exact words in the page (README › The Code page)
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    want = {
        "code-open": ("Open Code", "unlock it with the portal password", "New session", "Needs you", "Working", "Done", "claude-code-terminal"),
        "code-modes": ("Read only", "Plan", "Manual", "Accept edits", "Shift+Tab", "Alt+M", "Allow once", "Always", "Deny", "Permissions",
                       "Auto", "Bypass permissions", '"CODE_AUTO_MODE"'),
        "code-models": ("works", "chat only", "not tested", "Models for Claude Code", "Default model for new sessions",
                        "claude-bedrock --models", "claude-bedrock --model mistral-large-3", "Budget for this session"),
        "code-workspace": ("cfg.workspace", '"./stack code status"', "Ctrl/⌘+P", "Ctrl/⌘+Shift+F", "Ctrl/⌘+K", "Preview", "Mermaid",
                           "Memory (CLAUDE.md)", "./stack code enable --workspace DIR"),
        "code-context": ('code("@file#L5-10")', "Alt+K", '"@terminal"', '"@diff"', '"@problems"', "Comment on lines", "Keep planning"),
        "code-clone": ("Git: clone a repository…", "Ctrl/⌘+K", "Ctrl/⌘+Shift+G", "while the workspace is not a repository yet",
                       'openGit("clone")', "Submodules are not cloned"),
        "code-review": ("Review", "Ctrl/⌘+Shift+D", "Keep", "Undo", "Stage", "Commit", "Write message", "no git hooks", "Fetch", "Pull",
                        "Push", "Publish branch", "Open a pull request"),
        "code-run": ("Run & test", "Alt+R", "package.json", "Makefile", "pyproject.toml", "Problems", "Ask Claude", "Ports & previews",
                     "Alt+P", "Preview :5173", ".claude/launch.json", "Start"),
        "sandbox": ("Internet only", "+ this computer", "Off", "TERMINAL_EGRESS_ALLOW", "TERMINAL_EGRESS_DENY", "./stack logs terminal-egress",
                    '"TERMINAL_EGRESS"', "cfg.egress"),
        "code-plugins": ("Plugins & marketplaces", "MCP servers", "Run this command and install", "SHA-256", "bedrock-shared"),
    }
    for sid, words in want.items():
        block = _step(js, sid)
        for w in words:
            assert w in block, (sid, w)


def test_git_host_step_opens_the_code_pages_git_hosts():
    # "Open Git hosts" as Settings › Claude Code › Git hosts does it: the Code tab (code.js) at ?git=hosts, else the Code
    # page's address in a new tab; a token, a key or a host is never entered in the walkthrough itself
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    step = _step(js, "git-hosts")
    for words in ("Connect a git host…", "access token", "Contents: Read and write", '"read_repository"', '"write_repository"', "SSH key",
                  "Allow write access", "Test connection", "Let Claude use this host", "off by default",
                  "only from the computer running bedrock-now", 'openGit("hosts")', "window.bnCode.gitHosts()"):
        assert words in step, words
    opener = js[js.index("function openGit(what)"):js.index("// The Terminal tab")]
    assert "c.openGitHosts()" in opener and "c.openClone()" in opener
    assert 'u.searchParams.set("git", what)' in opener and 'window.open(u.href, "_blank", "noopener")' in opener
    assert "<input" not in js and 'el("input"' not in js and 'type: "password"' not in js
    code = (STATIC / "code.js").read_text(encoding="utf-8")
    assert 'openGitHosts: () => openGit("hosts")' in code and 'openClone: () => openGit("clone")' in code
    # a running Code tab is asked in place (no reload: unsaved edits stay), to the code host's origin only; else ?git=
    og = code[code.index("function openGit(dialog)"):code.index("// The badge needs the page running")]
    assert 'f.contentWindow.postMessage({ type: "bn-portal-git", dialog }, origin)' in og and "window.bnCode.ready()" in og
    assert "openLink({ git: dialog })" in og
    # the Code tab's count of hosts: a number only, through the bridge's own origin and frame checks
    assert "hosts: Number.isInteger(e.data.hosts) && e.data.hosts >= 0 ? Math.min(e.data.hosts, 99) : null" in code
    listener = code[code.index('window.addEventListener("message"'):code.index("const hooked = new WeakSet()")]
    assert "e.origin !== codeOrigin" in listener and "e.source !== f.contentWindow" in listener and "e.data.hosts" in listener
    assert "gitHosts: () => (reported && Number.isInteger(reported.hosts) ? reported.hosts : null)" in code


def test_the_api_step_shows_the_port_and_placeholders_never_a_key():
    # the LiteLLM API's address from the masked settings snapshot (LITELLM_PORT), never a hard-coded port; YOUR_KEY in
    # the snippets; no key, no master key, no .env value of any secret
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    step = _step(js, "api")
    assert "cfg: true" in step and "http://127.0.0.1:${cfg.port}" in step and "4000" not in js
    for words in ("/v1", "/chat/completions", "/models", "/v1/messages", "Virtual Keys", "+ Create New Key", "Optional Settings",
                  "./stack models", "YOUR_KEY", "listens on ", "tools on other devices cannot reach it",
                  "Over remote access LiteLLM is the ", "not an endpoint for tools", 'doc("the-models-from-your-own-code"'):
        assert words in step, words
    assert "logins" not in step and "MASTER" not in js and "LITELLM_KEY" not in js and "/api/logins" not in js
    assert 'api("/api/settings")' in js and "cfg = cfgFrom(d)" in js
    readme = Path(os.environ.get("BN_REPO_DIR") or Path(__file__).resolve().parents[2]) / "README.md"
    if readme.is_file():   # (in the image's test stage only when portal/test.sh passes the repository in)
        text = readme.read_text(encoding="utf-8")
        assert "### The models from your own code" in text and "#the-models-from-your-own-code" in text


def test_new_steps_are_marked_for_a_browser_that_did_an_older_walkthrough():
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    # (what is seen and what is New, the saved state's migration: parse / resolve, tour.test.mjs)
    assert "let st = resolve(load(), ORDER);" in js
    # the button and More say how many; a step opened is seen; nothing opens the walkthrough for an upgrader
    assert '$("#tour-count").textContent = fresh ? `${fresh} new`' in js
    assert 'opener.classList.toggle("has-new", fresh > 0)' in js
    assert "if (st.cur && isNew(st.cur)) { st.seen.push(st.cur); save(); }" in js
    assert "const first = st.open === null;" in js and "if (first || PHONE.matches) st.open = !PHONE.matches && first;" in js
    assert "seen" in js[js.index("function save()"):js.index("let st = resolve(load(), ORDER);")]
    css = (STATIC / "tour.css").read_text(encoding="utf-8")
    assert ".tour-new {" in css and ".tour-btn.has-new" in css


def test_its_links_into_the_readme_reach_a_heading():
    # doc("anchor", …) links the README on GitHub at that heading: each one must be a heading of README.md
    readme = Path(os.environ.get("BN_REPO_DIR") or Path(__file__).resolve().parents[2]) / "README.md"
    if not readme.is_file():
        pytest.skip("the repository's README is not here: portal/test.sh passes it to the test image")
    heads = set()
    for line in readme.read_text(encoding="utf-8").splitlines():
        m = re.match(r"#{1,6} (.+)", line)
        if m:   # GitHub's anchors: lower case, punctuation dropped, spaces to hyphens
            heads.add(re.sub(r"[^\w\- ]", "", m.group(1).strip().lower()).replace(" ", "-"))
    js = (STATIC / "tour.js").read_text(encoding="utf-8")
    anchors = re.findall(r'doc\("([a-z0-9-]+)"', js)
    assert len(anchors) >= 10
    assert not [a for a in anchors if a not in heads], [a for a in anchors if a not in heads]
