#!/usr/bin/env bash
# Build the iPhone app development-signed and install it on a connected iPhone
# (IO-19 TS-2, IO-5). Needs Xcode signed in to the team's Apple ID (Xcode >
# Settings > Accounts) and the phone in Developer Mode, trusted, on USB or Wi-Fi.
#
#   apps/ios/scripts/device-run.sh            first connected iPhone
#   apps/ios/scripts/device-run.sh <udid>     a specific one
#   TEAM=XXXXXXXXXX apps/ios/scripts/device-run.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
ios="$root/apps/ios"
team="${TEAM:-3HM5598S99}"

command -v xcodegen >/dev/null || { echo "xcodegen missing: brew install xcodegen" >&2; exit 1; }

udid="${1:-}"
if [ -z "$udid" ]; then
  json="$(mktemp)"
  xcrun devicectl list devices --json-output "$json" >/dev/null
  udid="$(python3 -c '
import json, sys
for d in json.load(open(sys.argv[1]))["result"]["devices"]:
    hw = d.get("hardwareProperties", {})
    if hw.get("platform") == "iOS" and hw.get("reality") == "physical" and d.get("connectionProperties", {}).get("tunnelState") != "unavailable":
        print(hw["udid"]); break
' "$json")"
  rm -f "$json"
fi
[ -n "$udid" ] || { echo "No iPhone found. Plug it in, unlock it, tap Trust, and turn on Settings > Privacy & Security > Developer Mode." >&2; exit 1; }
echo "iPhone: $udid  team: $team"

cd "$ios"
xcodegen generate --quiet
xcodebuild -project NekkoNative.xcodeproj -scheme NekkoNative -configuration Debug \
  -destination "id=$udid" -derivedDataPath DerivedData \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$team" build | tail -n 5

app="$ios/DerivedData/Build/Products/Debug-iphoneos/NekkoNative.app"
xcrun devicectl device install app --device "$udid" "$app"
xcrun devicectl device process launch --device "$udid" dev.nekkolabs.nekkoagent
echo "Installed and launched. First launch only: Settings > General > VPN & Device Management > trust the developer."
