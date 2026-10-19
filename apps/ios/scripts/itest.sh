#!/usr/bin/env bash
# Phone ↔ relay ↔ computer integration test for the Swift client: starts a
# disposable stack (itest-stack.sh) and runs RelayIntegrationTests against it.
# Uses a local `swift` when there is one (macOS: the real URLSessionTransport),
# else the Linux Docker image (a test-only socket transport; see SocketTransport.swift).
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
env_file="$(mktemp)"
"$root/apps/ios/scripts/itest-stack.sh" "$env_file"
# shellcheck disable=SC1090
. "$env_file"
trap 'kill $NEKKO_ITEST_PIDS 2>/dev/null || true; rm -f "$env_file"' EXIT
status=0
if command -v swift >/dev/null 2>&1 && [ "$(uname)" = Darwin ]; then
  (cd "$root/apps/ios/Protocol" && swift test --filter RelayIntegrationTests) || status=$?
else
  SWIFT_ENV="-e NEKKO_ITEST_RELAY -e NEKKO_ITEST_ROOM -e NEKKO_ITEST_KEY -e NEKKO_ITEST_PAIR -e NEKKO_ITEST_ROUTE -e NEKKO_ITEST_ROUTE_CTL" \
    "$root/apps/ios/scripts/linux-test.sh" --filter RelayIntegrationTests || status=$?
fi
if [ "$status" != 0 ]; then
  { echo "--- agent log"; tail -n 40 "$NEKKO_ITEST_LOGDIR/agent.log"; echo "--- relay log"; tail -n 20 "$NEKKO_ITEST_LOGDIR/relay.log"; } >&2
fi
exit "$status"
