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

allocate_data_dir() {
  if [ -n "$REQUESTED_DATA_DIR" ]; then
    DATA_DIR=$REQUESTED_DATA_DIR
    mkdir -p -m 700 "$DATA_DIR"
  else
    DATA_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tokenproxy-test-${PORT}-XXXXXX")
    chmod 700 "$DATA_DIR"
  fi
  export DATA_DIR
}

up() {
  local state process_id start_time entry_path
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

  if [ "${SKIP_BUILD:-0}" != "1" ] || { [ "$SERVER_ENTRY" = ".next/standalone/custom-server.js" ] && [ ! -d .next ]; }; then
    echo "[1/3] build"
    npm run build >/dev/null 2>&1
  fi
  entry_path=$(readlink -f "$SERVER_ENTRY")
  [ -f "$entry_path" ] || { echo "server entry does not exist: $SERVER_ENTRY" >&2; return 1; }
  allocate_data_dir
  echo "[2/3] start standalone on :$PORT (DATA_DIR=$DATA_DIR)"
  DATA_DIR="$DATA_DIR" PORT="$PORT" HOSTNAME=127.0.0.1 nohup "$NODE_BIN" "$entry_path" >"$LOG_FILE" 2>&1 &
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
    local code
    code=$(curl -q --silent --show-error --output /dev/null --write-out '%{http_code}' \
      --connect-timeout 1 --max-time 2 "http://localhost:$PORT/dashboard" 2>/dev/null || true)
    if [ "$code" = "200" ]; then
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
  [ -f "$CLONE_FROM_DATA_DIR/db/data.sqlite" ] || {
    echo "clone source has no db/data.sqlite: $CLONE_FROM_DATA_DIR" >&2
    return 2
  }
  DATA_DIR=$CLONE_TO_DATA_DIR
  mkdir -p -m 700 "$DATA_DIR"
  [ "$(readlink -f "$CLONE_FROM_DATA_DIR")" != "$(readlink -f "$DATA_DIR")" ] || {
    echo "clone source and target must differ" >&2
    return 2
  }
  down >/dev/null 2>&1 || true
  mkdir -p -m 700 "$DATA_DIR/db"
  echo "[sync] explicit source $CLONE_FROM_DATA_DIR to isolated target $DATA_DIR"
  sqlite3 "$CLONE_FROM_DATA_DIR/db/data.sqlite" ".backup '$DATA_DIR/db/data.sqlite'"
  unlink "$DATA_DIR/db/data.sqlite-wal" 2>/dev/null || true
  unlink "$DATA_DIR/db/data.sqlite-shm" 2>/dev/null || true
  for file in usage.json log.txt; do
    [ -f "$CLONE_FROM_DATA_DIR/$file" ] && cp "$CLONE_FROM_DATA_DIR/$file" "$DATA_DIR/$file"
  done
  echo "credential clone complete; start explicitly with DATA_DIR=$DATA_DIR"
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
  up) up ;;
  down) down ;;
  restart) down && up ;;
  sync) sync_credentials ;;
  status) status ;;
  *) echo "usage: $0 [up|down|restart|sync|status]" >&2; exit 2 ;;
esac
