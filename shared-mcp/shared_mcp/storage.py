"""The human-friendly `shared` bucket that people (RustFS console) and Claude Code both use."""

import mimetypes
import posixpath
from dataclasses import dataclass
from typing import Any

MAX_READ_BYTES = 2_000_000
MAX_KEY_BYTES = 1024  # S3 object key limit
# Types a browser would run as a page. The files host serves stored objects on the RustFS console's origin, which
# keeps the console's credentials, so such files are stored as plain text (Caddy also makes every object there inert).
ACTIVE_TYPES = frozenset({"text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml"})
ACTIVE_SUFFIXES = (".html", ".htm", ".xhtml", ".xht", ".svg", ".svgz", ".xml", ".xsl", ".xslt", ".shtml", ".mht", ".mhtml",
                   ".rss", ".atom")   # (by name too: a system's MIME table may not know them)


def content_type(key: str) -> str:
    """The Content-Type to store KEY with: its usual one, but never one a browser would run."""
    guessed = mimetypes.guess_type(key)[0] or "text/plain"
    if guessed in ACTIVE_TYPES or guessed.endswith("+xml") or key.lower().endswith(ACTIVE_SUFFIXES):
        return "text/plain; charset=utf-8"
    return guessed


class PathError(ValueError):
    pass


def normalize_key(path: str) -> str:
    """Turn a user/LLM-supplied path into a safe object key: relative, no '..' escapes."""
    if any(ord(c) < 0x20 or c == "\x7f" for c in path):
        raise PathError(f"invalid path (control character): {path!r}")
    p = path.strip().replace("\\", "/").lstrip("/")
    norm = posixpath.normpath(p) if p else ""
    if norm in ("", ".", "..") or norm.startswith("../"):
        raise PathError(f"invalid path: {path!r}")
    if len(norm.encode("utf-8")) > MAX_KEY_BYTES:
        raise PathError(f"invalid path (longer than {MAX_KEY_BYTES} bytes)")
    return norm


@dataclass
class SharedStore:
    s3: Any  # boto3 S3 client
    bucket: str

    def list(self, prefix: str = "", limit: int = 500) -> dict:
        """Return {"files": [{path, size, modified}, ...], "truncated": bool} (at most `limit` files)."""
        out: list[dict] = []
        pages = self.s3.get_paginator("list_objects_v2").paginate(
            Bucket=self.bucket, Prefix=prefix.strip().lstrip("/"))
        for page in pages:
            for obj in page.get("Contents", []):
                if len(out) >= limit:
                    return {"files": out, "truncated": True}
                out.append({"path": obj["Key"], "size": obj["Size"],
                            "modified": obj["LastModified"].isoformat()})
        return {"files": out, "truncated": False}

    def read_text(self, path: str) -> str:
        key = normalize_key(path)
        stream = self.s3.get_object(Bucket=self.bucket, Key=key)["Body"]
        try:
            body = stream.read(MAX_READ_BYTES + 1)
        finally:
            stream.close()
        if len(body) > MAX_READ_BYTES:
            raise ValueError(f"{key} exceeds the read limit of {MAX_READ_BYTES} bytes")
        try:
            return body.decode("utf-8")
        except UnicodeDecodeError:
            raise ValueError(f"{key} is not UTF-8 text ({len(body)} bytes)") from None

    def write_text(self, path: str, content: str) -> str:
        key = normalize_key(path)
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=content.encode("utf-8"),
                           ContentType=content_type(key))
        return key
