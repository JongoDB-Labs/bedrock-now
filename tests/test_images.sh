# shellcheck shell=bash
# lib/images.sh: precise cleanup after ./stack update, ./stack clean and the disk line of ./stack status.
# Docker is stubbed with a tiny image store in $TMP/imgs ("ID<TAB>REF<TAB>SIZE<TAB>COMPOSE-PROJECT-LABEL",
# REF "<none>" for an untagged image), container images in $CTR_IMAGES, other checkouts in $OTHER_DIRS.
# Like Docker 29 (containerd image store), `docker image ls` leaves untagged images out unless -a is given.
. "$STACK_DIR/lib/commands.sh"

_store() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:-}" >> "$TMP/imgs"; }   # _store ID REF SIZE [LABEL]
_refs_of() { awk -F'\t' -v i="$1" '$1 == i && $2 != "<none>" { print $2 }' "$TMP/imgs"; }

_stub_docker() {
  : >> "$TMP/imgs"
  docker() {
    local a last; for a in "$@"; do last="$a"; done
    case "$*" in
      "image inspect --format {{join .RepoTags \" \"}} "*) _refs_of "$last" | tr '\n' ' ' ;;
      "image inspect --format {{.Id}} "*) awk -F'\t' -v r="$last" '$2 == r { print $1; f = 1; exit } END { exit !f }' "$TMP/imgs" ;;
      "tag "*)
        local id; id="$(awk -F'\t' -v r="$2" '$2 == r { print $1; exit }' "$TMP/imgs")"; [ -n "$id" ] || return 1
        echo "tag $2 $3" >> "$TMP/dcalls"
        awk -F'\t' -v OFS='\t' -v r="$3" '$2 == r { $2 = "<none>" } { print }' "$TMP/imgs" > "$TMP/imgs.n"
        awk -F'\t' -v i="$id" '$1 == i { print $3 "\t" $4; exit }' "$TMP/imgs" > "$TMP/meta"
        mv "$TMP/imgs.n" "$TMP/imgs"; printf '%s\t%s\t%s\n' "$id" "$3" "$(cat "$TMP/meta")" >> "$TMP/imgs"
        # an ID that now has a name loses its <none> row
        awk -F'\t' '{ n[$1] += ($2 != "<none>"); row[NR] = $0; id[NR] = $1; ref[NR] = $2 }
          END { for (i = 1; i <= NR; i++) if (!(ref[i] == "<none>" && n[id[i]] > 0)) print row[i] }' "$TMP/imgs" | sort -u > "$TMP/imgs.n"
        mv "$TMP/imgs.n" "$TMP/imgs" ;;
      info) return 0 ;;
      "ps -aq --no-trunc") [ -z "${CTR_IMAGES:-}" ] || printf '%s\n' "$CTR_IMAGES" | sed 's/^/ctr-/' ;;
      "inspect --format {{.Image}} "*) shift 3; for a in "$@"; do printf '%s\n' "${a#ctr-}"; done ;;
      "volume ls --filter label=io.bedrock-now.dir "*) [ -z "${OTHER_DIRS:-}" ] || printf '%s\n' "$OTHER_DIRS" ;;
      "image ls -q --no-trunc --filter dangling=true --filter label=com.docker.compose.project="*)
        awk -F'\t' -v p="${last#label=com.docker.compose.project=}" '$2 == "<none>" && $4 == p { print $1 }' "$TMP/imgs" ;;
      # Docker 29 (containerd image store): without -a the list leaves untagged images out ("dangling=true" still finds them)
      "image ls --no-trunc --format {{.ID}}	{{.Size}}") awk -F'\t' '$2 != "<none>" && !s[$1]++ { print $1 "\t" $3 }' "$TMP/imgs" ;;
      "image ls -a --no-trunc --format {{.ID}}	{{.Size}}") awk -F'\t' '!s[$1]++ { print $1 "\t" $3 }' "$TMP/imgs" ;;
      "image ls --no-trunc --format {{.ID}}	{{.Repository}}:{{.Tag}} --filter reference="*)
        local pre="${last#reference=}"; pre="${pre%\*}"
        awk -F'\t' -v p="$pre" 'index($2, p) == 1 { print $1 "\t" $2 }' "$TMP/imgs" ;;
      "image rm "*)
        echo "rm $last" >> "$TMP/dcalls"
        case "
