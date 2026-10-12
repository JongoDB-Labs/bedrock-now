import httpx
import pytest
import respx

from shared_mcp.openwebui import OpenWebUI

BASE = "http://owui"


@pytest.fixture
def owui():
    return OpenWebUI(BASE, "k-123", process_timeout=0.5, poll_interval=0.01)


@respx.mock
def test_list_knowledge_bases_handles_list_and_paged_shapes(owui):
    route = respx.get(f"{BASE}/api/v1/knowledge/")
    route.return_value = httpx.Response(200, json=[{"id": "1", "name": "Docs", "description": "d"}])
    assert owui.list_knowledge_bases() == [{"id": "1", "name": "Docs", "description": "d"}]
    route.return_value = httpx.Response(200, json={"items": [{"id": "2", "name": "X"}], "total": 1})
    assert owui.list_knowledge_bases() == [{"id": "2", "name": "X", "description": ""}]
    assert route.calls.last.request.headers["authorization"] == "Bearer k-123"


@respx.mock
def test_resolve_by_name_or_id(owui):
    respx.get(f"{BASE}/api/v1/knowledge/").return_value = httpx.Response(200, json=[{"id": "abc", "name": "Docs"}])
    assert owui.resolve_kb("Docs") == "abc"
    assert owui.resolve_kb("abc") == "abc"
    with pytest.raises(LookupError):
        owui.resolve_kb("Nope")


@respx.mock
def test_resolve_creates_when_asked(owui):
    respx.get(f"{BASE}/api/v1/knowledge/").return_value = httpx.Response(200, json=[])
    create = respx.post(f"{BASE}/api/v1/knowledge/create").mock(return_value=httpx.Response(200, json={"id": "new"}))
    assert owui.resolve_kb("Claude Code", create=True) == "new"
    assert create.called


@respx.mock
def test_search_flattens_results(owui):
    respx.post(f"{BASE}/api/v1/retrieval/query/collection").return_value = httpx.Response(200, json={
        "documents": [["chunk one", "chunk two"]],
        "metadatas": [[{"name": "a.pdf"}, {"source": "b.md"}]],
        "distances": [[0.9, 0.5]],
    })
    hits = owui.search("q", ["abc"], k=2)
    assert hits == [
        {"text": "chunk one", "source": "a.pdf", "score": 0.9},
        {"text": "chunk two", "source": "b.md", "score": 0.5},
    ]
    sent = respx.calls.last.request
    assert b'"collection_names":["abc"]' in sent.content.replace(b" ", b"")


@respx.mock
def test_ingest_uploads_then_attaches(owui):
    respx.get(f"{BASE}/api/v1/knowledge/").return_value = httpx.Response(200, json=[{"id": "kb1", "name": "Docs"}])
    up = respx.post(f"{BASE}/api/v1/files/").mock(return_value=httpx.Response(200, json={"id": "f1"}))
    status = respx.get(f"{BASE}/api/v1/files/f1/process/status").mock(side_effect=[
        httpx.Response(200, json={"status": "pending"}),
        httpx.Response(200, json={"status": "completed"}),
    ])
    add = respx.post(f"{BASE}/api/v1/knowledge/kb1/file/add").mock(return_value=httpx.Response(200, json={}))
    assert owui.ingest("r.md", b"# hi", "Docs") == {"knowledge_base_id": "kb1", "file_id": "f1"}
    assert up.called and add.called and status.call_count == 2
    assert b'"file_id":"f1"' in add.calls.last.request.content.replace(b" ", b"")


def _upload_routes(status_json):
    respx.get(f"{BASE}/api/v1/knowledge/").return_value = httpx.Response(200, json=[{"id": "kb1", "name": "Docs"}])
    respx.post(f"{BASE}/api/v1/files/").mock(return_value=httpx.Response(200, json={"id": "f1"}))
    respx.get(f"{BASE}/api/v1/files/f1/process/status").mock(return_value=httpx.Response(200, json=status_json))
    return respx.post(f"{BASE}/api/v1/knowledge/kb1/file/add").mock(return_value=httpx.Response(200, json={}))


@respx.mock
def test_ingest_stops_when_processing_fails(owui):
    add = _upload_routes({"status": "failed"})
    respx.get(f"{BASE}/api/v1/files/f1").mock(return_value=httpx.Response(404))
    with pytest.raises(RuntimeError, match="failed to process"):
        owui.ingest("r.md", b"# hi", "Docs")
    assert not add.called


@respx.mock
def test_ingest_failure_includes_open_webui_error_detail(owui):
    # v0.12: /process/status only says "failed"; the reason is stored in the file's data.error
    add = _upload_routes({"status": "failed"})
    respx.get(f"{BASE}/api/v1/files/f1").mock(return_value=httpx.Response(
        200, json={"id": "f1", "data": {"status": "failed", "error": "No embedding model configured"}}))
    with pytest.raises(RuntimeError, match="failed to process file f1: No embedding model configured"):
        owui.ingest("r.md", b"# hi", "Docs")
    assert not add.called


@respx.mock
def test_ingest_failure_prefers_error_in_status_response(owui):
    _upload_routes({"status": "failed", "error": "content is empty"})
    file_route = respx.get(f"{BASE}/api/v1/files/f1").mock(return_value=httpx.Response(500))
    with pytest.raises(RuntimeError, match="f1: content is empty"):
        owui.ingest("r.md", b"# hi", "Docs")
    assert not file_route.called


@respx.mock
def test_ingest_failure_without_detail_points_to_logs(owui):
    _upload_routes({"status": "failed"})
    respx.get(f"{BASE}/api/v1/files/f1").mock(return_value=httpx.Response(500))
    with pytest.raises(RuntimeError, match="gave no reason.*stack logs open-webui"):
        owui.ingest("r.md", b"# hi", "Docs")


@respx.mock
def test_ingest_times_out_while_processing(owui):
    add = _upload_routes({"status": "processing"})
    with pytest.raises(TimeoutError):
        owui.ingest("r.md", b"# hi", "Docs")
    assert not add.called


def test_client_timeouts(owui):
    assert owui.http.timeout.connect == 5
    assert owui.http.timeout.read == 120
