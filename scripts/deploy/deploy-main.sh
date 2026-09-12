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

stage_json=$($PYTHON "$DRIVER" stage --sha "$SHA" --expected-old-sha "$OLD_SHA")
manifest=$($PYTHON -c 'import json,sys; print(json.load(sys.stdin)["manifest"])' <<<"$stage_json")
"$FRONT_INSTALLER" --manifest "$manifest"
"$SCRIPT_DIR/await-quiet-cutover.sh" \
  --manifest "$manifest" \
  --expected-old-sha "$OLD_SHA" \
  --operator-auth-file "$AUTH" \
  --direct-backend-traffic-accounted
