#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/Users/ren/.paperclip-deck7-router"
LAUNCH_AGENT="/Users/ren/Library/LaunchAgents/com.odessa.paperclip-deck7-router.plist"
LABEL="com.odessa.paperclip-deck7-router"
DOMAIN="gui/$(id -u)"
NODE="/opt/homebrew/opt/node@22/bin/node"
AUTH_TOKEN="$INSTALL_DIR/auth-token"
DOCKER="$(command -v docker)"
TOKEN_VOLUME="paperclip_odessa_deck7_router"
PAPERCLIP_IMAGE="paperclip-odessa-paperclip:latest"

test -x "$NODE"
test -x "$DOCKER"
test -x "/Users/ren/.deck7/deck7"
test -f "/Users/ren/.deck7/agents.json"
test -f "$SOURCE_DIR/paperclip-deck7-router.mjs"
test -f "$SOURCE_DIR/provision-paperclip-deck7-source.mjs"
test -f "$SOURCE_DIR/com.odessa.paperclip-deck7-router.plist"

/usr/bin/install -d -m 700 "$INSTALL_DIR"

if [[ ! -f "$AUTH_TOKEN" ]]; then
  TOKEN_TMP="$INSTALL_DIR/auth-token.tmp"
  /usr/bin/openssl rand -hex 32 >"$TOKEN_TMP"
  chmod 600 "$TOKEN_TMP"
  mv "$TOKEN_TMP" "$AUTH_TOKEN"
fi
test "$(stat -f '%Lp' "$AUTH_TOKEN")" = "600"

"$DOCKER" image inspect "$PAPERCLIP_IMAGE" >/dev/null
if ! "$DOCKER" volume inspect "$TOKEN_VOLUME" >/dev/null 2>&1; then
  "$DOCKER" volume create "$TOKEN_VOLUME" >/dev/null
fi
"$DOCKER" run --rm -i \
  --mount "type=volume,src=$TOKEN_VOLUME,dst=/credential" \
  --entrypoint /bin/sh \
  "$PAPERCLIP_IMAGE" \
  -c 'umask 077; cat > /credential/auth-token; chown 501:20 /credential/auth-token; chmod 600 /credential/auth-token' \
  <"$AUTH_TOKEN"

"$NODE" "$SOURCE_DIR/provision-paperclip-deck7-source.mjs"
"$NODE" "$SOURCE_DIR/paperclip-deck7-router.mjs" --check

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN" "$LAUNCH_AGENT"
fi

/usr/bin/install -m 700 \
  "$SOURCE_DIR/paperclip-deck7-router.mjs" \
  "$INSTALL_DIR/paperclip-deck7-router.mjs"

if [[ ! -f "$INSTALL_DIR/state.json" ]]; then
  "$NODE" "$INSTALL_DIR/paperclip-deck7-router.mjs" --bootstrap
fi

/usr/bin/install -m 600 \
  "$SOURCE_DIR/com.odessa.paperclip-deck7-router.plist" \
  "$LAUNCH_AGENT"

launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENT"
launchctl kickstart -k "$DOMAIN/$LABEL"

printf '%s\n' "Paperclip DECK7 router installed"
