# The optional browser terminal (./stack terminal; compose.terminal.yaml): Claude Code in a sandbox container,
# shown in the portal by ttyd, inside a tmux session that outlives the browser. Built on your computer, never pulled
# from a registry: Debian's packages, Claude Code from npm at the version and SHA-512 checksums in
# claude-code/package-lock.json, and ttyd's release binary checked against its SHA-256.
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66

# ./stack passes the ISO week (lib/terminal.sh): a new value invalidates Docker's cache from here on, so Debian's
# security fixes reach the packages below at most a week late (the next ./stack setup, update or terminal enable).
ARG APT_REFRESH=unset
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client tmux ncurses-term ripgrep less \
      nano jq procps unzip python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*

# ttyd: the terminal in the browser (xterm.js is compiled into the binary; nothing is fetched at runtime).
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256_AMD64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_ARM64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) a=x86_64; sum="$TTYD_SHA256_AMD64" ;; \
      arm64) a=aarch64; sum="$TTYD_SHA256_ARM64" ;; \
      *) echo "ttyd: no pinned checksum for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/ttyd "https://github.com/tsl0922/ttyd/releases/download/$TTYD_VERSION/ttyd.$a"; \
    echo "$sum  /tmp/ttyd" | sha256sum -c -; \
    install -m 755 /tmp/ttyd /usr/local/bin/ttyd; rm /tmp/ttyd; ttyd --version

# ttyd's own page, served with -I: the same page plus a viewport for phones (without one they lay it out 980 px wide;
# the on-screen keyboard then resizes it instead of covering the prompt) and a bedrock-now icon instead of ttyd's.
RUN set -eu; ttyd -p 7682 -i lo true >/dev/null 2>&1 & pid=$!; \
    for _ in 1 2 3 4 5 6 7 8 9 10; do curl -fsS -o /tmp/ttyd.html http://127.0.0.1:7682/ && break; sleep 0.5; done; \
    kill "$pid"; mkdir -p /usr/local/share/bedrock-now; \
    python3 -c 'import re, sys; p = open(sys.argv[1], encoding="utf-8").read(); \
icon = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 20 20%27%3E%3Crect width=%2720%27 height=%2720%27 rx=%274%27 fill=%27%23111820%27/%3E%3Cpath d=%27M5 7l3 3-3 3M10 13h5%27 fill=%27none%27 stroke=%27%2373b6cd%27 stroke-width=%271.8%27 stroke-linecap=%27round%27/%3E%3C/svg%3E"; \
meta = "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content\"><meta name=\"theme-color\" content=\"#111820\">"; \
assert "name=\"viewport\"" not in p; p, n = re.subn(r"<meta charset=\"UTF-8\">", lambda m: m.group(0) + meta, p, count=1); assert n == 1; \
p, n = re.subn(r"<link rel=\"icon\"[^>]*>", lambda m: "<link rel=\"icon\" href=\"" + icon + "\">", p, count=1); assert n == 1; \
open(sys.argv[2], "w", encoding="utf-8").write(p)' /tmp/ttyd.html /usr/local/share/bedrock-now/ttyd.html; \
    rm /tmp/ttyd.html; chmod 644 /usr/local/share/bedrock-now/ttyd.html

# Claude Code: npm ci refuses any tarball whose checksum differs from the lockfile (the platform's native binary
# included). No auto-update in the container (read-only); ./stack update rebuilds with the next pinned version.
COPY claude-code/package.json claude-code/package-lock.json /opt/claude-code/
RUN cd /opt/claude-code && npm ci --no-audit --no-fund --loglevel=error \
 && ln -s /opt/claude-code/node_modules/.bin/claude /usr/local/bin/claude && claude --version

# You, inside: the same uid/gid as on your computer (TERMINAL_UID/GID from ./stack), so files in the workspace
# folder stay yours. The node image's own user (uid 1000) goes first. The home folder is the terminal-home volume
# (Claude Code's settings and history, shell history); it starts empty: the settings below live in /etc.
ARG BN_UID=10104
ARG BN_GID=10104
RUN set -eu; userdel -r node 2>/dev/null || true; \
    getent group "$BN_GID" >/dev/null || groupadd -g "$BN_GID" claude; \
    useradd -o -M -d /home/claude -s /bin/bash -u "$BN_UID" -g "$BN_GID" claude; \
    mkdir -p /home/claude /workspace; chown "$BN_UID:$BN_GID" /home/claude /workspace; chmod 700 /home/claude
COPY tmux.conf /etc/tmux.conf
COPY bashrc /etc/bedrock-now.bashrc
COPY bin/ /usr/local/bin/
RUN chmod 644 /etc/tmux.conf /etc/bedrock-now.bashrc && chmod 755 /usr/local/bin/claude-bedrock /usr/local/bin/bn-terminal \
      /usr/local/bin/bn-session \
 && printf '\n# bedrock-now terminal\n[ -r /etc/bedrock-now.bashrc ] && . /etc/bedrock-now.bashrc\n' >> /etc/bash.bashrc

ENV LANG=C.UTF-8 HOME=/home/claude SHELL=/bin/bash NPM_CONFIG_PREFIX=/home/claude/.local \
    PATH=/home/claude/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER claude
WORKDIR /workspace
EXPOSE 7681
# ttyd answers only requests that carry X-Portal-User (-H; Caddy adds it after the portal's check), so this one does too.
HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD curl -fsS -o /dev/null -H 'X-Portal-User: healthcheck' http://127.0.0.1:7681/ || exit 1
CMD ["bn-terminal"]
