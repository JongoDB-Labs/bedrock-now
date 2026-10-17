"""Settings › the page's layout: catalog/settings-layout.tsv (sections, More, parent switches, summaries) as the
portal reads and serves it, the deep links into it (#settings/<section>, #settings/<KEY>), and the page code that
hides a setting while its switch is off. The checks against the real catalog run where the repository is around (not
in the portal's test image, which holds portal/ only); tests/test_settings.sh checks the same file from the shell."""

import json
import os
import re
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from portal import settings as st
from portal.app import STATIC, create_app
from dataclasses import replace

ORIGIN = {"Origin": "http://bedrock-now.localhost"}
API = {"X-Requested-With": "bedrock-now"}
REPO = Path(__file__).resolve().parents[2]
REAL = REPO / "catalog" / "settings-layout.tsv"
TABLE = REPO / "catalog" / "settings.tsv"
need_repo = pytest.mark.skipif(not (REAL.is_file() and TABLE.is_file()), reason="the repository's catalog is not here (test image)")

LAYOUT = """# a comment
@account\tAccount & security\tYour password.\tREADME.md#settings
PORTAL_PASSWORD\taccount\tmain\t-\tThe one password.
PORTAL_PASSWORD_HASH\taccount\twith\tPORTAL_PASSWORD\t-
+devices\taccount\tmain\t-\tEvery browser signed in.

@updates\tUpdates & backups\tNew releases.\tdocs/remote.md
BACKUP_NIGHTLY\tupdates\tmain\t-\tBack up every night.
BACKUP_HOUR\tupdates\tmain\tBACKUP_NIGHTLY\tWhen the window starts.
UPDATE_REQUIRE_SIGNED_TAGS\tupdates\tmore\t-\tSigned releases only.
"""


def offline(request):
    raise httpx.ConnectError("offline in tests")


def write(tmp_path, text, name=st.LAYOUT):
    (tmp_path / name).write_text(text, encoding="utf-8")
    st._layout_cache.clear()
    return tmp_path


def test_layout_reads_sections_and_rows_in_the_files_order(tmp_path):
    lay = st.layout(write(tmp_path, LAYOUT))
    assert [s["id"] for s in lay["sections"]] == ["account", "updates"]
    assert lay["sections"][0] == {"id": "account", "title": "Account & security", "lede": "Your password.", "doc": "README.md#settings"}
    assert [r["key"] for r in lay["rows"]] == ["PORTAL_PASSWORD", "PORTAL_PASSWORD_HASH", "+devices", "BACKUP_NIGHTLY", "BACKUP_HOUR",
                                              "UPDATE_REQUIRE_SIGNED_TAGS"]
    rows = {r["key"]: r for r in lay["rows"]}
    assert rows["PORTAL_PASSWORD_HASH"] == {"key": "PORTAL_PASSWORD_HASH", "section": "account", "place": "with",
                                            "parent": "PORTAL_PASSWORD", "summary": ""}
    assert rows["BACKUP_HOUR"]["parent"] == "BACKUP_NIGHTLY" and rows["BACKUP_NIGHTLY"]["parent"] == ""
    assert rows["UPDATE_REQUIRE_SIGNED_TAGS"]["place"] == "more"


def test_layout_drops_what_it_does_not_know(tmp_path):
    bad = "\n".join([
        "@account\tAccount\tok\tjavascript:alert(1)",      # a link only to a page of the repository
        "@account\tAgain\tdup\t-",                          # a section once
        "@nosuch\tNo such section\tx\t-",
        "@updates\t" + "T" * 200 + "\t" + "L" * 900 + "\thttps://evil.example/x",
        "PORTAL_PASSWORD\taccount\tmain\t-\t" + "s" * 500,
        "PORTAL_PASSWORD\taccount\tmore\t-\tdup",            # a key once
        "bad key\taccount\tmain\t-\tx",
        "lower_case\taccount\tmain\t-\tx",
        "+unknown\taccount\tmain\t-\tnot one of the page's own rows",
        "AWS_REGION_NAME\tnosuch\tmain\t-\tx",              # a section the file does not have
        "BUDGET_SETUP\taccount\ttop\t-\tx",                 # main, more or with
        "BUDGET_OPENWEBUI\taccount\tmain\tnot a key\tx",
        "STT_MODEL\taccount\twith\t-\t-",                   # with: always inside another row
        "SHORT\taccount\tmain",                             # five columns
    ])
    lay = st.layout(write(tmp_path, bad))
    assert [s["id"] for s in lay["sections"]] == ["account", "updates"]
    assert lay["sections"][0]["doc"] == "" and lay["sections"][0]["title"] == "Account"
    assert lay["sections"][1]["doc"] == "" and len(lay["sections"][1]["title"]) == 60 and len(lay["sections"][1]["lede"]) == 400
    assert [r["key"] for r in lay["rows"]] == ["PORTAL_PASSWORD"]
    assert len(lay["rows"][0]["summary"]) == 200 and lay["rows"][0]["place"] == "main"


