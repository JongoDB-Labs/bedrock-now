# shellcheck shell=bash
# Precise image cleanup and disk reporting (./stack update, ./stack clean, ./stack status). Sourced by
# lib/commands.sh. Removes ONLY images this project used, never anything another container (any project)
# uses or another bedrock-now checkout's compose.yaml names, and never runs a global prune.
#
# Snapshots in .state/images/ (one "ID<TAB>REF" line per image):
#   before.tsv    the images in use when the running update started (written before 3/4 images)
#   previous.tsv  the images of the version before the current one: KEPT, so ./stack rollback is instant
# After a successful update, before.tsv becomes previous.tsv and the old previous.tsv (previous-previous) is
# removed. Locally built images (<project>/portal:local, <project>/shared-mcp:local, <project>/stt:local) keep their previous build
# as <project>/<name>:previous.

images_dir() { printf '%s/images\n' "$STATE_DIR"; }

# _bytes "1.73GB" -> 1730000000 (Docker's human sizes are decimal: B, kB, MB, GB, TB); "" for nonsense
_bytes() {
  printf '%s\n' "$1" | awk '{
    s = $0; n = s + 0; u = s; sub(/^[0-9.]+/, "", u)
    m = (u == "B" || u == "") ? 1 : (u == "kB" || u == "KB") ? 1e3 : (u == "MB") ? 1e6 : (u == "GB") ? 1e9 : (u == "TB") ? 1e12 : -1
    if (m < 0 || s !~ /^[0-9]/) exit
    printf "%.0f\n", n * m }'
}

# fmt_bytes BYTES -> "3.1 GB" / "450 MB" / "12 kB"
fmt_bytes() {
  awk -v b="${1:-0}" 'BEGIN {
    if (b >= 1e9) printf "%.1f GB\n", b / 1e9; else if (b >= 1e6) printf "%.0f MB\n", b / 1e6;
    else if (b >= 1e3) printf "%.0f kB\n", b / 1e3; else printf "%d B\n", b }'
}

# compose_refs < compose.yaml -> image references ("image:" lines), ${COMPOSE_PROJECT_NAME:-…} → this project
compose_refs() {
  local p; p="$(project_name)"
  sed -n 's/^[[:space:]]*image:[[:space:]]*\([^[:space:]#]*\).*/\1/p' |
    P="$p" awk '{ gsub(/\$\{COMPOSE_PROJECT_NAME:-[^}]*\}/, ENVIRON["P"]); print }' | tr -d '"'"'"
}

# project_refs [COMMIT] -> the images this project's compose.yaml names (at COMMIT, else as checked out now)
project_refs() {
  if [ -n "${1:-}" ] && [ -e "$STACK_DIR/.git" ] && git -C "$STACK_DIR" show "$1:compose.yaml" >/dev/null 2>&1; then
    git -C "$STACK_DIR" show "$1:compose.yaml" | compose_refs
  else
    compose_refs < "$STACK_DIR/compose.yaml"
  fi
}

_image_id() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }

# snapshot_refs < refs -> "ID<TAB>REF" for each reference present locally
snapshot_refs() {
  local ref id
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    id="$(_image_id "$ref")"; [ -z "$id" ] || printf '%s\t%s\n' "$id" "$ref"
  done
}

# _local_build REF -> 0 for this project's locally built images (<project>/<name>:local)
_local_build() { case "$1" in "$(project_name)/"*:local) return 0 ;; esac; return 1; }

