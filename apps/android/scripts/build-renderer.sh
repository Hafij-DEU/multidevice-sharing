#!/usr/bin/env bash
# Builds the shared React renderer (apps/desktop/src/renderer) into app/src/main/assets/web.
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
( cd ../desktop && pnpm exec vite build -c vite.renderer.config.ts --outDir "$out" --emptyOutDir >/dev/null )
rm -rf app/src/main/assets/web
mkdir -p app/src/main/assets/web
cp -r "$out"/. app/src/main/assets/web/
find app/src/main/assets/web -name '*.map' -delete
echo "renderer -> app/src/main/assets/web"
