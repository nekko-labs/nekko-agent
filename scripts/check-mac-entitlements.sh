#!/usr/bin/env bash
# Usage: scripts/check-mac-entitlements.sh <path to Nekko Agent.app> [--signed]
#
# Only Contents/Resources/bin/nekko-vm may carry com.apple.security.virtualization
# (apps/desktop/scripts/sign-mac.cjs signs it with crates/nekkod/vm/nekko-vm.entitlements).
# No helper app or Resources/bin file may carry a restricted entitlement
# (keychain-access-groups, com.apple.application-identifier, com.apple.developer.*):
# only the main executable has a provisioning profile, and macOS refuses to launch
# a Developer ID binary carrying one without a profile authorizing it (#2688).
# With --signed (a Developer ID build), the app must embed
# Contents/embedded.provisionprofile and its main executable must carry the
# application identifier, team identifier and keychain access group.
#
# Reads the entitlements of the app, every helper app under Contents/Frameworks and
# every file under Contents/Resources/bin, except bin/runner-image, which holds only
# guest scripts (text, so never signed). A file codesign cannot read fails the check:
# an unreadable signature is never a pass. See docs/signing.md.
set -euo pipefail

app="${1:-}"
signed=0
case "${2:-}" in
  '') ;;
  --signed) signed=1 ;;
  *) echo "unknown option $2." >&2; exit 1 ;;
esac
vm="$app/Contents/Resources/bin/nekko-vm"
key='<key>com.apple.security.virtualization</key>'
restricted='<key>(keychain-access-groups|com\.apple\.application-identifier|com\.apple\.developer\.[^<]*)</key>'

# The workflows pass `find ... -print -quit`, which is empty when nothing was built.
if [ -z "$app" ]; then
  echo 'no .app found.' >&2
  exit 1
fi
if [ ! -f "$vm" ]; then
  echo "$app has no nekko-vm." >&2
  exit 1
fi

n=0
saw_vm=0
while IFS= read -r -d '' path; do
  if ! ents=$(codesign -d --entitlements - --xml "$path" 2>/dev/null); then
    echo "codesign could not read $path." >&2
    exit 1
  fi
  n=$((n + 1))
  if [ "$path" = "$vm" ]; then
    saw_vm=1
    if [[ "$ents" != *"$key"* ]]; then
      echo 'nekko-vm lacks the virtualization entitlement.' >&2
      exit 1
    fi
  elif [[ "$ents" == *"$key"* ]]; then
    echo "$path carries the virtualization entitlement." >&2
    exit 1
  fi

  if [ "$path" = "$app" ]; then
    if [ "$signed" -eq 1 ]; then
      for want in keychain-access-groups com.apple.application-identifier com.apple.developer.team-identifier; do
        if [[ "$ents" != *"<key>$want</key>"* ]]; then
          echo "The signed app lacks $want, so Touch ID passkeys cannot work." >&2
          exit 1
        fi
      done
    fi
  elif [[ "$ents" =~ $restricted ]]; then
    echo "$path carries ${BASH_REMATCH[1]}, which only the main executable may (it alone has the provisioning profile)." >&2
    exit 1
  fi
done < <(
  printf '%s\0' "$app"
  find "$app/Contents/Frameworks" -name '*.app' -type d -prune -print0 2>/dev/null || true
  find "$app/Contents/Resources/bin" -path '*/bin/runner-image' -prune -o -type f -print0
)

# find -type f skips a symlink, so a symlinked nekko-vm would never be read.
if [ "$saw_vm" -ne 1 ]; then
  echo "$vm is not a regular file, so it was never checked." >&2
  exit 1
fi

if [ "$signed" -eq 1 ] && [ ! -f "$app/Contents/embedded.provisionprofile" ]; then
  echo "$app embeds no provisioning profile, so macOS will refuse to launch it." >&2
  exit 1
fi

echo "virtualization entitlement: nekko-vm only ($n binaries checked)"
profile=''
[ "$signed" -eq 0 ] || profile=', profile embedded'
echo "restricted entitlements: main executable only$profile"