${CTR_IMAGES:-}
" in *"
$last
"*) return 1 ;; esac
        [ "$(_refs_of "$last" | wc -l | tr -d ' ')" -le 1 ] || return 1
        awk -F'\t' -v i="$last" '$1 != i' "$TMP/imgs" > "$TMP/imgs.n"; mv "$TMP/imgs.n" "$TMP/imgs" ;;
      "system df -v") printf 'Images space usage:\n\nREPOSITORY TAG\nx y\n\nLocal Volumes space usage:\n\nVOLUME NAME   LINKS   SIZE\nbn-t_pgdata   1   300MB\nbn-t_owui   1   10.5MB\nother_pgdata   1   9GB\n\nBuild cache usage: 0B\n' ;;
      *system\ prune* | *image\ prune* | *builder\ prune*) echo "GLOBAL PRUNE $*" >> "$TMP/dcalls"; return 1 ;;
      *) echo "unexpected docker $*" >&2; return 1 ;;
    esac
  }
}

_compose() { # _compose LITELLM_TAG — this checkout's compose.yaml
  mkdir -p "$STACK_DIR"
  printf 'services:\n  litellm:\n    image: ghcr.io/berriai/litellm:%s\n  portal:\n    build: { context: ./portal }\n    image: ${COMPOSE_PROJECT_NAME:-bedrock-now}/portal:local   # per project\n  caddy:\n    image: caddy:2.11.7-alpine@sha256:abc\n' "$1" > "$STACK_DIR/compose.yaml"
}

_setup() {
  STACK_DIR="$TMP/stack"; _compose 1
  printf 'COMPOSE_PROJECT_NAME=bn-t\nPOSTGRES_PASSWORD=p\n' > "$ENV_FILE"
  _stub_docker
  _store L1 ghcr.io/berriai/litellm:1 1.7GB
  _store P1 bn-t/portal:local 213MB bn-t
  _store C1 caddy:2.11.7-alpine@sha256:abc 90MB
}

# one update: new litellm tag, a rebuilt portal (what 3/4 and 4/4 do), then the cleanup
_fake_update() { # _fake_update LITELLM_TAG NEW_LITELLM_ID NEW_PORTAL_ID
  images_snapshot_before ""
  _compose "$1"; _store "$2" "ghcr.io/berriai/litellm:$1" 1.8GB
  awk -F'\t' -v OFS='\t' '$2 == "bn-t/portal:local" { $2 = "<none>" } { print }' "$TMP/imgs" > "$TMP/imgs.n"; mv "$TMP/imgs.n" "$TMP/imgs"
  _store "$3" bn-t/portal:local 220MB bn-t
  images_after_update
}

test_bytes_and_fmt_bytes() {
  assert_eq "$(_bytes 1.73GB)" 1730000000
  assert_eq "$(_bytes 213MB)" 213000000
  assert_eq "$(_bytes 45.5kB)" 45500
  assert_eq "$(_bytes 22B)" 22
  assert_eq "$(_bytes nonsense)" ""
  assert_eq "$(fmt_bytes 3100000000)" "3.1 GB"
  assert_eq "$(fmt_bytes 450000000)" "450 MB"
  assert_eq "$(fmt_bytes 0)" "0 B"
}

test_compose_refs_resolve_the_project_name() {
  _setup
  assert_eq "$(project_refs | tr '\n' ' ')" "ghcr.io/berriai/litellm:1 bn-t/portal:local caddy:2.11.7-alpine@sha256:abc "
}

