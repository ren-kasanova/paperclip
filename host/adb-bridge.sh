#!/bin/sh
set -eu

ADB=/Users/ren/.paperclip-adb-bridge/adb
test -x "$ADB"

# Colima's host.docker.internal gateway can reach macOS loopback without
# exposing this server on a physical LAN interface.
exec "$ADB" -L tcp:localhost:5038 server nodaemon
