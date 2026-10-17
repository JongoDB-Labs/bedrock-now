import pytest

from portal.config import Settings
from portal.security import hash_password

SECRET = "s" * 64
# Few rounds keep the tests fast; the format is the one ./stack writes (600000 rounds there).
PASSWORD_HASH = hash_password("correct horse", rounds=1000, salt=bytes.fromhex("0011223344556677"))


@pytest.fixture
def settings(tmp_path):
    lit = tmp_path / "litellm"; lit.mkdir()
    cat = tmp_path / "catalog"; cat.mkdir()
    return Settings(
        password_hash=PASSWORD_HASH, secret=SECRET, host="bedrock-now.localhost", port=80, user_email="admin@example.com",
        litellm_master_key="sk-master",
        keys=(("claude-code", "Claude Code", "sk-cc"), ("open-webui", "Chat (Open WebUI)", "sk-ow"), ("setup", "Setup and tests", "")),
        litellm_ui_password="ui-pass", rustfs_access_key="bn-access", rustfs_secret_key="rustfs-secret",
        litellm_dir=lit, catalog_dir=cat, prices_dir=tmp_path / "prices",
    )


@pytest.fixture
def just_replaced(monkeypatch):
    """just_replaced(*paths): the host has just renamed a new file over each of PATHS, as Docker Desktop's file
    sharing (macOS) shows that for 10-30 ms: the container is told it does not exist until something lists its
    folder (measured; portal/portal/hostfiles.py). Here each file is moved aside, and a listing of its folder puts it
    back first — whatever way the code reads the file, it is missing until then."""
    import os
    from pathlib import Path

    hidden = {}   # folder -> [(path, aside)]
    real_listdir = os.listdir

    def listdir(path="."):
        for p, aside in hidden.pop(os.path.realpath(os.fspath(path)), []):
            os.replace(aside, p)
        return real_listdir(path)

    monkeypatch.setattr(os, "listdir", listdir)

    def hide(*paths):
        for p in map(Path, paths):
            aside = p.with_name(f".{p.name}.aside")
            os.replace(p, aside)
            hidden.setdefault(os.path.realpath(p.parent), []).append((p, aside))
    return hide
