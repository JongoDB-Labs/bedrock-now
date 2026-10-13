# Alpine: its ffmpeg package is ~110 MB lighter than Debian's. The base is pinned by digest; ffmpeg comes from
# that Alpine release's repository (8.1.x for Alpine 3.24).
FROM python:3.12-alpine@sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4 AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apk add --no-cache "ffmpeg~8.1"
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --root-user-action=ignore --require-hashes -r requirements.txt
COPY stt_service ./stt_service
# A checkout made under umask 077 has 0600 files; the runtime user (uid 10103) must still read them.
RUN chmod -R a+rX /app

FROM base AS test
COPY requirements-dev.txt .
RUN pip install --no-cache-dir --root-user-action=ignore --require-hashes -r requirements-dev.txt
COPY tests ./tests
RUN python -m pytest -q -p no:cacheprovider tests

FROM base AS runtime
RUN adduser -S -D -H -u 10103 stt
USER stt
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"
CMD ["python", "-m", "stt_service"]
