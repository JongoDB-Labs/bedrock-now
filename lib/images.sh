# shellcheck shell=bash
# Precise image cleanup and disk reporting (./stack update, ./stack clean, ./stack status). Sourced by
# lib/commands.sh. Removes ONLY images this project used, never anything another container (any project)
# uses or another bedrock-now checkout's compose.yaml names, and never runs a global prune.
#
# Snapshots in .state/images/ (one "ID<TAB>REF" line per image):
#   before.tsv    the images in use when the running update started (written before 3/4 images)
#   previous.tsv  the images of the version before the current one: KEPT, so ./stack rollback is instant
# After a successful update, before.tsv becomes previous.tsv and the old previous.tsv (previous-previous) is
# removed. Locally built images (<project>/portal:local, <project>/shared-mcp:local) keep their previous build
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
  project_refs "${1:-}" | snapshot_refs > "$d/before.tsv.new" 2>/dev/null || true
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

# images_used_by_containers -> IDs of the images of every container on this machine (any project, any state)
images_used_by_containers() {
  local ids
  ids="$(docker ps -aq --no-trunc 2>/dev/null || true)"
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086  # one argument per container id
  docker inspect --format '{{.Image}}' $ids 2>/dev/null || true
}

# images_of_other_checkouts -> IDs of the images other bedrock-now checkouts' compose.yaml files name (found
# through their owner markers), so a stopped install never loses an image it will need at its next start
images_of_other_checkouts() {
  local me d
  me="$(cd "$STACK_DIR" 2>/dev/null && pwd -P || printf '%s' "$STACK_DIR")"   # same as _real_dir (lib/guard.sh)
  docker volume ls --filter label=io.bedrock-now.dir --format '{{.Label "io.bedrock-now.dir"}}' 2>/dev/null | sort -u |
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

# project_named_images -> "ID<TAB>REF" of the images named after this project (<project>/portal:…, …)
project_named_images() {
  docker image ls --no-trunc --format '{{.ID}}	{{.Repository}}:{{.Tag}}' --filter "reference=$(project_name)/*" 2>/dev/null || true
}

# image_sizes -> "ID<TAB>BYTES" for every local image
image_sizes() {
  local id size
  docker image ls --no-trunc --format '{{.ID}}	{{.Size}}' 2>/dev/null | while IFS='	' read -r id size; do
    printf '%s\t%s\n' "$id" "$(_bytes "$size")"
  done
}

# image_label REF -> what a person calls it: "litellm 1.105.0", "portal (previous build)", "old build"
image_label() {
  local ref="$1" name tag
  [ -n "$ref" ] || { echo "old build"; return 0; }
  ref="${ref%%@*}"; name="${ref%:*}"; tag="${ref##*:}"; [ "$tag" != "$ref" ] || tag=''
  name="${name##*/}"
  case "$tag" in previous | local) printf '%s (previous build)\n' "$name" ;; '') printf '%s\n' "$name" ;; *) printf '%s %s\n' "$name" "$tag" ;; esac
}

# cleanup_plan KEEP_IDS CANDIDATES PROTECTED_IDS -> "ID<TAB>REF" lines to remove: candidates ("ID<TAB>REF",
# REF may be empty) that are neither kept nor protected (used by a container / another checkout). Pure.
cleanup_plan() {
  K="$1" P="$3" awk -F'\t' '
    BEGIN { n = split(ENVIRON["K"] "\n" ENVIRON["P"], a, "\n"); for (i = 1; i <= n; i++) if (a[i] != "") skip[a[i]] = 1 }
    $1 != "" && !($1 in skip) && !($1 in seen) { seen[$1] = 1; print }' <<EOF
$2
EOF
}

# _present_only < plan -> the plan lines whose image still exists (Docker's containerd image store drops an
# untagged build by itself, so a recorded ID may simply be gone)
_present_only() {
  local ids; ids="$(image_sizes | cut -f1)"
  I="$ids" awk -F'\t' 'BEGIN { n = split(ENVIRON["I"], a, "\n"); for (i = 1; i <= n; i++) have[a[i]] = 1 } ($1 in have)'
}

# images_remove PLAN — removes each image by ID (never forced: an image that something else still tags or
# uses stays) and prints "freed N (labels)". Sets CLEAN_SUMMARY. Writes
# .state/images/last-clean (freed_bytes=, summary=, at=) for the host helper.
images_remove() {
  local plan="$1" id ref sizes b freed=0 labels='' kept='' other d
  sizes="$(image_sizes)"
  while IFS='	' read -r id ref; do
    [ -n "$id" ] || continue
    b="$(printf '%s\n' "$sizes" | awk -F'\t' -v i="$id" '$1 == i { print $2; exit }')"
    # Not listed = already gone (Docker's containerd image store drops an untagged build by itself).
    [ -n "$b" ] || continue
    if docker image rm "$id" >/dev/null 2>&1; then
      freed=$((freed + ${b:-0})); labels="$labels, $(image_label "$ref")"
    else
      # Never forced: say why it stays (another name for the same image, or something uses it)
      other="$(docker image inspect --format '{{join .RepoTags " "}}' "$id" 2>/dev/null | tr ' ' '\n' | grep -vxF -- "$ref" | grep . | head -n 1)"
      if [ -n "$other" ]; then kept="$kept, $(image_label "$ref") (also named $other)"
      else kept="$kept, $(image_label "$ref") (still in use)"; fi
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
  log "$CLEAN_SUMMARY"
}

