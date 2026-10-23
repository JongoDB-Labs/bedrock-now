# The optional browser terminal (./stack terminal; compose.terminal.yaml): Claude Code in a sandbox container,
# shown in the portal by ttyd, inside a tmux session that outlives the browser. Built on your computer, never pulled
# from a registry: Debian's packages, Claude Code from npm at the version and SHA-512 checksums in
# claude-code/package-lock.json, ttyd's and gh's release binaries checked against their SHA-256, and your AI
# subscriptions' own tools (the ai-tools stage) pinned and checked the same ways.

# Your AI subscriptions' own tools (tools/install.sh; README "Your AI subscriptions"): Codex, Gemini CLI, Copilot CLI,
# Cursor CLI and Grok Build, each the provider's unmodified client at the version and checksum pinned below (npm ones by
# their lockfiles in tools/). A stage of its own, with no APT_REFRESH: the weekly refresh of the image's packages never
# downloads them again — only a new pin does. TERMINAL_AI_TOOLS in .env (BN_AI_TOOLS: all, none or a comma list)
# chooses which go in; Claude Code is always there. Signing in happens later, in the sandbox, with each tool's own flow.
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS ai-tools
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
ARG BN_AI_TOOLS=all
ARG CODEX_VERSION=0.163.0
ARG CODEX_SHA256_AMD64=beb339e8ecd9ba057a6bb2dc81ad8ca474812edfbf0fc5056ca818797648dde4
ARG CODEX_SHA256_ARM64=a7261e65f4a96d8f4ca65a069c6cf2dc2c33defc341e48078acefda9461fffe4
ARG COPILOT_VERSION=1.0.103
ARG COPILOT_SHA256_AMD64=9aeb4430e9ac9523546db07b227c7aba179a4710a55f9ac29ad143b0f9e1b325
ARG COPILOT_SHA256_ARM64=728a91dffb9a02817bd98c5b01bf2f9cb08c4fdac3c0ca8c48d7f1ccbfe282a1
# (Cursor publishes no checksum: these are the SHA-256 of the files its installer pointed to on 2026-10-23)
ARG CURSOR_VERSION=2026.10.22-27dcf5f
ARG CURSOR_SHA256_AMD64=85296944e4600a83c4b764f578d1502bf9c416db200d33a593e8f3ecabfdc294
ARG CURSOR_SHA256_ARM64=22a36df9720830668ccd4d707e5190204ab9c8a0efb2f068cc914895f804d3ec
COPY tools/ /tmp/tools/
RUN sh /tmp/tools/install.sh

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66

# ./stack passes the ISO week (lib/terminal.sh): a new value invalidates Docker's cache from here on, so Debian's
# security fixes reach the packages below at most a week late (the next ./stack setup, update or terminal enable).
# make: Run & test runs a Makefile's targets with it (bn-coded: the image's own /usr/bin/make). netcat-openbsd: ssh's
# way through the egress proxy (an HTTP CONNECT: bin/bn-ssh-proxy, ssh_config).
ARG APT_REFRESH=unset
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client tmux ncurses-term ripgrep less \
      nano jq procps unzip python3 python3-pip python3-venv make netcat-openbsd \
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

# gh, the GitHub CLI: its release tarball checked against its SHA-256. It is never logged in here: the gh on PATH is
# bin/bn-gh, which gives this one (/usr/local/lib/gh/gh) your login for one command at a time, and only for a GitHub
# host you let Claude use (Git panel › Hosts) — through the same broker as git's, each use in Activity.
ARG GH_VERSION=2.102.0
ARG GH_SHA256_AMD64=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG GH_SHA256_ARM64=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) a=amd64; sum="$GH_SHA256_AMD64" ;; \
      arm64) a=arm64; sum="$GH_SHA256_ARM64" ;; \
      *) echo "gh: no pinned checksum for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    d="gh_${GH_VERSION}_linux_$a"; \
    curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v$GH_VERSION/$d.tar.gz"; \
    echo "$sum  /tmp/gh.tgz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tgz -C /tmp "$d/bin/gh"; \
    install -D -m 755 "/tmp/$d/bin/gh" /usr/local/lib/gh/gh; rm -rf /tmp/gh.tgz "/tmp/$d"; \
    /usr/local/lib/gh/gh --version | grep -qF "gh version $GH_VERSION "

# ttyd's own page, served with --index: the same page plus a viewport for phones and a bedrock-now icon (ttyd-page.py).
# Its inline script must hash to this: the main Caddy's CSP for the terminal host allows that script alone
# (caddy/Caddyfile, terminal_page — the same value), so a new ttyd stops the build until both are updated.
ARG TTYD_PAGE_SCRIPT_SHA256=qpCL1JTmm6ktW0DnjpSILM7GnS2fO8/e+XjSlYJuQzQ=
COPY ttyd-page.py /tmp/ttyd-page.py
RUN set -eu; ttyd -p 7682 -i lo true >/dev/null 2>&1 & pid=$!; \
    for _ in 1 2 3 4 5 6 7 8 9 10; do curl -fsS -o /tmp/ttyd.html http://127.0.0.1:7682/ && break; sleep 0.5; done; \
    kill "$pid"; mkdir -p /usr/local/share/bedrock-now; \
    python3 /tmp/ttyd-page.py /tmp/ttyd.html /usr/local/share/bedrock-now/ttyd.html "$TTYD_PAGE_SCRIPT_SHA256"; \
    rm /tmp/ttyd.html /tmp/ttyd-page.py; chmod 644 /usr/local/share/bedrock-now/ttyd.html