# images_snapshot_before [COMMIT] — before 3/4 images: records the images the running version uses (COMMIT =
# the code before the update, so the old pinned versions are known even after the code moved) and tags each
# local build as :previous, so the rebuild in 4/4 does not leave it nameless. Never fatal.
images_snapshot_before() {
  local d ref
  d="$(images_dir)"; mkdir -p "$d" 2>/dev/null || return 0
  # + the browser terminal's and the Code page's local builds while they are on (their overlays are not compose.yaml)
  { project_refs "${1:-}"; ! declare -F terminal_image_refs >/dev/null || terminal_image_refs
    ! declare -F code_image_refs >/dev/null || code_image_refs; } |
    snapshot_refs > "$d/before.tsv.new" 2>/dev/null || true
  mv "$d/before.tsv.new" "$d/before.tsv" 2>/dev/null || true
  while IFS= read -r ref; do
    _local_build "$ref" || continue
    docker tag "$ref" "${ref%:local}:previous" >/dev/null 2>&1 || true
  done <<EOF
$(cut -f2 "$d/before.tsv" 2>/dev/null)
EOF
}

# _ids FILE... -> the IDs (first column) of snapshot files that exist
_ids() { local f; for f in "$@"; do [ -f "$f" ] && cut -f1 "$f"; done; return 0; }

# images_used_by_containers -> IDs of the images of every container on this machine (any project, any state).
# Fails (nothing may be removed then) when Docker cannot say: docker ps fails, or docker inspect twice (a container
# that goes away between the two calls makes one attempt fail).
images_used_by_containers() {
  local ids out _
  for _ in 1 2; do
    ids="$(docker ps -aq --no-trunc 2>/dev/null)" || return 1
    [ -n "$ids" ] || return 0
    # shellcheck disable=SC2086  # one argument per container id
    if out="$(docker inspect --format '{{.Image}}' $ids 2>/dev/null)"; then printf '%s\n' "$out"; return 0; fi
  done
  return 1
}

# images_of_other_checkouts -> IDs of the images other bedrock-now checkouts' compose.yaml files name (found
# through their owner markers), so a stopped install never loses an image it will need at its next start
images_of_other_checkouts() {
  local me d dirs
  me="$(cd "$STACK_DIR" 2>/dev/null && pwd -P || printf '%s' "$STACK_DIR")"   # same as _real_dir (lib/guard.sh)
  dirs="$(docker volume ls --filter label=io.bedrock-now.dir --format '{{.Label "io.bedrock-now.dir"}}' 2>/dev/null)" ||
    return 1   # cannot tell: nothing may be removed
  printf '%s\n' "$dirs" | sort -u |
    while IFS= read -r d; do
      case "$d" in /*) ;; *) continue ;; esac   # labels are free text: only absolute paths
      [ "$d" != "$me" ] && [ -f "$d/compose.yaml" ] && [ ! -L "$d/compose.yaml" ] || continue
      head -c 262144 "$d/compose.yaml" 2>/dev/null |
        sed -n 's/^[[:space:]]*image:[[:space:]]*\([^[:space:]#$]*\)[[:space:]]*$/\1/p' | snapshot_refs | cut -f1
    done
}

# project_dangling -> IDs of this project's untagged images (old local builds; Compose labels what it builds)
project_dangling() {
  docker image ls -q --no-trunc --filter dangling=true --filter "label=com.docker.compose.project=$(project_name)" 2>/dev/null | sort -u
}

# project_named_images -> "ID<TAB>REF" of the images named after this project (<project>/portal:…, …), except the
# :local ones: that name is always some service's current build (also the overlays' caddy-dns, or stt while off)
project_named_images() {
  docker image ls --no-trunc --format '{{.ID}}	{{.Repository}}:{{.Tag}}' --filter "reference=$(project_name)/*" 2>/dev/null |
    awk -F'\t' '$2 !~ /:local$/' || true
}

# overlay_refs -> the images the compose overlays in this checkout name (compose.<name>.yaml: remote access, own
# domain), whether or not they are on: kept like the ones compose.yaml names
overlay_refs() {
  local f
  for f in "$STACK_DIR"/compose.*.yaml; do [ -f "$f" ] && compose_refs < "$f"; done
  return 0
}

# image_sizes -> "ID<TAB>BYTES" for every local image, untagged ones included: Docker 29 (containerd image store)
# leaves them out of `docker image ls` without -a. Only a lookup table: what is removed comes from the snapshots,
# this project's named images and its labelled untagged builds (cleanup_plan), never from this list.
image_sizes() {
  local id size
  # disk_line lists them once for all of its parts (_IMAGE_SIZES, local there)
  if [ -n "${_IMAGE_SIZES:-}" ]; then printf '%s\n' "$_IMAGE_SIZES"; return 0; fi
  docker image ls -a --no-trunc --format '{{.ID}}	{{.Size}}' 2>/dev/null | while IFS='	' read -r id size; do
    printf '%s\t%s\n' "$id" "$(_bytes "$size")"
  done
}

# image_label REF [NAMES] -> what a person calls it: "litellm 1.105.0", "portal (unused build)", "unused build".
# A local build (REF <project>/<name>:local or :previous, or none) is "(previous build)" only while NAMES (the image's
# names now: docker image inspect) still include its :previous name; without it, it is an unused leftover.
image_label() {
  local ref="$1" names="${2:-}" name tag
  [ -n "$ref" ] || { echo "unused build"; return 0; }
  ref="${ref%%@*}"; name="${ref%:*}"; tag="${ref##*:}"; [ "$tag" != "$ref" ] || tag=''
  case "$tag" in
    previous | local)
      case " $names " in *" ${name}:previous "*) printf '%s (previous build)\n' "${name##*/}" ;; *) printf '%s (unused build)\n' "${name##*/}" ;; esac ;;
    '') printf '%s\n' "${name##*/}" ;;
    *) printf '%s %s\n' "${name##*/}" "$tag" ;;
  esac
}

