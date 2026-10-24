#!/usr/bin/env bash
# Signed release APK: dist-apk/MeshDrop-<version>.apk + SHA256SUMS. The keystore lives in ~/.android
# and is created on first use (keep it: every update must be signed with it).
set -euo pipefail
cd "$(dirname "$0")/.."
ENV=~/.android/meshdrop-release.env
if [ ! -f "$ENV" ]; then
  KS=~/.android/meshdrop-release.jks
  PASS=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)
  keytool -genkeypair -keystore "$KS" -storepass "$PASS" -keypass "$PASS" -alias meshdrop -keyalg RSA -keysize 4096 \
    -validity 10000 -dname "CN=MeshDrop, O=Hafij-BGE" >/dev/null
  ( umask 077; printf 'export MESHDROP_KS=%s\nexport MESHDROP_KS_PASS=%s\nexport MESHDROP_KEY_ALIAS=meshdrop\nexport MESHDROP_KEY_PASS=%s\n' "$KS" "$PASS" "$PASS" >"$ENV" )
  chmod 600 "$KS" "$ENV"
  echo "release: created $KS (alias meshdrop); keep it and $ENV safe"
fi
# shellcheck disable=SC1090
source "$ENV"
~/.local/opt/gradle-8.11.1/bin/gradle --offline -q :app:lintRelease :app:assembleRelease
VERSION=$(sed -n "s/.*versionName '\(.*\)'.*/\1/p" app/build.gradle)
mkdir -p dist-apk
cp app/build/outputs/apk/release/app-release.apk "dist-apk/MeshDrop-$VERSION.apk"
( cd dist-apk && sha256sum "MeshDrop-$VERSION.apk" > SHA256SUMS )
~/Android/Sdk/build-tools/35.0.0/apksigner verify --print-certs "dist-apk/MeshDrop-$VERSION.apk" | grep -E "Signer #1 certificate (DN|SHA-256)"
ls -l "dist-apk/MeshDrop-$VERSION.apk"
