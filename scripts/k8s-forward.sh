#!/usr/bin/env bash
# Port-forward the cluster services onto the same localhost ports
# docker-compose uses, so every URL, script and bookmark works against the
# cluster unchanged — including scripts/smoke.js, seed.js and traffic.js, which
# already default to these ports.
#
#   ./scripts/k8s-forward.sh                      # hold them open (ctrl-c to stop)
#   ./scripts/k8s-forward.sh --run "make smoke"   # bring up, run, tear down
#
# This is why the manifests carry no NodePort and no Ingress: nothing needs to
# be exposed cluster-side for a demo, and nothing needs cleaning up afterwards.
set -euo pipefail

NS="${NS:-assurance}"

# service  remote-port  local-port
FORWARDS=(
    "quote-service        8080  3001"
    "pricing-service      8080  3002"
    "workflow-service     8080  3003"
    "notification-service 8080  3004"
    "backoffice-service   8080  3005"
    "mailpit              8025  8025"
)

PIDS=()
cleanup() {
    for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

for entry in "${FORWARDS[@]}"; do
    read -r svc remote local_port <<<"$entry"
    kubectl -n "$NS" port-forward "svc/${svc}" "${local_port}:${remote}" >/dev/null 2>&1 &
    PIDS+=($!)
done

for entry in "${FORWARDS[@]}"; do
    read -r svc remote local_port <<<"$entry"
    for i in $(seq 1 60); do
        curl -sf -o /dev/null "http://localhost:${local_port}/" && break
        if [ "$i" = 60 ]; then
            echo "  port-forward to ${svc} never came up" >&2
            echo "  check: kubectl -n ${NS} get pods" >&2
            exit 1
        fi
        sleep 0.5
    done
done

if [ "${1:-}" = "--run" ]; then
    shift
    bash -c "$*"
    exit $?
fi

cat <<EOF

  Public quote form   http://localhost:3001
  Back office         http://localhost:3005   (alice@assurance.demo / demo)
  Mailpit             http://localhost:8025
  Quote PDFs          http://localhost:3004/documents

  Forwarding from namespace ${NS}. Ctrl-C to stop.

EOF

wait