# _names ID -> the image's names now, space-separated ("" for an untagged one)
_names() { docker image inspect --format '{{join .RepoTags " "}}' "$1" 2>/dev/null || true; }

# cleanup_plan KEEP_IDS CANDIDATES PROTECTED_IDS -> "ID<TAB>REF" lines to remove: candidates ("ID<TAB>REF",
# REF may be empty) that are neither kept nor protected (used by a container / another checkout). Pure.
cleanup_plan() {
  K="$1" P="$3" awk -F'\t' '
    BEGIN { n = split(ENVIRON["K"] "\n" ENVIRON["P"], a, "\n"); for (i = 1; i <= n; i++) if (a[i] != "") skip[a[i]] = 1 }
    $1 != "" && !($1 in skip) && !($1 in seen) { seen[$1] = 1; print }' <<EOF
$2
EOF
}

# _present_only < plan -> the plan lines whose image still exists (a recorded ID may have been removed meanwhile,
# by hand or by another tool)
_present_only() {
  local ids; ids="$(image_sizes | cut -f1)"
  I="$ids" awk -F'\t' 'BEGIN { n = split(ENVIRON["I"], a, "\n"); for (i = 1; i <= n; i++) have[a[i]] = 1 } ($1 in have)'
}

# images_remove PLAN — removes each image by ID (never forced: an image that something else still tags or
# uses stays) and prints "old images: freed N (labels)" or "old images: nothing to free". Sets CLEAN_SUMMARY.
# Writes .state/images/last-clean (freed_bytes=, summary=, at=) for the host helper.
images_remove() {
  local plan="$1" id ref sizes b freed=0 labels='' kept='' other d names
  sizes="$(image_sizes)"
  while IFS='	' read -r id ref; do
    [ -n "$id" ] || continue
    b="$(printf '%s\n' "$sizes" | awk -F'\t' -v i="$id" '!f && $1 == i { print $2; f = 1 }')"
    # Not listed = already gone (removed meanwhile). image_sizes lists untagged images too (-a).
    [ -n "$b" ] || continue
    names="$(_names "$id")"
    if docker image rm "$id" >/dev/null 2>&1; then
      freed=$((freed + ${b:-0})); labels="$labels, $(image_label "$ref" "$names")"
    else
      # Never forced: say why it stays (another name for the same image, or something uses it)
      other="$(docker image inspect --format '{{join .RepoTags " "}}' "$id" 2>/dev/null | tr ' ' '\n' | grep -vxF -- "$ref" | grep . | head -n 1)"
      if [ -n "$other" ]; then kept="$kept, $(image_label "$ref" "$names") (also named $other)"
      else kept="$kept, $(image_label "$ref" "$names") (still in use)"; fi
    fi
  done <<EOF
$plan
EOF
  labels="${labels#, }"
  if [ -n "$labels" ]; then
    labels="$(printf '%s\n' "$labels" | tr ',' '\n' | sed 's/^ *//' | sort | uniq -c | awk '{ c = $1; $1 = ""; sub(/^ /, ""); printf "%s%s%s", (NR > 1 ? ", " : ""), (c > 1 ? c " × " : ""), $0 }')"
    CLEAN_SUMMARY="freed $(fmt_bytes "$freed") (old $labels)"
  else
    CLEAN_SUMMARY="nothing to free"
  fi
  [ -z "$kept" ] || CLEAN_SUMMARY="$CLEAN_SUMMARY; kept ${kept#, }"
  d="$(images_dir)"; mkdir -p "$d" 2>/dev/null || true
  printf 'freed_bytes=%s\nsummary=%s\nat=%s\n' "$freed" "$CLEAN_SUMMARY" "$(date +%s)" > "$d/last-clean" 2>/dev/null || true
  rm -f "$STATE_DIR/disk.cache"   # ./stack status measures again (its "old images … ./stack clean" part changed)
  log "old images: $CLEAN_SUMMARY"
}

