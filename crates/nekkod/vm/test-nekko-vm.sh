#!/bin/bash
# CLI checks for nekko-vm (crates/nekkod/vm/nekko-vm.swift). Builds the helper
# into a temp dir, ad-hoc signs it with its entitlement, runs clone, run, install
# and count-vms against small fake files, asks restore-image, and reads the first
# line of egress and host.
# Never boots a VM.
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
mkdir "$tmp/exists" && echo keep >"$tmp/exists/keep.txt"
out=$("$helper" clone --from "$src" --to "$tmp/exists"); code=$?
check "clone refuses an existing target" "[ $code -eq 1 ] && [[ '$out' == '{\"ok\":false,\"error\":'* ]]"
check "clone leaves an existing target intact" "[ -f '$tmp/exists/keep.txt' ] && [ ! -e '$tmp/exists/disk.img' ]"

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

# first boot: the password file never outlives the call, whatever happens next
printf secret >"$tmp/pw"
out=$("$helper" run --bundle "$tmp/c1" --cpus 2 --memory-mb 4096 --net-fd 3 --first-boot-user nekko-build --first-boot-password-file "$tmp/pw" 3</dev/null); code=$?
check "first boot on a fake bundle stops with an error" "[ $code -eq 1 ] && [[ '$out' == *'\"reason\":\"error\"'* ]]"
check "first boot deletes the password file" "[ ! -e '$tmp/pw' ]"
out=$("$helper" run --bundle "$tmp/c1" --cpus 2 --memory-mb 4096 --net-fd 3 --first-boot-user nekko-build --first-boot-password-file "$tmp/nope" 3</dev/null); code=$?
check "first boot without a password file fails" "[ $code -eq 1 ] && [[ '$out' == *'\"reason\":\"error\"'* ]]"

# install refuses bad input and leaves no bundle
out=$("$helper" install --ipsw "$tmp/nope"); code=$?
check "install needs its flags" "[ $code -eq 1 ] && [[ '$out' == '{\"ok\":false,\"error\":\"install needs'* ]]"
head -c 4096 /dev/urandom >"$tmp/not.ipsw"
out=$("$helper" install --ipsw "$tmp/not.ipsw" --bundle "$tmp/fresh" --disk-gb 1); code=$?
check "install refuses a file that is no restore image" "[ $code -eq 1 ] && [[ '$out' == '{\"ok\":false,\"error\":'* ]] && [ ! -e '$tmp/fresh' ]"

# capabilities says what this SDK built in
out=$("$helper" capabilities); code=$?
check "capabilities reports first boot ($out)" "[ $code -eq 0 ] && [ '$out' = '{\"firstBoot\":true}' ]"

# restore-image asks Apple's catalog, so offline it must still answer in JSON
out=$("$helper" restore-image); code=$?
check "restore-image answers in JSON ($out)" \
  "python3 -c 'import json, sys; d = json.loads(sys.argv[1]); assert isinstance(d[\"ok\"], bool); assert \"usage\" not in d.get(\"error\", \"\"); assert not d[\"ok\"] or (d[\"url\"].startswith(\"https://\") and d[\"build\"] and d[\"version\"])' '$out' 2>/dev/null"

# count-vms prints a JSON count
out=$("$helper" count-vms); code=$?
check "count-vms prints a count ($out)" "[ $code -eq 0 ] && echo '$out' | grep -Eqx '[{]\"count\":[0-9]+[}]'"

# egress prints its first JSON line within 2 s
"$helper" egress >"$tmp/egress.out" 2>/dev/null &
egress_pid=$!
for _ in $(seq 20); do [ -s "$tmp/egress.out" ] && break; sleep 0.1; done
kill "$egress_pid" 2>/dev/null; wait "$egress_pid" 2>/dev/null
out=$(head -n 1 "$tmp/egress.out")
check "egress prints the four keys ($out)" \
  "python3 -c 'import json, sys; d = json.loads(sys.argv[1]); assert set(d) == {\"physical\", \"vpnCarriesDefault\", \"expensive\", \"constrained\"}' '$out' 2>/dev/null"

# host prints its first JSON line within 2 s
"$helper" host >"$tmp/host.out" 2>/dev/null &
host_pid=$!
for _ in $(seq 20); do [ -s "$tmp/host.out" ] && break; sleep 0.1; done
kill "$host_pid" 2>/dev/null; wait "$host_pid" 2>/dev/null
out=$(head -n 1 "$tmp/host.out")
check "host prints the three keys ($out)" \
  "python3 -c 'import json, sys; d = json.loads(sys.argv[1]); assert set(d) == {\"thermal\", \"lowPowerMode\", \"memoryPressure\"}; assert d[\"thermal\"] in (\"nominal\", \"fair\", \"serious\", \"critical\"); assert d[\"memoryPressure\"] in (\"normal\", \"warning\", \"critical\"); assert isinstance(d[\"lowPowerMode\"], bool)' '$out' 2>/dev/null"

# an unknown command fails
"$helper" bogus >/dev/null; code=$?
check "unknown command exits 1" "[ $code -eq 1 ]"

[ $fails -eq 0 ] && echo "all checks passed" || { echo "$fails check(s) failed"; exit 1; }
