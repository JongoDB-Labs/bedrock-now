"""Who answers (answers.py): your AI subscriptions' tools from catalog/ai-tools.tsv joined with ./stack's last check
(STATUS_DIR/subscriptions.json, which the sandbox fills: only its words are kept), the pickers' JSON (/api/answers, and
/.bn/answers for the Code page), the terminal's words that survive the unlock and the Code page's hand-off (the same rules
as bn-session's), and Settings' two actions for the update helper (Check again, a tool's own Sign out)."""

import json
import shutil
from dataclasses import replace
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest
from starlette.testclient import TestClient

from portal import answers
from portal import settings as st
from portal.app import create_app
from portal.security import CODE_COOKIE, COOKIE

PW = "correct horse"
PORTAL = "http://bedrock-now.localhost"
TERM_HOST = "terminal.bedrock-now.localhost"
TERM = f"http://{TERM_HOST}"
CODE_HOST = "code.bedrock-now.localhost"
CODE = f"http://{CODE_HOST}"
CATALOG = Path(__file__).resolve().parents[2] / "catalog" / "ai-tools.tsv"
H = {"X-Requested-With": "bedrock-now"}


def offline(request):
    raise httpx.ConnectError("offline in tests")


@pytest.fixture
def s(settings, tmp_path):
    status = tmp_path / "status"; status.mkdir()
    req = tmp_path / "requests"; req.mkdir()
    if CATALOG.exists():
        shutil.copy(CATALOG, settings.catalog_dir / "ai-tools.tsv")
    return replace(settings, terminal=True, code=True, status_dir=status, request_dir=req)


def _client(s):
    return TestClient(create_app(s, transport=httpx.MockTransport(offline)), base_url=PORTAL, follow_redirects=False)


def session(c):
    r = c.post("/login", data={"password": PW, "next": "/"}, headers={"Origin": PORTAL})
    assert r.status_code == 303, r.text
    return r


def _status(s, body):
    (s.status_dir / "subscriptions.json").write_text(json.dumps(body) if not isinstance(body, str) else body)


def test_the_catalog_lists_six_tools_each_checked(s):
    rows = answers.read_tools(s.catalog_dir)
    assert [r["id"] for r in rows] == ["claude", "codex", "gemini", "copilot", "cursor", "grok"]
    assert {r["signout"] for r in rows} == {"cli", "inside"}
    assert all(r["terms"].startswith("https://") and r["chat_why"] for r in rows)
    # a row with an unknown id, a bad terms link or a field too many is dropped
    (s.catalog_dir / "ai-tools.tsv").write_text(
        "evil\tE\tP\tp\tc\tcli\tno\twhy\thttps://x.example/\n"
        "codex\tCodex\tOpenAI\tplan\tcodex\tcli\tno\twhy\tjavascript:alert(1)\n"
        "grok\tGrok\txAI\tplan\tgrok\tcli\tno\twhy\thttps://x.ai/\textra\n"
        "cursor\tCursor\tCursor\tplan\tcursor-agent\tcli\tno\twhy\thttps://cursor.com/terms-of-service\n")
    assert [r["id"] for r in answers.read_tools(s.catalog_dir)] == ["cursor"]


def test_only_the_sandboxs_words_are_kept(s):
    tok = "sk-ant-oat01-" + "x" * 40
    _status(s, {"version": 1, "written_at": 1792760000, "terminal": "running", "tools": [
        {"id": "claude", "installed": True, "version": "2.1.309", "signed_in": "yes", "kind": "claude-max", "how": "command"},
        {"id": "codex", "installed": True, "version": "<script>", "signed_in": "maybe", "kind": tok, "how": "rm -rf"},
        {"id": "claude", "installed": True, "version": "9", "signed_in": "no", "kind": "", "how": "command"},
        {"id": "../etc", "installed": True},
        {"id": "grok", "installed": False, "version": "1.0.67", "signed_in": "yes", "kind": "xai", "how": "file"},
        "garbage"]})
    t = {r["id"]: r for r in answers.tools(s.catalog_dir, s.status_dir)["tools"]}
    assert t["claude"]["signed_in"] == "yes" and t["claude"]["kind_words"] == "Claude Max" and t["claude"]["version"] == "2.1.309"
    assert t["codex"] | {} == {**t["codex"], "version": "", "signed_in": "unknown", "kind": "", "kind_words": "", "how": "none"}
    assert t["grok"]["installed"] is False and t["grok"]["signed_in"] == "no" and t["grok"]["version"] == ""
    assert t["gemini"]["installed"] is None          # not in the file: not checked yet
    assert tok not in json.dumps(answers.tools(s.catalog_dir, s.status_dir))
    # not JSON, a link, too large: nothing
    _status(s, "{nope")
    assert answers.read_status(s.status_dir) == {"written_at": None, "sandbox": None, "tools": {}}
    _status(s, json.dumps({"terminal": "running", "tools": [], "pad": "x" * 20000}))
    assert answers.read_status(s.status_dir)["sandbox"] is None


