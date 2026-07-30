#!/bin/sh
set -eu

curl --fail --silent http://127.0.0.1:3100/api/health >/dev/null
test -r /run/paperclip-deck7-router/auth-token
test "$(wc -c </run/paperclip-deck7-router/auth-token)" -eq 65
test -r /Volumes/OdessaExt/Kasanova/.worktrees/.toolchains/flutter/bin/cache/.paperclip-kasanova-flutter-cache
dart_bin=/Volumes/OdessaExt/Kasanova/.worktrees/.toolchains/flutter/bin/cache/dart-sdk/bin/dart
test -x "$dart_bin"
test "$(od -An -t x1 -j18 -N2 "$dart_bin" | tr -d ' \n')" = b700
watcher_health=/paperclip/instances/default/data/ksnvqa-rfqa-intake/health.json
test -r "$watcher_health"
node -e '
  const fs = require("node:fs");
  const health = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const lastPollMs = Date.parse(health.lastPollAt || "");
  if (!["ok", "degraded"].includes(health.status)) process.exit(1);
  if (!Number.isFinite(lastPollMs)) process.exit(1);
  if (Date.now() - lastPollMs > 5 * 60 * 1000) process.exit(1);
' "$watcher_health"
test -r /odessa-root/USING_ANDROID_DEVICE.lock
node -e '
  const fs = require("node:fs");
  const lock = JSON.parse(fs.readFileSync("/odessa-root/USING_ANDROID_DEVICE.lock", "utf8"));
  if (lock.schema !== "odessa.android-device-lock.v1") process.exit(1);
  if (!["available", "reserved"].includes(lock.status)) process.exit(1);
  if (lock.status === "reserved" && (!lock.owner || !lock.issue || !lock.sourceIssue)) process.exit(1);
'
