# shellcheck shell=bash
# One Compose project per checkout. Sourced by ./stack after lib/common.sh.
#
# Two checkouts with the same project name would share containers and data volumes (wrong database password,
# one checkout recreating or deleting the other's stack). Ownership comes from two places:
#  - containers: Compose labels each one with the folder it was started from (com.docker.compose.project.working_dir);
#  - an owner marker: an empty Docker volume "<project>_bedrock-now-owner" labelled io.bedrock-now.dir=<folder>.
#    The first checkout that passes the guard writes it and ./stack uninstall removes it, so the claim holds while
#    the stack is down (no containers) and also covers volumes created before markers existed.
# The data volumes themselves are NOT labelled: Compose (2.36+) keeps a config hash on each volume, and a changed
# or added label makes it ask "Recreate (data will be lost)?" — `up -y` answers yes and wipes the database.

_real_dir() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"; }
owner_marker() { printf '%s_bedrock-now-owner\n' "$1"; }

# _project_volumes NAME -> the project's data volumes on one line ("" if none)
_project_volumes() {
  docker volume ls -q --filter "label=com.docker.compose.project=$1" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//'
}
# _project_owner NAME -> folder recorded in the owner marker ("" if there is none)
_project_owner() {
  docker volume inspect --format '{{index .Labels "io.bedrock-now.dir"}}' "$(owner_marker "$1")" 2>/dev/null || true
}
# _project_container_dirs NAME -> one working_dir per line for the project's containers
_project_container_dirs() {
  docker ps -a --filter "label=com.docker.compose.project=$1" --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | sort -u
}
_is_bedrock_now_dir() { [ -f "$1/compose.yaml" ] && [ -f "$1/stack" ] && grep -q 'bedrock-now' "$1/stack" 2>/dev/null; }
_guard_where() { # _guard_where DIR -> how to name what lives in DIR
  if _is_bedrock_now_dir "$1"; then printf 'the bedrock-now install in %s' "$1"
  else printf 'another Compose project in %s' "$1"; fi
}

# _other_owner NAME ME -> folder of ANOTHER checkout that owns project NAME (running/stopped containers, or the
# owner marker while it has data volumes), or "" when the project is free or ours. A marker whose folder no longer
# holds a .env (moved, deleted) is stale and ignored.
_other_owner() {
  local name="$1" me="$2" d
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    [ "$(_real_dir "$d")" = "$me" ] || { printf '%s\n' "$d"; return 0; }
  done <<EOF
$(_project_container_dirs "$name")
EOF
  [ -n "$(_project_volumes "$name")" ] || return 0
  d="$(_project_owner "$name")"
  [ -n "$d" ] && [ "$(_real_dir "$d")" != "$me" ] && [ -e "$d/.env" ] && printf '%s\n' "$d"
  return 0
}

# _guard_advice NAME DIR — how to resolve a clash with DIR. "Give this copy its own name" is only offered on a
# first setup: once .env holds a database password, the checkout belongs to project NAME for good.
_guard_advice() {
  local name="$1" d="$2"
  if [ -z "$(get_env POSTGRES_PASSWORD)" ]; then
    if _is_bedrock_now_dir "$d"; then
      printf 'Either use that install (cd %s), remove it (cd %s && ./stack uninstall), or give this copy its own name: COMPOSE_PROJECT_NAME=%s-2 ./setup.sh.' "$d" "$d" "$name"
    else
      printf 'Stop that project (cd %s && docker compose down), or give this copy its own name: COMPOSE_PROJECT_NAME=%s-2 ./setup.sh.' "$d" "$name"
    fi
  elif _is_bedrock_now_dir "$d"; then
    printf "This checkout (%s) is set up for project '%s' too, so both would use one database and one set of containers. Keep only one: use that install (cd %s), or remove it (cd %s && ./stack uninstall) and then run ./stack setup here. A second copy side by side needs its own fresh checkout (see README: Running a second copy)." "$(_real_dir "$STACK_DIR")" "$name" "$d" "$d"
  else
    printf "This checkout is set up for project '%s' already, so it cannot be renamed. Stop that project first (cd %s && docker compose down)." "$name" "$d"
  fi
}