# Claude Code: npm ci refuses any tarball whose checksum differs from the lockfile (the platform's native binary
# included). No auto-update in the container (read-only); ./stack update rebuilds with the next pinned version.
COPY claude-code/package.json claude-code/package-lock.json /opt/claude-code/
RUN cd /opt/claude-code && npm ci --no-audit --no-fund --loglevel=error --cache /tmp/npm-cache && rm -rf /tmp/npm-cache \
 && ln -s /opt/claude-code/node_modules/.bin/claude /usr/local/bin/claude && claude --version

# The AI tools of the stage above, read-only like everything here; their commands on PATH are the launchers in bin/
# (claude-sub, codex, gemini, copilot, cursor-agent, grok), which only choose each one's config folder, leave the
# stack's own variables out and keep its self-updates off (the image pins it). Gemini CLI's system settings (they
# outrank yours) only turn its auto-update off.
COPY --from=ai-tools /out/ /usr/local/lib/bn-tools/
COPY tools/gemini-settings.json /etc/gemini-cli/settings.json

# The Code page's spawn server (bin/bn-coded.mjs: Node built-ins only) listens in /run/bn-code — the code-socket volume
# (compose.terminal.yaml), shared with the code container alone while ./stack code is on; bn-terminal always starts it.
# Its preview proxy (bin/bn-preview.mjs, likewise) listens in /run/bn-preview — the preview-socket volume, shared with
# the terminal's gateway alone.
# You, inside: the same uid/gid as on your computer (TERMINAL_UID/GID from ./stack), so files in the workspace
# folder stay yours. The node image's own user (uid 1000) goes first. The home folder is the terminal-home volume
# (Claude Code's settings and history, shell history); it starts empty: the settings below live in /etc.
ARG BN_UID=10104
ARG BN_GID=10104
RUN set -eu; userdel -r node 2>/dev/null || true; \
    getent group "$BN_GID" >/dev/null || groupadd -g "$BN_GID" claude; \
    useradd -o -M -d /home/claude -s /bin/bash -u "$BN_UID" -g "$BN_GID" claude; \
    mkdir -p /home/claude /workspace /run/bn-ttyd /run/bn-code /run/bn-preview; \
    chown "$BN_UID:$BN_GID" /home/claude /workspace /run/bn-ttyd /run/bn-code /run/bn-preview; \
    chmod 700 /home/claude /run/bn-ttyd /run/bn-code /run/bn-preview
COPY tmux.conf /etc/tmux.conf
COPY bashrc /etc/bedrock-now.bashrc
COPY ssh_config /etc/ssh/ssh_config.d/bedrock-now.conf
# git's credential helper for every git here (bin/bn-git-credential: it keeps nothing; it answers only for a git host
# you let Claude use, through the Code page), and the well-known git hosts' SSH host keys
COPY gitconfig /etc/gitconfig
COPY ssh_known_hosts /etc/ssh/ssh_known_hosts
COPY bin/ /usr/local/bin/
# Claude Code's managed settings for every claude here — the terminal's, claude-bedrock's and the Code page's. They
# outrank every other settings tier (permission rules, hooks, the mode), so nothing in the sandbox may change them:
# root's file in root's folder, on a read-only image. This one (auto mode off) is the default; compose.terminal.yaml
# mounts one of managed/*.json over it, read-only, chosen on your computer from Settings' auto mode switches. Behind a
# custom base URL Claude Code counts auto mode as available and would start in it, or hand Plan mode's writing commands
# to its classifier.
COPY managed/off.json /etc/claude-code/managed-settings.json
RUN chmod 755 /etc/claude-code && chmod 644 /etc/claude-code/managed-settings.json \
 && chmod 644 /etc/tmux.conf /etc/bedrock-now.bashrc /etc/ssh/ssh_config.d/bedrock-now.conf /etc/gitconfig /etc/ssh/ssh_known_hosts \
 && chmod 755 /usr/local/bin/claude-bedrock /usr/local/bin/bn-terminal \
      /usr/local/bin/bn-session /usr/local/bin/bn-coded.mjs /usr/local/bin/bn-preview.mjs /usr/local/bin/bn-ssh-proxy /usr/local/bin/bn-git-credential \
      /usr/local/bin/bn-gh /usr/local/bin/claude-sub /usr/local/bin/subscriptions /usr/local/bin/codex /usr/local/bin/gemini \
      /usr/local/bin/copilot /usr/local/bin/cursor-agent /usr/local/bin/grok \
 && chmod 755 /etc/gemini-cli && chmod 644 /etc/gemini-cli/settings.json \
 && ln -s bn-gh /usr/local/bin/gh && gh --version | grep -qF "gh version $GH_VERSION " \
 && make --version >/dev/null && test -x /usr/bin/nc.openbsd \
 && printf '\n# bedrock-now terminal\n[ -r /etc/bedrock-now.bashrc ] && . /etc/bedrock-now.bashrc\n' >> /etc/bash.bashrc

ENV LANG=C.UTF-8 HOME=/home/claude SHELL=/bin/bash NPM_CONFIG_PREFIX=/home/claude/.local \
    PATH=/home/claude/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER claude
WORKDIR /workspace
# ttyd listens on a UNIX socket only (bn-terminal; the terminal-socket volume, shared with its gateway alone)
HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD curl -fsS -o /dev/null --unix-socket /run/bn-ttyd/ttyd.sock http://terminal/ || exit 1
CMD ["bn-terminal"]
