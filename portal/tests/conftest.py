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
