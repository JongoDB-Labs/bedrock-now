# repo: the repository's catalog/settings*.tsv, README.md and docs/: for the tests that check the real files (the
# Settings page's layout, its links), and for the global search's docs index (stage docs). portal/test.sh passes them
# (--build-context repo=..), and so does compose.portal-docs.yaml (additional_contexts, where Docker Compose 2.17+ reads
# it: only the files named below are sent); with an older Compose, or a plain `docker build portal`, there is none:
# this empty stage stands in, those tests skip and the docs index is empty. The
# repository's files themselves never reach the runtime image: only the index built from them.
FROM scratch AS repo

FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --root-user-action=ignore --require-hashes -r requirements.txt
COPY portal ./portal
# A checkout made under umask 077 has 0600 files; the runtime user (uid 10102) must still read them.
RUN chmod -R a+rX /app

# docs: the global search's index of README.md and docs/*.md (headings, GitHub's anchors, a line of text each), built
# here so the running portal reads no repository files (portal/searchindex.py). Without the files: an empty index.
FROM base AS docs
# (a wildcard in every part: without the context nothing matches, and nothing is copied)
COPY --from=repo README.m[d] /src/
COPY --from=repo doc[s]/*.md /src/docs/
RUN mkdir -p /src /out && python -m portal.searchindex /src /out/docs-index.json

# jstest: the page scripts' pure parts (static/fuzzy.js, activity.js, search.js; and that no script builds a regular
# expression) under Node's test runner, with the same
# pinned Node image as the Code page (shared layers). Only the test stage needs it: never setup, update or the runtime.
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS jstest
WORKDIR /app
COPY portal/static/*.js ./portal/static/
COPY tests/js/ ./tests/js/
RUN node --test --test-reporter=spec tests/js/*.test.mjs && touch /tmp/js-tested

FROM base AS test
# (the scripts' tests first: this stage needs theirs)
COPY --from=jstest /tmp/js-tested /tmp/js-tested
COPY --from=docs /out/docs-index.json /tmp/docs-index.json
COPY requirements-dev.txt .
RUN pip install --no-cache-dir --root-user-action=ignore --require-hashes -r requirements-dev.txt
COPY tests ./tests
# (a wildcard in every part: without the context nothing matches, and nothing is copied)
COPY --from=repo catalo[g]/settings*.tsv catalo[g]/ai-tools.tsv /repo/catalog/
COPY --from=repo README.m[d] /repo/
COPY --from=repo doc[s]/*.md /repo/docs/
ENV BN_REPO_DIR=/repo
RUN python -m pytest -q tests

FROM base AS runtime
COPY --from=docs /out/docs-index.json /app/portal/docs-index.json
RUN chmod a+r /app/portal/docs-index.json && useradd --system --uid 10102 portal
# /state: the portal-state volume (the logout time). A new named volume copies this owner and mode.
RUN mkdir /state && chown portal:portal /state && chmod 700 /state
USER portal
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"
CMD ["python", "-m", "portal"]
