"""The global search: /api/search/index (the Settings page's sections and settings, the docs index built into the image:
portal/searchindex.py), /api/search/chats (Open WebUI's own search, asked as the owner through the trusted header the
Chat tab uses: portal/chatsearch.py), and the page (static/search.js) — text only, the Code tab's frame asked only on
its origin and window."""

import asyncio
import json
import os
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from portal import chatsearch, searchindex
from portal.app import STATIC, create_app

ORIGIN = {"Origin": "http://bedrock-now.localhost"}
API = {"X-Requested-With": "bedrock-now"}
REPO = Path(os.environ.get("BN_REPO_DIR") or Path(__file__).resolve().parents[2])
need_repo = pytest.mark.skipif(not ((REPO / "README.md").is_file() and (REPO / "catalog" / "settings-layout.tsv").is_file()),
                               reason="the repository's README/catalog are not here: portal/test.sh passes them to the test image")
C1, C2 = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"


def offline(request):
    raise httpx.ConnectError("offline in tests")


def client(s, transport=None):
    c = TestClient(create_app(s, transport=transport or httpx.MockTransport(offline)), base_url="http://bedrock-now.localhost",
                   follow_redirects=False)
    c.__enter__()
    c.post("/login", data={"password": "correct horse"}, headers=ORIGIN)
    return c


LAYOUT = """# comment
@spending\tSpending & budgets\tA monthly budget for each LiteLLM key.\tREADME.md#costs--budgets
BUDGET_TERMINAL\tspending\tmain\t-\tMonthly limit for the Terminal tab and the Code page.
LITELLM_KEY_TERMINAL\tspending\twith\tBUDGET_TERMINAL\t-
@updates\tUpdates & backups\tNew releases and backups.\tREADME.md#updating
+backups\tupdates\tmain\t-\tBack up now, and the backups on this computer.
"""
TABLE = "key\tgroup\tsecret\tpolicy\tvalidator\tapply\tlabel\tnote\tcli\n" \
        "BUDGET_TERMINAL\tbudgets\t-\tedit\tbudget\t-\tTerminal budget\tnote\tcli\n" \
        "LITELLM_KEY_TERMINAL\tbudgets\tk\tro\t-\t-\tTerminal key\tnote\tcli\n"


def test_index_settings_sections_and_rows_with_their_labels(settings, tmp_path, monkeypatch):
    (settings.catalog_dir / "settings-layout.tsv").write_text(LAYOUT)
    (settings.catalog_dir / "settings.tsv").write_text(TABLE)
    idx = tmp_path / "docs-index.json"
    idx.write_text(json.dumps({"version": 1, "pages": [{"file": "README.md", "title": "bedrock-now", "sections": [
        {"anchor": "costs--budgets", "title": "Costs & budgets", "level": 2, "parent": "", "text": "Every key has a budget."},
        {"anchor": "bad anchor<", "title": "x"}]}, {"file": "/etc/passwd", "title": "x", "sections": []}]}))
    monkeypatch.setattr(searchindex, "DOCS_INDEX", idx)
    c = client(settings)
    assert c.get("/api/search/index").status_code == 400   # the custom header
    d = c.get("/api/search/index", headers=API).json()
    assert d["settings"]["sections"] == [{"id": "spending", "title": "Spending & budgets", "lede": "A monthly budget for each LiteLLM key."},
                                         {"id": "updates", "title": "Updates & backups", "lede": "New releases and backups."}]
    rows = {r["key"]: r for r in d["settings"]["rows"]}
    assert rows["BUDGET_TERMINAL"] == {"key": "BUDGET_TERMINAL", "section": "spending", "section_title": "Spending & budgets",
                                       "title": "Terminal budget", "summary": "Monthly limit for the Terminal tab and the Code page.", "parent": ""}
    assert rows["LITELLM_KEY_TERMINAL"]["parent"] == "BUDGET_TERMINAL" and rows["+backups"]["title"] == "Backups (Back up now)"
    assert [p["file"] for p in d["docs"]["pages"]] == ["README.md"]
    assert [x["anchor"] for x in d["docs"]["pages"][0]["sections"]] == ["costs--budgets"]
    # never a value of .env: the index has none to give
    assert "value" not in json.dumps(d["settings"])


MD = """# Title of the page

Intro.

## Costs & budgets

Every key has a **monthly** budget; see [Settings](#settings).

```bash
# a comment in a code block is no heading
## nor this
```

### Claude Code: `claude-bedrock`
Runs Claude Code.

## Costs & budgets

Again.

#### Deep *one* <span>with html</span>
- a list item first
## Not#a heading
##No space either
"""


def test_markdown_headings_github_anchors_parents_and_excerpts():
    title, secs = searchindex.parse_markdown(MD)
    assert title == "Title of the page"
    assert [(s["anchor"], s["level"], s["parent"]) for s in secs] == [
        ("costs--budgets", 2, ""), ("claude-code-claude-bedrock", 3, "Costs & budgets"), ("costs--budgets-1", 2, ""),
        ("deep-one-with-html", 4, "Costs & budgets"), ("nota-heading", 2, "")]   # ("##No space" is none)
    assert secs[0]["text"] == "Every key has a monthly budget; see Settings."
    assert secs[3]["title"] == "Deep one with html" and secs[3]["text"] == "a list item first"
    assert searchindex.slug("Models & access") == "models--access" and searchindex.slug("Ünïcode ✓ ok") == "ünïcode--ok"


