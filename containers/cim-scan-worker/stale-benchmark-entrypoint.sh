#!/bin/sh
set -eu

socket_path=/run/clamav/clamd.sock
mkdir -p /run/clamav
clamd --config-file=/etc/clamav/clamd.conf &
clamd_pid=$!
worker_pid=

shutdown() {
  if [ -n "$worker_pid" ]; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  kill "$clamd_pid" 2>/dev/null || true
  wait "$clamd_pid" 2>/dev/null || true
}
trap shutdown EXIT INT TERM

attempt=0
while [ ! -S "$socket_path" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 300 ]; then
    exit 1
  fi
  sleep 0.1
done

node scripts/check-cim-scan-worker-health.js
node scripts/run-cim-scan-worker-stale-benchmark.js &
worker_pid=$!
wait "$worker_pid"
