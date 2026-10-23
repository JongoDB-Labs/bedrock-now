#!/usr/bin/env bash
# bedrock-now one-line installer:
#   curl -fsSL https://raw.githubusercontent.com/JongoDB-Labs/bedrock-now/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/JongoDB-Labs/bedrock-now/main/install.sh | bash -s -- --yes
# Env: BEDROCK_NOW_DIR (default ~/bedrock-now), BEDROCK_NOW_REF (tag/branch/commit; default: latest release),
#      BEDROCK_NOW_REPO (git URL or path to clone from; default the GitHub repo — for forks and tests).
# Everything is inside functions and main runs on the last line, so a truncated download does nothing.
set -euo pipefail

BN_REPO_URL="https://github.com/JongoDB-Labs/bedrock-now"

say()  { printf '==> %s\n' "$*" >&2; }
fail() { printf 'xx  %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
has_tty() { { : > /dev/tty; } 2>/dev/null; }
start_setup() { exec ./setup.sh "$@"; }

# ec2_role_available — run inside the new checkout: an EC2 Linux host (firmware markers, never macOS) whose IMDSv2
# names an IAM role, per the checkout's own lib/host.sh (older releases don't have it: no).
ec2_role_available() {
  [ -f lib/host.sh ] || return 1
  STACK_DIR="$PWD" bash -c '. lib/common.sh && . lib/host.sh && instance_role_name >/dev/null' 2>/dev/null
}

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
    # a checkout of the project under its name or the name it is being renamed to (lib/brand.sh)
    case "$url" in *bedrock-now* | *devos-ade*) echo update; return ;; esac
  fi
  echo refuse
}

# latest_release_tag GIT_DIR -> newest vX.Y.Z tag, pre-releases (anything with "-") excluded.
# Same logic as newest_release_tag in lib/commands.sh (this file can't source lib/; a test checks they agree).
latest_release_tag() {
  git -C "$1" -c versionsort.suffix=- tag -l 'v[0-9]*' --sort=-v:refname | grep -v -- '-' | sed -n '1p' || true
}

# pick_ref REQUESTED LATEST_RELEASE_TAG -> ref to check out
pick_ref() {
  if [ -n "$1" ]; then echo "$1"; elif [ -n "$2" ]; then echo "$2"; else echo main; fi
}

main() {
  local dir="${BEDROCK_NOW_DIR:-$HOME/bedrock-now}" repo="${BEDROCK_NOW_REPO:-$BN_REPO_URL}" ref tag qdir
  check_prereqs "$(uname -s)"
  qdir="$(printf '%q' "$dir")"
  case "$(target_decision "$dir")" in
    refuse) fail "$dir exists and is not a bedrock-now checkout — move it away or choose another folder with BEDROCK_NOW_DIR=/path" ;;
    update)
      say "bedrock-now is already installed in $dir — nothing was changed."
      say "To update it (backup first, then the newest release): cd $qdir && ./stack update"
      return 0 ;;
  esac
  say "installing bedrock-now into $dir (from $repo)"
  say "setup then downloads ~5 GB of Docker images on the first run (5-15 minutes) and asks for your AWS key"
  git clone --quiet "$repo" "$dir" || fail "git clone of $repo failed (network?)"
  tag="$(latest_release_tag "$dir")"
  ref="$(pick_ref "${BEDROCK_NOW_REF:-}" "$tag")"
  [ -n "${BEDROCK_NOW_REF:-}" ] || [ -n "$tag" ] || say "no release tags yet — using main"
  git -C "$dir" -c advice.detachedHead=false checkout --quiet "$ref" ||
    fail "could not check out '$ref' (see git's message above). The clone is in $dir: pick another ref with  git -C $qdir checkout <ref>  and run ./setup.sh there, or start over with  rm -rf $qdir"
  say "checked out $ref"
  cd "$dir"
  if has_tty; then
    say "starting setup (./setup.sh $*)"
    start_setup "$@" < /dev/tty
  elif [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    say "no terminal; AWS credentials found in the environment — running ./setup.sh --yes"
    start_setup --yes "$@"
  elif ec2_role_available; then
    say "no terminal; this EC2 instance has an IAM role — running ./setup.sh --yes (it uses the role; no keys stored)"
    start_setup --yes "$@"
  fi
  say "no terminal to ask for your AWS key. Next, run:"
  printf '\n    cd %s && ./setup.sh\n\n' "$qdir"
}

# Tests source this file with BEDROCK_NOW_INSTALL_LIB=1 (BASH_SOURCE is empty when piped into bash).
if [ "${BEDROCK_NOW_INSTALL_LIB:-0}" != 1 ]; then main "$@"; fi
