#!/usr/bin/env bash
# Build a self-contained Windows install package for a machine WITHOUT internet.
#
#   ./deploy/pack-offline.sh            -> dist/webmanager-offline-<hash>.zip
#   NODE_VERSION=22.18.0 ./deploy/pack-offline.sh   (override bundled Node msi)
#
# Package layout (unzip anywhere, then double-click setup.cmd / update.cmd):
#   WEBMANAGER/                     git archive of HEAD (backend, built UI, scripts)
#   WEBMANAGER/VERSION              "<hash> (<date>)" - replaces `git rev-parse` on the target
#   WEBMANAGER/backend/node_modules production deps built for win32-x64 / Node 22
#   WEBMANAGER/offline/nginx-<v>.zip, node-v22.x-x64.msi
# setup.ps1 / install.ps1 / update.ps1 detect that layout and skip Git, npm and downloads.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGINX_VERSION="${NGINX_VERSION:-1.28.0}"
NODE_VERSION="${NODE_VERSION:-22.23.1}"
# Node ABI the native prebuilts are fetched for - every server runs Node 22.x (ABI 127)
NODE_TARGET="${NODE_TARGET:-22.18.0}"

cd "$ROOT"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "!! working tree has uncommitted tracked changes - commit or stash first so the package matches a git hash" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi
HASH="$(git rev-parse --short HEAD)"
DATE="$(date +%Y-%m-%d)"
DIST="$ROOT/dist"
CACHE="$DIST/cache"
STAGE="$DIST/webmanager-offline-$HASH"
PKG="$STAGE/WEBMANAGER"
ZIP="$DIST/webmanager-offline-$HASH.zip"
mkdir -p "$CACHE"
rm -rf "$STAGE" "$ZIP"
mkdir -p "$PKG"

echo "[1/5] git archive $HASH"
# git archive applies .gitattributes (ps1/cmd -> CRLF) the same way a Windows checkout would
git archive --format=tar HEAD | tar -x -C "$PKG"
echo "$HASH ($DATE)" > "$PKG/VERSION"

echo "[2/5] backend node_modules for win32-x64 / Node $NODE_TARGET"
NM_BUILD="$CACHE/win-node_modules"
mkdir -p "$NM_BUILD"
cp backend/package.json backend/package-lock.json "$NM_BUILD/"
# Mac/Linux host: npm resolves optional deps for the target OS (--os/--cpu) and
# prebuild-install picks the win32-x64 binary from npm_config_platform/arch/target.
( cd "$NM_BUILD" && rm -rf node_modules && \
  npm_config_cache="$CACHE/npm-cache" npm_config_platform=win32 npm_config_arch=x64 \
  npm_config_target="$NODE_TARGET" npm_config_runtime=node \
  npm ci --omit=dev --os=win32 --cpu=x64 --no-audit --no-fund )
SQLITE_NODE="$NM_BUILD/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
# grep without -q: under pipefail an early-exiting grep kills the producer with SIGPIPE
file "$SQLITE_NODE" | grep "PE32+" >/dev/null || { echo "!! better_sqlite3.node is not a Windows binary"; file "$SQLITE_NODE"; exit 1; }
[ -d "$NM_BUILD/node_modules/node-pty/prebuilds/win32-x64" ] || { echo "!! node-pty has no win32-x64 prebuild"; exit 1; }
[ -d "$NM_BUILD/node_modules/fsevents" ] && { echo "!! fsevents (mac-only) slipped in"; exit 1; }
rm -rf "$PKG/backend/node_modules"
cp -R "$NM_BUILD/node_modules" "$PKG/backend/node_modules"
# some registry tarballs ship stray dev folders (resolve@1.x publishes a .claude/) - never carry those
find "$PKG/backend/node_modules" -type d -name ".claude" -prune -exec rm -rf {} +

echo "[3/5] nginx $NGINX_VERSION + Node $NODE_VERSION installer"
mkdir -p "$PKG/offline"
NGINX_ZIP="$CACHE/nginx-$NGINX_VERSION.zip"
NODE_MSI="$CACHE/node-v$NODE_VERSION-x64.msi"
[ -s "$NGINX_ZIP" ] || curl -fsSL -o "$NGINX_ZIP" "https://nginx.org/download/nginx-$NGINX_VERSION.zip"
if [ ! -s "$NODE_MSI" ]; then
  curl -fsSL -o "$NODE_MSI" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-x64.msi"
  EXPECTED="$(curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | awk -v f="node-v$NODE_VERSION-x64.msi" '$2==f {print $1}')"
  ACTUAL="$(shasum -a 256 "$NODE_MSI" | awk '{print $1}')"
  [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo "!! Node msi checksum mismatch"; rm -f "$NODE_MSI"; exit 1; }
fi
unzip -l "$NGINX_ZIP" | grep "nginx-$NGINX_VERSION/nginx.exe" >/dev/null || { echo "!! nginx zip has no nginx.exe"; exit 1; }
cp "$NGINX_ZIP" "$NODE_MSI" "$PKG/offline/"

echo "[4/5] README"
cp deploy/README-OFFLINE.md "$STAGE/README-OFFLINE.md"

echo "[5/5] zip"
( cd "$DIST" && zip -qr "$ZIP" "$(basename "$STAGE")" )
rm -rf "$STAGE"
echo
echo "package: $ZIP ($(du -h "$ZIP" | cut -f1))"
echo "version: $HASH ($DATE) · nginx $NGINX_VERSION · node msi $NODE_VERSION · natives for Node $NODE_TARGET (ABI 127)"
echo "on the target: unzip -> WEBMANAGER\\setup.cmd (first install) or WEBMANAGER\\update.cmd (existing install)"
