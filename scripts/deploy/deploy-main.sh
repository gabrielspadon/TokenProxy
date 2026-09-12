#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: deploy-main.sh --sha SHA --expected-old-sha SHA --operator-auth-file FILE --direct-backend-traffic-accounted\n' >&2
}

SHA=''; OLD_SHA=''; AUTH=''; ATTEST=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --sha) SHA=${2:-}; shift ;;
    --expected-old-sha) OLD_SHA=${2:-}; shift ;;
    --operator-auth-file) AUTH=${2:-}; shift ;;
    --direct-backend-traffic-accounted) ATTEST=1 ;;
    *) usage; exit 2 ;;
  esac
  shift
done
[ -n "$SHA" ] && [ -n "$OLD_SHA" ] && [ -n "$AUTH" ] && [ "$ATTEST" -eq 1 ] || { usage; exit 2; }

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PYTHON=${TOKENPROXY_DEPLOY_PYTHON:-python3}
DRIVER="$SCRIPT_DIR/deploy_driver.py"
AI_DOTFILES=${TOKENPROXY_AI_DOTFILES:-$HOME/Codebases/ai-dotfiles}
FRONT_INSTALLER="$AI_DOTFILES/libexec/shared/bin/tokenproxy-install-front.sh"
READY_URL=${TOKENPROXY_BACKEND_READY_URL:-http://127.0.0.1:20127/api/ready}

ready=$(curl -q -sS --max-time 1 "$READY_URL" 2>/dev/null || true)
printf '%s' "$ready" | jq -e '.ready == true and (.buildSha | type == "string")' >/dev/null || {
  printf 'deployment refused: the running backend lacks the versioned local readiness contract; bootstrap once with ai-dotfiles update-tokenproxy.sh in a maintenance window\n' >&2
  exit 1
}

stage_json=$($PYTHON "$DRIVER" stage --sha "$SHA")
manifest=$($PYTHON -c 'import json,sys; print(json.load(sys.stdin)["manifest"])' <<<"$stage_json")
"$FRONT_INSTALLER" --manifest "$manifest"
"$SCRIPT_DIR/await-quiet-cutover.sh" \
  --manifest "$manifest" \
  --expected-old-sha "$OLD_SHA" \
  --operator-auth-file "$AUTH" \
  --direct-backend-traffic-accounted
