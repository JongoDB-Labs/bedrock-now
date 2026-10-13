import io
import math
import shutil
import struct
import subprocess
import wave

import pytest


def make_wav(seconds: float = 1.0, rate: int = 16000, tone: bool = True) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        n = int(seconds * rate)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(i * 0.05)) if tone else 0) for i in range(n)))
    return buf.getvalue()


def encode(wav: bytes, args: list[str], tmp_path) -> bytes:
    """wav -> another container with the local ffmpeg (the test stage has it)."""
    src, dst = tmp_path / "src.wav", tmp_path / f"out.{args[-1]}"
    src.write_bytes(wav)
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), *args[:-1], str(dst)], check=True)
    return dst.read_bytes()


needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


@pytest.fixture
def wav1():
    return make_wav(1.0)
