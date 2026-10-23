#!/usr/bin/env bash
# Builds the .deb and checks what is inside: the app, the bundled CLI, the launcher and icons,
# the package metadata, and that the CLI runs from the unpacked package.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "check-deb: FAIL: $*" >&2; exit 1; }

bash scripts/build-deb.sh
deb=$(ls -t dist-deb/meshdrop_*.deb 2>/dev/null | head -1)
[ -n "$deb" ] || fail "no dist-deb/meshdrop_*.deb"
echo "check-deb: $deb"

list=$(dpkg-deb -c "$deb")
for f in ./opt/MeshDrop/meshdrop-desktop ./opt/MeshDrop/resources/cli.cjs ./opt/MeshDrop/resources/meshdrop ./usr/share/applications/meshdrop.desktop ./usr/share/icons/hicolor/512x512/apps/meshdrop-desktop.png ./usr/share/icons/hicolor/64x64/apps/meshdrop-desktop.png; do
  grep -qF " $f" <<<"$list" || fail "missing $f"
done
info=$(dpkg-deb -I "$deb")
grep -q '^ Package: meshdrop$' <<<"$info" || fail "Package: meshdrop"
grep -q '^ Maintainer: Hafij-BGE <mdhafijur.rahman@ogr.deu.edu.tr>$' <<<"$info" || fail "Maintainer"
dpkg-deb --ctrl-tarfile "$deb" | tar -xO ./postinst | grep -q '/usr/bin/meshdrop' || fail "postinst does not install /usr/bin/meshdrop"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
dpkg-deb -x "$deb" "$tmp/root"
out=$(ELECTRON_RUN_AS_NODE=1 "$tmp/root/opt/MeshDrop/meshdrop-desktop" "$tmp/root/opt/MeshDrop/resources/cli.cjs" id --home "$tmp/home")
grep -q 'device id' <<<"$out" || fail "cli id printed: $out"
grep -q 'ELECTRON_RUN_AS_NODE=1 exec /opt/MeshDrop/meshdrop-desktop /opt/MeshDrop/resources/cli.cjs "\$@"' "$tmp/root/opt/MeshDrop/resources/meshdrop" || fail "CLI wrapper content"
grep -q '^Exec=/opt/MeshDrop/meshdrop-desktop' "$tmp/root/usr/share/applications/meshdrop.desktop" || fail "desktop Exec"
echo "check-deb: OK"
