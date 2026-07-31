#!/bin/sh
set -eu

mkdir -p /tmp/paperclip-android-device-lock
chown 501:20 /tmp/paperclip-android-device-lock
chmod 0770 /tmp/paperclip-android-device-lock

node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js &
server_pid=$!
socat \
  TCP-LISTEN:3100,bind=0.0.0.0,reuseaddr,fork \
  TCP:127.0.0.1:3101 &
proxy_pid=$!

reconcile_control_plane() {
  while kill -0 "$server_pid" 2>/dev/null; do
    if ! curl -fsS http://127.0.0.1:3101/api/health >/dev/null 2>&1; then
      sleep 1
      continue
    fi
    if ! PAPERCLIP_API_BASE=http://127.0.0.1:3101/api \
      node /opt/paperclip-host/reconcile-ksnvqa.mjs; then
      printf '%s\n' \
        "KSNVQA control-plane reconciliation failed; retrying in 60 seconds" \
        >&2
    fi
    sleep 60
  done
}

reconcile_control_plane &
reconciler_pid=$!

stop_children() {
  kill -TERM "$server_pid" "$proxy_pid" "$reconciler_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  wait "$proxy_pid" 2>/dev/null || true
  wait "$reconciler_pid" 2>/dev/null || true
}

trap 'stop_children; exit 143' HUP INT TERM

while kill -0 "$server_pid" 2>/dev/null &&
  kill -0 "$proxy_pid" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "$server_pid" 2>/dev/null; then
  failed_process="Paperclip server"
else
  failed_process="port 3100 proxy"
fi

printf '%s\n' "$failed_process exited; stopping the paired process so Docker can restart Paperclip" >&2
stop_children
exit 1
