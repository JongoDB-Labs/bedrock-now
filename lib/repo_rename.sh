# shellcheck shell=bash
# The project's repository is being renamed on GitHub (PRODUCT_REPO -> PRODUCT_REPO_NEXT, lib/brand.sh). GitHub keeps
# the old address working (git fetch follows its redirect), so nothing breaks on rename day; this moves a checkout's
# origin to the new address once, when it safely can (origin_follow_rename, after ./stack update fetched):
#   - only when origin is EXACTLY one of the old address's forms: https://github.com/<old>[.git],
#     ssh://git@github.com/<old>[.git] or git@github.com:<old>[.git] (as stored in .git/config — a fork, a mirror, a
#     local path, any other host or spelling is never touched, and nothing is asked of the network for it);
#   - only once the new repository exists: git ls-remote of the new address must answer (until the rename it does
#     not, and this does nothing);
#   - only when the new address has every tag the old one has, each at the same commit (the same repository, not
#     another one of that name);
#   - the new address in the same form as the old (https stays https, ssh stays ssh); said once: a second run finds
#     origin moved already. Any failure changes nothing (the old address keeps working).
# Both looks go to the public https addresses whatever origin's form (never ssh: no security key to touch, no agent
# to approve, GIT_SSH untouched), https only, never asking for a password (no credential helper, no askpass, no terminal
# prompt), each with a deadline — and at most once a day (REPO_RENAME_EVERY_S) until it moves origin.

REPO_RENAME_EVERY_S=86400

# repo_url_next URL -> the same address with the new repository name (exact old forms only); exit 1 for anything else
repo_url_next() {
  local u="$1" pre suf
  for pre in "https://github.com/" "ssh://git@github.com/" "git@github.com:"; do
    for suf in "" ".git"; do
      [ "$u" = "$pre$PRODUCT_REPO$suf" ] && { printf '%s%s%s\n' "$pre" "$PRODUCT_REPO_NEXT" "$suf"; return 0; }
    done
  done
  return 1
}

# _repo_tags REPO -> "<commit> <ref>" lines of https://github.com/REPO.git's tags, sorted; exit 1 when it does not
# answer (in REPO_RENAME_TIMEOUT_S seconds) or has no tags. https only: any other protocol (an insteadOf of yours that
# points it at ssh, say) is refused, so the look fails and nothing changes.
_repo_tags() {
  local out
  out="$(_with_deadline "${REPO_RENAME_TIMEOUT_S:-30}" env GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS= \
    git -C "$STACK_DIR" -c credential.helper= -c core.askPass= -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 \
      -c protocol.allow=never -c protocol.https.allow=always -c protocol.ssh.allow=never -c protocol.git.allow=never \
      -c protocol.http.allow=never -c protocol.ext.allow=never \
      ls-remote --tags "https://github.com/$1.git" 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  printf '%s\n' "$out" | LC_ALL=C sort
}

_repo_rename_stamp() { printf '%s/repo-rename-checked\n' "$STATE_DIR"; }

# _repo_rename_due -> 0 when the last look is more than REPO_RENAME_EVERY_S old (or there was none, or its time is
# unreadable or in the future)
_repo_rename_due() {
  local f last now
  f="$(_repo_rename_stamp)"; [ -f "$f" ] || return 0
  last="$(head -c 32 "$f" 2>/dev/null | tr -cd '0-9')"; now="$(date +%s)"
  case "$last" in '' | ?????????????*) return 0 ;; esac   # (none, or more digits than a time has)
  [ "$last" -le "$now" ] && [ $((now - last)) -lt "$REPO_RENAME_EVERY_S" ] && return 1
  return 0
}

# origin_follow_rename — origin moved to the new address when all of the above holds; 0 always (an update never fails
# for it)
origin_follow_rename() {
  local url next old_tags new_tags
  [ -e "$STACK_DIR/.git" ] || return 0
  url="$(git -C "$STACK_DIR" config --get-all remote.origin.url 2>/dev/null)" || return 0
  next="$(repo_url_next "$url")" || return 0   # (two origin URLs: never one of the exact forms)
  _repo_rename_due || return 0
  { mkdir -p "$STATE_DIR" && date +%s > "$(_repo_rename_stamp)"; } 2>/dev/null || true
  new_tags="$(_repo_tags "$PRODUCT_REPO_NEXT")" || return 0
  old_tags="$(_repo_tags "$PRODUCT_REPO")" || return 0
  # every tag of the old address, at the same commit, in the new one (comm -23: the lines only the old one has)
  [ -z "$(LC_ALL=C comm -23 <(printf '%s\n' "$old_tags") <(printf '%s\n' "$new_tags"))" ] || return 0
  git -C "$STACK_DIR" remote set-url origin "$next" 2>/dev/null || return 0
  rm -f "$(_repo_rename_stamp)" 2>/dev/null || true
  log "origin: the project's repository was renamed on GitHub — this checkout now fetches from $next (was $url)"
  return 0
}
