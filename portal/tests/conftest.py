import pytest

from portal.config import Settings

SECRET = "s" * 64


@pytest.fixture
def settings(tmp_path):
    lit = tmp_path / "litellm"; lit.mkdir()
    cat = tmp_path / "catalog"; cat.mkdir()
    return Settings(
        password="correct horse", secret=SECRET, host="bedrock-now.localhost", port=80, user_email="admin@example.com",
        litellm_master_key="sk-master",
        keys=(("claude-code", "Claude Code", "sk-cc"), ("open-webui", "Chat (Open WebUI)", "sk-ow"), ("setup", "Setup and tests", "")),
        litellm_ui_password="ui-pass", rustfs_access_key="bn-access", rustfs_secret_key="rustfs-secret",
        litellm_dir=lit, catalog_dir=cat, prices_dir=tmp_path / "prices",
    )
