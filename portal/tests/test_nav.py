"""The sidebar's collapse (static/nav.js, the rail rules in app.css, mobile.css, activity.css and tour.css): loaded
before the first paint, a button that says what it does, one set of rules for the icon rail of a tablet and of a
collapsed desktop sidebar, and the walkthrough and the tabs' tooltips following it."""

import re

import httpx
import pytest
from starlette.testclient import TestClient

from portal.app import STATIC, create_app

TABLET = "@media (min-width: 768px) and (max-width: 1099.98px)"


def offline(request):
    raise httpx.ConnectError("offline in tests")


@pytest.fixture
def client(settings):
    app = create_app(settings, transport=httpx.MockTransport(offline))
    with TestClient(app, base_url=f"http://{settings.origin()[7:]}", follow_redirects=False) as c:
        yield c


def css(name):
    return (STATIC / name).read_text(encoding="utf-8")


def block(text, head):
    """The rules of the block that starts with HEAD (up to its closing brace at the start of a line)."""
    i = text.index(head)
    return text[i:text.index("\n}", i)]


def test_home_loads_nav_js_before_the_first_paint_and_has_the_button(client):
    r = client.post("/login", data={"password": "correct horse"}, headers={"Origin": "http://bedrock-now.localhost"})
    assert r.status_code == 303
    page = client.get("/").text
    # not deferred (a collapsed sidebar is collapsed from the first paint), in <head>, before the deferred scripts
    assert '<script src="/static/nav.js"></script>' in page
    assert page.index('src="/static/nav.js"') < page.index('src="/static/app.js"') < page.index("</head>")
    # the button: in the sidebar, hidden until nav.js wires it, named, and saying what it controls and its state
    tag = re.search(r'<button [^>]*id="nav-toggle"[^>]*>', page).group(0)
    for attr in ('aria-controls="sidebar"', 'aria-expanded="true"', 'aria-label="Sidebar"', " hidden"):
        assert attr in tag, attr
    assert '<nav class="sidebar" id="sidebar" aria-label="Apps">' in page
    assert page.index('id="nav-toggle"') < page.index('class="tabs"')
    assert "style=" not in page and "<script>" not in page   # (CSP: no inline style or script)


def test_nav_js_is_served_with_its_type_and_security_headers(client):
    r = client.get("/static/nav.js")
    assert r.status_code == 200 and "javascript" in r.headers["content-type"]
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "script-src 'self'" in r.headers["content-security-policy"]


def test_nav_js_keeps_the_choice_in_this_browser_only_and_never_parses_html():
    js = (STATIC / "nav.js").read_text(encoding="utf-8")
    for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "fetch("):
        assert sink not in js, sink
    # every storage access in a try (blocked storage: expanded, the page works)
    for line in js.splitlines():
        if "localStorage." in line:
            assert "try {" in line, line
    assert 'html.classList.toggle("nav-collapsed", collapsed)' in js   # at load: <html> exists before <body> is parsed


def test_one_set_of_rules_for_the_icon_rail_tablets_and_a_collapsed_desktop_sidebar():
    mobile, app, act, tour = css("mobile.css"), css("app.css"), css("activity.css"), css("tour.css")
    # the sidebar is the "rail" container on tablets, and on a desktop while collapsed
    assert "container: rail / inline-size" in block(mobile, TABLET)
    desk = block(app, "@media (min-width: 1100px)")
    assert re.search(r"html\.nav-collapsed \.sidebar \{ container: rail / inline-size;", desk)
    assert "grid-template-columns: 76px minmax(0, 1fr)" in desk and "html.nav-collapsed body.shell.tour-open" in desk
    # what is inside the rail: container rules, no longer a tablet media query of their own
    for name, text, sel in (("mobile.css", mobile, ".tab {"), ("activity.css", act, ".side-search {"), ("tour.css", tour, ".tour-btn {")):
        assert sel in block(text, "@container rail (min-width: 0px)"), name
    assert TABLET not in act and TABLET not in tour
    assert ".tab {" not in block(mobile, TABLET)
    # the button: desktops only; the width animates, never with reduced motion
    assert ".nav-toggle { display: none; }" in app
    assert "html.nav-anim body.shell { transition: grid-template-columns" in desk
    assert re.search(r"prefers-reduced-motion: reduce\) \{\n  \.toast, html\.nav-anim body\.shell \{ transition: none; \}", app)


def test_the_walkthrough_and_the_tabs_tooltips_follow_the_rail():
    tour, mobile = (STATIC / "tour.js").read_text(encoding="utf-8"), (STATIC / "mobile.js").read_text(encoding="utf-8")
    for js in (tour, mobile):
        assert "bnNav.rail()" in js and 'addEventListener("bn:nav"' in js
    # the card's behaviour (Escape closes it, it steps aside for an app) is the rail's, not only a tablet's
    assert "TABLET.matches)" not in tour.replace("bnNav.rail() : TABLET.matches)", "")
    # a collapsed sidebar keeps the rail with the walkthrough open; Home keeps its two columns then
    assert "html:not(.nav-collapsed) body.tour-open .grid" in css("tour.css")