# LOCAL_BUILDS — the images this project builds itself: <project>/<name>:local (and :previous, the build before the
# last update's, kept for ./stack rollback); caddy-dns only with the own-domain overlay, and never a :previous
LOCAL_BUILDS="portal shared-mcp stt terminal terminal-egress code caddy-dns"

# local_builds_remove — ./stack uninstall, after compose's down: this install's built images by their exact names,
# only those that exist. Never forced and never a prune: an image something still uses stays (and is named).
local_builds_remove() {
  local p n t ref removed='' kept=''
  p="$(project_name)"
  for n in $LOCAL_BUILDS; do
    for t in local previous; do
      ref="$p/$n:$t"
      docker image inspect "$ref" >/dev/null 2>&1 || continue
      if docker image rm "$ref" >/dev/null 2>&1; then removed="$removed $n:$t"; else kept="$kept $ref"; fi
    done
  done
  [ -z "$removed" ] || log "removed this install's built images:$removed"
  [ -z "$kept" ] || warn "could not remove the image(s)$kept (still in use?) — docker image rm <name> removes one once nothing uses it"
}

# _protected -> IDs that must never be removed (used by any container, or named by another checkout). Fails when
# Docker cannot list them: the callers then remove nothing.
_protected() {
  local used other
  used="$(images_used_by_containers)" || return 1
  other="$(images_of_other_checkouts)" || return 1
  printf '%s\n%s\n' "$used" "$other" | sort -u
}
_PROTECTED_FAILED="could not list the images in use (docker ps or docker volume ls failed)"

# images_after_update — after a successful update: the images it replaced become previous.tsv (kept for
# rollback); the previous-previous ones and this project's dangling builds are removed. Never fatal.
images_after_update() {
  local d now keep cand plan prot
  d="$(images_dir)"; mkdir -p "$d" 2>/dev/null || return 0
  now="$(project_refs | snapshot_refs)"
  keep="$(printf '%s\n' "$now" | cut -f1; _ids "$d/before.tsv"; overlay_refs | snapshot_refs | cut -f1)"
  if ! prot="$(_protected)"; then
    # Remove nothing. The version just replaced and the one before it both stay recorded as previous, so the next
    # update removes the older one (./stack clean keeps both meanwhile).
    if [ -f "$d/before.tsv" ]; then
      cat "$d/before.tsv" "$d/previous.tsv" 2>/dev/null | sort -u > "$d/previous.tsv.new" && mv "$d/previous.tsv.new" "$d/previous.tsv"
      rm -f "$d/before.tsv"
    fi
    printf '%s\n' "$now" > "$d/current.tsv"
    warn "old images: $_PROTECTED_FAILED — none was removed; the next ./stack update tries again"
    return 0
  fi
  cand="$(cat "$d/previous.tsv" 2>/dev/null; project_dangling | sed 's/$/	/')"
  plan="$(cleanup_plan "$keep" "$cand" "$prot" | _present_only)"
  [ ! -f "$d/before.tsv" ] || mv "$d/before.tsv" "$d/previous.tsv"
  printf '%s\n' "$now" > "$d/current.tsv"
  images_remove "$plan"
}

