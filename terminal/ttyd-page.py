"""ttyd's own page (fetched from ttyd at image build) → the page bn-terminal serves with --index: the same page plus a
viewport for phones (without one they lay it out 980 px wide; the on-screen keyboard then resizes it instead of
covering the prompt), the terminal's background as theme colour, and a bedrock-now icon instead of ttyd's.
Usage: python3 ttyd-page.py IN OUT"""

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
open(sys.argv[2], "w", encoding="utf-8").write(page)
