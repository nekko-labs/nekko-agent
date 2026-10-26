#!/usr/bin/env bash
# Usage: scripts/check-mac-entitlements.sh <path to Nekko Agent.app>
#
# Only Contents/Resources/bin/nekko-vm may carry com.apple.security.virtualization
# (apps/desktop/scripts/sign-mac.cjs signs it with crates/nekkod/vm/nekko-vm.entitlements).
# Reads the entitlements of the app, every helper app under Contents/Frameworks and
# every file under Contents/Resources/bin. A file codesign cannot read fails the
# check: an unreadable signature is never a pass. See docs/signing.md.
set -euo pipefail

app="${1:-}"
vm="$app/Contents/Resources/bin/nekko-vm"
key='<key>com.apple.security.virtualization</key>'

if [ ! -f "$vm" ]; then
  echo "$app has no nekko-vm." >&2
  exit 1
fi

n=0
while IFS= read -r -d '' path; do
  if ! ents=$(codesign -d --entitlements - --xml "$path" 2>/dev/null); then
    echo "codesign could not read $path." >&2
    exit 1
  fi
  n=$((n + 1))
  if [ "$path" = "$vm" ]; then
    if [[ "$ents" != *"$key"* ]]; then
      echo 'nekko-vm lacks the virtualization entitlement.' >&2
      exit 1
    fi
  elif [[ "$ents" == *"$key"* ]]; then
    echo "$path carries the virtualization entitlement." >&2
    exit 1
  fi
done < <(
  printf '%s\0' "$app"
  find "$app/Contents/Frameworks" -name '*.app' -type d -prune -print0 2>/dev/null || true
  find "$app/Contents/Resources/bin" -type f -print0
)

echo "virtualization entitlement: nekko-vm only ($n binaries checked)"
