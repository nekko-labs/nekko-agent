#!/bin/bash
# CLI checks for nekko-vm (crates/nekkod/vm/nekko-vm.swift). Builds the helper
# into a temp dir, ad-hoc signs it with its entitlement, and runs clone, run and
# count-vms against small fake bundle files. Never boots a VM.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

helper="$tmp/nekko-vm"
if ! xcrun swiftc -O -target arm64-apple-macos14 -framework Virtualization "$here/nekko-vm.swift" -o "$helper" 2>"$tmp/build.log"; then
  cat "$tmp/build.log"
  echo "FAIL build"
  exit 1
fi
codesign --force -s - --entitlements "$here/nekko-vm.entitlements" "$helper" 2>/dev/null
check "signed with the virtualization entitlement" \
  "codesign -d --entitlements - --xml '$helper' 2>/dev/null | grep -q com.apple.security.virtualization"

src="$tmp/src"
mkdir -p "$src"
printf '{"version":1,"os":"darwin","arch":"arm64","cpuCount":4,"memorySize":8589934592,"macAddress":"aa:bb:cc:dd:ee:ff","hardwareModel":"AAAA","ecid":"AAAA","display":{"width":1024,"height":768}}' >"$src/config.json"
head -c 65536 /dev/urandom >"$src/disk.img"
head -c 4096 /dev/urandom >"$src/nvram.bin"
src_sum=$(cat "$src"/* | shasum)

# clone refuses an existing target
mkdir "$tmp/exists"
out=$("$helper" clone --from "$src" --to "$tmp/exists"); code=$?
check "clone refuses an existing target" "[ $code -eq 1 ] && [[ '$out' == '{\"ok\":false,\"error\":'* ]]"

# clone refuses a missing source
out=$("$helper" clone --from "$tmp/nope" --to "$tmp/c0"); code=$?
check "clone refuses a missing source" "[ $code -eq 1 ] && [[ '$out' == '{\"ok\":false,\"error\":'* ]] && [ ! -e '$tmp/c0' ]"

# clone copies the disk and gives the clone a fresh MAC
out=$("$helper" clone --from "$src" --to "$tmp/c1"); code=$?
check "clone succeeds" "[ $code -eq 0 ] && [ '$out' = '{\"ok\":true}' ]"
check "clone disk.img is identical" "cmp -s '$src/disk.img' '$tmp/c1/disk.img'"
check "clone nvram.bin is identical" "cmp -s '$src/nvram.bin' '$tmp/c1/nvram.bin'"
mac=$(plutil -extract macAddress raw "$tmp/c1/config.json" 2>/dev/null)
check "clone has a new locally administered MAC ($mac)" \
  "[[ '$mac' =~ ^[0-9a-f]{2}(:[0-9a-f]{2}){5}$ ]] && [ '$mac' != 'aa:bb:cc:dd:ee:ff' ] && (( 0x${mac:0:2} & 2 )) && ! (( 0x${mac:0:2} & 1 ))"
check "clone keeps the other config keys" "[ \"\$(plutil -extract hardwareModel raw '$tmp/c1/config.json')\" = AAAA ]"
check "clone never touches the source" "[ \"\$(cat '$src'/* | shasum)\" = '$src_sum' ]"

# run with a missing bundle reports an error and exits 1
out=$("$helper" run --bundle "$tmp/nope" --cpus 2 --memory-mb 4096 --net-fd 3 3</dev/null); code=$?
check "run with a missing bundle stops with an error" "[ $code -eq 1 ] && [[ '$out' == '{\"event\":\"stopped\",\"reason\":\"error\",\"detail\":'* ]]"

# run with an unusable hardware model reports an error instead of booting
out=$("$helper" run --bundle "$tmp/c1" --cpus 2 --memory-mb 4096 --net-fd 3 3</dev/null); code=$?
check "run with a fake bundle stops with an error" "[ $code -eq 1 ] && [[ '$out' == *'\"event\":\"stopped\"'* && '$out' == *'\"reason\":\"error\"'* ]]"

# count-vms prints a JSON count
out=$("$helper" count-vms); code=$?
check "count-vms prints a count ($out)" "[ $code -eq 0 ] && echo '$out' | grep -Eqx '[{]\"count\":[0-9]+[}]'"

# an unknown command fails
"$helper" bogus >/dev/null; code=$?
check "unknown command exits 1" "[ $code -eq 1 ]"

[ $fails -eq 0 ] && echo "all checks passed" || { echo "$fails check(s) failed"; exit 1; }
