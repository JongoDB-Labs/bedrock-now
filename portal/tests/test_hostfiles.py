"""The reader of the files the host writes into the status folder (portal/portal/hostfiles.py): only a regular file of
at most CAP bytes holding a JSON object, and a file the host has just replaced (Docker Desktop's file sharing says it
is missing for a moment) is read again instead of being taken for absent."""

import json
import os

import pytest

from portal import hostfiles


@pytest.fixture
def naps(monkeypatch):
    slept = []
    monkeypatch.setattr(hostfiles.time, "sleep", slept.append)
    return slept


def test_a_file_the_host_just_replaced_is_read_again(tmp_path, just_replaced, naps):
    f = tmp_path / "helper.json"
    f.write_text(json.dumps({"heartbeat": 1}))
    just_replaced(f)
    assert hostfiles.read_json(f, 4096) == {"heartbeat": 1}
    assert naps == []   # the listing of the folder was enough


def test_a_missing_file_is_missing_at_once(tmp_path, naps, monkeypatch):
    opened = []
    real = hostfiles._read_once
    monkeypatch.setattr(hostfiles, "_read_once", lambda p, cap: opened.append(p) or real(p, cap))
    assert hostfiles.read_json(tmp_path / "helper-status.json", 4096) == {}
    assert opened == [tmp_path / "helper-status.json"] and naps == []   # one try, no wait: not listed in its folder


def test_a_listed_file_that_stays_unfindable_ends_quickly(tmp_path, naps, monkeypatch):
    (tmp_path / "helper.json").write_text("{}")
    tries = []

    def gone(p, cap):
        tries.append(p)
        raise FileNotFoundError(2, "No such file or directory")
    monkeypatch.setattr(hostfiles, "_read_once", gone)
    assert hostfiles.read_json(tmp_path / "helper.json", 4096) == {}
    assert len(tries) == hostfiles.RETRIES + 1 and sum(naps) <= 0.1


def test_only_a_regular_file_up_to_the_cap_holding_an_object(tmp_path):
    ok = tmp_path / "ok.json"
    ok.write_text(json.dumps({"a": 1}))
    assert hostfiles.read_json(ok, 4096) == {"a": 1}
    assert hostfiles.read_json(ok, 3) == {}                       # larger than the cap
    link = tmp_path / "link.json"
    link.symlink_to(ok)
    assert hostfiles.read_json(link, 4096) == {}                  # never through a symlink
    fifo = tmp_path / "fifo.json"
    os.mkfifo(fifo)
    assert hostfiles.read_json(fifo, 4096) == {}                  # nor a FIFO (and no hang on it)
    assert hostfiles.read_json(tmp_path, 4096) == {}              # nor a folder
    for name, body in (("list.json", b"[1]"), ("bad.json", b"{"), ("latin.json", b'{"a": "\xff"}')):
        (tmp_path / name).write_bytes(body)
        assert hostfiles.read_json(tmp_path / name, 4096) == {}, name