def test_api_answers_needs_a_session_and_says_where_the_terminal_is(s):
    _status(s, {"written_at": 1, "terminal": "running", "tools": [{"id": "codex", "installed": True, "version": "0.163.0", "signed_in": "no", "kind": "", "how": "command"}]})
    with _client(s) as c:
        assert c.get("/api/answers", headers=H).status_code == 401
        session(c)
        d = c.get("/api/answers", headers=H).json()
        assert d["terminal"] == {"enabled": True, "here": True} and d["sandbox"] == "running"
        assert [b["id"] for b in d["basics"]] == ["bedrock", "shell"]
        assert next(t for t in d["tools"] if t["id"] == "codex")["signed_in"] == "no"
        assert d["models"] == [] and d["folders"] == []
    with _client(replace(s, terminal=False, code=False)) as c:
        session(c)
        assert c.get("/api/answers", headers=H).json()["terminal"] == {"enabled": False, "here": False}


TOK = "1792760000-0123456789abcdef-" + "0" * 32   # a launch token's form (not a valid one)


@pytest.mark.parametrize("words,ok", [
    (["open", "codex", TOK], True),
    (["chat", "claude", TOK], True),
    (["open", "shell", TOK, "/workspace/app"], True),
    (["open", "codex", TOK, "/home/me/src/app"], True),
    (["run", "codex", TOK], False),
    (["open", "evil", TOK], False),
    (["open", "codex", "0123456789abcdef"], False),
    (["open", "codex", TOK.upper()], False),
    (["open", "codex", TOK, "relative"], False),
    (["open", "codex", TOK, "/workspace/../etc"], False),
    (["open", "codex", TOK, "/workspace/./x"], False),
    (["open", "codex", TOK, "/work\nspace"], False),
])
def test_the_terminals_words_follow_bn_sessions_rules(words, ok):
    assert (answers.terminal_args(*words) is not None) is ok
    link = "/?" + "&".join(f"arg={quote(w, safe='')}" for w in words)
    assert (answers.terminal_next(link) is not None) is ok


def test_terminal_next_keeps_nothing_else():
    assert answers.terminal_next(f"/?arg=open&arg=codex&arg={TOK}") == f"/?arg=open&arg=codex&arg={TOK}"
    for bad in (f"/x?arg=open&arg=codex&arg={TOK}", f"/?arg=open&arg=codex&arg={TOK}&next=//evil",
                "/?arg=open&arg=codex", f"/?arg=open&arg=codex&arg={TOK}&arg=/w&arg=x", "https://evil/?arg=open",
                "/?session=1", None, "/?" + "a" * 5000):
        assert answers.terminal_next(bad) is None, bad


def test_launch_tokens_are_bound_fresh_and_remembered_once_used():
    clock = {"t": 1_792_760_000.0}
    L = answers.Launches("s" * 64, "fp", clock=lambda: clock["t"])
    w = ["open", "codex"]
    t = L.issue("me@example.com", w)
    assert answers.TOKEN.fullmatch(t)
    assert L.valid(t, "me@example.com", w)
    assert not L.valid(t, "other@example.com", w)                    # another login
    assert not L.valid(t, "me@example.com", ["open", "grok"])         # other words
    assert not L.valid(t, "me@example.com", ["chat", "codex"])
    assert not L.valid(t, "me@example.com", ["open", "codex", "/workspace/x"])
    assert not answers.Launches("s" * 64, "new-password", clock=lambda: clock["t"]).valid(t, "me@example.com", w)
    assert not L.valid(t, "me@example.com", w, not_before=clock["t"] + 1)   # signed out everywhere since
    forged = t[:-1] + ("1" if t[-1] != "1" else "2")
    assert not L.valid(forged, "me@example.com", w)
    # fresh for 10 minutes to start something; a token that started its terminal keeps reconnecting it
    t2 = L.issue("me@example.com", w)
    clock["t"] += answers.FRESH_S + 1
    assert not L.valid(t2, "me@example.com", w, use=True)
    clock["t"] -= answers.FRESH_S + 1
    assert L.valid(t, "me@example.com", w, use=True)
    clock["t"] += 3 * 3600
    assert L.valid(t, "me@example.com", w) and not L.valid(t2, "me@example.com", w)
    clock["t"] += answers.LAUNCH_MAX_S
    assert not L.valid(t, "me@example.com", w)


