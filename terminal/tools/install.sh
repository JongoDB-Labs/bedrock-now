#!/bin/sh
# The sandbox's own AI tools (terminal/Dockerfile's ai-tools stage; README "Your AI subscriptions"): each provider's
# unmodified command-line client, pinned here and checked before anything of it is kept — npm packages by `npm ci`
# against their lockfile (SHA-512 per tarball, the platform's native package included; no install scripts run), release
# tarballs by SHA-256: Codex's and Copilot's as their GitHub releases list them, Cursor's as bedrock-now saw it on
# 2026-10-23 (Cursor publishes no checksum: a file that changed since stops the build). Nothing here signs in, and
# nothing is changed in what is installed. Each lands in /out/<tool>/, and /out/VERSIONS says which version.
#
#   BN_AI_TOOLS   all (default) | none | a comma list of codex, gemini, copilot, cursor, grok — TERMINAL_AI_TOOLS in .env
#                 (Claude Code is always in the image: it is the sandbox's own)
set -eu

TOOLS_ALL="codex gemini copilot cursor grok"
want="$(printf '%s' "${BN_AI_TOOLS:-all}" | tr 'A-Z,' 'a-z ')"
case " $want " in
  *" all "*) want="$TOOLS_ALL" ;;
  *" none "*) want="" ;;
esac
for t in $want; do
  case " $TOOLS_ALL " in *" $t "*) ;; *) echo "BN_AI_TOOLS: no tool called '$t' (one of: $TOOLS_ALL, all, none)" >&2; exit 1 ;; esac
done

case "$(dpkg --print-architecture)" in
  amd64) arch=amd64 ;;
  arm64) arch=arm64 ;;
  *) echo "ai-tools: no pinned checksums for $(dpkg --print-architecture)" >&2; exit 1 ;;
esac
mkdir -p /out
: > /out/VERSIONS

# fetch URL SHA256 FILE — the file, kept only when its SHA-256 is the pinned one
fetch() {
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c - >/dev/null || { echo "ai-tools: $1 is not the file pinned here (SHA-256 differs)" >&2; exit 1; }
}
# npm_tool NAME — terminal/tools/NAME's lockfile, as is
npm_tool() {
  mkdir -p "/out/$1"
  cp "/tmp/tools/$1/package.json" "/tmp/tools/$1/package-lock.json" "/out/$1/"
  (cd "/out/$1" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error --cache /tmp/npm-cache)
}

for t in $want; do
  case "$t" in
    codex)
      # OpenAI's Codex CLI: the static (musl) binary of the release, renamed to codex as its README says
      v="$CODEX_VERSION"
      if [ "$arch" = amd64 ]; then a=x86_64; sum="$CODEX_SHA256_AMD64"; else a=aarch64; sum="$CODEX_SHA256_ARM64"; fi
      fetch "https://github.com/openai/codex/releases/download/rust-v$v/codex-$a-unknown-linux-musl.tar.gz" "$sum" /tmp/codex.tgz
      mkdir -p /out/codex /tmp/codex
      tar -xzf /tmp/codex.tgz -C /tmp/codex "codex-$a-unknown-linux-musl"
      install -m 755 "/tmp/codex/codex-$a-unknown-linux-musl" /out/codex/codex
      /out/codex/codex --version | grep -qx "codex-cli $v"
      echo "codex $v" >> /out/VERSIONS ;;
    copilot)
      # GitHub's Copilot CLI: the release's standalone binary
      v="$COPILOT_VERSION"
      if [ "$arch" = amd64 ]; then a=x64; sum="$COPILOT_SHA256_AMD64"; else a=arm64; sum="$COPILOT_SHA256_ARM64"; fi
      fetch "https://github.com/github/copilot-cli/releases/download/v$v/copilot-linux-$a.tar.gz" "$sum" /tmp/copilot.tgz
      mkdir -p /out/copilot
      tar -xzf /tmp/copilot.tgz -C /out/copilot copilot
      chmod 755 /out/copilot/copilot
      COPILOT_AUTO_UPDATE=false HOME=/tmp/copilot-home /out/copilot/copilot --version | grep -q "CLI $v\."
      echo "copilot $v" >> /out/VERSIONS ;;
    cursor)
      # Cursor's CLI: the package its own installer (cursor.com/install) downloads, for this version
      v="$CURSOR_VERSION"
      if [ "$arch" = amd64 ]; then a=x64; sum="$CURSOR_SHA256_AMD64"; else a=arm64; sum="$CURSOR_SHA256_ARM64"; fi
      fetch "https://downloads.cursor.com/lab/$v/linux/$a/agent-cli-package.tar.gz" "$sum" /tmp/cursor.tgz
      mkdir -p /tmp/cursor
      tar -xzf /tmp/cursor.tgz -C /tmp/cursor
      mv /tmp/cursor/dist-package /out/cursor
      HOME=/tmp/cursor-home /out/cursor/cursor-agent --version 2>/dev/null | grep -qx "$v"
      echo "cursor $v" >> /out/VERSIONS ;;
    gemini)
      npm_tool gemini
      v="$(node -p 'require("/out/gemini/node_modules/@google/gemini-cli/package.json").version')"
      echo "gemini $v" >> /out/VERSIONS ;;
    grok)
      # its npm package ships the binary brotli-compressed; its own postinstall unpacks it into ~/.grok/bin at first
      # run (a home folder the sandbox can write, and its updater's place). Unpacked here instead, the same way, into
      # the read-only image: grok/grok is what the launcher runs
      npm_tool grok
      v="$(node -p 'require("/out/grok/node_modules/@xai-official/grok/package.json").version')"
      if [ "$arch" = amd64 ]; then a=x64; else a=arm64; fi
      node -e 'const fs = require("fs"), zlib = require("zlib");
        fs.writeFileSync(process.argv[2], zlib.brotliDecompressSync(fs.readFileSync(process.argv[1])), { mode: 0o755 });' \
        "/out/grok/node_modules/@xai-official/grok-linux-$a/bin/grok.br" /out/grok/grok
      HOME=/tmp/grok-home /out/grok/grok --version 2>/dev/null | grep -q "$v"
      echo "grok $v" >> /out/VERSIONS ;;
  esac
done
chmod -R a+rX,go-w /out
cat /out/VERSIONS