# clean_plan -> what ./stack clean would remove: this project's dangling builds, its own named images and the
# images recorded by an earlier update that are no longer the current or the one previous version
clean_plan() {
  local d now keep cand prot
  d="$(images_dir)"
  prot="$(_protected)" || return 1
  now="$(project_refs | snapshot_refs)"
  keep="$(printf '%s\n' "$now" | cut -f1; _ids "$d/previous.tsv" "$d/before.tsv"; overlay_refs | snapshot_refs | cut -f1)"
  cand="$(cat "$d/current.tsv" 2>/dev/null; project_named_images; project_dangling | sed 's/$/	/')"
  cleanup_plan "$keep" "$cand" "$prot" | _present_only
}

# cmd_clean — ./stack clean: lists what it would remove, asks, removes. --yes skips the question; --dry-run
# only lists (no lock, no removal, no last-clean record).
# shellcheck disable=SC2120  # arguments come from the ./stack dispatcher
cmd_clean() {
  local plan sizes total=0 id ref b dry=0
  case "$#:${1:-}" in 0:) ;; 1:--dry-run) dry=1 ;; *) die "usage: ./stack clean [--dry-run] [--yes]" ;; esac
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  [ "$dry" = 1 ] || stack_lock clean
  check_docker_daemon
  plan="$(clean_plan)" || die "$_PROTECTED_FAILED — nothing was removed; try again"
  if [ -z "$plan" ]; then
    log "nothing to clean: only the images in use and one previous version (for ./stack rollback) are here"
    [ "$dry" = 1 ] || images_remove ""
    return 0
  fi
  sizes="$(image_sizes)"
  printf 'Would remove these images of this project (none is in use; the previous version is kept):\n'
  while IFS='	' read -r id ref; do
    b="$(printf '%s\n' "$sizes" | awk -F'\t' -v i="$id" '!f && $1 == i { print $2; f = 1 }')"; total=$((total + ${b:-0}))
    printf '  %-40s %s  %s\n' "$(image_label "$ref" "$(_names "$id")")" "$(fmt_bytes "${b:-0}")" "${id#sha256:}" | cut -c1-100
  done <<EOF
$plan
EOF
  printf '  about %s in all\n' "$(fmt_bytes "$total")"
  if [ "$dry" = 1 ]; then log "dry run: nothing was removed (./stack clean removes them)"; return 0; fi
  [ "${ASSUME_YES:-0}" = 1 ] || _have_tty || die "re-run with --yes to remove them non-interactively — nothing was removed"
  confirm "Remove them?" || die "aborted — nothing was removed"
  images_remove "$plan"
}

# --- disk usage (./stack status) ---

# project_volume_bytes -> bytes used by this project's volumes (from docker system df -v)
project_volume_bytes() {
  local p; p="$(project_name)"
  docker system df -v 2>/dev/null | P="${p}_" awk '
    /^VOLUME NAME/ { f = 1; next } f && NF == 0 { f = 0 }
    f && index($1, ENVIRON["P"]) == 1 { print $NF }' | while IFS= read -r s; do _bytes "$s"; done |
    awk '{ t += $1 } END { printf "%.0f\n", t }'
}

