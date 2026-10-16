# The Code page's backend (./stack code; compose.code.yaml): built on your computer, never pulled from a registry.
# The same pinned Node base as the terminal image (shared layers). The Agent SDK and ws come from npm at the versions
# and SHA-512 checksums in package-lock.json; --omit=optional: no bundled Claude Code binaries — the SDK only ever
# gets pathToClaudeCodeExecutable + spawnClaudeCodeProcess, so Claude Code runs in the sandbox alone. .npmrc: no peer
# dependencies (the SDK's main entry imports only Node built-ins). Nothing is fetched at runtime.
#
#   web      code/web's build (its package-lock.json, npm ci, npm run build -> dist/: index.html + hashed assets) when
#            code/web exists; otherwise an empty dist, and the backend serves the plain page (code/plain)
#   webtest  the frontend's checks on that same install: npm test (tsc --noEmit, then its unit tests)
#   deps     the backend's node_modules, checked: no native binaries, no peer dependencies, the SDK imports
#   test     the unit tests, both halves (code/test.sh builds this stage; it needs --build-context terminal=terminal):
#            the backend and the sandbox's bn-coded and bn-preview (with Debian's git and ripgrep, as in the sandbox)
#   (last)   the runtime image
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS web
WORKDIR /src
# build-web.sh always exists; "web*" adds code/web's files when there is such a folder (nothing otherwise)
COPY build-web.sh web* /src/
RUN sh /src/build-web.sh

FROM web AS webtest
RUN if [ -f package.json ]; then npm test; else echo "no code/web: no frontend tests"; fi && touch /tmp/web-tested

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS deps
WORKDIR /opt/code
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=optional --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error \
 && for p in darwin-arm64 darwin-x64 linux-arm64 linux-arm64-musl linux-x64 linux-x64-musl win32-arm64 win32-x64; do \
      test ! -e "node_modules/@anthropic-ai/claude-agent-sdk-$p" || { echo "a bundled Claude Code binary got in ($p)" >&2; exit 1; }; done \
 && test ! -e node_modules/@modelcontextprotocol && test ! -e node_modules/zod && test ! -e node_modules/@anthropic-ai/sdk \
 && node -e 'import("@anthropic-ai/claude-agent-sdk").then((m) => { if (typeof m.query !== "function" || typeof m.getSessionMessages !== "function") process.exit(1); })'

FROM deps AS test
# (the frontend's tests first: this stage needs their stage)
COPY --from=webtest /tmp/web-tested /tmp/web-tested
# git and ripgrep, as the sandbox image has them (Debian's): bn-coded's git.diff is proven against a hostile repository
# with the same git, and fs.grep with the same ripgrep
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep && rm -rf /var/lib/apt/lists/*
COPY server/ ./server/
COPY plain/ ./plain/
COPY test/ ./test/
COPY --from=terminal bin/bn-coded.mjs bin/bn-preview.mjs /opt/terminal/bin/
COPY --from=terminal claude-code/package.json /opt/terminal/claude-code/package.json
ENV BN_TERMINAL_DIR=/opt/terminal
RUN node --test --test-reporter=spec test/*.test.mjs

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
WORKDIR /opt/code
COPY --from=deps /opt/code/node_modules ./node_modules
COPY package.json ./
COPY server/ ./server/
COPY plain/ ./plain/
COPY --from=web /src/dist/ ./web/dist/
ENV NODE_ENV=production
# (compose runs it as TERMINAL_UID, read-only; this is for a plain docker run)
USER node
HEALTHCHECK --interval=15s --timeout=5s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8095/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/main.mjs"]