def test_markdown_parsing_is_linear_on_hostile_input():
    import time
    t0 = time.time()
    searchindex.parse_markdown(("#" * 6 + " " + "`[" * 5000 + "\n") * 50 + "```\n" * 1000 + "[a](" * 20000)
    searchindex.parse_markdown("## " + "*" * 200000)
    assert time.time() - t0 < 2


@need_repo
def test_the_real_docs_index_has_every_section_the_settings_page_links_to(tmp_path):
    idx = searchindex.build_docs(REPO)
    files = {p["file"]: p for p in idx["pages"]}
    assert "README.md" in files and "docs/security.md" in files
    assert len(files["README.md"]["sections"]) >= 20
    from portal import settings as st
    for sec in st.layout(REPO / "catalog")["sections"]:
        if "#" in sec["doc"]:
            f, frag = sec["doc"].split("#", 1)
            assert frag in {x["anchor"] for x in files[f]["sections"]}, sec["doc"]
    # the image's build step writes the same (portal/Dockerfile, stage docs; the test stage keeps a copy)
    out = tmp_path / "i.json"
    assert searchindex.main([str(REPO), str(out)]) == 0
    assert searchindex.docs_index(out)["pages"][0]["file"] == "README.md"
    built = Path("/tmp/docs-index.json")
    if built.is_file() and os.environ.get("BN_REPO_DIR"):
        assert [p["file"] for p in searchindex.docs_index(built)["pages"]] == [p["file"] for p in idx["pages"]]


def test_a_missing_or_odd_docs_index_is_an_empty_one(tmp_path):
    assert searchindex.docs_index(tmp_path / "none.json") == {"pages": []}
    (tmp_path / "bad.json").write_text("{nope")
    assert searchindex.docs_index(tmp_path / "bad.json") == {"pages": []}
    (tmp_path / "big.json").write_text("x" * (searchindex.MAX_INDEX + 1))
    assert searchindex.docs_index(tmp_path / "big.json") == {"pages": []}
    assert searchindex.build_docs(tmp_path) == {"version": 1, "pages": []}


# --- Chat conversations ---

class OWUI:
    """Open WebUI's sign-in (the trusted header) and its chat search; records what was asked."""

    def __init__(self, rows=None, search_status=200, signin_status=200):
        self.rows = rows if rows is not None else [{"id": C1, "title": "Trip planning", "snippet": "budget for Lisbon", "updated_at": 1800000000}]
        self.search_status, self.signin_status = search_status, signin_status
        self.signins, self.searches, self.tokens = 0, [], []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.host == "open-webui" and request.url.port == 8080, request.url
        if request.url.path == "/api/v1/auths/signin":
            assert request.method == "POST" and request.headers["x-portal-user"] == "admin@example.com"
            assert "authorization" not in request.headers and "cookie" not in request.headers
            self.signins += 1
            if self.signin_status != 200:
                return httpx.Response(self.signin_status, json={"detail": "no"})
            tok = f"jwt-{self.signins}"
            self.tokens.append(tok)
            return httpx.Response(200, json={"token": tok, "token_type": "Bearer", "id": "u1"}, headers={"set-cookie": f"token={tok}; Path=/"})
        if request.url.path == "/api/v1/chats/search":
            self.searches.append((request.url.params.get("text"), request.headers.get("authorization")))
            status = self.search_status(request) if callable(self.search_status) else self.search_status
            return httpx.Response(status, json=self.rows if status == 200 else {"detail": "x"})
        return httpx.Response(404)


def test_chats_through_open_webuis_own_search_as_the_owner(settings):
    ow = OWUI(rows=[{"id": C1, "title": "Trip\nplanning\x1b[31m", "snippet": "budget " * 100, "updated_at": 1800000000, "archived": False},
                    {"id": "not-a-uuid", "title": "x"}, {"id": C2, "title": "", "snippet": None, "updated_at": True}, "junk"])
    c = client(settings, httpx.MockTransport(ow))
    r = c.get("/api/search/chats?q=budget", headers=API)
    assert r.status_code == 200, r.text
    chats = r.json()["chats"]
    assert [x["id"] for x in chats] == [C1, C2]
    assert chats[0]["title"] == "Trip planning [31m" and len(chats[0]["snippet"]) == chatsearch.MAX_SNIPPET
    assert chats[1] == {"id": C2, "title": "Untitled chat", "snippet": "", "updated_at": None, "archived": False}
    assert ow.searches == [("budget", "Bearer jwt-1")]
    # the token stays on the server: in no answer, and reused (one sign-in for many searches)
    assert "jwt-" not in r.text and not r.headers.get_list("set-cookie")
    c.get("/api/search/chats?q=lisbon", headers=API)
    assert ow.signins == 1 and ow.searches[-1] == ("lisbon", "Bearer jwt-1")


