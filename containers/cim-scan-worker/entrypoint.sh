#!/bin/sh
set -eu

socket_path=/run/clamav/clamd.sock
mkdir -p /run/clamav
clamd --config-file=/etc/clamav/clamd.conf &
clamd_pid=$!
trap 'kill "$clamd_pid" 2>/dev/null || true; wait "$clamd_pid" 2>/dev/null || true' EXIT INT TERM

attempt=0
while [ ! -S "$socket_path" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 300 ]; then
    exit 1
  fi
  sleep 0.1
done

node scripts/run-cim-scan-worker.js
