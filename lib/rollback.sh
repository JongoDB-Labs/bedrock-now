# shellcheck shell=bash
# ./stack rollback: back to the version before the last ./stack update — its code, its data (the update's own
# pre-update backup) and its images (kept by lib/images.sh, so nothing is downloaded). Sourced by
# lib/commands.sh. Works after an update that failed half-way: the record is written before 3/4 images.
#
# .state/update/last.env (key=value, written by ./stack update):
#   at=<epoch> from=<commit> branch=<branch or empty> from_version=<git describe> backup=backups/<ts>-auto
#   result=running|done|rolled-back  to_version=<after the update>

update_record_file() { printf '%s/update/last.env\n' "$STATE_DIR"; }

# _record_get KEY -> value from the update record ("" if absent)
_record_get() { local f; f="$(update_record_file)"; [ -f "$f" ] || return 0; ENV_FILE="$f" get_env "$1"; }
_record_set() { local f; f="$(update_record_file)"; [ -f "$f" ] || return 0; ENV_FILE="$f" set_env "$1" "$2"; }

# update_record_write FROM BRANCH BACKUP — before 3/4 images: what ./stack rollback needs to go back.
# FROM is the commit before the update (empty when this is not a git checkout: nothing to record).
update_record_write() {
  local f tmp from="$1" branch="$2" backup="$3" v
  [ -n "$from" ] && [ -n "$backup" ] || return 0
  f="$(update_record_file)"; mkdir -p "${f%/*}" && chmod 700 "${f%/*}"
  v="$(git -C "$STACK_DIR" describe --tags --always "$from" 2>/dev/null || printf '%s' "$from")"
  tmp="$(mktemp "$f.XXXXXX")" || return 0
  printf 'at=%s\nfrom=%s\nbranch=%s\nfrom_version=%s\nbackup=%s\nresult=running\n' "$(date +%s)" "$from" "$branch" "$v" "$backup" > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$f"
}

# update_record_done — after a successful update
update_record_done() { _record_set result "done"; _record_set to_version "$(installed_version)"; }

# _rollback_checkout FROM BRANCH — the code as it was before the update (branch users stay on their branch)
_rollback_checkout() {
  if [ -n "$2" ]; then git -C "$STACK_DIR" switch --quiet -C "$2" "$1"
  else git -C "$STACK_DIR" -c advice.detachedHead=false checkout --quiet "$1"; fi
}

# _rollback_local_builds — the previous portal/shared-mcp/stt builds (<project>/<name>:previous) become :local again
_rollback_local_builds() {
  local p n; p="$(project_name)"
  for n in portal shared-mcp stt; do
    docker image inspect "$p/$n:previous" >/dev/null 2>&1 || continue
    docker tag "$p/$n:previous" "$p/$n:local" >/dev/null 2>&1 || warn "could not restore the previous $n build — it will be rebuilt"
  done
}

# shellcheck disable=SC2120  # arguments come from the ./stack dispatcher
cmd_rollback() {
  local from branch fromv backup result at now_imgs d no_helper=0 no_stt=0
  [ $# -eq 0 ] || die "usage: ./stack rollback [--yes]   (goes back to the version before the last ./stack update)"
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  stack_lock rollback
  from="$(_record_get from)"; branch="$(_record_get branch)"; fromv="$(_record_get from_version)"
  backup="$(_record_get backup)"; result="$(_record_get result)"; at="$(_record_get at)"
  [ -n "$from" ] && [ -n "$backup" ] || die "nothing to roll back: no ./stack update has been recorded in this checkout"
  [ "$result" != rolled-back ] || die "the last update was already rolled back (to ${fromv:-$from}) — nothing was changed"
  case "$from" in *[!0-9a-f]* | '') die "the update record is damaged ($(update_record_file)) — nothing was changed" ;; esac
  case "$backup" in backups/*) ;; *) die "the update record names no backup in backups/ — nothing was changed" ;; esac
  [ -f "$STACK_DIR/$backup/litellm.dump" ] && [ -f "$STACK_DIR/$backup/openwebui.dump" ] ||
    die "the pre-update backup $backup is missing or incomplete — nothing was changed"
  [ -e "$STACK_DIR/.git" ] || die "this is not a git checkout — ./stack rollback needs one"
  git -C "$STACK_DIR" cat-file -e "$from^{commit}" 2>/dev/null || die "commit $from is not in this checkout — nothing was changed"
  _require_clean_tree
  printf 'Rollback goes back to %s (%s) and restores %s, the backup taken before the update%s.\n' \
    "${fromv:-$from}" "$(git -C "$STACK_DIR" rev-parse --short "$from")" "$backup" \
    "${at:+ on $(date -r "$at" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$at" '+%Y-%m-%d %H:%M' 2>/dev/null)}"
  printf 'Chats, files and spend recorded since then are replaced (a backup of the current state is taken first).\n'
  # The version rolled back to may predate the update helper: its unit would then start a script that is gone.
  if declare -F helper_installed >/dev/null && helper_installed && ! git -C "$STACK_DIR" cat-file -e "$from:bin/bedrock-now-helper" 2>/dev/null; then
    no_helper=1
    warn "${fromv:-$from} has no update helper: it is uninstalled at the end of the rollback (./stack helper install after the next update)"
  fi
  [ "${ASSUME_YES:-0}" = 1 ] || _have_tty || die "re-run with --yes to roll back non-interactively — nothing was changed"
  confirm "Roll back now?" || die "aborted — nothing was changed"
  d="$(images_dir)"; mkdir -p "$d"
  now_imgs="$(project_refs | snapshot_refs)"
  log "rollback: 1/3 code ($(installed_version) → ${fromv:-$from})"
  _rollback_checkout "$from" "$branch" || die "could not check out $from — nothing else was changed"
  # A version from before Bedrock speech-to-text has no stt service: its container and settings go (lib/stt.sh).
  no_stt=0
  if ! git -C "$STACK_DIR" cat-file -e "$from:stt/Dockerfile" 2>/dev/null && declare -F stt_rollback_cleanup >/dev/null; then
    no_stt=1; stt_rollback_cleanup
  fi
  _rollback_local_builds
  log "rollback: 2/3 data (./stack restore $backup, run by the restored code)"
  # The restored scripts do the rest, in fresh processes; their messages say how to retry if something fails.
  env BEDROCK_NOW_NO_OPEN=1 "$STACK_DIR/stack" restore "$backup" --yes ||
    die "the code is back at ${fromv:-$from}, but restoring $backup failed (see above) — fix the cause and run ./stack restore $backup"
  log "rollback: 3/3 start (./stack up with the restored code)"
  env BEDROCK_NOW_NO_OPEN=1 "$STACK_DIR/stack" up --yes ||
    die "the code and data are back, but ./stack up failed (see above) — run it again"
  [ "$no_stt" = 0 ] || stt_rollback_network_cleanup
  _record_set result rolled-back
  # The images of the version rolled back from are now the "previous version": kept until the next update
  # replaces them as previous-previous (or ./stack clean, once they are no longer the previous version).
  printf '%s\n' "$now_imgs" > "$d/previous.tsv"; rm -f "$d/before.tsv"
  project_refs | snapshot_refs > "$d/current.tsv" 2>/dev/null || true
  log "rolled back to ${fromv:-$from}. ./stack update goes forward again whenever you want."
  # Last, because stopping the helper's unit may end this process when the helper runs the rollback.
  [ "$no_helper" = 0 ] || helper_uninstall
}
