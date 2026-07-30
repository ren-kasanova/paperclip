#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/Users/ren/.paperclip-adb-bridge"
LAUNCH_AGENT="/Users/ren/Library/LaunchAgents/com.odessa.paperclip-adb-bridge.plist"
LABEL="com.odessa.paperclip-adb-bridge"
DOMAIN="gui/$(id -u)"

ADB_SOURCE="/Users/ren/Library/Android/sdk/platform-tools/adb"
test -x "$ADB_SOURCE"
/usr/bin/install -d -m 700 "$INSTALL_DIR"
/usr/bin/install -m 700 "$ADB_SOURCE" "$INSTALL_DIR/adb"
/usr/bin/install -m 700 "$SOURCE_DIR/adb-bridge.sh" "$INSTALL_DIR/adb-bridge.sh"
/usr/bin/install -m 600 "$SOURCE_DIR/com.odessa.paperclip-adb-bridge.plist" "$LAUNCH_AGENT"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN" "$LAUNCH_AGENT"
fi
launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENT"
launchctl kickstart -k "$DOMAIN/$LABEL"

printf '%s\n' "Paperclip ADB bridge installed on macOS loopback port 5038"
