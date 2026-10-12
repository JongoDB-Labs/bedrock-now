# shellcheck shell=bash
# Installed version and the portal's daily release check, ./stack side. Sourced by lib/commands.sh and
# bin/claude-bedrock. The check itself runs in the portal (portal/portal/updates.py); ./stack and
# claude-bedrock only read its cached answer (no network).
#
# Host folders the portal mounts (created here before Compose mounts them, else Docker creates them as root):
#   .state/status/        read-only in the portal: version.json (this file), helper status (lib/helper.sh)
#   .state/update-check/  writable by the portal: latest.json, latest.txt (its only output)

status_dir()       { printf '%s/status\n' "$STATE_DIR"; }
update_check_dir() { printf '%s/update-check\n' "$STATE_DIR"; }

# _portal_rw_dir DIR — a folder the portal (uid 10102) writes: like litellm/prices/ (lib/prices.sh), setgid +
# group-writable for PORTAL_GID on Linux; macOS (Docker Desktop) needs no group.
_portal_rw_dir() {
  local d="$1" gid
  mkdir -p "$d" 2>/dev/null || { warn "cannot create $d"; return 0; }
  gid="$(portal_gid)"
  if [ -z "$gid" ]; then chmod 755 "$d" 2>/dev/null || true; return 0; fi
  chgrp "$gid" "$d" 2>/dev/null || true
  chmod 2775 "$d" 2>/dev/null || warn "cannot make $d group-writable (chmod 2775)"
  [ "$(get_env PORTAL_GID)" = "$gid" ] || set_env PORTAL_GID "$gid"
}

# ensure_portal_dirs — the .state folders compose.yaml mounts into the portal (run before any portal start)
ensure_portal_dirs() {
  mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
  mkdir -p "$(status_dir)" && chmod 755 "$(status_dir)"
  _portal_rw_dir "$(update_check_dir)"
  ! declare -F ensure_request_dir >/dev/null || ensure_request_dir
}

# installed_version -> "v0.2.1" on a release, "v0.2.1-5-gabc1234" after it, a commit, or "unknown"
installed_version() {
  local v
  [ -e "$STACK_DIR/.git" ] || { echo unknown; return 0; }
  v="$(git -C "$STACK_DIR" describe --tags --always 2>/dev/null || true)"
  case "$v" in '' | *[!A-Za-z0-9._-]*) echo unknown ;; *) printf '%s\n' "$v" ;; esac
}

# _semver vX.Y.Z[-N-gHASH] -> "X Y Z" (fails for anything else)
_semver() {
  printf '%s\n' "$1" | sed -n 's/^v\([0-9]\{1,4\}\)\.\([0-9]\{1,4\}\)\.\([0-9]\{1,4\}\)\(-[0-9]\{1,\}-g[0-9a-f]\{4,40\}\)\{0,1\}$/\1 \2 \3/p' | grep .
}

# version_newer LATEST INSTALLED -> 0 when LATEST (a release tag) is newer than INSTALLED
version_newer() {
  local a b
  case "$1" in *-*) return 1 ;; esac   # pre-releases never count
  a="$(_semver "$1")" && b="$(_semver "$2")" || return 1
  # shellcheck disable=SC2086  # "X Y Z" on purpose
  awk -v a="$a" -v b="$b" 'BEGIN { split(a, x, " "); split(b, y, " ")
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 1 }'
}

# write_version_file — .state/status/version.json for the portal: the installed version and the images this
# compose.yaml pins (for the download estimate). Values are plain [A-Za-z0-9._/:@-]; anything else is left out.
write_version_file() {
  local d f v c refs='' r
  d="$(status_dir)"; mkdir -p "$d" 2>/dev/null || return 0
  v="$(installed_version)"
  c="$( [ -e "$STACK_DIR/.git" ] && git -C "$STACK_DIR" rev-parse --short HEAD 2>/dev/null || true)"
  case "$c" in *[!0-9a-f]*) c='' ;; esac
  while IFS= read -r r; do
    case "$r" in '' | *[!A-Za-z0-9._/:@-]*) continue ;; esac
    refs="$refs${refs:+, }\"$r\""
  done <<EOF
$(compose_refs < "$STACK_DIR/compose.yaml" 2>/dev/null)
EOF
  f="$(mktemp "$d/.version.XXXXXX")" || return 0
  printf '{"version": "%s", "commit": "%s", "images": [%s], "written_at": %s}\n' "$v" "$c" "$refs" "$(date +%s)" > "$f"
  chmod 644 "$f"; mv "$f" "$d/version.json"
}

# latest_release_seen -> the newest release the portal's last check found ("" if none, off, or nonsense)
latest_release_seen() {
  local f v
  [ "$(get_env UPDATE_CHECK)" != false ] || return 0
  f="$(update_check_dir)/latest.txt"
  [ -f "$f" ] && [ ! -L "$f" ] || return 0
  v="$(sed -n 's/^latest=//p' "$f" | head -n 1)"
  _semver "$v" >/dev/null 2>&1 && printf '%s\n' "$v"
  return 0
}

# update_available -> "v0.3.0" when the last check found a release newer than this checkout (else fails)
update_available() {
  local latest
  latest="$(latest_release_seen)"
  [ -n "$latest" ] && version_newer "$latest" "$(installed_version)" && printf '%s\n' "$latest"
}
