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
#   gitnew   the Git panel's unit tests once more with git 2.54 (Alpine 3.24): config-based hooks, which Debian's git
#            lacks, are proven switched off there (the test may not skip) — its remote operations' too (with openssl
#            and OpenSSH for their test servers)
#   test     the unit tests, both halves (code/test.sh builds this stage; it needs --build-context terminal=terminal):
#            the backend and the sandbox's bn-coded and bn-preview (with Debian's git and ripgrep, as in the sandbox),
#            and the sandbox's egress proxy (terminal/egress/bn-egress.mjs)
#   (last)   the runtime image — what setup and update build (no target): web and deps only, never webtest, gitnew or test
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS web
WORKDIR /src
# build-web.sh always exists; "web*" adds code/web's files when there is such a folder (nothing otherwise)
COPY build-web.sh web* /src/
RUN sh /src/build-web.sh

FROM web AS webtest
RUN if [ -f package.json ]; then npm test; else echo "no code/web: no frontend tests"; fi && touch /tmp/web-tested

# gitnew: the Git panel's proof again with a newer git than Debian's — 2.54 (Alpine 3.24's), which has config-based hooks
# (hook.<name>.command + hook.<name>.event) that core.hooksPath does not turn off: here that vector must run, never skip.
# The base is pinned by digest; the packages by series only (git 2.54.*, node 24.*): Alpine's mirrors drop superseded
# -rN builds, so an exact pin would stop building at the next one. Only code/test.sh (--target test) builds this stage
# and `test`: setup and update build the runtime stage at the end (compose.code.yaml: no target), which needs neither —
# an Alpine change here can never break an install or an update.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS gitnew
RUN apk add --no-cache "git~2.54" "nodejs~24" openssh-client openssh-server openssl
WORKDIR /opt/code
COPY server/frames.mjs server/sshagent.mjs ./server/
COPY test/helpers.mjs test/git-servers.mjs test/bn-coded-git.test.mjs test/bn-coded-remote.test.mjs ./test/
COPY --from=terminal bin/bn-coded.mjs bin/bn-git-credential /opt/terminal/bin/
ENV BN_TERMINAL_DIR=/opt/terminal BN_TEST_REQUIRE_CONFIG_HOOKS=1
RUN git --version && node --test --test-reporter=spec test/bn-coded-git.test.mjs test/bn-coded-remote.test.mjs && touch /tmp/gitnew-tested

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS deps
WORKDIR /opt/code
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=optional --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error \
 && for p in darwin-arm64 darwin-x64 linux-arm64 linux-arm64-musl linux-x64 linux-x64-musl win32-arm64 win32-x64; do \
      test ! -e "node_modules/@anthropic-ai/claude-agent-sdk-$p" || { echo "a bundled Claude Code binary got in ($p)" >&2; exit 1; }; done \
 && test ! -e node_modules/@modelcontextprotocol && test ! -e node_modules/zod && test ! -e node_modules/@anthropic-ai/sdk \
 && node -e 'import("@anthropic-ai/claude-agent-sdk").then((m) => { if (typeof m.query !== "function" || typeof m.getSessionMessages !== "function") process.exit(1); })'

FROM deps AS test
# (the frontend's tests first, and the Git panel's with a newer git: this stage needs their stages)
COPY --from=webtest /tmp/web-tested /tmp/web-tested
COPY --from=gitnew /tmp/gitnew-tested /tmp/gitnew-tested
# git, ripgrep and tmux, as the sandbox image has them (Debian's): bn-coded's git.diff is proven against a hostile
# repository with the same git, fs.grep with the same ripgrep, and terminal.capture with a real tmux under LANG=C; the
# Git panel's remote operations with the same OpenSSH client against test servers of their own (openssl's CA, sshd)
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep tmux ca-certificates openssh-client openssh-server openssl \
 && rm -rf /var/lib/apt/lists/*
COPY server/ ./server/
COPY plain/ ./plain/
COPY test/ ./test/
COPY --from=terminal bin/bn-coded.mjs bin/bn-preview.mjs bin/bn-git-credential /opt/terminal/bin/
COPY --from=terminal egress/bn-egress.mjs /opt/terminal/egress/
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
# Readable by the user compose runs it as (TERMINAL_UID), whatever modes the checkout has: COPY keeps them, and a
# checkout written with umask 077 (the update helper's) has 600 files — the server then failed with EACCES on its own
# main.mjs. (The portal, shared-mcp and stt images do the same; node_modules and web/dist are already a+r.)
RUN chmod -R a+rX /opt/code/package.json /opt/code/server /opt/code/plain \
 && mkdir -p /var/lib/bn-code && chmod 1777 /var/lib/bn-code
# /var/lib/bn-code: the code-state volume (compose.code.yaml) starts as a copy of this folder — writable by the user
# compose runs this as (TERMINAL_UID, unknown here), which keeps Git hosts in a folder of its own, mode 700, in it
ENV NODE_ENV=production
# (compose runs it as TERMINAL_UID, read-only; this is for a plain docker run)
USER node
HEALTHCHECK --interval=15s --timeout=5s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8095/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/main.mjs"]
