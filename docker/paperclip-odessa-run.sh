#!/bin/sh
set -eu

node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js &
server_pid=$!
socat \
  TCP-LISTEN:3100,bind=0.0.0.0,reuseaddr,fork \
  TCP:127.0.0.1:3101 &
proxy_pid=$!

stop_children() {
  kill -TERM "$server_pid" "$proxy_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  wait "$proxy_pid" 2>/dev/null || true
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
