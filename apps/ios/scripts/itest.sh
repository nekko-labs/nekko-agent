#!/usr/bin/env bash
# Phone ↔ relay ↔ computer integration test for the Swift client.
# Starts the real relay, a headless agent (relay-agent mode) and the fake
# model from apps/android/scripts, then runs RelayIntegrationTests against
# them with the NEKKO_ITEST_* coordinates. Needs Node and a root build of
# shared, core, host, cli, server and relay (`npm run build:core`, then each).
# Uses a local `swift` when there is one (macOS), else the Linux Docker image.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
for f in apps/relay/dist/index.js apps/server/dist/index.js; do
  [ -f "$f" ] || { echo "missing $f: build the workspaces first" >&2; exit 1; }
done
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
relay_port="$(free_port)"
model_port="$(free_port)"
room="$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))')"
key="$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
data="$(mktemp -d)"
logs="$(mktemp -d)"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$data"; }
trap cleanup EXIT

node apps/android/scripts/fake-model.mjs "$model_port" >"$logs/model.log" 2>&1 & pids+=($!)
NEKKO_RELAY_PORT="$relay_port" NEKKO_RELAY_HOST=127.0.0.1 NEKKO_RELAY_ALLOW_UNAUTHENTICATED=1 \
  node apps/relay/dist/index.js >"$logs/relay.log" 2>&1 & pids+=($!)
sleep 1
cat >"$data/settings.json" <<JSON
{"providers":[{"id":"fake","kind":"openai-compat","label":"Fake","baseUrl":"http://127.0.0.1:$model_port/v1","apiKey":"sk-should-never-reach-the-phone","enabled":true}],
 "defaultProviderId":"fake","defaultModelId":"fake-model"}
JSON
NEKKO_RELAY_URL="ws://127.0.0.1:$relay_port" NEKKO_ROOM="$room" NEKKO_PAIR_KEY="$key" NEKKO_DATA_DIR="$data" NEKKO_AGENT_LOOP=ts \
  node apps/server/dist/index.js >"$logs/agent.log" 2>&1 & pids+=($!)
pair=""
for _ in $(seq 150); do
  pair="$(grep -oE 'pairing code \(10 min\): [A-Z2-9]+' "$logs/agent.log" | head -n1 | awk '{print $NF}' || true)"
  [ -n "$pair" ] && break
  sleep 0.1
done
[ -n "$pair" ] || { echo "agent printed no pairing code:" >&2; cat "$logs/agent.log" >&2; exit 1; }

export NEKKO_ITEST_RELAY="ws://127.0.0.1:$relay_port" NEKKO_ITEST_ROOM="$room" NEKKO_ITEST_KEY="$key" NEKKO_ITEST_PAIR="$pair"
status=0
if command -v swift >/dev/null 2>&1; then
  (cd apps/ios/Protocol && swift test --filter RelayIntegrationTests) || status=$?
else
  SWIFT_ENV="-e NEKKO_ITEST_RELAY -e NEKKO_ITEST_ROOM -e NEKKO_ITEST_KEY -e NEKKO_ITEST_PAIR" \
    apps/ios/scripts/linux-test.sh --filter RelayIntegrationTests || status=$?
fi
[ "$status" = 0 ] || { echo "--- agent log"; tail -n 40 "$logs/agent.log"; echo "--- relay log"; tail -n 20 "$logs/relay.log"; } >&2
exit "$status"
