#!/usr/bin/env bash
# The Android app on a running emulator against a real relay, a headless agent
# and the fake model: pair, stream, deny a tool, answer a question
# (app/src/androidTest/.../LiveRelayTest.kt), once per theme, each against a
# fresh stack (pairing codes are single-use). The relay port reaches the
# emulator as localhost through `adb reverse`, which debug builds allow.
#
# Needs: a booted emulator (adb), the debug and androidTest APKs built, and a
# root build of shared, core, host, cli, server and relay (itest-stack.sh).
# Screenshots land in apps/android/evidence/<theme>/.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
pkg=com.nekko.native.android
apks=apps/android/app/build/outputs/apk
out=apps/android/evidence
mkdir -p "$out"

adb wait-for-device
adb install -r -t "$apks/debug/app-debug.apk"
adb install -r -t "$apks/androidTest/debug/app-debug-androidTest.apk"

status=0
for theme in light dark; do
  env_file="$(mktemp)"
  apps/ios/scripts/itest-stack.sh "$env_file" </dev/null >/dev/null
  # shellcheck disable=SC1090
  . "$env_file"
  port="${NEKKO_ITEST_RELAY##*:}"
  adb reverse "tcp:$port" "tcp:$port"
  adb shell pm clear "$pkg" >/dev/null || true
  result="$(adb shell "am instrument -w -e class $pkg.LiveRelayTest -e nekkoTheme $theme -e nekkoLink '$NEKKO_ITEST_LINK' $pkg.test/androidx.test.runner.AndroidJUnitRunner" || true)"
  echo "$result"
  mkdir -p "$out/$theme"
  adb pull "/sdcard/Android/data/$pkg/files/evidence/." "$out/$theme/" >/dev/null 2>&1 || echo "no screenshots for $theme"
  if ! grep -q "OK (1 test)" <<<"$result"; then
    status=1
    echo "--- $theme failed; agent log"; tail -n 40 "$NEKKO_ITEST_LOGDIR/agent.log" || true
    echo "--- relay log"; tail -n 20 "$NEKKO_ITEST_LOGDIR/relay.log" || true
  fi
  adb reverse --remove "tcp:$port" || true
  kill $NEKKO_ITEST_PIDS 2>/dev/null || true
  rm -f "$env_file"
done

# Small JPEG copies in the log, for reviewers who can't download artifacts.
find "$out" -name '*.png' | sort | while read -r f; do
  if python3 -c "import PIL" 2>/dev/null; then
    python3 -c "import sys;from PIL import Image;i=Image.open(sys.argv[1]).convert('RGB');i.thumbnail((900,900));i.save('/tmp/shot.jpg',quality=60)" "$f" || continue
  else
    cp "$f" /tmp/shot.jpg
  fi
  echo "SHOT-BEGIN android/$(basename "$(dirname "$f")")-$(basename "$f" .png)"
  base64 -w0 /tmp/shot.jpg; echo
  echo "SHOT-END"
done
exit "$status"
