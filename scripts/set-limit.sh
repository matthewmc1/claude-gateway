#!/usr/bin/env bash
# Manage spend caps on the gateway admin API. Amounts are given in USD.
#
#   set-limit.sh org   <usd> <daily|weekly|monthly>
#   set-limit.sh group <name> <usd> <period>
#   set-limit.sh user  <oidc-sub> <usd> <period>
#   set-limit.sh list
#   set-limit.sh effective [daily|weekly|monthly]     # who has spent what, top first
#   set-limit.sh delete <spl_id>
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

base="${GATEWAY_URL:-http://localhost:8791}/v1/organizations/spend_limits"
wkey=(-H "x-api-key: $GATEWAY_ADMIN_WRITE_KEY")

cents() { python3 -c 'import sys; print(round(float(sys.argv[1])*100))' "$1"; }

post() {
  curl -sS "$base" "${wkey[@]}" -H 'Content-Type: application/json' -d "$1"; echo
}

case "${1:-}" in
  org)   post "{\"scope\":{\"type\":\"organization\"},\"amount\":\"$(cents "$2")\",\"period\":\"$3\"}" ;;
  group) post "{\"scope\":{\"type\":\"rbac_group\",\"rbac_group_id\":\"$2\"},\"amount\":\"$(cents "$3")\",\"period\":\"$4\"}" ;;
  user)  post "{\"scope\":{\"type\":\"user\",\"user_id\":\"$2\"},\"amount\":\"$(cents "$3")\",\"period\":\"$4\"}" ;;
  list)  curl -sS "$base" "${wkey[@]}" | python3 -m json.tool ;;
  effective)
    p="${2:-monthly}"
    curl -sS "$base/effective?period%5B%5D=$p&sort=spend_desc" "${wkey[@]}" | python3 -m json.tool ;;
  delete) curl -sS -X DELETE "$base/$2" "${wkey[@]}"; echo ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
