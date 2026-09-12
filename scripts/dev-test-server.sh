#!/bin/bash
# Isolated source server for local smoke testing. Normal startup always creates
# fresh state. Credential cloning is a separate, explicit operation.
set -euo pipefail

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd -P)
PORT=${PORT:-20129}
PID_FILE=${PID_FILE:-/tmp/tokenproxy-test-$PORT.pid}
META_FILE=${META_FILE:-$PID_FILE.meta}
LOG_FILE=${LOG_FILE:-/tmp/tokenproxy-test-$PORT.log}
NODE_BIN=${NODE_BIN:-node}
SERVER_ENTRY=${SERVER_ENTRY:-.next/standalone/custom-server.js}
REQUESTED_DATA_DIR=${DATA_DIR:-}
STATE_ROOT=${TOKENPROXY_TEST_STATE_ROOT:-${TMPDIR:-/tmp}}
cd "$REPO_DIR"

pid() {
  [ -f "$PID_FILE" ] && sed -n '1p' "$PID_FILE" 2>/dev/null || true
}

process_start_time() {
  local process_id=$1
  [ -r "/proc/$process_id/stat" ] || return 1
  awk '{print $22}' "/proc/$process_id/stat"
}

process_command() {
  local process_id=$1
  [ -r "/proc/$process_id/cmdline" ] || return 1
  tr '\0' ' ' < "/proc/$process_id/cmdline"
}

process_cwd() {
  local process_id=$1
  readlink -f "/proc/$process_id/cwd" 2>/dev/null
}

process_owns_listener() {
  local process_id=$1 port_hex inode fd socket
  [[ "$PORT" =~ ^[0-9]+$ ]] || return 1
  printf -v port_hex '%04X' "$PORT"
  while read -r inode; do
    [ -n "$inode" ] || continue
    for fd in "/proc/$process_id/fd/"*; do
      socket=$(readlink "$fd" 2>/dev/null || true)
      [ "$socket" = "socket:[$inode]" ] && return 0
    done
  done < <(
    awk -v suffix=":$port_hex" '
      $4 == "0A" && substr($2, length($2) - length(suffix) + 1) == suffix { print $10 }
    ' /proc/net/tcp /proc/net/tcp6 2>/dev/null
  )
  return 1
}

read_metadata() {
  META_PID=
  META_START=
  META_ENTRY=
  META_REPO=
  [ -f "$META_FILE" ] || return 1
  IFS=$'\t' read -r META_PID META_START META_ENTRY META_REPO < "$META_FILE"
  [ -n "$META_PID" ] && [ -n "$META_START" ] && [ -n "$META_ENTRY" ] && [ -n "$META_REPO" ]
}

owned_process() {
  local process_id actual_start actual_command actual_cwd
  process_id=$(pid)
  [[ "$process_id" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$process_id" 2>/dev/null || return 1
  read_metadata || return 2
  [ "$META_PID" = "$process_id" ] || return 2
  actual_start=$(process_start_time "$process_id") || return 2
  [ "$actual_start" = "$META_START" ] || return 2
  actual_cwd=$(process_cwd "$process_id") || return 2
  [ "$actual_cwd" = "$META_REPO" ] || return 2
  actual_command=$(process_command "$process_id") || return 2
  case "$actual_command" in
    *"$META_ENTRY"*) return 0 ;;
    *) return 2 ;;
  esac
}

clear_stale_control_files() {
  unlink "$PID_FILE" 2>/dev/null || true
  unlink "$META_FILE" 2>/dev/null || true
}

validate_isolated_target() {
  local target root
  target=$(readlink -m "$1")
  root=$(readlink -m "$STATE_ROOT")
  case "$target" in
    "$root"/tokenproxy-test-*) return 0 ;;
    *)
      echo "test state must be under $root with a tokenproxy-test- prefix: $target" >&2
      return 2
      ;;
  esac
}

