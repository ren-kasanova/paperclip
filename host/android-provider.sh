#!/bin/sh
set -eu

INSTALL_DIR=/Users/ren/.paperclip-android-provider
ADB="$INSTALL_DIR/adb"
EMULATOR=/Users/ren/Library/Android/sdk/emulator/emulator
LOCK=/Volumes/OdessaExt/USING_ANDROID_DEVICE.lock
ADB_SOCKET=tcp:127.0.0.1:5038
ADB_TARGET=127.0.0.1:5555
AVD=ksnv_api36
emulator_pid=

test -x "$ADB"
test -x "$EMULATOR"
test -r "$LOCK"

lock_is_available() {
  /usr/bin/grep -q '"status"[[:space:]]*:[[:space:]]*"available"' "$LOCK"
}

device_is_ready() {
  env ADB_SERVER_SOCKET="$ADB_SOCKET" \
    "$ADB" -s "$ADB_TARGET" get-state 2>/dev/null |
    /usr/bin/grep -qx device
}

connect_emulator() {
  env ADB_SERVER_SOCKET="$ADB_SOCKET" \
    "$ADB" connect "$ADB_TARGET" >/dev/null 2>&1 || true
}

start_emulator() {
  env ADB_SERVER_SOCKET="$ADB_SOCKET" \
    "$EMULATOR" \
      -avd "$AVD" \
      -no-window \
      -no-audio \
      -no-boot-anim \
      -gpu swiftshader_indirect \
      -port 5554 &
  emulator_pid=$!
}

stop_emulator() {
  if test -n "$emulator_pid"; then
    kill -TERM "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
}

trap 'stop_emulator; exit 143' HUP INT TERM

while :; do
  if device_is_ready; then
    sleep 10
    continue
  fi

  # Never alter Android connectivity while an assigned QA run owns the lease.
  # The provider repairs availability as soon as the lease is free.
  if ! lock_is_available; then
    sleep 5
    continue
  fi

  connect_emulator
  if device_is_ready; then
    sleep 10
    continue
  fi

  if test -z "$emulator_pid" || ! kill -0 "$emulator_pid" 2>/dev/null; then
    start_emulator
  fi

  sleep 5
done