test_project_refs_reads_the_old_compose_file_from_git() {
  _setup
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
  git init -q "$STACK_DIR"; git -C "$STACK_DIR" add compose.yaml; git -C "$STACK_DIR" commit -qm one
  old="$(git -C "$STACK_DIR" rev-parse HEAD)"; _compose 2
  assert_contains "$(project_refs "$old")" "litellm:1"
  assert_contains "$(project_refs)" "litellm:2"
  assert_contains "$(project_refs nope)" "litellm:2"   # unknown commit: the checked-out file
}

test_first_update_keeps_the_previous_version_and_removes_nothing() {
  _setup
  _fake_update 2 L2 P2 2> "$TMP/err"
  assert_contains "$(cat "$TMP/imgs")" "L1	ghcr.io/berriai/litellm:1"
  assert_contains "$(cat "$TMP/imgs")" "P1	bn-t/portal:previous"
  assert_contains "$(cat "$TMP/err")" "==> old images: nothing to free"   # not a bare "nothing to free"
  assert_eq "$(cut -f1 "$STATE_DIR/images/previous.tsv" | sort | tr '\n' ' ')" "C1 L1 P1 "
  [ ! -f "$STATE_DIR/images/before.tsv" ] || { echo "before.tsv must become previous.tsv" >&2; return 1; }
}

test_second_update_removes_the_previous_previous_version_and_reports_it() {
  _setup
  _fake_update 2 L2 P2 2>/dev/null
  _fake_update 3 L3 P3 2> "$TMP/err"
  imgs="$(cut -f1 "$TMP/imgs" | sort -u | tr '\n' ' ')"
  assert_eq "$imgs" "C1 L2 L3 P2 P3 "
  assert_contains "$(cat "$TMP/imgs")" "P2	bn-t/portal:previous"
  assert_contains "$(cat "$TMP/err")" "freed 1.9 GB (old litellm 1, portal (previous build))"
  assert_eq "$(sed -n 's/^freed_bytes=//p' "$STATE_DIR/images/last-clean")" 1913000000
  assert_not_contains "$(cat "$TMP/dcalls")" "GLOBAL PRUNE"
  assert_not_contains "$(cat "$TMP/dcalls")" "rm C1"
}

test_images_used_by_any_container_or_another_checkout_are_kept() {
  _setup
  _fake_update 2 L2 P2 2>/dev/null
  mkdir -p "$TMP/other"; printf 'services:\n  x:\n    image: ghcr.io/berriai/litellm:1\n' > "$TMP/other/compose.yaml"
  OTHER_DIRS="$(printf '%s\n%s' "$TMP/other" "$(_real_dir "$STACK_DIR")")"
  CTR_IMAGES=P1
  _fake_update 3 L3 P3 2> "$TMP/err"
  assert_contains "$(cut -f1 "$TMP/imgs" | tr '\n' ' ')" "L1"
  assert_contains "$(cut -f1 "$TMP/imgs" | tr '\n' ' ')" "P1"
  assert_not_contains "$(cat "$TMP/dcalls" 2>/dev/null)" "rm L1"
  assert_contains "$(cat "$TMP/err")" "nothing to free"
}

test_only_this_projects_dangling_builds_are_removed() {
  _setup
  _store D1 '<none>' 200MB bn-t
  _store D2 '<none>' 200MB other-project
  _store D3 '<none>' 200MB ''
  _fake_update 2 L2 P2 2> "$TMP/err"
  ids="$(cut -f1 "$TMP/imgs" | sort -u | tr '\n' ' ')"
  assert_not_contains "$ids" "D1"
  assert_contains "$ids" "D2"
  assert_contains "$ids" "D3"
  assert_contains "$(cat "$TMP/err")" "freed 200 MB (old old build)"
}

