#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/Users/ren/.paperclip-android-provider"
LAUNCH_AGENT="/Users/ren/Library/LaunchAgents/com.odessa.paperclip-android-provider.plist"
LABEL="com.odessa.paperclip-android-provider"
DOMAIN="gui/$(id -u)"

ADB_SOURCE="/Users/ren/Library/Android/sdk/platform-tools/adb"
EMULATOR_SOURCE="/Users/ren/Library/Android/sdk/emulator/emulator"
test -x "$ADB_SOURCE"
test -x "$EMULATOR_SOURCE"
test -r "/Volumes/OdessaExt/USING_ANDROID_DEVICE.lock"

/usr/bin/install -d -m 700 "$INSTALL_DIR"
/usr/bin/install -m 700 "$ADB_SOURCE" "$INSTALL_DIR/adb"
/usr/bin/install -m 700 "$SOURCE_DIR/android-provider.sh" "$INSTALL_DIR/android-provider.sh"
/usr/bin/install -m 600 "$SOURCE_DIR/com.odessa.paperclip-android-provider.plist" "$LAUNCH_AGENT"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN" "$LAUNCH_AGENT"
fi
launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENT"
launchctl kickstart -k "$DOMAIN/$LABEL"

printf '%s\n' "Paperclip Android provider installed with persistent ksnv_api36 fallback"