def _login_unlock(c):
    r = c.post("/login", data={"password": PW, "next": "/"}, headers={"Origin": PORTAL})
    tok = r.cookies.get(COOKIE)
    c.cookies.clear()
    r = c.post("/auth/terminal-unlock", data={"password": PW}, headers={"Host": TERM_HOST, "Origin": TERM, "Cookie": f"{COOKIE}={tok}"})
    ut = r.cookies.get("bn_terminal")
    c.cookies.clear()
    return tok, ut


def _verify(c, tok, ut, uri, ws=False, accept="text/html", method="GET"):
    h = {"X-Forwarded-Method": method, "X-Forwarded-Host": TERM_HOST, "X-Forwarded-Uri": uri, "Cookie": f"{COOKIE}={tok}; bn_terminal={ut}"}
    if ws:
        h.update({"Upgrade": "websocket", "Connection": "Upgrade", "Origin": TERM})
    else:
        h["Accept"] = accept
    return c.get("/auth/verify?app=terminal", headers=h)


def test_nothing_starts_from_an_address_alone(s):
    with _client(s) as c:
        tok, ut = _login_unlock(c)
        assert _verify(c, tok, ut, "/").status_code == 200
        # a link with words and no token, a forged one: the question, on the terminal host's own page — nothing runs
        for t in (TOK, "1792760000-0123456789abcdef-" + "f" * 32):
            r = _verify(c, tok, ut, f"/?arg=open&arg=codex&arg={t}")
            assert r.status_code == 403 and "Open Codex here?" in r.text and 'action="/.bn/launch"' in r.text, r.text[:300]
            assert 'name="tool" value="codex"' in r.text and t not in r.text
            assert "frame-ancestors" in r.headers["content-security-policy"] and "form-action 'self'" in r.headers["content-security-policy"]
            # its WebSocket — what would start the tool — refused
            assert _verify(c, tok, ut, f"/ws?arg=open&arg=codex&arg={t}", ws=True).status_code == 403
        # other words, other paths: the terminal as it is / refused; words hidden in a spelling ttyd decodes, too
        r = _verify(c, tok, ut, "/?arg=open&arg=evil&arg=x")
        assert r.status_code == 303 and r.headers["location"] == "/"
        assert _verify(c, tok, ut, f"/token?arg=open&arg=codex&arg={TOK}", accept="*/*").status_code == 403
        for q in (f"/ws?x=1&arg=open&arg=codex&arg={TOK}", "/ws?arg%3Dopen&arg%3Dshell&arg%3D" + TOK, "/ws?%61rg=open&arg=shell&arg=" + TOK,
                  f"/ws?x=1;arg=open;arg=shell;arg={TOK}", f"/ws?arg=open;arg=shell;arg={TOK}"):
            assert _verify(c, tok, ut, q, ws=True).status_code == 403, q
        # a query without words: ttyd ignores it, nothing to check
        assert _verify(c, tok, ut, "/ws?x=1", ws=True).status_code == 200
        assert answers.carries_words("x=1&ar%67=1") and answers.carries_words("x;arg=1") and answers.carries_words("arg+=1") is False
        # the question's Open: same origin only, then a token for exactly those words
        form = {"mode": "open", "tool": "codex", "folder": ""}
        hdr = {"Host": TERM_HOST, "Cookie": f"{COOKIE}={tok}; bn_terminal={ut}"}
        assert c.post("/auth/terminal-launch", data=form, headers={**hdr, "Origin": "http://evil.example"}).status_code == 403
        assert c.post("/auth/terminal-launch", data=form, headers={**hdr, "Origin": PORTAL}).status_code == 403
        assert c.post("/auth/terminal-launch", data=form, headers={**hdr, "Origin": TERM, "Sec-Fetch-Site": "same-site"}).status_code == 403
        assert c.post("/auth/terminal-launch", data={**form, "tool": "evil"}, headers={**hdr, "Origin": TERM}).status_code == 400
        r = c.post("/auth/terminal-launch", data=form, headers={**hdr, "Origin": TERM, "Sec-Fetch-Site": "same-origin"})
        assert r.status_code == 303
        link = r.headers["location"]
        assert link.startswith("/?arg=open&arg=codex&arg=")
        assert _verify(c, tok, ut, link).status_code == 200
        assert _verify(c, tok, ut, "/ws" + link[1:], ws=True).status_code == 200
        # without the unlock: the unlock first (no token made)
        r = c.post("/auth/terminal-launch", data=form, headers={"Host": TERM_HOST, "Cookie": f"{COOKIE}={tok}", "Origin": TERM})
        assert r.status_code == 303 and r.headers["location"] == "/"


