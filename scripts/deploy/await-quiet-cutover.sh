#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: await-quiet-cutover.sh --manifest FILE --expected-old-sha SHA --operator-auth-file FILE --direct-backend-traffic-accounted\n' >&2
}

MANIFEST=''; OLD_SHA=''; AUTH=''; ATTEST=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST=${2:-}; shift ;;
    --expected-old-sha) OLD_SHA=${2:-}; shift ;;
    --operator-auth-file) AUTH=${2:-}; shift ;;
    --direct-backend-traffic-accounted) ATTEST=1 ;;
    *) usage; exit 2 ;;
  esac
  shift
done
[ -n "$MANIFEST" ] && [ -n "$OLD_SHA" ] && [ -n "$AUTH" ] && [ "$ATTEST" -eq 1 ] || { usage; exit 2; }

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PYTHON=${TOKENPROXY_DEPLOY_PYTHON:-python3}
CONTROL=${TOKENPROXY_FRONT_CONTROL:-$HOME/.tokenproxy-front/front-control.sock}
WAIT_SECONDS=${TOKENPROXY_QUIET_WAIT_SECONDS:-600}
deadline=$(( $(date +%s) + WAIT_SECONDS ))

while [ "$(date +%s)" -lt "$deadline" ]; do
  status=$(curl -q -sS --max-time 1 --unix-socket "$CONTROL" http://localhost/status 2>/dev/null || true)
  if [ -n "$status" ] && printf '%s' "$status" | jq -e \
    '.activation_paused == false and .backend_ready == true and .public_ready == true and .active == 0 and .dispatching == 0 and .queued == 0' \
    >/dev/null 2>&1; then
    exec "$PYTHON" "$SCRIPT_DIR/deploy_driver.py" cutover \
      --manifest "$MANIFEST" \
      --expected-old-sha "$OLD_SHA" \
      --operator-auth-file "$AUTH" \
      --direct-backend-traffic-accounted
  fi
  sleep 0.2
done

printf 'deployment refused: no quiet front interval within %ss; production unchanged\n' "$WAIT_SECONDS" >&2
exit 1