allocate_data_dir() {
  local mode=${1:-fresh}
  mkdir -p "$STATE_ROOT"
  if [ "$mode" = "clone" ]; then
    validate_isolated_target "$CLONE_TO_DATA_DIR" || return $?
    DATA_DIR=$(readlink -m "$CLONE_TO_DATA_DIR")
    [ -f "$DATA_DIR/.tokenproxy-test-clone" ] || {
      echo "cloned startup requires the marker written by sync: $DATA_DIR/.tokenproxy-test-clone" >&2
      return 2
    }
  else
    [ -z "$REQUESTED_DATA_DIR" ] || {
      echo "normal startup always uses fresh state; use sync then up-clone for an explicit clone" >&2
      return 2
    }
    DATA_DIR=$(mktemp -d "$STATE_ROOT/tokenproxy-test-${PORT}-XXXXXX")
  fi
  TEST_HOME="$DATA_DIR/home"
  TEST_TMP="$DATA_DIR/tmp"
  mkdir -p -m 700 "$DATA_DIR" "$TEST_HOME" "$TEST_TMP" "$DATA_DIR/npm-cache"
  chmod 700 "$DATA_DIR" "$TEST_HOME" "$TEST_TMP" "$DATA_DIR/npm-cache"
  RUNTIME_ENV=(
    "PATH=${PATH:-/usr/bin:/bin}"
    "HOME=$TEST_HOME"
    "TMPDIR=$TEST_TMP"
    "DATA_DIR=$DATA_DIR"
    "NODE_ENV=production"
    "NEXT_TELEMETRY_DISABLED=1"
    "npm_config_cache=$DATA_DIR/npm-cache"
    "PORT=$PORT"
    "HOSTNAME=127.0.0.1"
    "JWT_SECRET=${TEST_JWT_SECRET:-tokenproxy-local-test-jwt-secret-000000000000}"
    "API_KEY_SECRET=${TEST_API_KEY_SECRET:-tokenproxy-local-test-api-secret-111111111111}"
    "MACHINE_ID_SALT=${TEST_MACHINE_ID_SALT:-tokenproxy-local-test-machine-salt-2222}"
  )
}

up() {
  local mode=${1:-fresh} state process_id start_time entry_path
  set +e
  owned_process
  state=$?
  set -e
  if [ "$state" = "0" ]; then
    echo "already running: pid $(pid) at http://localhost:$PORT"
    return 0
  fi
  if [ "$state" = "2" ]; then
    echo "refusing startup: PID control files have an ownership mismatch" >&2
    return 1
  fi
  clear_stale_control_files

  allocate_data_dir "$mode" || return $?

  if [ "${SKIP_BUILD:-0}" != "1" ]; then
    echo "[1/3] build"
    env -i "${RUNTIME_ENV[@]}" npm run build >/dev/null 2>&1
  elif [ "$SERVER_ENTRY" = ".next/standalone/custom-server.js" ] && [ ! -f "$SERVER_ENTRY" ]; then
    echo "SKIP_BUILD=1 requested but the standalone server is missing: $SERVER_ENTRY" >&2
    return 1
  fi
  entry_path=$(readlink -f "$SERVER_ENTRY")
  [ -f "$entry_path" ] || { echo "server entry does not exist: $SERVER_ENTRY" >&2; return 1; }
  echo "[2/3] start standalone on :$PORT (HOME=$TEST_HOME DATA_DIR=$DATA_DIR)"
  nohup env -i "${RUNTIME_ENV[@]}" "$NODE_BIN" "$entry_path" >"$LOG_FILE" 2>&1 &
  process_id=$!
  printf '%s\n' "$process_id" > "$PID_FILE"
  for _ in $(seq 1 50); do
    start_time=$(process_start_time "$process_id" 2>/dev/null || true)
    [ -n "$start_time" ] && break
    sleep 0.02
  done
  if [ -z "${start_time:-}" ]; then
    echo "server process exited before ownership could be recorded" >&2
    clear_stale_control_files
    return 1
  fi
  printf '%s\t%s\t%s\t%s\n' "$process_id" "$start_time" "$entry_path" "$REPO_DIR" > "$META_FILE"
  chmod 600 "$PID_FILE" "$META_FILE"

  echo "[3/3] health check"
  for _ in $(seq 1 30); do
    local code current_state
    set +e
    owned_process
    current_state=$?
    set -e
    if [ "$current_state" != "0" ]; then
      echo "server process exited or changed identity during health check" >&2
      tail -20 "$LOG_FILE" >&2 || true
      clear_stale_control_files
      return 1
    fi
    code=
    if process_owns_listener "$process_id"; then
      code=$(curl -q --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --connect-timeout 1 --max-time 2 "http://localhost:$PORT/dashboard" 2>/dev/null || true)
    fi
    if [ "$code" = "200" ] && process_owns_listener "$process_id"; then
      echo "ok: pid $process_id at http://localhost:$PORT (log: $LOG_FILE)"
      return 0
    fi
    sleep 0.2
  done
  echo "FAILED health check, log tail follows" >&2
  tail -20 "$LOG_FILE" >&2 || true
  down >/dev/null 2>&1 || true
  return 1
}

