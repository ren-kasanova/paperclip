#!/bin/sh
set -eu

curl --fail --silent http://127.0.0.1:3100/api/health >/dev/null
test -r /run/paperclip-deck7-router/auth-token
test "$(wc -c </run/paperclip-deck7-router/auth-token)" -eq 65
test -r /Volumes/OdessaExt/Kasanova/.worktrees/.toolchains/flutter/bin/cache/.paperclip-kasanova-flutter-cache
dart_bin=/Volumes/OdessaExt/Kasanova/.worktrees/.toolchains/flutter/bin/cache/dart-sdk/bin/dart
test -x "$dart_bin"
test "$(od -An -t x1 -j18 -N2 "$dart_bin" | tr -d ' \n')" = b700
test -r /odessa-root/USING_ANDROID_DEVICE.lock
node -e '
  const fs = require("node:fs");
  const lock = JSON.parse(fs.readFileSync("/odessa-root/USING_ANDROID_DEVICE.lock", "utf8"));
  if (lock.schema !== "odessa.android-device-lock.v1") process.exit(1);
  if (!["available", "reserved"].includes(lock.status)) process.exit(1);
  if (lock.status === "reserved" && (!lock.owner || !lock.issue || !lock.sourceIssue)) process.exit(1);
'
