#!/usr/bin/env bash
# Run on a Mac with Swift 6. The tests are overlaid on base to prove red -> green.
set -euo pipefail
base="$1"
root="$(pwd)"
out="$root/.shots/relay-handshake"
mkdir -p "$out"
git worktree add --detach "$out/base" "$base"
trap 'git worktree remove --force "$out/base"' EXIT
for file in RelayClientTests.swift RelayHandshakeTests.swift; do
  cp "apps/ios/Protocol/Tests/NekkoProtocolTests/$file" "$out/base/apps/ios/Protocol/Tests/NekkoProtocolTests/$file"
done
set +e
(cd "$out/base/apps/ios/Protocol" && swift test --filter 'RelayClientTests.testLateOpen') > "$out/base.log" 2>&1
result=$?
set -e
cat "$out/base.log"
if [ "$result" -eq 0 ]; then echo 'Regression unexpectedly passes on base'; exit 1; fi
# Build errors are not reproduction evidence.
grep -q 'testLateOpenDoesNotDisconnectAWelcomedSocket.*failed' "$out/base.log"
grep -q 'testLateOpenDoesNotShortenTheWelcomeDeadline.*failed' "$out/base.log"
(cd apps/ios/Protocol && swift test --filter RelayClientTests) 2>&1 | tee "$out/head.log"