def test_no_layout_a_big_one_or_a_link_gives_none(tmp_path):
    empty = {"sections": [], "rows": []}
    assert st.layout(tmp_path) == empty
    write(tmp_path, "#" * (st.MAX_LAYOUT + 1))
    assert st.layout(tmp_path) == empty
    (tmp_path / st.LAYOUT).unlink()
    (tmp_path / "elsewhere.tsv").write_text(LAYOUT)
    os.symlink(tmp_path / "elsewhere.tsv", tmp_path / st.LAYOUT)
    st._layout_cache.clear()
    assert st.layout(tmp_path) == empty


def test_layout_follows_the_file(tmp_path):
    assert len(st.layout(write(tmp_path, LAYOUT))["rows"]) == 6
    (tmp_path / st.LAYOUT).write_text(LAYOUT + "AUTO_UPDATE\tupdates\tmain\t-\tInstall a new release at night.\n")
    assert len(st.layout(tmp_path)["rows"]) == 7   # a new size: read again (an update brings a new layout)


def test_get_settings_carries_the_layout(settings, tmp_path):
    write(settings.catalog_dir, LAYOUT)
    sd = tmp_path / "status"; sd.mkdir()
    with TestClient(create_app(replace(settings, status_dir=sd, request_dir=tmp_path), transport=httpx.MockTransport(offline)),
                    base_url="http://bedrock-now.localhost", follow_redirects=False) as c:
        assert c.get("/api/settings", headers=API).status_code == 401
        assert c.post("/login", data={"password": "correct horse"}, headers=ORIGIN).status_code == 303
        d = c.get("/api/settings", headers=API).json()
    assert [s["id"] for s in d["layout"]["sections"]] == ["account", "updates"] and len(d["layout"]["rows"]) == 6


def test_a_note_is_whole_on_the_page(tmp_path):
    # the full explanation (Details, and the confirmation of a change): Auto mode's is ~1,250 characters
    long = "Auto mode. " * 120
    (tmp_path / "settings.json").write_text(json.dumps({"version": 1, "keys": [
        {"key": "CODE_AUTO_MODE", "group": "advanced", "secret": "-", "policy": "widen-local", "validator": "bool", "apply": "code-env",
         "label": "Auto mode", "note": long, "cli": "x", "present": True, "set": True, "value": "false"},
        {"key": "X_LONG", "group": "advanced", "secret": "-", "policy": "ro", "validator": "-", "apply": "-", "label": "x",
         "note": "n" * 5000, "cli": "x", "present": True, "set": True, "value": ""}]}))
    k = st.by_key(st.snapshot(tmp_path))
    assert k["CODE_AUTO_MODE"]["note"] == long and len(long) > 600
    assert len(k["X_LONG"]["note"]) == st.MAX_NOTE


# --- the real catalog ---

def _table():
    rows = [l.rstrip("\n").split("\t") for l in TABLE.read_text().splitlines() if l and not l.startswith("#")]
    return {r[0]: r for r in rows if r[0] != "key" and len(r) >= 9}