down() {
  local state process_id
  set +e
  owned_process
  state=$?
  set -e
  if [ "$state" = "1" ]; then
    clear_stale_control_files
    echo "not running"
    return 0
  fi
  if [ "$state" = "2" ]; then
    echo "refusing signal: PID control files have an ownership mismatch" >&2
    return 1
  fi
  process_id=$(pid)
  kill "$process_id"
  for _ in $(seq 1 50); do
    if ! kill -0 "$process_id" 2>/dev/null; then
      clear_stale_control_files
      echo "stopped pid $process_id"
      return 0
    fi
    sleep 0.1
  done
  echo "owned process $process_id did not stop within 5 seconds" >&2
  return 1
}

sync_credentials() {
  if [ "${ALLOW_CREDENTIAL_CLONE:-0}" != "1" ]; then
    echo "credential clone requires ALLOW_CREDENTIAL_CLONE=1" >&2
    return 2
  fi
  if [ -z "${CLONE_FROM_DATA_DIR:-}" ]; then
    echo "credential clone requires explicit CLONE_FROM_DATA_DIR" >&2
    return 2
  fi
  if [ -z "${CLONE_TO_DATA_DIR:-}" ]; then
    echo "credential clone requires explicit CLONE_TO_DATA_DIR" >&2
    return 2
  fi
  validate_isolated_target "$CLONE_TO_DATA_DIR" || return $?
  [ -f "$CLONE_FROM_DATA_DIR/db/data.sqlite" ] || {
    echo "clone source has no db/data.sqlite: $CLONE_FROM_DATA_DIR" >&2
    return 2
  }
  DATA_DIR=$CLONE_TO_DATA_DIR
  [ "$(readlink -m "$CLONE_FROM_DATA_DIR")" != "$(readlink -m "$DATA_DIR")" ] || {
    echo "clone source and target must differ" >&2
    return 2
  }
  if ! down >/dev/null; then
    echo "credential clone aborted because the existing process could not be stopped safely" >&2
    return 1
  fi
  if [ -e "$DATA_DIR" ] && { [ ! -d "$DATA_DIR" ] || [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; }; then
    echo "credential clone target must be absent or empty: $DATA_DIR" >&2
    return 2
  fi
  mkdir -p -m 700 "$DATA_DIR"
  mkdir -p -m 700 "$DATA_DIR/db"
  echo "[sync] explicit source $CLONE_FROM_DATA_DIR to isolated target $DATA_DIR"
  sqlite3 "$CLONE_FROM_DATA_DIR/db/data.sqlite" ".backup '$DATA_DIR/db/data.sqlite'"
  unlink "$DATA_DIR/db/data.sqlite-wal" 2>/dev/null || true
  unlink "$DATA_DIR/db/data.sqlite-shm" 2>/dev/null || true
  for file in usage.json log.txt; do
    [ -f "$CLONE_FROM_DATA_DIR/$file" ] && cp "$CLONE_FROM_DATA_DIR/$file" "$DATA_DIR/$file"
  done
  printf 'explicit test credential clone\n' > "$DATA_DIR/.tokenproxy-test-clone"
  chmod 600 "$DATA_DIR/.tokenproxy-test-clone"
  echo "credential clone complete; start with ALLOW_CREDENTIAL_CLONE=1 CLONE_TO_DATA_DIR=$DATA_DIR $0 up-clone"
}

status() {
  local state
  set +e
  owned_process
  state=$?
  set -e
  if [ "$state" = "0" ]; then
    echo "running: pid $(pid) at http://localhost:$PORT"
    return 0
  fi
  if [ "$state" = "2" ]; then
    echo "not running: PID control files have an ownership mismatch" >&2
    return 1
  fi
  echo "not running"
}

case "${1:-up}" in
  up) up fresh ;;
  up-clone)
    [ "${ALLOW_CREDENTIAL_CLONE:-0}" = "1" ] || {
      echo "cloned startup requires ALLOW_CREDENTIAL_CLONE=1" >&2
      exit 2
    }
    [ -n "${CLONE_TO_DATA_DIR:-}" ] || {
      echo "cloned startup requires CLONE_TO_DATA_DIR" >&2
      exit 2
    }
    up clone
    ;;
  down) down ;;
  restart) down && up fresh ;;
  sync) sync_credentials ;;
  status) status ;;
  *) echo "usage: $0 [up|up-clone|down|restart|sync|status]" >&2; exit 2 ;;
esac
