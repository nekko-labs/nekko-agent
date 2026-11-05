#!/usr/bin/env bash
# CI emulator only, after assembling debug + androidTest APKs. No relay or user device.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
pkg=com.nekko.native.android
out=apps/android/evidence
mkdir -p "$out/shots"
# Keep any screenshots on assertion failure too.
trap 'adb pull "/sdcard/Android/data/$pkg/files/evidence/." "$out/shots/" || true' EXIT
adb wait-for-device
adb shell getprop > "$out/device.txt"
adb shell cmd uimode night no
adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941
adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged true
adb install -r -t apps/android/app/build/outputs/apk/debug/app-debug.apk
adb install -r -t apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w -e class com.nekko.android.ChatModesTest -e nekkoModeEvidence true -e nekkoDevice phone "$pkg.test/androidx.test.runner.AndroidJUnitRunner" > "$out/instrumentation.txt" 2>&1
cat "$out/instrumentation.txt"
adb pull "/sdcard/Android/data/$pkg/files/evidence/." "$out/shots/"
# adb can exit zero even when JUnit fails or the process crashes.
grep -Eq 'OK \([1-9][0-9]* tests?\)' "$out/instrumentation.txt"
! grep -Eq 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$out/instrumentation.txt"
test -n "$(find "$out/shots" -name '*settings-simple-mode*.png' -print -quit)"