@need_repo
def test_every_key_has_one_place_in_a_known_section():
    st._layout_cache.clear()
    lay = st.layout(REAL.parent)
    table = _table()
    assert [s["id"] for s in lay["sections"]] == list(st.SECTIONS)
    assert all(s["title"] and s["lede"] and s["doc"] for s in lay["sections"])
    keys = [r["key"] for r in lay["rows"] if not r["key"].startswith("+")]
    assert sorted(keys) == sorted(table) and len(keys) == len(set(keys))   # every key of settings.tsv exactly once
    # (the parser drops a row it does not understand: as many rows as the file has)
    lines = [l for l in REAL.read_text().splitlines() if l and not l.startswith(("#", "@"))]
    assert len(lines) == len(lay["rows"])
    assert sorted(r["key"] for r in lay["rows"] if r["key"].startswith("+")) == sorted(st.OWN_ROWS)
    rows = {r["key"]: r for r in lay["rows"]}
    for r in lay["rows"]:
        if r["parent"]:
            p = rows[r["parent"]]
            assert p["section"] == r["section"], r          # a switch of the same section
            assert p["place"] != "with" and not p["key"].startswith("+"), r
        if r["place"] == "with":
            assert r["parent"] and not r["summary"], r
        else:
            assert r["summary"] and len(r["summary"]) <= 120 and r["summary"].endswith("."), r   # one plain line


@need_repo
def test_sections_hold_what_their_task_needs():
    st._layout_cache.clear()
    rows = {r["key"]: r for r in st.layout(REAL.parent)["rows"]}
    table = _table()
    where = lambda k: (rows[k]["section"], rows[k]["place"], rows[k]["parent"])   # noqa: E731
    # the Code page with Bypass and Auto under it; the terminal with its internet access and Auto mode
    assert where("CODE_ENABLED") == ("code", "main", "") and where("CODE_ALLOW_BYPASS") == ("code", "main", "CODE_ENABLED")
    assert where("CODE_AUTO_MODE") == ("code", "main", "CODE_ENABLED")
    assert where("TERMINAL_AUTO_MODE") == ("code", "main", "TERMINAL_ENABLED") and where("TERMINAL_EGRESS")[0] == "code"
    # every budget with its key, the terminal's too (it was read-only under Advanced)
    for b, k in (("BUDGET_OPENWEBUI", "LITELLM_KEY_OPENWEBUI"), ("BUDGET_CLAUDE_CODE", "LITELLM_KEY_CLAUDE_CODE"),
                 ("BUDGET_TERMINAL", "LITELLM_KEY_TERMINAL"), ("BUDGET_SETUP", "LITELLM_KEY_SETUP")):
        assert rows[b]["section"] == "spending" and where(k) == ("spending", "with", b)
    assert where("BUDGET_TERMINAL") == ("spending", "main", "")
    # Chat's models with Chat, Claude Code's with Claude Code; voice and OpenRouter with Chat
    assert rows["CHAT_DEFAULT_MODEL"]["section"] == "chat" and rows["CLAUDE_MODEL_OPUS"]["section"] == "code"
    assert rows["STT_PROVIDER"]["section"] == "chat" and where("OPENROUTER_MODELS") == ("chat", "main", "OPENROUTER_API_KEY")
    # remote access's switches only while it is on; nightly backups' window and count only while they are on
    for k in ("TAILSCALE_ALLOWED_LOGIN", "REMOTE_ADMIN_ACTIONS", "REMOTE_TERMINAL"):
        assert where(k) == ("remote", "main", "REMOTE_MODE")
    assert where("REMOTE_PREVIEW") == ("remote", "main", "REMOTE_TERMINAL")
    assert where("BACKUP_HOUR")[2] == where("BACKUP_KEEP")[2] == "BACKUP_NIGHTLY" and where("AUTO_UPDATE_HOUR")[2] == "AUTO_UPDATE"
    # nothing that changes from the page hides in Advanced or About; About is what ./stack writes
    for k, r in rows.items():
        if r["section"] in ("advanced", "about"):
            assert table[k][3] in ("ro", "derived"), k
        if r["section"] == "about":
            assert table[k][3] == "derived", k
    editable = [k for k, t in table.items() if t[3] in ("edit", "local", "on-only", "widen-local", "regen")]
    assert all(rows[k]["place"] in ("main", "more") or k in ("AWS_SECRET_ACCESS_KEY", "STT_API_KEY", "STT_MODEL", "RUSTFS_SECRET_KEY") for k in editable)