test_untagged_leftovers_are_found_although_image_ls_hides_them() {
  # Docker 29 lists untagged images only with -a. A rollback leaves the builds it re-tags away from untagged,
  # labelled with this project: ./stack clean must see them (it said "nothing to clean" with 4 of them there).
  _setup
  _store U1 '<none>' 214MB bn-t; _store U2 '<none>' 250MB bn-t; _store U3 '<none>' 280MB bn-t; _store U4 '<none>' 312MB bn-t
  out="$(cmd_clean --dry-run 2>&1 </dev/null)"
  assert_not_contains "$out" "nothing to clean"
  assert_contains "$out" "about 1.1 GB in all"
  ASSUME_YES=1 cmd_clean > /dev/null 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "freed 1.1 GB"
  assert_eq "$(cut -f1 "$TMP/imgs" | sort -u | tr '\n' ' ')" "C1 L1 P1 "
}

test_untagged_leftovers_of_a_rollback_go_with_the_next_update() {
  _setup
  _fake_update 2 L2 P2 2>/dev/null
  docker tag bn-t/portal:previous bn-t/portal:local   # what ./stack rollback does: P2 loses its name
  printf 'L2\tghcr.io/berriai/litellm:2\n' > "$STATE_DIR/images/previous.tsv"   # (its record names only L2)
  _compose 1
  _fake_update 3 L3 P3 2> "$TMP/err"
  assert_not_contains "$(cut -f1 "$TMP/imgs" | tr '\n' ' ')" "P2"
  assert_contains "$(cat "$TMP/err")" "old images: freed"
}

test_listing_every_image_never_widens_what_is_removed() {
  _setup
  _store D1 '<none>' 200MB bn-t            # this project's unused leftover: the only image to go
  _store D2 '<none>' 200MB other-project   # another project's untagged build
  _store D3 '<none>' 200MB ''              # untagged without a Compose label (e.g. an intermediate image)
  _store D4 '<none>' 200MB bn-t            # this project's, but a container still uses it
  _store O1 other/app:1 100MB other-project
  CTR_IMAGES=D4
  assert_eq "$(clean_plan | cut -f1 | tr '\n' ' ')" "D1 "
  ASSUME_YES=1 cmd_clean > /dev/null 2>&1
  _fake_update 2 L2 P2 2>/dev/null
  ids="$(cut -f1 "$TMP/imgs" | sort -u | tr '\n' ' ')"
  assert_eq "$ids" "C1 D2 D3 D4 L1 L2 O1 P1 P2 "
  assert_eq "$(grep -c '^rm ' "$TMP/dcalls")" 1
  assert_contains "$(cat "$TMP/dcalls")" "rm D1"
}

test_current_local_builds_are_never_offered() {
  # :local is always some service's current build. After ./stack down no container protects it: caddy-dns (the
  # own-domain overlay's xcaddy build, a networked rebuild) and stt (off, or not in this version's compose.yaml)
  # must still never be removed or shown as "(previous build)".
  _setup
  printf 'services:\n  caddy:\n    image: ${COMPOSE_PROJECT_NAME:-bedrock-now}/caddy-dns:local\n' > "$STACK_DIR/compose.domain.yaml"
  _store CD1 bn-t/caddy-dns:local 120MB bn-t
  _store S1 bn-t/stt:local 150MB bn-t
  _store X1 bn-t/shared-mcp:old 300MB bn-t
  mkdir -p "$STATE_DIR/images"; printf 'CD1\tbn-t/caddy-dns:local\n' > "$STATE_DIR/images/current.tsv"   # recorded once
  assert_eq "$(clean_plan | cut -f1 | tr '\n' ' ')" "X1 "
  out="$(ASSUME_YES=1 cmd_clean 2>&1)"
  assert_not_contains "$out" "previous build"
  assert_eq "$(cut -f1 "$TMP/imgs" | sort -u | tr '\n' ' ')" "C1 CD1 L1 P1 S1 "
  _fake_update 2 L2 P2 2>/dev/null   # the overlay's build stays through an update's cleanup too
  assert_contains "$(cut -f1 "$TMP/imgs" | tr '\n' ' ')" "CD1"
}

