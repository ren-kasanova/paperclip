#!/usr/bin/env bash
set -euo pipefail

DOCKER="$(command -v docker)"
PAPERCLIP_IMAGE="paperclip-odessa-paperclip:latest"
SDK_VOLUME="paperclip_odessa_kasanova_dart_sdk"
CACHE_VOLUME="paperclip_odessa_kasanova_flutter_cache"
FLUTTER_CACHE="/Volumes/OdessaExt/Kasanova/.worktrees/.toolchains/flutter/bin/cache"
ENGINE_VERSION="$(tr -d '[:space:]' <"$FLUTTER_CACHE/engine.stamp")"
ENGINE_REALM="$(tr -d '[:space:]' <"$FLUTTER_CACHE/engine.realm")"
STORAGE_BASE="${FLUTTER_STORAGE_BASE_URL:-https://storage.googleapis.com}"

test -x "$DOCKER"
test -n "$ENGINE_VERSION"
"$DOCKER" image inspect "$PAPERCLIP_IMAGE" >/dev/null
if ! "$DOCKER" volume inspect "$SDK_VOLUME" >/dev/null 2>&1; then
  "$DOCKER" volume create "$SDK_VOLUME" >/dev/null
fi
if ! "$DOCKER" volume inspect "$CACHE_VOLUME" >/dev/null 2>&1; then
  "$DOCKER" volume create "$CACHE_VOLUME" >/dev/null
fi

if "$DOCKER" run --rm \
  --mount "type=volume,src=$SDK_VOLUME,dst=/sdk,readonly" \
  --entrypoint /bin/sh \
  "$PAPERCLIP_IMAGE" \
  -c 'test -x /sdk/bin/dart &&
      test "$(od -An -t x1 -j18 -N2 /sdk/bin/dart | tr -d " \n")" = b700 &&
      test -f /sdk/.paperclip-kasanova-dart-sdk' \
  >/dev/null 2>&1; then
  sdk_ready=true
else
  sdk_ready=false
fi

DART_SDK_URL="$STORAGE_BASE${ENGINE_REALM:+/$ENGINE_REALM}/flutter_infra_release/flutter/$ENGINE_VERSION/dart-sdk-linux-arm64.zip"

if [[ "$sdk_ready" != true ]]; then
  "$DOCKER" run --rm \
    --mount "type=volume,src=$SDK_VOLUME,dst=/sdk" \
    --env "DART_SDK_URL=$DART_SDK_URL" \
    --env "ENGINE_VERSION=$ENGINE_VERSION" \
    --entrypoint /bin/sh \
    "$PAPERCLIP_IMAGE" \
    -ec '
    if find /sdk -mindepth 1 -maxdepth 1 \
      ! -name .paperclip-kasanova-dart-sdk \
      ! -name .staging | grep -q .; then
      echo "Refusing to overwrite a non-empty, unverified Dart SDK volume" >&2
      exit 1
    fi
    curl --fail --location --retry 3 --output /tmp/dart-sdk.zip "$DART_SDK_URL"
    python3 - /tmp/dart-sdk.zip /sdk <<'"'"'PY'"'"'
import os
import pathlib
import shutil
import sys
import zipfile

archive_path = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
staging = destination / ".staging"
if staging.exists():
    shutil.rmtree(staging)
staging.mkdir(mode=0o700)

with zipfile.ZipFile(archive_path) as archive:
    for info in archive.infolist():
        name = pathlib.PurePosixPath(info.filename)
        if not name.parts:
            continue
        if name.parts[0] != "dart-sdk":
            if len(name.parts) == 1 and not info.is_dir():
                continue
            raise SystemExit(f"unexpected archive member: {info.filename}")
        relative = pathlib.Path(*name.parts[1:])
        if not relative.parts:
            continue
        target = staging / relative
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(info) as source, target.open("wb") as output:
            shutil.copyfileobj(source, output)
        mode = (info.external_attr >> 16) & 0o777
        target.chmod(mode or 0o644)

dart = staging / "bin" / "dart"
with dart.open("rb") as executable:
    executable.seek(18)
    if executable.read(2) != b"\xb7\x00":
        raise SystemExit("downloaded Dart SDK is not Linux ARM64")

for child in list(destination.iterdir()):
    if child == staging:
        continue
    if child.is_dir() and not child.is_symlink():
        shutil.rmtree(child)
    else:
        child.unlink()
for child in list(staging.iterdir()):
    child.rename(destination / child.name)
staging.rmdir()
(destination / ".paperclip-kasanova-dart-sdk").write_text(
    os.environ["ENGINE_VERSION"] + "\n",
    encoding="utf-8",
)
PY
    chown -R 501:20 /sdk
    chmod 644 /sdk/.paperclip-kasanova-dart-sdk
    /sdk/bin/dart --version
    '
fi

"$DOCKER" run --rm \
  --mount "type=volume,src=$CACHE_VOLUME,dst=/cache" \
  --env "ENGINE_VERSION=$ENGINE_VERSION" \
  --env "ENGINE_REALM=$ENGINE_REALM" \
  --entrypoint /bin/sh \
  "$PAPERCLIP_IMAGE" \
  -ec '
    umask 022
    printf "%s\n" "$ENGINE_VERSION" > /cache/engine.stamp
    printf "%s\n" "$ENGINE_VERSION" > /cache/engine-dart-sdk.stamp
    printf "%s\n" "$ENGINE_REALM" > /cache/engine.realm
    : > /cache/.dartignore
    printf "%s\n" "$ENGINE_VERSION" > /cache/.paperclip-kasanova-flutter-cache
    chown -R 501:20 /cache
    chmod 644 \
      /cache/engine.stamp \
      /cache/engine-dart-sdk.stamp \
      /cache/engine.realm \
      /cache/.dartignore \
      /cache/.paperclip-kasanova-flutter-cache
  '

printf '%s\n' "Kasanova ARM64 Flutter cache volumes provisioned"
