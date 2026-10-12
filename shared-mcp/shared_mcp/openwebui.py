"""Thin client for the Open WebUI REST API (knowledge bases + retrieval), authenticated with a user API key."""

import time

import httpx


def _flatten(result: dict) -> list[dict]:
    """Open WebUI returns Chroma-style nested lists; turn them into one hit per chunk."""
    docs = (result.get("documents") or [[]])[0]
    metas = (result.get("metadatas") or [[]])[0]
    dists = (result.get("distances") or [[]])[0]
    hits = []
    for i, text in enumerate(docs):
        meta = metas[i] if i < len(metas) and metas[i] else {}
        hits.append({"text": text,
                     "source": meta.get("name") or meta.get("source") or "",
                     "score": dists[i] if i < len(dists) else None})
    return hits


class OpenWebUI:
    def __init__(self, base_url: str, api_key: str, timeout: float = 120,
                 process_timeout: float = 120, poll_interval: float = 1.0):
        self.http = httpx.Client(base_url=base_url, timeout=httpx.Timeout(timeout, connect=5),
                                 headers={"Authorization": f"Bearer {api_key}"})
        self.process_timeout = process_timeout
        self.poll_interval = poll_interval

    def list_knowledge_bases(self) -> list[dict]:
        r = self.http.get("/api/v1/knowledge/")
        r.raise_for_status()
        data = r.json()
        items = data.get("items", []) if isinstance(data, dict) else data
        return [{"id": kb["id"], "name": kb["name"], "description": kb.get("description", "")}
                for kb in items]

    def resolve_kb(self, name_or_id: str, create: bool = False) -> str:
        for kb in self.list_knowledge_bases():
            if name_or_id in (kb["id"], kb["name"]):
                return kb["id"]
        if not create:
            raise LookupError(f"no knowledge base named {name_or_id!r}")
        r = self.http.post("/api/v1/knowledge/create",
                           json={"name": name_or_id, "description": "Created by Claude Code (shared-mcp)"})
        r.raise_for_status()
        return r.json()["id"]

    def search(self, query: str, kb_ids: list[str], k: int = 5) -> list[dict]:
        r = self.http.post("/api/v1/retrieval/query/collection",
                           json={"collection_names": kb_ids, "query": query, "k": k})
        r.raise_for_status()
        return _flatten(r.json())

    def ingest(self, filename: str, content: bytes, kb: str) -> dict:
        kb_id = self.resolve_kb(kb, create=True)
        r = self.http.post("/api/v1/files/", files={"file": (filename, content)})
        r.raise_for_status()
        file_id = r.json()["id"]
        self._wait_processed(file_id)
        r = self.http.post(f"/api/v1/knowledge/{kb_id}/file/add", json={"file_id": file_id})
        r.raise_for_status()
        return {"knowledge_base_id": kb_id, "file_id": file_id}

    def _file_error(self, file_id: str) -> str | None:
        """Why processing failed. v0.12's /process/status only returns the status; the reason is
        stored in the file record's data.error. Best effort: any problem here returns None."""
        try:
            r = self.http.get(f"/api/v1/files/{file_id}")
            r.raise_for_status()
            return ((r.json() or {}).get("data") or {}).get("error") or None
        except (httpx.HTTPError, ValueError, AttributeError):
            return None

    def _wait_processed(self, file_id: str) -> None:
        """Uploads are processed in the background; knowledge/file/add rejects unprocessed files."""
        deadline = time.monotonic() + self.process_timeout
        while True:
            r = self.http.get(f"/api/v1/files/{file_id}/process/status")
            r.raise_for_status()
            body = r.json()
            status = body.get("status")
            if status == "completed":
                return
            if status == "failed":
                reason = body.get("error") or self._file_error(file_id) or (
                    "Open WebUI gave no reason; see ./stack logs open-webui")
                raise RuntimeError(f"Open WebUI failed to process file {file_id}: {reason}")
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Open WebUI still processing file {file_id} after {self.process_timeout}s")
            time.sleep(self.poll_interval)