def test_the_query_is_checked_and_capped(settings):
    ow = OWUI()
    c = client(settings, httpx.MockTransport(ow))
    assert c.get("/api/search/chats", headers=API).status_code == 400
    assert c.get("/api/search/chats?q=%20%20", headers=API).status_code == 400
    assert c.get("/api/search/chats?q=x", headers={}).status_code == 400   # the custom header
    c.get("/api/search/chats?q=" + "z" * 500, headers=API)
    c.get("/api/search/chats?q=a%00b%0Ac%1Bd", headers=API)
    assert [q for q, _ in ow.searches] == ["z" * 64, "abcd"]
    assert chatsearch.query(["x"]) == "" and chatsearch.query(None) == ""


def test_an_expired_token_signs_in_again_once_and_errors_are_said(settings):
    calls = {"n": 0}

    def first_401(request):
        calls["n"] += 1
        return 401 if calls["n"] == 1 else 200
    ow = OWUI(search_status=first_401)
    c = client(settings, httpx.MockTransport(ow))
    assert c.get("/api/search/chats?q=trip", headers=API).status_code == 200
    assert ow.signins == 2 and [a for _, a in ow.searches] == ["Bearer jwt-1", "Bearer jwt-2"]
    # always 401, a sign-in refused, Chat down: an answer that says so (the page offers Chat's own search), nothing else
    for ow2, words in ((OWUI(search_status=401), "HTTP 401"), (OWUI(signin_status=400), "refused the portal's sign-in (HTTP 400)"),
                       (OWUI(search_status=500), "HTTP 500")):
        c2 = client(settings, httpx.MockTransport(ow2))
        r = c2.get("/api/search/chats?q=trip", headers=API)
        assert r.status_code == 200 and words in r.json()["error"] and r.json()["chats"] == [], r.text
    c3 = client(settings)   # offline
    r = c3.get("/api/search/chats?q=trip", headers=API)
    assert r.status_code == 200 and "Chat did not answer (ConnectError)" in r.json()["error"]


def test_a_few_searches_a_second_at_most(settings):
    c = client(settings, httpx.MockTransport(OWUI()))
    codes = [c.get(f"/api/search/chats?q=t{i}", headers=API).status_code for i in range(chatsearch.PER_SECOND + 2)]
    assert codes[:chatsearch.PER_SECOND] == [200] * chatsearch.PER_SECOND and codes[-1] == 429


def test_the_token_is_dropped_after_its_hour():
    now = {"t": 1000.0}
    ow = OWUI()
    cs = chatsearch.ChatSearch(replace_settings(), clock=lambda: now["t"])

    async def run():
        # as the portal's own client (app.py lifespan): no cookie jar — the sign-in's cookie is never kept or sent
        import http.cookiejar
        jar = http.cookiejar.CookieJar(policy=http.cookiejar.DefaultCookiePolicy(allowed_domains=[]))
        async with httpx.AsyncClient(transport=httpx.MockTransport(ow), cookies=jar) as hc:
            await cs.search(hc, "a")
            now["t"] += chatsearch.TOKEN_TTL_S - 1
            await cs.search(hc, "b")
            now["t"] += 2
            await cs.search(hc, "c")
    asyncio.run(run())
    assert [a for _, a in ow.searches] == ["Bearer jwt-1", "Bearer jwt-1", "Bearer jwt-2"]


def replace_settings():
    from portal.config import Settings
    return Settings(password_hash="x", secret="s" * 64, user_email="admin@example.com")


# --- the page ---

def test_the_search_page_builds_text_only_and_talks_to_the_code_frame_on_its_origin():
    js = (STATIC / "search.js").read_text(encoding="utf-8")
    for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"):
        assert sink not in js, sink
    assert 'f.contentWindow.postMessage({ type: "bn-portal-search", id, q: text }, codeOrigin)' in js
    assert "e.origin !== codeOrigin || !f || e.source !== f.contentWindow" in js
    assert "const r = takeCodeReply(e.data, code.id);" in js
    # external links: only GitHub's pages of this repository, without the opener or the referrer
    assert 'e.url.startsWith(REPO)) window.open(e.url, "_blank", "noopener,noreferrer")' in js
    code = (STATIC / "code.js").read_text(encoding="utf-8")
    assert 'f.contentWindow.postMessage({ type: "bn-portal-open", path }, origin)' in code
    # the Code page's side checks the same (code/web/src/portalbridge.ts)
    bridge = REPO / "code" / "web" / "src" / "portalbridge.ts"
    if bridge.is_file():
        b = bridge.read_text(encoding="utf-8")
        assert "origin !== portal || !parent || source !== parent" in b and "win.parent.postMessage(" in b and ", portal);" in b


def test_ctrl_k_never_opens_over_the_password_dialogs():
    js = (STATIC / "search.js").read_text(encoding="utf-8")
    assert 'if (document.querySelector("dialog[open]:not(#search)")) return;' in js
    page = (STATIC / "index.html").read_text(encoding="utf-8")
    assert '<dialog id="search" class="search-dlg" aria-label="Search">' in page and 'role="combobox"' in page and 'maxlength="64"' in page
