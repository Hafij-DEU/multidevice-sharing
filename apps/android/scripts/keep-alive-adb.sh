#!/usr/bin/env bash
# Lets MeshDrop run in the background without the system stopping it (Doze, app standby, MIUI/HyperOS
# battery saver and autostart), and grants the permissions it would ask for. Needs the phone on USB with USB debugging on; no root.
#   bash apps/android/scripts/keep-alive-adb.sh [serial]
# Undo the Doze exemption: adb shell dumpsys deviceidle whitelist -io.github.hafijbge.meshdrop
set -u
PKG=io.github.hafijbge.meshdrop
ADB=(adb)
[ $# -ge 1 ] && ADB=(adb -s "$1")
run() { echo "+ adb shell $*"; "${ADB[@]}" shell "$@" || echo "  (not supported on this phone, skipped)"; }

"${ADB[@]}" get-state >/dev/null || { echo "No phone found: plug it in with USB debugging on."; exit 1; }
"${ADB[@]}" shell pm path "$PKG" >/dev/null || { echo "MeshDrop is not installed on this phone."; exit 1; }

run dumpsys deviceidle whitelist +"$PKG"                     # never deferred by Doze
run cmd appops set "$PKG" RUN_ANY_IN_BACKGROUND allow          # background restriction off
run cmd appops set "$PKG" RUN_IN_BACKGROUND allow
run am set-standby-bucket "$PKG" active                       # app standby: always active
run cmd appops set "$PKG" 10008 allow                          # MIUI / HyperOS: autostart
run cmd appops set "$PKG" 10021 allow                          # MIUI / HyperOS: start in background
run cmd notification allow_listener "$PKG/$PKG.NotifyListener" # notifications to the PC (Remote page)
# Permissions MeshDrop would otherwise ask for (0.5.0+): no prompts later.
for perm in CAMERA RECORD_AUDIO POST_NOTIFICATIONS READ_MEDIA_IMAGES READ_MEDIA_VIDEO; do
  run pm grant "$PKG" "android.permission.$perm"
done
run cmd appops set "$PKG" SYSTEM_ALERT_WINDOW allow             # links from the PC open even in the background
echo "Done. On Xiaomi also set Battery saver to 'No restrictions' for MeshDrop (Settings > Apps > MeshDrop)."