@need_repo
def test_links_into_settings_name_a_section_or_a_setting():
    st._layout_cache.clear()
    lay = st.layout(REAL.parent)
    places = {s["id"] for s in lay["sections"]} | {r["key"] for r in lay["rows"]}
    found = []
    for f in ("code.js", "index.html", "settings.js"):
        found += re.findall(r'#settings/([A-Za-z_+-]+)', (STATIC / f).read_text(encoding="utf-8"))
    tour = (STATIC / "tour.js").read_text(encoding="utf-8")
    names = dict(re.findall(r'"([^"]+)": "([A-Za-z_]+)"', tour[tour.index("const PLACES = {"):tour.index("const settings = (where, place)")]))
    found += list(names.values()) + re.findall(r'settings\("[^"]+", "([A-Za-z_]+)"\)', tour)
    alone = re.findall(r'settings\("([^"]+)"\)', tour)   # settings(WHERE): a place named in PLACES
    assert alone and not [w for w in alone if w not in names], alone
    assert len(found) >= 10
    assert not [p for p in found if p not in places], found


# --- the page code (string checks: the portal's tests run no browser; tests/e2e/browser/checks_browser.py does) ---

def _js(name="settings.js"):
    return (STATIC / name).read_text(encoding="utf-8")


def test_the_address_keeps_a_place_inside_a_page():
    app = _js("app.js")
    show = app[app.index("function showTab(tab) {"):app.index("// --- formatting ---")]
    assert 'const [name, ...place] = String(tab || "").split("/");' in show and "tab = name;" in show
    # only a page of the portal keeps it (an app's tab never), and only through replaceState: no new history entry
    assert 'const hash = place.length && PAGES.includes(tab) ? `#${tab}/${place.join("/")}` : `#${tab}`;' in show
    js = _js()
    go = js[js.index("function goTo(place) {"):js.index("// --- what is shown")]
    # a section id or a key the layout knows; a key shown inside another row opens that row; nothing else is used
    assert "if (sectionOf(part)) sec = part;" in go and "KEY_NAME.test(part)" in go and "&& rowOf[part]" in go
    assert 'rowOf[key].place === "with"' in go and "more.open = true;" in go and 'classList.add("set-forced")' in go
    assert "const KEY_NAME = /^[A-Z][A-Z0-9_]{1,40}$/;" in js
    assert 'history.replaceState(null, "", `#settings/${id}`)' in js and "history.pushState" not in js


def test_a_setting_shows_only_while_its_switch_is_on():
    js = _js()
    on = js[js.index("function isOn(key) {"):js.index("function showError(msg)")]
    # true or on; for other values, set and not off (REMOTE_MODE: tailscale or domain); a secret: set
    assert "return v !== \"\" && !OFF_VALUES.includes(v);" in on and "if (!plain(k)) return Boolean(k.set);" in on
    assert "return isOn(r.parent) && parentsOn(rowOf[r.parent], depth + 1);" in on   # the whole chain of switches
    view = js[js.index("function applyView() {"):js.index("function helperBox()")]
    # hidden unless opened by an address, or itself a switch that is on (Bypass allowed while the Code page is off)
    assert 'd.hidden = off && !selfOn && !d.classList.contains("set-forced");' in view
    assert "const selfOn = off && switchedOn(keys[d.dataset.key]);" in view
    assert '["bool", "on_off", "true_blank"].includes(k.validator) && ON_VALUES.includes(lower(k.value))' in js
    assert "d.hidden = !(hit || inner);" in view                                  # a search shows it anyway
    assert "Applies while" in js


def test_switches_keep_the_rules_of_the_chips_they_replace():
    js = _js()
    t = js[js.index("function toggle(k, v, labelId) {"):js.index("// OpenRouter's model set")]
    assert 'role: "switch", "aria-checked": String(cur === on)' in t and '"aria-labelledby": labelId' in t
    # off for on-only keys, and for the less protective direction of a widen-local key on a remote device
    assert 'b.disabled = !canChange() || (k.policy === "on-only" && other !== on) || localOnlyHere(k, other);' in t
    assert "confirmApply({ [k.key]: other }" in t   # a change asks for the password like every other


def test_the_page_stays_inside_the_csp():
    # no HTML parsed from strings, no style attribute (the CSP has no 'unsafe-inline'), no code built from strings
    # (the names below are only searched for: none of them may appear in the page code)
    for name in ("settings.js", "app.js", "tour.js"):
        js = _js(name)
        for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "style:", 'setAttribute("style"', "new Function"):
            assert sink not in js, (name, sink)
    js = _js()
    assert 'try { localStorage.setItem(SECTION_MEMO, id); } catch (_)' in js   # the last section: best effort only
