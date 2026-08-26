#!/usr/bin/env bash
# Two deals end to end. Usage: scripts/demo.sh [base_url] [customer]
set -euo pipefail
BASE=${1:-http://localhost:8787}; C=${2:-acme}
api() { curl -sS -X "$1" "$BASE/api/customers/$C$2" -H 'content-type: application/json' ${3:+-d "$3"}; echo; }
echo "--- small deal: auto-approved, pays first time"
api POST /deals '{"message":"5 Pro seats monthly in the US","paymentMethod":"card_ok"}'
echo "--- big deal: needs approval, declines twice then pays"
BIG=$(api POST /deals '{"message":"50 Pro seats, 20 TB egress, EU, annual for Acme","paymentMethod":"card_decline_then_ok"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["deal"]["id"])')
echo "deal $BIG is waiting for approval"; sleep 2
api POST "/deals/$BIG/decision" '{"decision":"approved","by":"demo"}'
echo "--- dunning runs on the SECONDS_PER_DAY clock; waiting 30s"; sleep 30
api GET "/deals/$BIG"