def test_the_portals_own_page_gets_a_token_on_a_click(s):
    with _client(s) as c:
        tok, ut = _login_unlock(c)
        post = lambda body, h=None: c.post("/api/terminal/launch", json=body, headers={**H, "Origin": PORTAL, "Cookie": f"{COOKIE}={tok}", **(h or {})})
        assert c.post("/api/terminal/launch", json={"mode": "open", "tool": "codex"}, headers={"Origin": PORTAL, "Cookie": f"{COOKIE}={tok}"}).status_code == 400
        assert post({"mode": "open", "tool": "codex"}, {"Origin": "http://evil.example"}).status_code == 403
        assert post({"mode": "open", "tool": "rm"}).status_code == 400
        assert post({"mode": "chat", "tool": "grok", "folder": "/workspace/../x"}).status_code == 400
        r = post({"mode": "chat", "tool": "grok", "folder": "/workspace/app"})
        assert r.status_code == 200
        url = r.json()["url"]
        assert url.startswith(f"{TERM}/?arg=chat&arg=grok&arg=") and url.endswith("&arg=%2Fworkspace%2Fapp")
        assert _verify(c, tok, ut, url[len(TERM):]).status_code == 200
        # the token is for exactly those words: another tool or folder with it starts nothing
        t = url.split("&arg=")[2]
        assert _verify(c, tok, ut, f"/?arg=chat&arg=codex&arg={t}&arg=%2Fworkspace%2Fapp").status_code == 403
        assert _verify(c, tok, ut, f"/?arg=chat&arg=grok&arg={t}").status_code == 403
    with _client(replace(s, terminal=False, code=False)) as c:
        r = c.post("/login", data={"password": PW, "next": "/"}, headers={"Origin": PORTAL})
        t2 = r.cookies.get(COOKIE)
        c.cookies.clear()
        assert c.post("/api/terminal/launch", json={"mode": "open", "tool": "codex"}, headers={**H, "Origin": PORTAL, "Cookie": f"{COOKIE}={t2}"}).status_code == 404


def test_the_unlock_keeps_the_pickers_words_and_nothing_else(s):
    with _client(s) as c:
        r = c.post("/login", data={"password": PW, "next": "/"}, headers={"Origin": PORTAL})
        tok = r.cookies.get(COOKIE)
        c.cookies.clear()
        nav = {"Accept": "text/html", "X-Forwarded-Method": "GET", "X-Forwarded-Host": TERM_HOST, "Cookie": f"{COOKIE}={tok}"}
        r = c.get("/auth/verify?app=terminal", headers={**nav, "X-Forwarded-Uri": f"/?arg=open&arg=codex&arg={TOK}"})
        assert r.status_code == 401 and f'name="next" value="/?arg=open&amp;arg=codex&amp;arg={TOK}"' in r.text
        r = c.get("/auth/verify?app=terminal", headers={**nav, "X-Forwarded-Uri": f"/?arg=open&arg=evil&arg={TOK}"})
        assert r.status_code == 401 and 'name="next"' not in r.text
        r = c.post("/auth/terminal-unlock", data={"password": PW, "next": f"/?arg=chat&arg=grok&arg={TOK}"},
                   headers={"Host": TERM_HOST, "Origin": TERM, "Cookie": f"{COOKIE}={tok}"})
        assert r.status_code == 303 and r.headers["location"] == f"/?arg=chat&arg=grok&arg={TOK}"
        r = c.post("/auth/terminal-unlock", data={"password": PW, "next": "//evil.example/?arg=chat"},
                   headers={"Host": TERM_HOST, "Origin": TERM, "Cookie": f"{COOKIE}={tok}"})
        assert r.status_code == 303 and r.headers["location"] == "/"


