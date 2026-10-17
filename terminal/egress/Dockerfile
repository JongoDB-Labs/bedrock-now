# The sandbox's egress proxy (compose.terminal-proxy.yaml; TERMINAL_EGRESS=internet, the default): bn-egress.mjs, Node
# built-ins only, on the same pinned Node base as the terminal and Code page images (their layers are shared: this image
# adds a few kilobytes). Built on your computer, never pulled; nothing is installed and nothing is fetched at runtime.
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
COPY bn-egress.mjs /opt/bn-egress/bn-egress.mjs
# readable by the user compose runs it as (65534, nobody), whatever modes the checkout has (an update helper's umask 077
# writes 600 files); checked for syntax here, so a broken file stops the build instead of the sandbox's internet
RUN chmod 755 /opt/bn-egress && chmod 644 /opt/bn-egress/bn-egress.mjs && node --check /opt/bn-egress/bn-egress.mjs
# getaddrinfo runs in libuv's thread pool: more than its default 4 lookups at once (npm opens many connections)
ENV NODE_ENV=production UV_THREADPOOL_SIZE=16
USER 65534:65534
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 CMD ["node", "/opt/bn-egress/bn-egress.mjs", "--health"]
CMD ["node", "--max-old-space-size=96", "/opt/bn-egress/bn-egress.mjs"]
