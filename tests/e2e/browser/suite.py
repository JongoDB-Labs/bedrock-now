"""bedrock-now e2e browser suite: HTTP, LiteLLM, shared-mcp and Chromium checks against a throwaway stack.
Run by tests/e2e/browser.sh inside the pinned Playwright container; writes /out/results.tsv, screenshots (/out/shots),
network/console logs (/out/net, redacted) and tracebacks (/out/tracebacks, redacted)."""

from __future__ import annotations

import json
import sys

from playwright.sync_api import sync_playwright

import checks_api  # noqa: F401 — registers checks
import checks_artifact  # noqa: F401
import checks_browser  # noqa: F401
import checks_code  # noqa: F401
import checks_http  # noqa: F401
import checks_preview  # noqa: F401
import checks_terminal  # noqa: F401
import checks_voice  # noqa: F401
from common import CHECKS, ENV, HOST, RESULTS, TARGET_IP, origin, portal_login, run_all
from checks_browser import Recorder

DEVICES = {
    "desktop": {"viewport": {"width": 1400, "height": 900}},
    "phone": {"viewport": {"width": 390, "height": 844}, "is_mobile": True, "has_touch": True, "device_scale_factor": 3,
              "user_agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
                            "Chrome/140.0.0.0 Mobile Safari/537.36"},
    "tablet": {"viewport": {"width": 820, "height": 1180}, "is_mobile": True, "has_touch": True, "device_scale_factor": 2,
               "user_agent": "Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) "
                             "Chrome/140.0.0.0 Safari/537.36"},
}


class Ctx:
    def __init__(self, browser):
        self.browser = browser
        self._session = None
        self._contexts = []
        self.rag_file = None   # set by chat-file-upload-rag: the upload files-rustfs-console-pages looks for

    # raw-HTTP session cookie (checks_http)
    def session(self) -> str:
        if self._session is None:
            self._session = portal_login()
        return self._session

    def reset_session(self):
        self._session = None

    def enabled_rows(self) -> list[dict]:
        """The enabled models as the portal reports them ({name, kind, display, …}; kind: chat/embed/rerank/image/stt)."""
        import json
        from common import http
        r = http("GET", None, "/api/summary", {"X-Requested-With": "bedrock-now"}, cookie=self.session())
        return [m for m in json.loads(r.body)["models"]["rows"] if m["enabled"]]

    def enabled_models(self) -> list[str]:
        return [m["name"] for m in self.enabled_rows()]

    def page(self, name: str, device: str = "desktop", tour: bool = False):
        """A new browser context (no cookies) and page with a Recorder attached. The portal's walkthrough opens by
        itself on a first visit (desktop, tablet) and narrows the apps' frames: closed in every context but the
        walkthrough checks' own (tour=True), which see a first visit."""
        for c in self._contexts:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
        self._contexts = []
        c = self.browser.new_context(locale="en-US", timezone_id="UTC", accept_downloads=True, **DEVICES[device])
        self._contexts.append(c)
        if not tour:
            c.add_init_script("(o => { try { if (location.origin === o && !localStorage.getItem('bn.tour')) "
                              "localStorage.setItem('bn.tour', JSON.stringify({open: false})); } catch (e) {} })"
                              f"({json.dumps(origin())});")
        rec = Recorder(name)
        p = rec.attach(c.new_page())
        p.set_default_timeout(30000)
        return p, rec


def main() -> int:
    RESULTS.write_text("", encoding="utf-8")
    # Settings change credentials (after the rest), sign-out checks revoke every session (last)
    CHECKS.sort(key=lambda c: {"settings": 1, "final": 2}.get(c[0], 0))
    print(f"bedrock-now e2e: http://{HOST} via {TARGET_IP}, {len(CHECKS)} checks", flush=True)
    with sync_playwright() as p:
        # *.localhost always means loopback in Chromium: point the throwaway's names at the host instead.
        # A fake microphone (Chromium's test tone, no prompt) so Open WebUI's Call can start without a device.
        # (and the Code page's previews: their own site, PREVIEW_DOMAIN)
        preview = f", MAP *.{ENV['PREVIEW_DOMAIN']} {TARGET_IP}" if ENV.get("PREVIEW_DOMAIN") else ""
        browser = p.chromium.launch(args=[f"--host-resolver-rules=MAP {HOST} {TARGET_IP}, MAP *.{HOST} {TARGET_IP}{preview}",
                                          "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
        fails = run_all(Ctx(browser))
        browser.close()
    print(f"done: {fails} failed", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
