# PROTOTYPE (code-page spike): the Code page's backend. Same pinned base as the terminal image; the Agent SDK and ws
# by version and SHA-512 (npm ci with package-lock.json). --omit=optional: no bundled Claude Code binaries — the SDK
# only ever gets pathToClaudeCodeExecutable + spawnClaudeCodeProcess, so Claude Code runs in the sandbox alone.
# .npmrc: no peer dependencies (the SDK's main entry imports only Node built-ins).
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
WORKDIR /opt/code
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=optional --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error \
 && test ! -e node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 && test ! -e node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64 \
 && test ! -e node_modules/@modelcontextprotocol && test ! -e node_modules/zod
COPY server.mjs spawn-client.mjs ./
COPY public/ ./public/
ENV NODE_ENV=production
EXPOSE 8095
CMD ["node", "server.mjs"]
