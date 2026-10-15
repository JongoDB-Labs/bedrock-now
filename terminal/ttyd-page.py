"""ttyd's own page (fetched from ttyd at image build) → the page bn-terminal serves with --index: the same page plus a
viewport for phones (without one they lay it out 980 px wide; the on-screen keyboard then resizes it instead of
covering the prompt), the terminal's background as theme colour, and a bedrock-now icon instead of ttyd's.
Then the page's one inline script must hash to SHA256 (the main Caddy's Content-Security-Policy for the terminal
host allows only that script: caddy/Caddyfile, terminal_page): a new ttyd fails the build here, not in browsers.
Usage: python3 ttyd-page.py IN OUT SHA256"""

import base64
import hashlib
import re
import sys

ICON = ("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 20 20%27%3E"
        "%3Crect width=%2720%27 height=%2720%27 rx=%274%27 fill=%27%23111820%27/%3E"
        "%3Cpath d=%27M5 7l3 3-3 3M10 13h5%27 fill=%27none%27 stroke=%27%2373b6cd%27 stroke-width=%271.8%27 "
        "stroke-linecap=%27round%27/%3E%3C/svg%3E")
META = ('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, '
        'interactive-widget=resizes-content"><meta name="theme-color" content="#111820">')

page = open(sys.argv[1], encoding="utf-8").read()
assert 'name="viewport"' not in page, "ttyd's page has a viewport of its own now: check this script"
page, n = re.subn(r'<meta charset="UTF-8">', lambda m: m.group(0) + META, page, count=1)
assert n == 1, "no <meta charset> in ttyd's page"
page, n = re.subn(r'<link rel="icon"[^>]*>', lambda m: f'<link rel="icon" href="{ICON}">', page, count=1)
assert n == 1, "no icon link in ttyd's page"
open(sys.argv[2], "w", encoding="utf-8", newline="").write(page)

# The hash browsers compute: over the script's text as served (UTF-8, no carriage returns to normalise).
served = open(sys.argv[2], "rb").read()
scripts = re.findall(rb"<script\b[^>]*>(.*?)</script>", served, re.S)
assert len(scripts) == 1 and b"\r" not in scripts[0], f"ttyd's page has {len(scripts)} inline scripts (or CRs): check its CSP"
got = base64.b64encode(hashlib.sha256(scripts[0]).digest()).decode()
want = sys.argv[3].removeprefix("sha256-")
if got != want:
    sys.exit(f"ttyd's page script is sha256-{got}, not the pinned sha256-{want}: put the new hash in terminal/Dockerfile "
             "(TTYD_PAGE_SCRIPT_SHA256) and caddy/Caddyfile (terminal_page), after checking what changed")