test_cleanup_removes_nothing_when_it_cannot_tell_what_is_in_use() {
  _setup
  _fake_update 2 L2 P2 2>/dev/null
  _store D1 '<none>' 200MB bn-t
  eval "_ok_$(declare -f docker)"
  docker() { case "$*" in "ps -aq --no-trunc") return 1 ;; esac; _ok_docker "$@"; }   # e.g. the daemon went away
  if out="$( (ASSUME_YES=1 cmd_clean) 2>&1)"; then return 1; fi
  assert_contains "$out" "could not list the images in use"
  assert_contains "$(cut -f1 "$TMP/imgs" | tr '\n' ' ')" "D1"
  assert_not_contains "$(disk_line)" "./stack clean"
  # an update's cleanup: nothing removed, and the version it replaced stays recorded with the one before it
  _fake_update 3 L3 P3 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "could not list the images in use"
  assert_eq "$(cut -f1 "$TMP/imgs" | sort -u | tr '\n' ' ')" "C1 D1 L1 L2 L3 P1 P2 P3 "
  assert_eq "$(cut -f1 "$STATE_DIR/images/previous.tsv" | sort -u | tr '\n' ' ')" "C1 L1 L2 P1 P2 "
  docker() { _ok_docker "$@"; }   # the next update removes both older versions
  _fake_update 4 L4 P4 2> "$TMP/err"
  assert_eq "$(cut -f1 "$TMP/imgs" | sort -u | tr '\n' ' ')" "C1 L3 L4 P3 P4 "
  # the same when the other checkouts cannot be listed
  docker() { case "$*" in "volume ls "*) return 1 ;; esac; _ok_docker "$@"; }
  _store D2 '<none>' 200MB bn-t
  if (ASSUME_YES=1 cmd_clean) > /dev/null 2>&1; then return 1; fi
  assert_contains "$(cut -f1 "$TMP/imgs" | tr '\n' ' ')" "D2"
}

test_an_image_docker_still_needs_is_kept_and_said() {
  _setup
  _fake_update 2 L2 P2 2>/dev/null
  _store L1 my/own:copy 1.7GB   # someone else tagged it too: never forced
  _fake_update 3 L3 P3 2> "$TMP/err"
  assert_contains "$(cut -f1 "$TMP/imgs" | tr '\n' ' ')" "L1"
  assert_contains "$(cat "$TMP/err")" "kept litellm 1 (also named my/own:copy)"
}

test_images_that_are_already_gone_are_not_reported() {
  _setup
  _fake_update 2 L2 P2 2>/dev/null
  # the old portal build was removed meanwhile (by hand, or by another tool)
  awk -F'\t' '$1 != "P1"' "$TMP/imgs" > "$TMP/imgs.n"; mv "$TMP/imgs.n" "$TMP/imgs"
  _fake_update 3 L3 P3 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "freed 1.7 GB (old litellm 1)"
  assert_not_contains "$(cat "$TMP/err")" "portal"
  assert_not_contains "$(cat "$TMP/dcalls")" "rm P1"
}

test_cleanup_plan_is_pure_set_arithmetic() {
  plan="$(cleanup_plan "$(printf 'a\nb')" "$(printf 'a\tx:1\nc\tx:2\nc\tx:3\nd\t\ne\t')" "e")"
  assert_eq "$plan" "$(printf 'c\tx:2\nd\t')"
}

test_clean_lists_first_then_removes_with_yes() {
  _setup
  _fake_update 2 L2 P2 2>/dev/null
  _store D1 '<none>' 200MB bn-t
  _store X1 bn-t/shared-mcp:old 300MB bn-t
  out="$(ASSUME_YES=1 cmd_clean 2> "$TMP/err")"
  assert_contains "$out" "Would remove"
  assert_contains "$out" "shared-mcp old"
  assert_contains "$out" "old build"
  assert_contains "$out" "about 500 MB in all"
  assert_contains "$(cat "$TMP/err")" "freed 500 MB"
  ids="$(cut -f1 "$TMP/imgs" | sort -u | tr '\n' ' ')"
  assert_eq "$ids" "C1 L1 L2 P1 P2 "   # current + one previous version stay
}

