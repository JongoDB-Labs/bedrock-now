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
#     origin moved already. Any failure changes nothing (the old address keeps working); no password is ever asked
#     for (no credential helper, no askpass, no terminal prompt, ssh in batch mode) and each look has a deadline.

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

# _repo_tags URL -> "<commit> <ref>" lines of the address's tags, sorted; exit 1 when it does not answer (in
# REPO_RENAME_TIMEOUT_S seconds) or has no tags
_repo_tags() {
  local ssh out
  ssh="${GIT_SSH_COMMAND:-$(git -C "$STACK_DIR" config core.sshCommand 2>/dev/null || echo ssh)}"
  out="$(_with_deadline "${REPO_RENAME_TIMEOUT_S:-30}" env GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS= \
    GIT_SSH_COMMAND="$ssh -o BatchMode=yes -o ConnectTimeout=20" \
    git -C "$STACK_DIR" -c credential.helper= -c core.askPass= -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 \
    ls-remote --tags "$1" 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  printf '%s\n' "$out" | LC_ALL=C sort
}

# origin_follow_rename — origin moved to the new address when all of the above holds; 0 always (an update never fails
# for it)
origin_follow_rename() {
  local url next old_tags new_tags
  [ -e "$STACK_DIR/.git" ] || return 0
  url="$(git -C "$STACK_DIR" config --get-all remote.origin.url 2>/dev/null)" || return 0
  next="$(repo_url_next "$url")" || return 0   # (two origin URLs: never one of the exact forms)
  new_tags="$(_repo_tags "$next")" || return 0
  old_tags="$(_repo_tags "$url")" || return 0
  # every tag of the old address, at the same commit, in the new one (comm -23: the lines only the old one has)
  [ -z "$(LC_ALL=C comm -23 <(printf '%s\n' "$old_tags") <(printf '%s\n' "$new_tags"))" ] || return 0
  git -C "$STACK_DIR" remote set-url origin "$next" 2>/dev/null || return 0
  log "origin: the project's repository was renamed on GitHub — this checkout now fetches from $next (was $url)"
  return 0
}
