#!/bin/sh
set -eu

KEY_FILE="/Users/ren/.deck7/linear-api-key"
PYTHON="/opt/homebrew/opt/python@3.13/libexec/bin/python3"
SCRIPT="/Users/ren/.deck7/deck7-loopback.py"

test -r "$KEY_FILE"
LINEAR_PERSONAL_API_KEY="$(tr -d '\r\n' <"$KEY_FILE")"
test -n "$LINEAR_PERSONAL_API_KEY"
export LINEAR_PERSONAL_API_KEY

exec "$PYTHON" "$SCRIPT"
