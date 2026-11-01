#!/usr/bin/env bash
# Builds the add-on's own .deb (meshdrop-addon-share): the bundled add-on and its manifest in
# /usr/lib/meshdrop/addons/share/, root-owned and read-only for everyone else, which is what
# MeshDrop's add-on loader requires before it loads anything from there.
set -euo pipefail
umask 022
cd "$(dirname "$0")/.."

version="$(node -p "require('./manifest.json').version")"
npx vite build

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
chmod 755 "$stage"
dest="$stage/usr/lib/meshdrop/addons/share"
install -d "$dest" "$stage/DEBIAN"
install -m 644 manifest.json dist/index.cjs "$dest/"
size="$(du -sk "$stage/usr" | cut -f1)"
cat > "$stage/DEBIAN/control" <<CONTROL
Package: meshdrop-addon-share
Version: $version
Architecture: all
Maintainer: Hafij-BGE <mdhafijur.rahman@ogr.deu.edu.tr>
Depends: meshdrop (>= 0.9.4)
Installed-Size: $size
Section: net
Priority: optional
Homepage: https://github.com/Hafij-DEU/meshdrop
Description: MeshDrop add-on: share with other apps
 Lets MeshDrop find, send to and receive from Android phones and tablets
 that use Quick Share, on the same Wi-Fi network.
CONTROL

mkdir -p dist-deb
out="dist-deb/meshdrop-addon-share_${version}_all.deb"
dpkg-deb --root-owner-group --build "$stage" "$out"
echo "$out"