def test_the_code_pages_open_menu_goes_through_the_hand_off(s):
    with _client(s) as c:
        r = c.post("/login", data={"password": PW, "next": "/"}, headers={"Origin": PORTAL})
        tok = r.cookies.get(COOKIE)
        c.cookies.clear()
        r = c.post("/auth/code-unlock", data={"password": PW}, headers={"Host": CODE_HOST, "Origin": CODE, "Cookie": f"{COOKIE}={tok}"})
        ut = r.cookies.get(CODE_COOKIE)
        c.cookies.clear()
        hdr = {"Host": CODE_HOST, "Cookie": f"{COOKIE}={tok}; {CODE_COOKIE}={ut}", "Sec-Fetch-Site": "same-origin"}
        r = c.get("/auth/code-terminal", params={"open": "codex", "dir": "/workspace/app", "t": "1"}, headers=hdr)
        assert r.status_code == 303
        loc = r.headers["location"]
        assert loc.startswith(f"{TERM}/.bn/unlock-callback?t=") and "&next=%2F%3Farg%3Dopen%26arg%3Dcodex%26arg%3D" in loc
        r = c.get(f"/auth/terminal-unlock-callback?{loc.split('?', 1)[1]}", headers={"Host": TERM_HOST, "Cookie": f"{COOKIE}={tok}"})
        assert r.status_code == 303 and r.headers["location"].startswith("/?arg=open&arg=codex&arg=") \
            and r.headers["location"].endswith("&arg=%2Fworkspace%2Fapp")
        term_ut = r.cookies.get("bn_terminal")
        assert _verify(c, tok, term_ut, r.headers["location"]).status_code == 200   # its token: valid for those words
        # only from the Code page itself
        assert c.get("/auth/code-terminal", params={"open": "codex"}, headers={**hdr, "Sec-Fetch-Site": "same-site"}).status_code == 403
        assert c.get("/auth/code-terminal", params={"open": "evil"}, headers=hdr).status_code == 400
        assert c.get("/auth/code-terminal", params={"open": "codex", "dir": "/w/../etc"}, headers=hdr).status_code == 400
        # the Code page's own answers: after its own check only
        assert c.get("/auth/code-answers", headers={"Host": CODE_HOST}).status_code == 401
        d = c.get("/auth/code-answers", headers={"Host": CODE_HOST, "Cookie": f"{COOKIE}={tok}; {CODE_COOKIE}={ut}"}).json()
        assert [t["id"] for t in d["tools"]][:2] == ["claude", "codex"]


def _cap(s, subs=("subscriptions-check", "subscriptions-signout")):
    import time
    (s.status_dir / "helper-settings.json").write_text(json.dumps({"settings": 1, "diagnostics": [], "projects": [], "sessions": [],
                                                                  "subscriptions": list(subs), "written_at": int(time.time())}))
    (s.status_dir / "helper.json").write_text(json.dumps({"heartbeat": int(time.time()), "pid": 1}))


def test_settings_sends_check_and_sign_out_by_tool_only(s):
    _cap(s)
    with _client(s) as c:
        session(c)
        post = lambda body: c.post("/api/settings/subscriptions", json={"password": PW, **body}, headers={**H, "Origin": PORTAL})
        d = c.get("/api/settings", headers=H).json()
        assert [t["id"] for t in d["subscriptions"]["tools"]][0] == "claude"
        assert post({"action": "subscriptions-signout", "tool": "copilot"}).status_code == 400
        assert post({"action": "subscriptions-signout", "tool": "../x"}).status_code == 400
        assert post({"action": "subscriptions-wipe"}).status_code == 400
        r = post({"action": "subscriptions-signout", "tool": "codex"})
        assert r.status_code == 202, r.text
        files = list(s.request_dir.glob("act-*.json"))
        assert len(files) == 1
        body = json.loads(files[0].read_text())
        assert set(body) == {"action", "requested_at", "nonce", "auth", "tool"} and body["tool"] == "codex"


def test_write_subs_action_is_exact(tmp_path):
    n = st.write_subs_action(tmp_path, "pw", "subscriptions-check", now=1792760000)
    raw = (tmp_path / f"act-{n}.json").read_text()
    assert raw == '{"action":"subscriptions-check","requested_at":1792760000,"nonce":"%s","auth":"cHc="}' % n
    n = st.write_subs_action(tmp_path, "pw", "subscriptions-signout", "grok", now=1)
    assert json.loads((tmp_path / f"act-{n}.json").read_text())["tool"] == "grok"
    for bad in (("subscriptions-check", "codex"), ("subscriptions-signout", None), ("subscriptions-signout", "gemini"), ("x", None)):
        with pytest.raises(ValueError):
            st.write_subs_action(tmp_path, "pw", *bad)
