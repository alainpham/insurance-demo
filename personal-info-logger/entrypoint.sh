#!/usr/bin/env bash
set -euo pipefail

: "${LOKI_ENDPOINT:?LOKI_ENDPOINT env var is required (Grafana Cloud Loki push endpoint)}"
: "${LOKI_USER:?LOKI_USER env var is required (Grafana Cloud Loki instance/user ID)}"
: "${LOKI_PASSWORD:?LOKI_PASSWORD env var is required (Grafana Cloud API key)}"

LOG_FILE="/usr/src/app/logs/pii.log"
ALLOY_CONFIG="/etc/alloy/config.alloy"

mkdir -p "$(dirname "$LOG_FILE")" /etc/alloy/data

cat > "$ALLOY_CONFIG" <<CFG
local.file_match "pii_logs" {
  path_targets = [{"__path__" = "${LOG_FILE}", "job" = "personal-info-logger"}]
}

loki.source.file "pii_logs" {
  targets    = local.file_match.pii_logs.targets
  forward_to = [loki.write.grafana_cloud.receiver]
}

loki.write "grafana_cloud" {
  endpoint {
    url = env("LOKI_ENDPOINT")
    basic_auth {
      username = env("LOKI_USER")
      password = env("LOKI_PASSWORD")
    }
  }
}
CFG

node server/server.js &
APP_PID=$!

alloy run "$ALLOY_CONFIG" --storage.path=/etc/alloy/data &
ALLOY_PID=$!

trap 'kill "$APP_PID" "$ALLOY_PID" 2>/dev/null || true' TERM INT

wait -n "$APP_PID" "$ALLOY_PID"
EXIT_CODE=$?
kill "$APP_PID" "$ALLOY_PID" 2>/dev/null || true
exit "$EXIT_CODE"
