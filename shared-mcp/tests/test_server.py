import inspect
import threading

import anyio
import pytest

from shared_mcp import server

TOOLS = [server.list_files, server.read_file, server.write_file,
         server.list_knowledge_bases, server.search_knowledge]


def test_tools_are_coroutines():
    assert all(inspect.iscoroutinefunction(t) for t in TOOLS)


def test_healthz_answers_while_a_tool_is_blocked(monkeypatch):
    started, release = threading.Event(), threading.Event()
    released_in_time = []

    class SlowStore:
        def list(self, prefix):
            started.set()
            released_in_time.append(release.wait(5))  # blocks a worker thread, not the event loop
            return {"files": [], "truncated": False}

    monkeypatch.setattr(server, "store", lambda: SlowStore())

    async def main():
        async with anyio.create_task_group() as tg:
            tg.start_soon(server.list_files)
            while not started.is_set():
                await anyio.sleep(0.01)
            assert (await server.healthz(None)).status_code == 200
            release.set()

    anyio.run(main)
    assert released_in_time == [True]


class FakeOWUI:
    def __init__(self, kbs=(), fail_ingest=False):
        self.kbs, self.fail_ingest = list(kbs), fail_ingest

    def list_knowledge_bases(self):
        return self.kbs

    def search(self, *a):
        raise AssertionError("search must not be called without knowledge bases")

    def ingest(self, *a):
        if self.fail_ingest:
            raise RuntimeError("boom")
        return {"knowledge_base_id": "kb1", "file_id": "f1"}


def test_search_knowledge_without_kbs_returns_empty(monkeypatch):
    monkeypatch.setattr(server, "owui", lambda: FakeOWUI())
    assert anyio.run(server.search_knowledge, "q") == []


class MemStore:
    def write_text(self, path, content):
        return path.lstrip("/")


def test_write_file_reports_ingest_error_but_keeps_file(monkeypatch):
    monkeypatch.setattr(server, "store", lambda: MemStore())
    monkeypatch.setattr(server, "owui", lambda: FakeOWUI(fail_ingest=True))
    assert anyio.run(server.write_file, "/r.md", "x", "Docs") == {"path": "r.md", "ingest_error": "RuntimeError: boom"}


def test_write_file_ingests(monkeypatch):
    monkeypatch.setattr(server, "store", lambda: MemStore())
    monkeypatch.setattr(server, "owui", lambda: FakeOWUI())
    assert anyio.run(server.write_file, "r.md", "x", "Docs")["ingested"] == {"knowledge_base_id": "kb1", "file_id": "f1"}


@pytest.mark.parametrize("missing", ["S3_ENDPOINT_URL", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])
def test_store_requires_s3_env(monkeypatch, missing):
    for name in ("S3_ENDPOINT_URL", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(name, "http://x" if name == "S3_ENDPOINT_URL" else "x")
    monkeypatch.delenv(missing)
    server.store.cache_clear()
    with pytest.raises(RuntimeError, match=missing):
        server.store()


@pytest.mark.parametrize("missing", ["OPENWEBUI_URL", "OPENWEBUI_API_KEY"])
def test_owui_requires_env(monkeypatch, missing):
    monkeypatch.setenv("OPENWEBUI_URL", "http://x")
    monkeypatch.setenv("OPENWEBUI_API_KEY", "k")
    monkeypatch.delenv(missing)
    server.owui.cache_clear()
    with pytest.raises(RuntimeError, match=missing):
        server.owui()


def test_s3_client_timeouts(monkeypatch):
    for name in ("S3_ENDPOINT_URL", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(name, "http://x" if name == "S3_ENDPOINT_URL" else "x")
    server.store.cache_clear()
    cfg = server.store().s3.meta.config
    server.store.cache_clear()
    assert (cfg.connect_timeout, cfg.read_timeout) == (3, 30)
    # botocore normalises retries={"max_attempts": 2} (2 retries) to 3 total attempts
    assert cfg.retries == {"mode": "standard", "total_max_attempts": 3}
