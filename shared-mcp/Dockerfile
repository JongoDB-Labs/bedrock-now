FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --root-user-action=ignore --require-hashes -r requirements.txt
COPY shared_mcp ./shared_mcp
# A checkout made under umask 077 has 0600 files; the runtime user (uid 10101) must still read them.
RUN chmod -R a+rX /app

FROM base AS test
COPY requirements-dev.txt .
RUN pip install --no-cache-dir --root-user-action=ignore --require-hashes -r requirements-dev.txt
COPY tests ./tests
RUN python -m pytest -q tests

FROM base AS runtime
RUN useradd --system --uid 10101 mcp
USER mcp
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"
CMD ["python", "-m", "shared_mcp.server"]
