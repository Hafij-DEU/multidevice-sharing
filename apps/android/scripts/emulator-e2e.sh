#!/usr/bin/env bash
# End-to-end on the emulator (never a physical phone): the debug APK against the Node engine on the
# host. PC -> phone (MediaStore Download/MeshDrop), phone -> PC (a MediaStore content URI through
# UriSource), a name collision, and a receive cut by force-stop that resumes.
# Usage: scripts/emulator-e2e.sh   (EMU=emulator-5554 by default; the emulator must be running)
set -euo pipefail
cd "$(dirname "$0")/.."
EMU=${EMU:-emulator-5554}
case "$EMU" in emulator-*) ;; *) echo "emulator-e2e: refusing to run on $EMU (emulators only)" >&2; exit 2 ;; esac
E="adb -s $EMU"
PKG=io.github.hafijbge.meshdrop
CLI="node $(cd ../.. && pwd)/packages/core/src/cli.ts"
fail() { echo "emulator-e2e: FAIL: $*" >&2; exit 1; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
esha() { $E shell sha256sum "'$1'" | cut -d' ' -f1; }
until_ok() { local t=$1; shift; for _ in $(seq 1 "$t"); do if "$@"; then return 0; fi; sleep 1; done; return 1; }

~/.local/opt/gradle-8.11.1/bin/gradle --offline -q :app:assembleDebug
$E uninstall $PKG >/dev/null 2>&1 || true   # fresh install: a release-signed build may be on the emulator
$E install app/build/outputs/apk/debug/app-debug.apk >/dev/null
$E shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true
$E shell am force-stop $PKG
$E shell rm -rf /sdcard/Download/MeshDrop
$E shell am start -n $PKG/.MainActivity >/dev/null

H=$(mktemp -d)
LOG=$H/listen.log
cleanup() { [ -n "${LP:-}" ] && kill "$LP" 2>/dev/null; $E forward --remove-all >/dev/null 2>&1 || true; rm -rf "$H"; }
trap cleanup EXIT
$CLI listen --home "$H/pc" --inbox "$H/inbox" --port 0 --no-discovery --alias pc >"$LOG" 2>&1 &
LP=$!
until_ok 20 grep -q "listening on port" "$LOG" || fail "node listen did not start"
NPORT=$(sed -n 's/.*listening on port \([0-9]*\).*/\1/p' "$LOG" | head -1)
NID=$(sed -n 's/^device id \([0-9a-f]\{64\}\).*/\1/p' "$LOG" | head -1)

F=$((20000 + RANDOM % 20000))
$E forward tcp:$F tcp:53318 >/dev/null
until_ok 30 $CLI pair 127.0.0.1:$F phone --home "$H/pc" >"$H/pair.log" 2>&1 || fail "pair with the phone: $(cat "$H/pair.log")"
PID=$(sed -n 's/^their device id: \([0-9a-f]\{64\}\)/\1/p' "$H/pair.log")
[ -n "$PID" ] || fail "no phone id"
$E shell am broadcast -n $PKG/.DebugCommands -a $PKG.debug.PAIR --es host 10.0.2.2 --ei port "$NPORT" --es alias pc >/dev/null
until_ok 20 grep -q "$NID" <($E shell cat "/sdcard/Android/data/$PKG/files/debug.log" 2>/dev/null) || fail "phone did not pair back"

# PC -> phone: a 9 MiB file plus text.
head -c 9437191 /dev/urandom >"$H/big.bin"
$CLI send "${PID:0:8}" "$H/big.bin" --text "hi phone" --home "$H/pc" >/dev/null || fail "send to the phone"
[ "$(esha /sdcard/Download/MeshDrop/big.bin)" = "$(sha "$H/big.bin")" ] || fail "big.bin differs on the phone"
echo "emulator-e2e: PC -> phone ok"

# phone -> PC: the debug receiver puts the file into MediaStore Downloads and sends its content URI.
head -c 5242883 /dev/urandom >"$H/x.bin"
$E push "$H/x.bin" "/sdcard/Android/data/$PKG/files/x.bin" >/dev/null
$E shell am broadcast -n $PKG/.DebugCommands -a $PKG.debug.SEND --es file x.bin --es to "$NID" >/dev/null
until_ok 60 test -f "$H/inbox/x.bin" || fail "x.bin did not reach the PC"
until_ok 20 bash -c "[ \"\$(sha256sum '$H/inbox/x.bin' | cut -d' ' -f1)\" = '$(sha "$H/x.bin")' ]" || fail "x.bin differs on the PC"
echo "emulator-e2e: phone -> PC ok (content URI)"

# The same name twice: the second lands as "ü 😀 (1).txt", never overwritten.
printf 'one' >"$H/ü 😀.txt"
$CLI send "${PID:0:8}" "$H/ü 😀.txt" --home "$H/pc" >/dev/null || fail "send ü 😀.txt"
printf 'two' >"$H/ü 😀.txt"
$CLI send "${PID:0:8}" "$H/ü 😀.txt" --home "$H/pc" >/dev/null || fail "send ü 😀.txt again"
[ "$($E shell cat "'/sdcard/Download/MeshDrop/ü 😀.txt'")" = "one" ] || fail "first ü 😀.txt was changed"
[ "$($E shell cat "'/sdcard/Download/MeshDrop/ü 😀 (1).txt'")" = "two" ] || fail "second ü 😀.txt not landed as (1)"
echo "emulator-e2e: name collision ok"

# A receive cut by force-stop resumes after the service restarts.
head -c 209715213 /dev/urandom >"$H/huge.bin"
($CLI send "${PID:0:8}" "$H/huge.bin" --home "$H/pc" >"$H/huge.log" 2>&1 || true) &
SP=$!
until_ok 60 bash -c "$E shell run-as $PKG ls files/meshdrop/inbox-state 2>/dev/null | tr -d '\\r' | grep -qE '^[A-Za-z0-9_-]{22}\$'" || fail "no partial session on the phone"
sleep 2
$E shell am force-stop $PKG
wait $SP || true
$E shell am start -n $PKG/.MainActivity >/dev/null
sleep 3
until_ok 60 $CLI resume --home "$H/pc" >"$H/resume.log" 2>&1 || fail "resume: $(cat "$H/resume.log")"
[ "$(esha /sdcard/Download/MeshDrop/huge.bin)" = "$(sha "$H/huge.bin")" ] || fail "huge.bin differs after resume"
echo "emulator-e2e: resume after force-stop ok"
echo "emulator-e2e: OK"
