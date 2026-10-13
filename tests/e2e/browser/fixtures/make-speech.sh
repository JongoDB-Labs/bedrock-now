#!/usr/bin/env bash
# Rebuilds speech.webm, the spoken test clip for the speech-to-text checks (committed, so a run needs no TTS):
# espeak-ng says SPEECH_TEXT, ffmpeg encodes it like a browser recording (WebM/Opus, mono 48 kHz).
# Needs Docker and network access (Alpine packages). Usage: tests/e2e/browser/fixtures/make-speech.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
text="hello world, this is the bedrock now voice test"
docker run --rm -v "$here:/out" alpine:3.22 sh -c "
  apk add -q --no-cache espeak-ng ffmpeg >/dev/null &&
  espeak-ng -v en-us -s 140 -w /tmp/speech.wav '$text' &&
  ffmpeg -loglevel error -y -i /tmp/speech.wav -ac 1 -ar 48000 -c:a libopus -b:a 24k /out/speech.webm &&
  chmod 644 /out/speech.webm"
printf '%s\n' "$text" > "$here/speech.txt"
