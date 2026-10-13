"""End-to-end check of "Install app", entirely inside one throwaway container (run.sh): the real portal on
http://bedrock-now.localhost:8000, Chromium on a virtual display with a throwaway profile, driven over CDP.

  1. Chrome finds the portal installable (Page.getInstallabilityErrors) from the login page and from Home.
  2. After sign-in, beforeinstallprompt fires and the sidebar and Home "Install app" buttons appear.
  3. A real click on "Install app" and the browser's own Install dialog install it: Chromium writes the
     ~/.local/share/applications entry, named after the manifest.
  4. lib/open.sh finds that entry by name, and `./stack open` (cmd_open) opens the app: a standalone window
     in which the Install buttons are hidden.
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
        self.ws, self.n = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=30), 0

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

subprocess.Popen([sys.executable, "-m", "portal"], cwd="/app", stderr=subprocess.DEVNULL)
wait_for(f"http://127.0.0.1:{PORT}/healthz")
subprocess.Popen(["Xvfb", ":99", "-screen", "0", "1400x900x24"], stderr=subprocess.DEVNULL)
os.environ["DISPLAY"] = ":99"
time.sleep(1)
subprocess.Popen(["chromium", "--no-first-run", "--test-type", "--window-size=1380,860", "--password-store=basic",
                  "--remote-debugging-port=9222", f"--remote-allow-origins={DEVTOOLS}", "--user-data-dir=/tmp/profile",
                  "about:blank"], stderr=subprocess.DEVNULL)
tab = Page(pages()[0])
tab("Page.enable"); tab("Runtime.enable")
tab("Page.addScriptToEvaluateOnNewDocument", source="window.__bip = 0; addEventListener('beforeinstallprompt', () => __bip++)")

r = {}
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

# A real click (user gesture) on Home's Install app, then the browser's dialog: Cancel has focus, Tab → Install.
x, y = tab.js("(() => { const b = document.querySelector('#install-note [data-install]').getBoundingClientRect();"
              " return [b.x + b.width / 2, b.y + b.height / 2]; })()")
for kind in ("mousePressed", "mouseReleased"):
    tab("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left", clickCount=1)
time.sleep(3)
subprocess.run(["xdotool", "key", "Tab", "key", "Return"])
time.sleep(6)

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
if os.path.isdir("/out"):
    subprocess.run(["import", "-window", "root", "/out/installed-app.png"], stderr=subprocess.DEVNULL)

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
    "the app window is standalone and offers no Install button":
        r["app window: display-mode standalone"] is True and r["app window: install buttons shown"] == 0,
}
for name, ok in checks.items():
    print(("ok   " if ok else "FAIL ") + name)
sys.exit(0 if all(checks.values()) else 1)