# project_image_bytes -> "IN_USE PREVIOUS" bytes of this project's images (each image counted once)
project_image_bytes() {
  local d now prev sizes
  d="$(images_dir)"; sizes="$(image_sizes)"
  now="$(project_refs | snapshot_refs | cut -f1 | sort -u)"
  prev="$(_ids "$d/previous.tsv" | sort -u)"
  N="$now" V="$prev" awk -F'\t' '
    BEGIN { n = split(ENVIRON["N"], a, "\n"); for (i = 1; i <= n; i++) if (a[i] != "") cur[a[i]] = 1
            n = split(ENVIRON["V"], a, "\n"); for (i = 1; i <= n; i++) if (a[i] != "" && !(a[i] in cur)) old[a[i]] = 1 }
    ($1 in cur) { u += $2 } ($1 in old) { p += $2 }
    END { printf "%.0f %.0f\n", u, p }' <<EOF
$sizes
EOF
}

# backups_bytes -> "BYTES COUNT" of backups/ (complete backups only)
backups_bytes() {
  local d n=0 kb=0 k
  for d in "$STACK_DIR"/backups/*; do
    [ -d "$d" ] || continue
    case "$d" in *.partial) continue ;; esac
    n=$((n + 1)); k="$(du -sk "$d" 2>/dev/null | cut -f1)"; kb=$((kb + ${k:-0}))
  done
  printf '%s %s\n' "$((kb * 1024))" "$n"
}

# disk_line_cached [--fresh] -> disk_line, reused for 5 minutes (it takes a few seconds: docker system df -v)
disk_line_cached() {
  local f line at now
  f="$STATE_DIR/disk.cache"; now="$(date +%s)"
  if [ "${1:-}" != --fresh ] && [ -f "$f" ] && [ ! -L "$f" ]; then
    at="$(head -n 1 "$f" | head -c 15)"; line="$(sed -n 2p "$f")"
    case "$at" in '' | *[!0-9]*) at='' ;; *) at=$((10#$at)) ;; esac   # digits only; a leading 0 is not octal
    if [ -n "$at" ] && [ -n "$line" ] && [ $((now - at)) -lt 300 ] && [ $((now - at)) -ge 0 ]; then
      printf '%s (as of %s min ago; --disk refreshes)\n' "$line" "$(( (now - at) / 60 ))"; return 0
    fi
  fi
  line="$(disk_line)"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  { printf '%s\n%s\n' "$now" "$line" > "$f.tmp" && mv "$f.tmp" "$f"; } 2>/dev/null || true
  printf '%s\n' "$line"
}

# clean_plan_bytes -> bytes ./stack clean would free now (0 when nothing)
clean_plan_bytes() {
  local plan
  plan="$(clean_plan)" && [ -n "$plan" ] || { echo 0; return 0; }   # unknown counts as nothing to offer
  P="$plan" awk -F'\t' 'BEGIN { n = split(ENVIRON["P"], a, "\n"); for (i = 1; i <= n; i++) { split(a[i], f, "\t"); if (f[1] != "") want[f[1]] = 1 } }
    ($1 in want) { t += $2; delete want[$1] } END { printf "%.0f\n", t }' <<EOF
$(image_sizes)
EOF
}

# disk_line -> "Disk: images 3.4 GB (+1.2 GB previous version, for rollback) · data 310 MB · backups 1.1 GB (6)",
# plus " · old images 600 MB (./stack clean removes them)" when ./stack clean would free something
disk_line() {
  local img vol bk old _IMAGE_SIZES
  _IMAGE_SIZES="$(image_sizes)"
  img="$(project_image_bytes)"; vol="$(project_volume_bytes)"; bk="$(backups_bytes)"; old="$(clean_plan_bytes)"
  printf 'Disk: images %s' "$(fmt_bytes "${img% *}")"
  [ "${img#* }" = 0 ] || printf ' (+%s previous version, for rollback)' "$(fmt_bytes "${img#* }")"
  printf ' · data volumes %s · backups %s (%s)' "$(fmt_bytes "${vol:-0}")" "$(fmt_bytes "${bk% *}")" "${bk#* }"
  [ "${old:-0}" = 0 ] || printf ' · old images %s (./stack clean removes them)' "$(fmt_bytes "$old")"
  printf '\n'
}