# _protected -> IDs that must never be removed (used by any container, or named by another checkout)
_protected() { { images_used_by_containers; images_of_other_checkouts; } | sort -u; }

# images_after_update — after a successful update: the images it replaced become previous.tsv (kept for
# rollback); the previous-previous ones and this project's dangling builds are removed. Never fatal.
images_after_update() {
  local d now keep cand plan
  d="$(images_dir)"; mkdir -p "$d" 2>/dev/null || return 0
  now="$(project_refs | snapshot_refs)"
  keep="$(printf '%s\n' "$now" | cut -f1; _ids "$d/before.tsv")"
  cand="$(cat "$d/previous.tsv" 2>/dev/null; project_dangling | sed 's/$/	/')"
  plan="$(cleanup_plan "$keep" "$cand" "$(_protected)" | _present_only)"
  [ ! -f "$d/before.tsv" ] || mv "$d/before.tsv" "$d/previous.tsv"
  printf '%s\n' "$now" > "$d/current.tsv"
  images_remove "$plan"
}

# clean_plan -> what ./stack clean would remove: this project's dangling builds, its own named images and the
# images recorded by an earlier update that are no longer the current or the one previous version
clean_plan() {
  local d now keep cand
  d="$(images_dir)"
  now="$(project_refs | snapshot_refs)"
  keep="$(printf '%s\n' "$now" | cut -f1; _ids "$d/previous.tsv" "$d/before.tsv")"
  cand="$(cat "$d/current.tsv" 2>/dev/null; project_named_images; project_dangling | sed 's/$/	/')"
  cleanup_plan "$keep" "$cand" "$(_protected)" | _present_only
}

# cmd_clean — ./stack clean: lists what it would remove, asks, removes. --yes skips the question.
# shellcheck disable=SC2120  # arguments come from the ./stack dispatcher
cmd_clean() {
  local plan sizes total=0 id ref b
  [ $# -eq 0 ] || die "usage: ./stack clean [--yes]"
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  stack_lock clean
  check_docker_daemon
  plan="$(clean_plan)"
  if [ -z "$plan" ]; then
    log "nothing to clean: only the images in use and one previous version (for ./stack rollback) are here"
    images_remove ""
    return 0
  fi
  sizes="$(image_sizes)"
  printf 'Would remove these images of this project (none is in use; the previous version is kept):\n'
  while IFS='	' read -r id ref; do
    b="$(printf '%s\n' "$sizes" | awk -F'\t' -v i="$id" '$1 == i { print $2; exit }')"; total=$((total + ${b:-0}))
    printf '  %-40s %s  %s\n' "$(image_label "$ref")" "$(fmt_bytes "${b:-0}")" "${id#sha256:}" | cut -c1-100
  done <<EOF
$plan
EOF
  printf '  about %s in all\n' "$(fmt_bytes "$total")"
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
    at="$(head -n 1 "$f" | tr -cd '0-9')"; line="$(sed -n 2p "$f")"
    if [ -n "$at" ] && [ -n "$line" ] && [ $((now - at)) -lt 300 ] && [ $((now - at)) -ge 0 ]; then
      printf '%s (as of %s min ago; --disk refreshes)\n' "$line" "$(( (now - at) / 60 ))"; return 0
    fi
  fi
  line="$(disk_line)"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  { printf '%s\n%s\n' "$now" "$line" > "$f.tmp" && mv "$f.tmp" "$f"; } 2>/dev/null || true
  printf '%s\n' "$line"
}

# disk_line -> "Disk: images 3.4 GB (+1.2 GB previous version, for rollback) · data 310 MB · backups 1.1 GB (6)"
disk_line() {
  local img vol bk
  img="$(project_image_bytes)"; vol="$(project_volume_bytes)"; bk="$(backups_bytes)"
  printf 'Disk: images %s' "$(fmt_bytes "${img% *}")"
  [ "${img#* }" = 0 ] || printf ' (+%s previous version, for rollback)' "$(fmt_bytes "${img#* }")"
  printf ' · data volumes %s · backups %s (%s)\n' "$(fmt_bytes "${vol:-0}")" "$(fmt_bytes "${bk% *}")" "${bk#* }"
}
