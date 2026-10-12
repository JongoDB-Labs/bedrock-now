# shellcheck shell=bash
# lib/images.sh: precise cleanup after ./stack update, ./stack clean and the disk line of ./stack status.
# Docker is stubbed with a tiny image store in $TMP/imgs ("ID<TAB>REF<TAB>SIZE<TAB>COMPOSE-PROJECT-LABEL",
# REF "<none>" for an untagged image), container images in $CTR_IMAGES, other checkouts in $OTHER_DIRS.
. "$STACK_DIR/lib/commands.sh"

_store() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:-}" >> "$TMP/imgs"; }   # _store ID REF SIZE [LABEL]
_refs_of() { awk -F'\t' -v i="$1" '$1 == i && $2 != "<none>" { print $2 }' "$TMP/imgs"; }

_stub_docker() {
  : >> "$TMP/imgs"
  docker() {
    local a last; for a in "$@"; do last="$a"; done
    case "$*" in
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
      "image ls --no-trunc --format {{.ID}}	{{.Size}}") awk -F'\t' '!s[$1]++ { print $1 "\t" $3 }' "$TMP/imgs" ;;
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
  assert_contains "$(cat "$TMP/err")" "nothing to free"
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

test_an_image_docker_still_needs_is_kept_and_said() {
  _setup
  _fake_update 2 L2 P2 2>/dev/null
  _store L1 my/own:copy 1.7GB   # someone else tagged it too: never forced
  _fake_update 3 L3 P3 2> "$TMP/err"
  assert_contains "$(cut -f1 "$TMP/imgs" | tr '\n' ' ')" "L1"
  assert_contains "$(cat "$TMP/err")" "1 image(s) kept because Docker still needs them"
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
  assert_contains "$out" "usage: ./stack clean"
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

test_update_snapshots_before_images_and_cleans_only_after_setup_succeeded() {
  printf 'X=1\n' > "$ENV_FILE"; STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"
  printf '#!/bin/sh\nexit ${FAKE_RC:-0}\n' > "$STACK_DIR/stack"; chmod +x "$STACK_DIR/stack"
  dc() { echo "dc $1" >> "$TMP/calls"; }
  images_snapshot_before() { echo "snapshot ${1:-}" >> "$TMP/calls"; }
  images_after_update() { echo "after" >> "$TMP/calls"; }
  update_record_write() { :; }
  BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_BACKUP=backups/b BEDROCK_NOW_UPDATE_FROM=abc123 cmd_update 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "snapshot abc123;dc pull;after;"
  : > "$TMP/calls"
  if (FAKE_RC=3 BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_FROM=abc123 cmd_update) 2>/dev/null; then return 1; fi
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "snapshot abc123;dc pull;"
}

test_no_global_prune_anywhere() {
  assert_eq "$(grep -nE 'system prune|image prune|builder prune|buildx prune|volume prune|rmi -f|image rm -f|image rm --force' "$T_ROOT"/lib/*.sh "$T_ROOT/stack" || true)" ""
}

test_dispatcher_guards_clean_like_update() {
  d="$(sed -n '/^case "\$cmd" in/,/^esac/p' "$T_ROOT/stack")"
  assert_contains "$(printf '%s\n' "$d" | grep -A1 'update | clean)')" 'guard_project'
}