# guard_project [--warn] [NAME] — dies if this checkout's Compose project (default: project_name) belongs to
# ANOTHER checkout, or if a first setup (no POSTGRES_PASSWORD in .env yet) would land on existing data volumes,
# whose database password would not match. Never shares silently, --yes included. When the project is free it
# records this checkout as the owner. --warn (read-only ./stack status): print the problem, don't stop, don't claim.
guard_project() {
  local warn_only=0 name me d vols msg=''
  if [ "${1:-}" = --warn ]; then warn_only=1; shift; fi
  name="${1:-}"
  docker info >/dev/null 2>&1 || return 0   # commands that need Docker report a stopped daemon themselves
  [ -n "$name" ] || name="$(project_name)"
  me="$(_real_dir "$STACK_DIR")"
  d="$(_other_owner "$name" "$me")"
  if [ -n "$d" ]; then
    msg="project '$name' is already used by $(_guard_where "$d"). $(_guard_advice "$name" "$d")"
  elif [ -z "$(get_env POSTGRES_PASSWORD)" ]; then
    vols="$(_project_volumes "$name")"
    [ -z "$vols" ] ||
      msg="project '$name' already has data volumes ($vols) from another or an earlier bedrock-now install, and this checkout's .env is new — its database password would not match. Either use that install, give this copy its own name: COMPOSE_PROJECT_NAME=$name-2 ./setup.sh, or, if you no longer need that data: docker volume rm $vols."
  fi
  if [ -n "$msg" ]; then
    [ "$warn_only" = 0 ] || { warn "$msg"; return 0; }
    die "$msg Nothing was changed."
  fi
  [ "$warn_only" = 1 ] || claim_project "$name" "$me"
}

# claim_project NAME DIR — (re)writes the owner marker for DIR unless it already names DIR. Best effort.
claim_project() {
  local name="$1" me="$2" m owner
  m="$(owner_marker "$name")"; owner="$(_project_owner "$name")"
  [ "$owner" != "$me" ] || return 0
  [ -z "$owner" ] || docker volume rm "$m" >/dev/null 2>&1 || true   # labels can't change: replace the marker
  docker volume create --label "io.bedrock-now.dir=$me" --label "io.bedrock-now.project=$name" "$m" >/dev/null 2>&1 || true
}

# guard_uninstall — before ./stack uninstall (with or without .env): lists the data volumes it will delete and
# refuses when they belong to another checkout, or when this checkout was never set up and does not own them.
guard_uninstall() {
  local name me d vols owner
  docker info >/dev/null 2>&1 || return 0
  name="$(project_name)"; me="$(_real_dir "$STACK_DIR")"
  d="$(_other_owner "$name" "$me")"
  [ -z "$d" ] ||
    die "./stack uninstall here would delete project '$name', which belongs to $(_guard_where "$d"). To remove that install, run ./stack uninstall in $d. Nothing was removed."
  vols="$(_project_volumes "$name")"
  if [ -z "$vols" ]; then log "project '$name' has no data volumes"; return 0; fi
  owner="$(_project_owner "$name")"
  [ -n "$(get_env POSTGRES_PASSWORD)" ] || [ "$owner" = "$me" ] ||
    die "this checkout was never set up, so the data volumes of project '$name' ($vols) are not its own. If you are sure nobody needs them: docker volume rm $vols. Nothing was removed."
  log "./stack uninstall deletes these data volumes of project '$name': $vols"
}

# release_project — after a successful ./stack uninstall: drops the owner marker if it names this checkout.
release_project() {
  local name
  docker info >/dev/null 2>&1 || return 0
  name="$(project_name)"
  [ "$(_project_owner "$name")" = "$(_real_dir "$STACK_DIR")" ] || return 0
  docker volume rm "$(owner_marker "$name")" >/dev/null 2>&1 || true
}
