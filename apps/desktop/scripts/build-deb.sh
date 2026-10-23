#!/usr/bin/env bash
# Builds dist-deb/meshdrop_<version>_amd64.deb. electron-builder works in a scratch directory
# (dpkg-deb rejects files with NTFS-style permissions if the checkout lives on such a drive).
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build
out=$(mktemp -d "${TMPDIR:-/tmp}/meshdrop-deb.XXXXXX")
trap 'rm -rf "$out"' EXIT
pnpm exec electron-builder --linux deb --config electron-builder.yml --publish never -c.directories.output="$out"
mkdir -p dist-deb
cp "$out"/*.deb dist-deb/
ls -l dist-deb/*.deb
