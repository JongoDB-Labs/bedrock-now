#!/usr/bin/env bash
# bedrock-now one-line installer:
#   curl -fsSL https://raw.githubusercontent.com/JongoDB-Labs/bedrock-now/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/JongoDB-Labs/bedrock-now/main/install.sh | bash -s -- --yes
# Env: BEDROCK_NOW_DIR (default ~/bedrock-now), BEDROCK_NOW_REF (tag/branch/commit; default: latest release).
# Everything is inside functions and main runs on the last line, so a truncated download does nothing.
set -euo pipefail

BN_REPO_URL="https://github.com/JongoDB-Labs/bedrock-now"

say()  { printf '==> %s\n' "$*" >&2; }
fail() { printf 'xx  %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
has_tty() { { : > /dev/tty; } 2>/dev/null; }

prereq_hint() { # prereq_hint TOOL OS(uname -s) -> how to get it
  case "$1:$2" in
    docker:Darwin) echo "install Docker Desktop: https://www.docker.com/products/docker-desktop/" ;;
    docker:*) echo "install Docker Engine: https://docs.docker.com/engine/install/" ;;
    compose:Darwin) echo "Docker Compose v2 ships with Docker Desktop — update Docker Desktop" ;;
    compose:*) echo "install the Docker Compose v2 plugin (package docker-compose-plugin): https://docs.docker.com/compose/install/linux/" ;;
    daemon:Darwin) echo "start Docker Desktop and wait until it says it is running" ;;
    daemon:*) echo "start the Docker service (sudo systemctl start docker) and make sure your user may use it (docker group)" ;;
    *:Darwin) echo "brew install $1   (Homebrew: https://brew.sh), or xcode-select --install for git" ;;
    *) echo "install $1 with your package manager (e.g. sudo apt install $1 / sudo dnf install $1)" ;;
  esac
}

check_prereqs() { # check_prereqs OS — reports every missing piece, then exits if anything is missing
  local os="$1" t missing=0
  for t in git curl openssl docker; do
    have "$t" || { printf 'xx  %s is missing — %s\n' "$t" "$(prereq_hint "$t" "$os")" >&2; missing=1; }
  done
  if have docker; then
    if ! docker compose version >/dev/null 2>&1; then
      printf 'xx  Docker Compose v2 is missing — %s\n' "$(prereq_hint compose "$os")" >&2; missing=1
    elif ! docker info >/dev/null 2>&1; then
      printf 'xx  the Docker daemon is not reachable — %s\n' "$(prereq_hint daemon "$os")" >&2; missing=1
    fi
  fi
  [ "$missing" -eq 0 ] || fail "install the missing prerequisites above, then run the installer again"
}

# target_decision DIR -> clone | update | refuse
target_decision() {
  local d="$1" url
  [ -e "$d" ] || { echo clone; return; }
  [ -d "$d" ] || { echo refuse; return; }
  [ -n "$(ls -A "$d" 2>/dev/null)" ] || { echo clone; return; }
  url="$(git -C "$d" remote get-url origin 2>/dev/null || true)"
  if [ -d "$d/.git" ] && [ -x "$d/stack" ]; then
    case "$url" in *bedrock-now*) echo update; return ;; esac
  fi
  echo refuse
}

# pick_ref REQUESTED TAGS(newest first, one per line) -> ref to check out
pick_ref() {
  if [ -n "$1" ]; then echo "$1"; return; fi
  local t; t="$(printf '%s\n' "$2" | sed -n '1p')"
  if [ -n "$t" ]; then echo "$t"; else echo main; fi
}

main() {
  local dir="${BEDROCK_NOW_DIR:-$HOME/bedrock-now}" repo="${BEDROCK_NOW_REPO:-$BN_REPO_URL}" ref tags
  check_prereqs "$(uname -s)"
  case "$(target_decision "$dir")" in
    refuse) fail "$dir exists and is not a bedrock-now checkout — move it away or choose another folder with BEDROCK_NOW_DIR=/path" ;;
    update)
      say "bedrock-now is already installed in $dir — nothing was changed."
      say "To update it (newest release, with a backup first): cd $dir && ./stack update"
      return 0 ;;
  esac
  say "installing bedrock-now into $dir (from $repo)"
  say "setup then downloads ~5 GB of Docker images on the first run (5-15 minutes) and asks for your AWS key"
  git clone --quiet "$repo" "$dir" || fail "git clone of $repo failed (network?)"
  tags="$(git -C "$dir" tag --sort=-v:refname)"
  ref="$(pick_ref "${BEDROCK_NOW_REF:-}" "$tags")"
  [ -n "${BEDROCK_NOW_REF:-}" ] || [ -n "$tags" ] || say "no release tags yet — using main"
  git -C "$dir" -c advice.detachedHead=false checkout --quiet "$ref" || fail "could not check out '$ref' in $dir"
  say "checked out $ref"
  cd "$dir"
  if has_tty; then
    say "starting setup (./setup.sh $*)"
    exec ./setup.sh "$@" < /dev/tty
  elif [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    say "no terminal; AWS credentials found in the environment — running ./setup.sh --yes"
    exec ./setup.sh --yes "$@"
  fi
  say "no terminal to ask for your AWS key. Next, run:"
  printf '\n    cd %s && ./setup.sh\n\n' "$dir"
}

# Tests source this file with BEDROCK_NOW_INSTALL_LIB=1 (BASH_SOURCE is empty when piped into bash).
if [ "${BEDROCK_NOW_INSTALL_LIB:-0}" != 1 ]; then main "$@"; fi
