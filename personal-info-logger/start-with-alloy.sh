#!/usr/bin/env bash
set -euo pipefail

########################################
# Configuration - fill these in before running
########################################
LOKI_ENDPOINT="https://logs-prod-XXX.grafana.net/loki/api/v1/push"   # Grafana Cloud Loki push endpoint
LOKI_USER="000000"                                                    # Grafana Cloud Loki instance/user ID
LOKI_PASSWORD="glc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"                # Grafana Cloud API key
########################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/logs/pii.log"
ALLOY_DIR="$SCRIPT_DIR/.alloy"
ALLOY_BIN="$ALLOY_DIR/alloy"
ALLOY_CONFIG="$ALLOY_DIR/config.alloy"

if [[ "$LOKI_ENDPOINT" == *"XXX"* || "$LOKI_PASSWORD" == "glc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" ]]; then
    echo "Please edit LOKI_ENDPOINT, LOKI_USER and LOKI_PASSWORD at the top of this script first." >&2
    exit 1
fi

for cmd in curl unzip npm; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }
done

mkdir -p "$ALLOY_DIR"

APP_PID=""
ALLOY_PID=""
cleanup() {
    echo "Shutting down..."
    [[ -n "$ALLOY_PID" ]] && kill "$ALLOY_PID" 2>/dev/null || true
    [[ -n "$APP_PID" ]] && kill "$APP_PID" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

########################################
# 1. Start personal-info-logger
########################################
echo "Starting personal-info-logger..."
if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
    (cd "$SCRIPT_DIR" && npm install --no-audit --no-fund)
fi
(cd "$SCRIPT_DIR" && npm start) &
APP_PID=$!

echo "Waiting for $LOG_FILE to be created..."
for i in $(seq 1 30); do
    [[ -f "$LOG_FILE" ]] && break
    sleep 1
done
[[ -f "$LOG_FILE" ]] || { echo "Log file never appeared, aborting." >&2; exit 1; }

########################################
# 2. Download latest Grafana Alloy
########################################
if [[ ! -x "$ALLOY_BIN" ]]; then
    echo "Downloading latest Grafana Alloy..."
    OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
    case "$(uname -m)" in
        x86_64) ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
    esac

    ASSET_NAME="alloy-${OS}-${ARCH}.zip"
    DOWNLOAD_URL="$(curl -fsSL https://api.github.com/repos/grafana/alloy/releases/latest \
        | grep "browser_download_url.*${ASSET_NAME}" \
        | cut -d '"' -f 4)"

    [[ -n "$DOWNLOAD_URL" ]] || { echo "Could not find an Alloy release asset named ${ASSET_NAME}" >&2; exit 1; }

    curl -fsSL "$DOWNLOAD_URL" -o "$ALLOY_DIR/alloy.zip"
    unzip -o "$ALLOY_DIR/alloy.zip" -d "$ALLOY_DIR"
    mv "$ALLOY_DIR/alloy-${OS}-${ARCH}" "$ALLOY_BIN"
    chmod +x "$ALLOY_BIN"
    rm -f "$ALLOY_DIR/alloy.zip"
else
    echo "Alloy already present at $ALLOY_BIN, skipping download."
fi

########################################
# 3. Write Alloy config: tail the log file and ship it to Loki
########################################
cat > "$ALLOY_CONFIG" <<EOF
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
EOF

########################################
# 4. Run Alloy
########################################
echo "Starting Alloy..."
export LOKI_ENDPOINT LOKI_USER LOKI_PASSWORD
"$ALLOY_BIN" run "$ALLOY_CONFIG" --storage.path="$ALLOY_DIR/data" &
ALLOY_PID=$!

echo "personal-info-logger (pid $APP_PID) and Alloy (pid $ALLOY_PID) are running. Press Ctrl+C to stop."
wait