test_clean_without_tty_or_yes_removes_nothing() {
  _setup; _store D1 '<none>' 200MB bn-t
  if out="$( (ASSUME_YES=0 cmd_clean </dev/null) 2>&1)"; then
    _have_tty && return 77   # a terminal is attached: the question would be asked
    return 1
  fi
  assert_contains "$out" "re-run with --yes"
  assert_contains "$(cat "$TMP/imgs")" "D1"
}

test_clean_dry_run_lists_and_removes_nothing() {
  _setup
  _fake_update 2 L2 P2 2>/dev/null
  _store D1 '<none>' 200MB bn-t
  before="$(cat "$TMP/imgs")"; rm -f "$STATE_DIR/images/last-clean" "$TMP/dcalls"
  out="$(ASSUME_YES=1 cmd_clean --dry-run 2>&1)"
  assert_contains "$out" "Would remove"
  assert_contains "$out" "old build"
  assert_contains "$out" "dry run: nothing was removed"
  assert_eq "$(cat "$TMP/imgs")" "$before"
  assert_not_contains "$(cat "$TMP/dcalls" 2>/dev/null)" "rm "
  [ ! -e "$STATE_DIR/images/last-clean" ]
}

test_clean_dry_run_with_nothing_to_do() {
  _setup
  out="$(cmd_clean --dry-run 2>&1 </dev/null)"
  assert_contains "$out" "nothing to clean"
  [ ! -e "$STATE_DIR/images/last-clean" ]
}

test_clean_with_nothing_to_do_says_so() {
  _setup
  out="$(ASSUME_YES=1 cmd_clean 2>&1)"
  assert_contains "$out" "nothing to clean"
  assert_eq "$(sed -n 's/^freed_bytes=//p' "$STATE_DIR/images/last-clean")" 0
}

test_clean_needs_setup_and_takes_no_arguments() {
  STACK_DIR="$TMP/stack"; _compose 1; _stub_docker
  check_docker_daemon() { :; }
  if out="$( (cmd_clean) 2>&1)"; then return 1; fi
  assert_contains "$out" "./stack setup"
  printf 'X=1\n' > "$ENV_FILE"
  if out="$( (cmd_clean --force) 2>&1)"; then return 1; fi
  assert_contains "$out" "usage: ./stack clean [--dry-run] [--yes]"
}

test_disk_line_counts_project_images_volumes_and_backups() {
  _setup
  _fake_update 2 L2 P2 2>/dev/null
  mkdir -p "$STACK_DIR/backups/20260101-000000-auto" "$STACK_DIR/backups/x.partial"
  head -c 2048 /dev/zero > "$STACK_DIR/backups/20260101-000000-auto/litellm.dump"
  line="$(disk_line)"
  assert_contains "$line" "images 2.1 GB (+1.9 GB previous version, for rollback)"   # L2+P2+C1 / L1+P1
  assert_contains "$line" "data volumes 310 MB"
  assert_contains "$line" "(1)"
}

test_disk_line_mentions_clean_only_when_there_is_something_to_clean() {
  _setup
  _fake_update 2 L2 P2 2>/dev/null
  assert_not_contains "$(disk_line)" "./stack clean"   # the current and one previous version only
  _store D1 '<none>' 200MB bn-t
  eval "_counted_$(declare -f docker)"   # counts the full image listings (about a second each on a busy machine)
  docker() { case "$*" in "image ls -a "*) echo x >> "$TMP/listings" ;; esac; _counted_docker "$@"; }
  assert_contains "$(disk_line)" " · old images 200 MB (./stack clean removes them)"
  assert_eq "$(wc -l < "$TMP/listings" | tr -d ' ')" 1
}

test_removing_images_refreshes_the_cached_disk_line() {
  _setup; _store D1 '<none>' 200MB bn-t
  disk_line_cached > /dev/null
  [ -f "$STATE_DIR/disk.cache" ] || return 1
  ASSUME_YES=1 cmd_clean > /dev/null 2>&1
  [ ! -e "$STATE_DIR/disk.cache" ] || { echo "the cached disk line still offers ./stack clean" >&2; return 1; }
}

