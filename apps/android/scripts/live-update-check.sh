#!/usr/bin/env bash
# AN-27 on an Android 16+ emulator: install the debug and test APKs and run
# LiveUpdateTest, which checks the running-chat notification qualifies as a
# Live Update. Needs a booted emulator and both APKs built.
set -euo pipefail
cd "$(dirname "$0")/.."
pkg=com.nekko.native.android
apks=app/build/outputs/apk
adb wait-for-device
adb install -r -t "$apks/debug/app-debug.apk"
adb install -r -t "$apks/androidTest/debug/app-debug-androidTest.apk"
result="$(adb shell "am instrument -w -e class com.nekko.android.LiveUpdateTest $pkg.test/androidx.test.runner.AndroidJUnitRunner" || true)"
echo "$result"
grep -q "OK (1 test)" <<<"$result"
