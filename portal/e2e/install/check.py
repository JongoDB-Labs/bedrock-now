"""Opt-in end-to-end check of "Install app" (run.sh by hand; not in tests/run.sh or CI), entirely inside one
throwaway container: the real portal on
http://bedrock-now.localhost:8000, Chromium on a virtual display with a throwaway profile, driven over CDP.

  1. Chrome finds the portal installable (Page.getInstallabilityErrors) from the login page and from Home.
  2. After sign-in, beforeinstallprompt fires and the sidebar and Home "Install app" buttons appear.
  3. A real click on "Install app" and the browser's own Install dialog install it: Chromium writes the
     ~/.local/share/applications entry, named after the manifest.
  4. lib/open.sh finds that entry by name, and `./stack open` (cmd_open) opens the app: a standalone window
     in which the Install buttons are hidden.
     A second portal tab, open in the background meanwhile, switches to "Open in the app".
  5. A browser tab of the same site knows the app is installed (getInstalledRelatedApps lists it, no
     beforeinstallprompt) and shows "Open in the app" instead of Install; the link uses the manifest's own
     scheme, which Chromium registered with the desktop (MimeType=x-scheme-handler/...).
  6. A real click on it: the browser asks ("Open …?", then the app's "Allow app to open … links?"; both
     answered with their box ticked), the open app window comes forward on the tab's tab, and the tab says it
     can be closed. A second click asks nothing. With the app window closed, a click starts it on the tab's tab.
  7. Uninstalled (chrome://app-settings, keeping its data): the tab offers Install again.
Prints the results as JSON and exits 1 if any check fails.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

import websocket

PORT, HOST = os.environ["PORTAL_PORT"], os.environ["PORTAL_HOST"]
ORIGIN = f"http://{HOST}:{PORT}"
NAME = "bedrock-now (port 8000)"
DEVTOOLS = "http://127.0.0.1:9222"


def wait_for(url):
    for _ in range(100):
        try:
            return urllib.request.urlopen(url).read()
        except OSError:
            time.sleep(0.2)
    sys.exit(f"{url} never answered")


class Page:
    def __init__(self, target):
        url = target if isinstance(target, str) else target["webSocketDebuggerUrl"]
        self.ws, self.n = websocket.create_connection(url, timeout=30), 0

    def __call__(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.n:
                return m.get("result", {"error": m.get("error")})

    def js(self, expr):
        return self("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)["result"].get("value")


def pages():
    return [t for t in json.loads(wait_for(f"{DEVTOOLS}/json")) if t["type"] == "page"]


def stack(script):
    env = dict(os.environ, STACK_DIR="/stack", ENV_FILE="/tmp/test.env", STATE_DIR="/tmp/state")
    with open("/tmp/test.env", "w") as f:
        f.write(f"PORTAL_HOST={HOST}\nPORTAL_PORT={PORT}\n")
    return subprocess.run(["bash", "-c", ". /stack/lib/common.sh; . /stack/lib/ports.sh; . /stack/lib/portal.sh; "
                           ". /stack/lib/open.sh; open_os() { echo Linux; }; " + script],
                          env=env, capture_output=True, text=True, timeout=60)


VISIBLE_INSTALL = "[...document.querySelectorAll('[data-install]')].filter(b => !b.hidden).length"
OPEN_LINKS = "[...document.querySelectorAll('[data-open-app]')].filter(a => !a.hidden).map(a => a.href)"
NOTE = "document.getElementById('app-note-text').textContent"
CUR_TAB = "document.querySelector('.tab[aria-current=page]').dataset.tab"
# Every state install.js went through, with when (ms after the page started).
STATES = ("window.__bip = 0; addEventListener('beforeinstallprompt', () => __bip++); window.__states = [];"
          "document.addEventListener('bn:app', e => __states.push([e.detail, Math.round(performance.now())]))")


def click(page, selector):
    """A real (trusted) click in the middle of the element."""
    x, y = page.js(f"(() => {{ const r = document.querySelector({json.dumps(selector)}).getBoundingClientRect();"
                   " return [r.x + r.width / 2, r.y + r.height / 2]; })()")
    for kind in ("mousePressed", "mouseReleased"):
        page("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left", clickCount=1)


def keys(*k):
    subprocess.run(["xdotool", *[a for key in k for a in ("key", key)]])


def tick_and_accept():
    """The browser's and the app's link dialogs: focus starts on Cancel / Don't allow; the box is before it, the
    accepting button after it."""
    keys("shift+Tab", "space", "Tab", "Tab", "Return")


def wait_js(page, expr, timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = page.js(expr)
        if v:
            return v
        time.sleep(0.25)
    return page.js(expr)

subprocess.Popen([sys.executable, "-m", "portal"], cwd="/app", stderr=subprocess.DEVNULL)
wait_for(f"http://127.0.0.1:{PORT}/healthz")
subprocess.Popen(["Xvfb", ":99", "-screen", "0", "1400x900x24"], stderr=subprocess.DEVNULL)
os.environ["DISPLAY"] = ":99"
time.sleep(1)
subprocess.Popen(["chromium", "--no-first-run", "--test-type", "--window-size=1380,860", "--password-store=basic",
                  "--remote-debugging-port=9222", f"--remote-allow-origins={DEVTOOLS}", "--user-data-dir=/tmp/profile",
                  "about:blank"], stderr=subprocess.DEVNULL)
first_id = pages()[0]["id"]
tab = Page(pages()[0])
tab("Page.enable"); tab("Runtime.enable")
tab("Page.addScriptToEvaluateOnNewDocument", source="window.__bip = 0; addEventListener('beforeinstallprompt', () => __bip++)")

r = {"chromium": subprocess.run(["chromium", "--version"], capture_output=True, text=True).stdout.strip()}
tab("Page.navigate", url=f"{ORIGIN}/login"); time.sleep(2)
r["login: installability errors"] = tab("Page.getInstallabilityErrors").get("installabilityErrors")
r["login: manifest errors"] = tab("Page.getAppManifest").get("errors")
tab.js("fetch('/login', {method: 'POST', body: new URLSearchParams({password: 'correct horse'}), redirect: 'manual'})"
       ".then(() => { location.assign('/'); return true; })")
time.sleep(4)
r["home: installability errors"] = tab("Page.getInstallabilityErrors").get("installabilityErrors")
r["home: beforeinstallprompt fired"] = tab.js("__bip") >= 1
r["home: install buttons shown"] = tab.js(VISIBLE_INSTALL)
r["home: install note shown"] = tab.js("!document.getElementById('install-note').hidden")

# A second tab of the portal, left open in the background while the first one installs the app.
browser = Page(json.loads(wait_for(f"{DEVTOOLS}/json/version"))["webSocketDebuggerUrl"])
other_id = browser("Target.createTarget", url=f"{ORIGIN}/#home", background=True)["targetId"]
time.sleep(4)
other = Page([t for t in pages() if t["id"] == other_id][0]); other("Runtime.enable")
r["other tab before install: state"] = other.js("document.documentElement.dataset.appState")
browser("Target.activateTarget", targetId=first_id)

# A real click (user gesture) on Home's Install app, then the browser's dialog: Cancel has focus, Tab → Install.
x, y = tab.js("(() => { const b = document.querySelector('#install-note [data-install]').getBoundingClientRect();"
              " return [b.x + b.width / 2, b.y + b.height / 2]; })()")
for kind in ("mousePressed", "mouseReleased"):
    tab("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left", clickCount=1)
time.sleep(3)
subprocess.run(["xdotool", "key", "Tab", "key", "Return"])
time.sleep(6)

r["other tab after install: state, install buttons, open links"] = [
    other.js("document.documentElement.dataset.appState"), other.js(VISIBLE_INSTALL), len(other.js(OPEN_LINKS))]
browser("Target.closeTarget", targetId=other_id)

apps = os.path.expanduser("~/.local/share/applications")
entries = {f: open(os.path.join(apps, f)).read() for f in os.listdir(apps)} if os.path.isdir(apps) else {}
r["installed: desktop entries"] = {f: [ln for ln in body.splitlines() if ln.startswith(("Name=", "Icon="))]
                                   for f, body in entries.items()}
found = stack("open_installed_app")
r["open.sh: app name"] = stack("portal_app_name").stdout.strip()
r["open.sh: found entry"] = os.path.basename(found.stdout.strip())

opened = stack("cmd_open")
r["stack open: log"] = opened.stderr.strip().splitlines()
time.sleep(5)
app = Page([t for t in pages() if t["url"].startswith(ORIGIN)][0])
app("Runtime.enable")
r["app window: display-mode standalone"] = app.js("matchMedia('(display-mode: standalone)').matches")
r["app window: install buttons shown"] = app.js(VISIBLE_INSTALL)
r["app window: open links shown"] = len(app.js(OPEN_LINKS))
r["app window: bn.app"] = app.js("localStorage.getItem('bn.app')")
if os.path.isdir("/out"):
    subprocess.run(["import", "-window", "root", "/out/installed-app.png"], stderr=subprocess.DEVNULL)

# 5. A browser tab of the same site (a new browser window: the first tab became the app window).
tab_id = browser("Target.createTarget", url="about:blank", newWindow=True)["targetId"]
tab = Page([t for t in pages() if t["id"] == tab_id][0])
tab("Page.enable"); tab("Runtime.enable")
tab("Page.addScriptToEvaluateOnNewDocument", source=STATES)
tab("Page.navigate", url=f"{ORIGIN}/#chat")
wait_js(tab, "document.documentElement.dataset.appState === 'open'")
time.sleep(3)   # beforeinstallprompt would have come by now
manifest = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/manifest.webmanifest").read())
scheme = manifest["protocol_handlers"][0]["protocol"]
r["tab: related apps"] = tab.js("navigator.getInstalledRelatedApps()")
r["tab: beforeinstallprompt fired"] = tab.js("__bip")
r["tab: states"] = tab.js("__states")
r["tab: install buttons shown"] = tab.js(VISIBLE_INSTALL)
r["tab: open links"] = tab.js(OPEN_LINKS)
r["tab: note"] = tab.js(NOTE)
entry = next((body for body in entries.values() if f"Name={NAME}" in body), "")
r["desktop entry: MimeType"] = [ln for ln in entry.splitlines() if ln.startswith("MimeType=")]

# 6. Open in the app, for real: the browser's two questions the first time, then the app comes forward on #chat.
click(tab, ".sidebar [data-open-app]")
time.sleep(2)
r["first click: tab has focus during the browser's question"] = tab.js("document.hasFocus()")
if os.path.isdir("/out"):
    subprocess.run(["import", "-window", "root", "/out/open-dialog.png"], stderr=subprocess.DEVNULL)
tick_and_accept()    # "Open bedrock-now (port 8000)?" + Always allow
time.sleep(3)
tick_and_accept()    # "Allow app to open web+… links?" + Remember this choice
r["first click: app window tab"] = wait_js(app, f"{CUR_TAB} === 'chat' && {CUR_TAB}") or app.js(CUR_TAB)
r["first click: tab note"] = wait_js(tab, f"{NOTE}.startsWith('Opened') && {NOTE}") or tab.js(NOTE)
tab.js("location.hash = '#admin'")
time.sleep(1)
t0 = time.time()
click(tab, ".sidebar [data-open-app]")
r["second click: tab note"] = wait_js(tab, f"{NOTE}.includes('Opening') ? '' : {NOTE}", timeout=10)
r["second click: seconds to the app's answer"] = round(time.time() - t0, 1)
r["second click: app window tab"] = app.js(CUR_TAB)
app_id = [t for t in pages() if t["url"].startswith(ORIGIN) and t["id"] != tab_id][0]["id"]
browser("Target.closeTarget", targetId=app_id)
time.sleep(2)
tab.js("location.hash = '#files'")
time.sleep(1)
click(tab, ".sidebar [data-open-app]")
time.sleep(6)
cold = [t for t in pages() if t["url"].startswith(ORIGIN) and t["id"] != tab_id]
r["cold start: app windows"] = len(cold)
if cold:
    app2 = Page(cold[0]); app2("Runtime.enable")
    r["cold start: app window"] = app2.js("[location.pathname + location.search + location.hash, "
                                          f"matchMedia('(display-mode: standalone)').matches, {CUR_TAB}]")
r["cold start: tab note"] = tab.js(NOTE)

# 7. Uninstall it (App Settings → Uninstall, data kept): the tab offers Install again.
app_key = next(f for f in entries if f"Name={NAME}" in entries[f]).split("-")[1]
settings_id = browser("Target.createTarget", url=f"chrome://app-settings/{app_key}", newWindow=True)["targetId"]
time.sleep(3)
settings = Page([t for t in pages() if t["id"] == settings_id][0]); settings("Runtime.enable")
pos = settings.js("""(() => { const found = []; const walk = (root) => { for (const n of root.querySelectorAll('*')) {
  if (n.shadowRoot) walk(n.shadowRoot); if (n.tagName === 'CR-BUTTON' && n.textContent.trim() === 'Uninstall') found.push(n); } };
  walk(document); const r = found.length && found[0].getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()""")
if pos:
    for kind in ("mousePressed", "mouseReleased"):
        settings("Input.dispatchMouseEvent", type=kind, x=pos[0], y=pos[1], button="left", clickCount=1)
    time.sleep(3)
    keys("Return")   # "Uninstall app?": Uninstall has the focus, "Remove this app's data" stays unticked
    time.sleep(4)
r["uninstalled: desktop entries"] = sorted(os.listdir(apps)) if os.path.isdir(apps) else []
r["uninstalled: the open tab, before a reload (info)"] = tab.js("document.documentElement.dataset.appState")
tab("Page.reload")
wait_js(tab, "document.documentElement.dataset.appState === 'install'")
r["uninstalled: tab"] = tab.js("navigator.getInstalledRelatedApps().then(a => ({state: document.documentElement.dataset.appState, "
                               "bip: __bip, flag: localStorage.getItem('bn.app'), related: a.length}))")
r["uninstalled: install buttons shown"] = tab.js(VISIBLE_INSTALL)
r["uninstalled: open links shown"] = len(tab.js(OPEN_LINKS))

print(json.dumps(r, indent=1))
checks = {
    "installable from the login page": r["login: installability errors"] == [] and r["login: manifest errors"] == [],
    "installable from Home": r["home: installability errors"] == [],
    "beforeinstallprompt shows both Install buttons and the note":
        r["home: beforeinstallprompt fired"] and r["home: install buttons shown"] == 2 and r["home: install note shown"],
    "installing writes a desktop entry named after the manifest":
        any(f"Name={NAME}" in body for body in entries.values()),
    "lib/open.sh finds it by name": r["open.sh: app name"] == NAME and r["open.sh: found entry"].endswith(".desktop"),
    "./stack open opens the installed app": opened.returncode == 0 and any("installed" in ln for ln in r["stack open: log"])
        and not any("did not start" in ln for ln in r["stack open: log"]),
    "the app window is standalone, offers neither Install nor Open, and marks the site (bn.app)":
        r["app window: display-mode standalone"] is True and r["app window: install buttons shown"] == 0
        and r["app window: open links shown"] == 0 and r["app window: bn.app"] == "1",
    "a tab left open while another installs the app switches to Open in the app":
        r["other tab after install: state, install buttons, open links"] == ["open", 0, 2],
    "a tab knows it is installed: getInstalledRelatedApps lists it, no beforeinstallprompt":
        r["tab: related apps"] == [{"id": f"{ORIGIN}/", "platform": "webapp", "url": f"{ORIGIN}/manifest.webmanifest"}]
        and r["tab: beforeinstallprompt fired"] == 0,
    "the tab shows Open in the app (sidebar + Home) and never Install, with no flash":
        r["tab: install buttons shown"] == 0 and len(r["tab: open links"]) == 2
        and [st for st, _ in r["tab: states"]] == ["none", "open"],
    "its link uses the site's own scheme, registered with the desktop":
        all(h.startswith(f"{scheme}://open?tab=chat&n=") for h in r["tab: open links"]) and scheme.startswith("web+bedrocknow")
        and any(f"x-scheme-handler/{scheme};" in ln for ln in r["desktop entry: MimeType"]),
    "first Open in the app: the browser asks, then the open app window shows the tab's tab and the tab says so":
        r["first click: tab has focus during the browser's question"] is False and r["first click: app window tab"] == "chat"
        and r["first click: tab note"] == "Opened in the app. You can close this tab.",
    "second Open in the app: no questions, the app switches tab and answers within seconds":
        r["second click: tab note"] == "Opened in the app. You can close this tab." and r["second click: app window tab"] == "admin",
    "with the app closed, Open in the app starts it on the tab's tab (/#files, no ?open= left)":
        r["cold start: app windows"] == 1 and r.get("cold start: app window") == ["/#files", True, "files"]
        and r["cold start: tab note"] == "Opened in the app. You can close this tab.",
    "uninstalled: the tab offers Install again and forgets the app":
        r["uninstalled: desktop entries"] == [] and r["uninstalled: tab"] == {"state": "install", "bip": 1, "flag": None, "related": 0}
        and r["uninstalled: install buttons shown"] == 2 and r["uninstalled: open links shown"] == 0,
}
for name, ok in checks.items():
    print(("ok   " if ok else "FAIL ") + name)
sys.exit(0 if all(checks.values()) else 1)
