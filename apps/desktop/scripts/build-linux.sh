#!/usr/bin/env bash
# Builds the packages for Linux distributions other than Ubuntu/Debian into dist-linux/: .rpm (Fedora,
# openSUSE), .pkg.tar.zst (Arch), .AppImage and .tar.gz (any). The .rpm needs rpmbuild and the Arch
# package bsdtar (Ubuntu: apt install rpm libarchive-tools). Same scratch-directory trick as build-deb.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
targets=${*:-rpm pacman AppImage tar.gz}
pnpm build
out=$(mktemp -d "${TMPDIR:-/tmp}/meshdrop-linux.XXXXXX")
trap 'rm -rf "$out"' EXIT
# shellcheck disable=SC2086
pnpm exec electron-builder --linux $targets --config electron-builder.yml --publish never -c.directories.output="$out"

# The Arch package's optional helpers (the .deb's Recommends). fpm 1.17 accepts --pacman-optional-depends
# but its template reads another key, so they go into .PKGINFO here; .MTREE holds .PKGINFO's checksum,
# so it is made again, from the archive itself so every entry stays owned by root.
optdepends=(
  'android-tools: Set up a phone over USB'
  'python-gobject: remote control on GNOME'
  'pipewire: PC sound and microphone to a phone'
  'gstreamer: phone camera as a webcam'
  'gst-plugin-pipewire: phone camera as a webcam'
  'gst-plugins-good: phone camera as a webcam'
  'gst-plugins-bad: phone camera as a webcam'
  'cups: print on this PC'
  'libappindicator-gtk3: tray icon'
)
for pkg in "$out"/*.pkg.tar.zst; do
  [ -e "$pkg" ] || continue
  w=$(mktemp -d "${TMPDIR:-/tmp}/meshdrop-pkg.XXXXXX")
  mkdir "$w/root"
  bsdtar -xpf "$pkg" -C "$w/root"
  printf 'optdepend = %s\n' "${optdepends[@]}" >>"$w/root/.PKGINFO"
  rm -f "$w/root/.MTREE"
  (cd "$w/root" && bsdtar --uid 0 --gid 0 --uname root --gname root -cf "$w/body.tar" .PKGINFO .INSTALL *)
  bsdtar --format=mtree --options='!all,use-set,type,uid,gid,mode,time,size,md5,sha256,link' -czf "$w/root/.MTREE" "@$w/body.tar"
  bsdtar --uid 0 --gid 0 --uname root --gname root -cf - -C "$w/root" .MTREE "@$w/body.tar" | zstd -q -19 -T0 >"$pkg.new"
  mv "$pkg.new" "$pkg"
  rm -rf "$w"
done
mkdir -p dist-linux
find "$out" -maxdepth 1 -type f \( -name '*.rpm' -o -name '*.pkg.tar.zst' -o -name '*.AppImage' -o -name '*.tar.gz' \) -exec cp {} dist-linux/ \;
ls -l dist-linux/
