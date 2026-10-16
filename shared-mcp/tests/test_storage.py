import boto3
import pytest
from moto import mock_aws

from shared_mcp.storage import MAX_KEY_BYTES, MAX_READ_BYTES, PathError, SharedStore, content_type, normalize_key


@pytest.fixture
def store():
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="shared")
        yield SharedStore(s3=s3, bucket="shared")


@pytest.mark.parametrize("raw,expected", [
    ("notes.md", "notes.md"),
    ("/reports/q3.md", "reports/q3.md"),
    ("a/./b//c.txt", "a/b/c.txt"),
    ("a\\b.txt", "a/b.txt"),
    ("..hidden", "..hidden"),
])
def test_normalize_key_accepts(raw, expected):
    assert normalize_key(raw) == expected


@pytest.mark.parametrize("raw", [
    "", "/", ".", "..", "../etc/passwd", "a/../../b", "a/..",
    "a\x00b.txt", "line\nbreak.md", "tab\there.md", "del\x7f.md",
    "x" * (MAX_KEY_BYTES + 1), "é" * (MAX_KEY_BYTES // 2 + 1),
])
def test_normalize_key_rejects(raw):
    with pytest.raises(PathError):
        normalize_key(raw)


def test_write_then_read_roundtrip(store):
    assert store.write_text("/reports/q3.md", "# Q3\n") == "reports/q3.md"
    assert store.read_text("reports/q3.md") == "# Q3\n"


def test_list_with_prefix(store):
    store.write_text("reports/a.md", "a")
    store.write_text("notes/b.md", "b")
    listing = store.list("reports/")
    assert [f["path"] for f in listing["files"]] == ["reports/a.md"]
    assert listing["truncated"] is False
    assert {"path", "size", "modified"} <= set(store.list()["files"][0])


def test_list_reports_truncation(store):
    for name in ("a", "b", "c"):
        store.write_text(f"{name}.md", name)
    assert store.list(limit=3)["truncated"] is False
    two = store.list(limit=2)
    assert len(two["files"]) == 2 and two["truncated"] is True


def test_normalize_key_accepts_max_length():
    assert normalize_key("x" * MAX_KEY_BYTES) == "x" * MAX_KEY_BYTES


def test_read_rejects_binary(store):
    store.s3.put_object(Bucket="shared", Key="img.png", Body=b"\x89PNG\xff\xfe")
    with pytest.raises(ValueError, match="not UTF-8"):
        store.read_text("img.png")


def test_read_rejects_oversized(store):
    store.s3.put_object(Bucket="shared", Key="big.txt", Body=b"x" * (MAX_READ_BYTES + 1))
    with pytest.raises(ValueError, match="limit"):
        store.read_text("big.txt")


@pytest.mark.parametrize("key", ["page.html", "dir/Page.HTM", "a.xhtml", "logo.svg", "feed.xml", "x.xsl", "doc.mhtml",
                                 "atom.atom", "x.rss"])
def test_files_a_browser_would_run_are_stored_as_plain_text(store, key):
    # The files host serves objects on the RustFS console's origin (which keeps its credentials): no page there.
    store.write_text(key, "<html><script>alert(1)</script></html>")
    assert store.s3.head_object(Bucket="shared", Key=key)["ContentType"] == "text/plain; charset=utf-8"
    assert content_type(key) == "text/plain; charset=utf-8"


@pytest.mark.parametrize("key,want", [("notes.md", "text/markdown"), ("data.json", "application/json"),
                                      ("a.txt", "text/plain"), ("noext", "text/plain"), ("t.csv", "text/csv")])
def test_other_files_keep_their_type(store, key, want):
    store.write_text(key, "x")
    assert store.s3.head_object(Bucket="shared", Key=key)["ContentType"] == want
