#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DECK7_DIR="/Users/ren/.deck7"
PLIST="/Users/ren/Library/LaunchAgents/com.deck7.helper.plist"
BACKUP="/Users/ren/Library/LaunchAgents/com.deck7.helper.pre-loopback.plist"
LABEL="com.deck7.helper"
DOMAIN="gui/$(id -u)"
PYTHON="/opt/homebrew/opt/python@3.13/libexec/bin/python3"
KEY_FILE="$DECK7_DIR/linear-api-key"
LAUNCHER="$DECK7_DIR/deck7-loopback-launch.sh"

test -f "$PLIST"
test -x "$PYTHON"
test -d "$DECK7_DIR/deck7d"
/usr/bin/install -m 600 "$PLIST" "$BACKUP"
/usr/bin/install -m 700 "$SOURCE_DIR/deck7-loopback.py" "$DECK7_DIR/deck7-loopback.py"
/usr/bin/install -m 700 "$SOURCE_DIR/deck7-loopback-launch.sh" "$LAUNCHER"

if [[ ! -f "$KEY_FILE" ]]; then
  KEY_TMP="$KEY_FILE.tmp"
  umask 077
  /usr/libexec/PlistBuddy \
    -c "Print :EnvironmentVariables:LINEAR_PERSONAL_API_KEY" \
    "$PLIST" >"$KEY_TMP"
  test -s "$KEY_TMP"
  mv "$KEY_TMP" "$KEY_FILE"
fi
chmod 600 "$KEY_FILE"
plutil -remove EnvironmentVariables.LINEAR_PERSONAL_API_KEY "$PLIST" \
  >/dev/null 2>&1 || true

plutil -replace ProgramArguments -json \
  "[\"$LAUNCHER\"]" \
  "$PLIST"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN" "$PLIST"
fi
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

printf '%s\n' "DECK7 helper restricted to 127.0.0.1:8765"
