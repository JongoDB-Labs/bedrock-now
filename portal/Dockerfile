# repo: the repository's catalog/settings*.tsv, README.md and docs/, for the tests that check the real files (the
# Settings page's layout, its links). portal/test.sh passes them (--build-context repo=..); a plain
# `docker build --target test portal` has none: this empty stage stands in, and those tests skip. Never in the runtime.
FROM scratch AS repo

FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --root-user-action=ignore --require-hashes -r requirements.txt
COPY portal ./portal
# A checkout made under umask 077 has 0600 files; the runtime user (uid 10102) must still read them.
RUN chmod -R a+rX /app

FROM base AS test
COPY requirements-dev.txt .
RUN pip install --no-cache-dir --root-user-action=ignore --require-hashes -r requirements-dev.txt
COPY tests ./tests
# (a wildcard in every part: without the context nothing matches, and nothing is copied)
COPY --from=repo catalo[g]/settings*.tsv /repo/catalog/
COPY --from=repo README.m[d] /repo/
COPY --from=repo doc[s]/*.md /repo/docs/
ENV BN_REPO_DIR=/repo
RUN python -m pytest -q tests

FROM base AS runtime
RUN useradd --system --uid 10102 portal
# /state: the portal-state volume (the logout time). A new named volume copies this owner and mode.
RUN mkdir /state && chown portal:portal /state && chmod 700 /state
USER portal
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"
CMD ["python", "-m", "portal"]