test_update_snapshots_before_images_and_cleans_only_after_setup_succeeded() {
  printf 'X=1\n' > "$ENV_FILE"; STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"
  printf '#!/bin/sh\nexit ${FAKE_RC:-0}\n' > "$STACK_DIR/stack"; chmod +x "$STACK_DIR/stack"
  dc() { echo "dc $1" >> "$TMP/calls"; }
  images_snapshot_before() { echo "snapshot ${1:-}" >> "$TMP/calls"; }
  images_after_update() { echo "after" >> "$TMP/calls"; }
  update_record_write() { :; }
  fake_reexec; BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_BACKUP=backups/b BEDROCK_NOW_UPDATE_FROM=abc123 cmd_update 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "snapshot abc123;dc pull;after;"
  : > "$TMP/calls"
  if (fake_reexec; FAKE_RC=3 BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_FROM=abc123 cmd_update) 2>/dev/null; then return 1; fi
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "snapshot abc123;dc pull;"
}

test_no_global_prune_anywhere() {
  assert_eq "$(grep -nE 'system prune|image prune|builder prune|buildx prune|volume prune|rmi -f|image rm -f|image rm --force' "$T_ROOT"/lib/*.sh "$T_ROOT/stack" || true)" ""
}

test_disk_line_is_cached_for_five_minutes() {   # M4
  disk_line() { echo "Disk: call $(date +%s%N)"; echo x >> "$TMP/n"; }
  a="$(disk_line_cached)"; b="$(disk_line_cached)"
  assert_eq "$(wc -l < "$TMP/n" | tr -d ' ')" 1
  assert_contains "$b" "(as of 0 min ago; --disk refreshes)"
  disk_line_cached --fresh > /dev/null
  assert_eq "$(wc -l < "$TMP/n" | tr -d ' ')" 2
  printf '%s\nDisk: old\n' $(( $(date +%s) - 400 )) > "$STATE_DIR/disk.cache"
  disk_line_cached > /dev/null
  assert_eq "$(wc -l < "$TMP/n" | tr -d ' ')" 3
  [ -n "$a" ] || return 1
}

test_disk_line_cache_time_must_be_a_plain_number() {
  disk_line() { echo "Disk: measured"; echo x >> "$TMP/n"; }
  mkdir -p "$STATE_DIR"
  printf '0%s\nDisk: cached\n' "$(date +%s)" > "$STATE_DIR/disk.cache"   # a leading 0 is not an octal number
  assert_eq "$(disk_line_cached 2>&1)" "Disk: cached (as of 0 min ago; --disk refreshes)"
  printf 'x%s\nDisk: cached\n' "$(date +%s)" > "$STATE_DIR/disk.cache"   # not a time stamp: measured again
  assert_eq "$(disk_line_cached 2>&1)" "Disk: measured"
  assert_eq "$(wc -l < "$TMP/n" | tr -d ' ')" 1
}

test_other_checkout_markers_must_be_absolute_paths() {   # M3
  _setup
  mkdir -p "$TMP/rel"; printf 'services:\n  x:\n    image: ghcr.io/berriai/litellm:1\n' > "$TMP/rel/compose.yaml"
  OTHER_DIRS="$(printf 'rel\n../rel')"
  ( cd "$TMP" && images_of_other_checkouts ) > "$TMP/out"
  assert_eq "$(cat "$TMP/out")" ""
  OTHER_DIRS="$TMP/rel"
  assert_eq "$(images_of_other_checkouts)" "L1"
}

test_dispatcher_guards_clean_like_update() {
  d="$(sed -n '/^case "\$cmd" in/,/^esac/p' "$T_ROOT/stack")"
  assert_contains "$(printf '%s\n' "$d" | grep -A1 'update | clean | rollback)')" 'guard_project'
}
