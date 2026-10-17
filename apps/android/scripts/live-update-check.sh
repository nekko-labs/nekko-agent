#!/usr/bin/env bash
# AN-27 on an Android 16+ emulator: install the debug and test APKs and run
# LiveUpdateTest, which checks the running-chat notification qualifies as a
# Live Update. Needs a booted emulator and both APKs built.
set -euo pipefail
cd "$(dirname "$0")/.."
pkg=com.nekko.native.android
apks=app/build/outputs/apk
adb wait-for-device
# A freshly booted image says boot_completed before the package service takes
# installs ("Broken pipe"); wait for it, and retry an install that still races.
for _ in $(seq 1 60); do
  adb shell cmd package list packages android >/dev/null 2>&1 && break
  sleep 2
done
# …and until the user's credential-encrypted storage is unlocked, or the app's
# first SharedPreferences read crashes it.
adb shell wm dismiss-keyguard >/dev/null 2>&1 || true
unlocked=no
for _ in $(seq 1 120); do
  if adb shell am get-started-user-state 0 2>/dev/null | grep -q RUNNING_UNLOCKED; then unlocked=yes; break; fi
  adb shell wm dismiss-keyguard >/dev/null 2>&1 || true
  sleep 2
done
echo "user 0 unlocked: $unlocked ($(adb shell am get-started-user-state 0 2>&1 | tr -d '\r'))"

install() {
  for attempt in 1 2 3 4 5; do
    adb install -r -t "$1" && return 0
    echo "install failed (attempt $attempt), retrying"; sleep 10
  done
  return 1
}
install "$apks/debug/app-debug.apk"
install "$apks/androidTest/debug/app-debug-androidTest.apk"
result="$(adb shell "am instrument -w -e class com.nekko.android.LiveUpdateTest,com.nekko.android.LiveUpdateProbeTest $pkg.test/androidx.test.runner.AndroidJUnitRunner" || true)"
echo "$result"
grep -q "OK (1 test)" <<<"$result"
