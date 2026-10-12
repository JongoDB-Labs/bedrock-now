from dataclasses import replace

import pytest

from portal.config import ConfigError, from_env
from portal.security import LoginThrottle, Sessions, password_ok, safe_next, same_origin

SECRET = "x" * 40


def test_password_ok_is_exact():
    assert password_ok("abc", "abc")
    assert not password_ok("abc", "abcd")
    assert not password_ok("", "abc")


def test_session_round_trip_and_tamper():
    s = Sessions(SECRET, "pw")
    tok = s.issue()
    assert s.valid(tok)
    assert not s.valid(tok[:-2] + ("A" if tok[-1] != "A" else "B") + tok[-1])
    assert not s.valid("")
    assert not s.valid(None)
    assert not Sessions("y" * 40, "pw").valid(tok)  # other secret


def test_session_dies_when_password_changes():
    tok = Sessions(SECRET, "pw").issue()
    assert not Sessions(SECRET, "new pw").valid(tok)


def test_session_expires_after_30_days(monkeypatch):
    import itsdangerous.timed as timed
    s = Sessions(SECRET, "pw")
    monkeypatch.setattr(timed.time, "time", lambda: 1_000_000.0)
    tok = s.issue()
    monkeypatch.setattr(timed.time, "time", lambda: 1_000_000.0 + 29 * 86400)
    assert s.valid(tok)
    monkeypatch.setattr(timed.time, "time", lambda: 1_000_000.0 + 31 * 86400)
    assert not s.valid(tok)


def test_revoke_all_invalidates_earlier_sessions_only():
    now = [100.0]
    s = Sessions(SECRET, "pw", clock=lambda: now[0])
    old = s.issue()
    now[0] = 101.0
    s.revoke_all()
    now[0] = 101.5
    new = s.issue()
    assert not s.valid(old)
    assert s.valid(new)


def test_throttle_backs_off_and_resets():
    t = [0.0]
    th = LoginThrottle(clock=lambda: t[0])
    for _ in range(LoginThrottle.FREE - 1):
        th.failure()
    assert th.retry_after() == 0
    th.failure()
    assert th.retry_after() == 2
    th.failure()
    assert th.retry_after() == 4
    for _ in range(20):
        th.failure()
    assert th.retry_after() == LoginThrottle.MAX_LOCK
    th.success()
    assert th.retry_after() == 0


@pytest.mark.parametrize("raw,want", [
    (None, "/"), ("", "/"), ("/", "/"), ("/x?y=1", "/x?y=1"),
    ("//evil.com/", "/"), ("/\\evil.com", "/"),
    ("http://chat.bedrock-now.localhost/c/1", "http://chat.bedrock-now.localhost/c/1"),
    ("http://admin.bedrock-now.localhost/ui/", "http://admin.bedrock-now.localhost/ui/"),
    ("http://bedrock-now.localhost/", "http://bedrock-now.localhost/"),
    ("http://evil.com/", "/"), ("https://chat.bedrock-now.localhost/", "/"),
    ("http://evil.bedrock-now.localhost/", "/"), ("http://chat.bedrock-now.localhost.evil.com/", "/"),
    ("http://chat.bedrock-now.localhost:8800/", "/"), ("http://user@chat.bedrock-now.localhost/", "/"),
    ("javascript:alert(1)", "/"), ("http://chat.bedrock-now.localhost/\nx", "/"),
    ("http://chat.bedrock-now.localhost:99999/", "/"),
])
def test_safe_next(settings, raw, want):
    assert safe_next(raw, settings) == want


def test_safe_next_checks_port(settings):
    s = replace(settings, port=8800)
    assert safe_next("http://chat.bedrock-now.localhost:8800/", s) == "http://chat.bedrock-now.localhost:8800/"
    assert safe_next("http://chat.bedrock-now.localhost/", s) == "/"


def test_same_origin(settings):
    assert same_origin({"origin": "http://bedrock-now.localhost"}, settings)
    assert not same_origin({"origin": "http://evil.com"}, settings)
    assert not same_origin({"origin": "null"}, settings)
    assert not same_origin({"origin": "http://chat.bedrock-now.localhost"}, settings)
    assert same_origin({"referer": "http://bedrock-now.localhost/login"}, settings)
    assert not same_origin({"referer": "http://bedrock-now.localhost.evil.com/"}, settings)
    assert not same_origin({}, settings)
    assert same_origin({"origin": "http://bedrock-now.localhost:8800"}, replace(settings, port=8800))


def test_from_env_requires_secrets_and_lowercases_email():
    with pytest.raises(ConfigError):
        from_env({"PORTAL_SECRET": "z" * 40})
    with pytest.raises(ConfigError):
        from_env({"PORTAL_PASSWORD": "pw", "PORTAL_SECRET": "short"})
    s = from_env({"PORTAL_PASSWORD": "pw", "PORTAL_SECRET": "z" * 40, "PORTAL_USER_EMAIL": " Me@Example.COM ",
                  "PORTAL_PORT": "8800", "PORTAL_HOST": "BN-dev.localhost", "LITELLM_KEY_SETUP": "sk-s"})
    assert s.user_email == "me@example.com"
    assert s.port == 8800 and s.host == "bn-dev.localhost"
    assert s.origin("chat") == "http://chat.bn-dev.localhost:8800"
    assert ("setup", "Setup and tests", "sk-s") in s.keys
