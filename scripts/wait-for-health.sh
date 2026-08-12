#!/usr/bin/env bash
# Block until all five services answer /health, or give up after ~2 minutes.
set -uo pipefail

services=("quote-service:3001" "pricing-service:3002" "workflow-service:3003" "notification-service:3004" "backoffice-service:3005")
deadline=$(( $(date +%s) + 150 ))

for entry in "${services[@]}"; do
    name="${entry%%:*}"
    port="${entry##*:}"
    printf "  %-22s" "$name"
    while true; do
        if curl -fsS "http://localhost:${port}/health" >/dev/null 2>&1; then
            echo "up"
            break
        fi
        if [ "$(date +%s)" -ge "$deadline" ]; then
            echo "TIMED OUT"
            echo ""
            echo "  docker compose logs $name"
            exit 1
        fi
        sleep 2
    done
done

printf "  %-22s" "grafana"
while ! curl -fsS "http://localhost:3000/api/health" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then echo "not ready (carrying on)"; exit 0; fi
    sleep 2
done
echo "up"
