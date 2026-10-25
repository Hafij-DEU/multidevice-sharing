#!/usr/bin/env bash
# Pack the browser extension as dist/meshdrop-extension-<version>.zip (manifest.json at the zip root),
# the release asset App Hub unpacks into Documents/MeshDrop Browser Extension.
set -euo pipefail
here=$(cd "$(dirname "$0")/../../browser-extension" && pwd)
version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$here/manifest.json")
out=${1:-"$here/../../dist"}
mkdir -p "$out"
out=$(cd "$out" && pwd)/meshdrop-extension-$version.zip
rm -f "$out"
(cd "$here" && zip -qrX "$out" manifest.json background.js content.js popup.html popup.js popup.css icons)
echo "$out"
