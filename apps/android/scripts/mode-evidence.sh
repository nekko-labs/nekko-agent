#!/usr/bin/env bash
# CI emulator only, after assembling debug + androidTest APKs. No relay or user device.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
pkg=com.nekko.native.android
# The instrumentation class and a screenshot it must produce (native-mode-evidence.yml inputs).
cls="${NEKKO_EVIDENCE_CLASS:-com.nekko.android.ChatModesTest}"
expect="${NEKKO_EVIDENCE_EXPECT:-settings-simple-mode}"
[[ "$cls" =~ ^[A-Za-z0-9_.]+$ && "$expect" =~ ^[A-Za-z0-9_-]+$ ]]
out=apps/android/evidence
mkdir -p "$out/shots"
# Keep screenshots and any motion recording on assertion failure too.
recording=
finish() {
  if [[ -n "$recording" ]]; then
    # This script owns the disposable emulator and its only screen recorder.
    adb shell 'kill -2 $(pidof screenrecord)' >/dev/null 2>&1 || true
    wait "$recording" || true
    adb pull /sdcard/nekko-voice-motion.mp4 "$out/after-phone-voice-motion.mp4" || true
  fi
  adb pull "/sdcard/Android/data/$pkg/files/evidence/." "$out/shots/" || true
}
trap finish EXIT
adb wait-for-device
adb shell getprop > "$out/device.txt"
adb shell cmd uimode night no
adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941
adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged true
adb install -r -t apps/android/app/build/outputs/apk/debug/app-debug.apk
adb install -r -t apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
if [[ "$cls" == "com.nekko.android.VoiceIntegrationEvidenceTest" ]]; then
  # Record native sheet/gesture motion, not the runner's animation-disabled mode.
  for scale in window_animation_scale transition_animation_scale animator_duration_scale; do
    adb shell settings put global "$scale" 1
  done
  adb shell screenrecord --time-limit 180 /sdcard/nekko-voice-motion.mp4 > "$out/recording.log" 2>&1 &
  recording=$!
fi
adb shell am instrument -w -e class "$cls" -e nekkoModeEvidence true -e nekkoDevice phone -e nekkoRevision "${NEKKO_EVIDENCE_REVISION:-unspecified}" "$pkg.test/androidx.test.runner.AndroidJUnitRunner" > "$out/instrumentation.txt" 2>&1
cat "$out/instrumentation.txt"
adb pull "/sdcard/Android/data/$pkg/files/evidence/." "$out/shots/"
# adb can exit zero even when JUnit fails or the process crashes.
grep -Eq 'OK \([1-9][0-9]* tests?\)' "$out/instrumentation.txt"
! grep -Eq 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$out/instrumentation.txt"
test -n "$(find "$out/shots" -name "*${expect}*.png" -print -quit)"
