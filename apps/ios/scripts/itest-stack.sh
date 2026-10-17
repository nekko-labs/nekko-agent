#!/usr/bin/env bash
# Start a disposable phone test stack: the real relay, a headless agent in
# relay-agent mode and the fake OpenAI-compatible model, on free loopback
# ports with a fresh room, key and data dir. Writes NEKKO_ITEST_* (and the
# pairing link) to the env file given as $1, plus the PIDs to stop it:
#   apps/ios/scripts/itest-stack.sh /tmp/stack.env && . /tmp/stack.env
#   ... kill $NEKKO_ITEST_PIDS
# Needs Node and a root build of shared, core, host, cli, server and relay.
set -euo pipefail
out="${1:?usage: itest-stack.sh <env-file>}"
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
logs="${NEKKO_ITEST_LOGS:-$(mktemp -d)}"
mkdir -p "$logs"

nohup node apps/android/scripts/fake-model.mjs "$model_port" >"$logs/model.log" 2>&1 &
model_pid=$!
NEKKO_RELAY_PORT="$relay_port" NEKKO_RELAY_HOST=127.0.0.1 NEKKO_RELAY_ALLOW_UNAUTHENTICATED=1 \
  nohup node apps/relay/dist/index.js >"$logs/relay.log" 2>&1 &
relay_pid=$!
sleep 1
cat >"$data/settings.json" <<JSON
{"providers":[{"id":"fake","kind":"openai-compat","label":"Fake","baseUrl":"http://127.0.0.1:$model_port/v1","apiKey":"sk-should-never-reach-the-phone","enabled":true}],
 "defaultProviderId":"fake","defaultModelId":"fake-model","phoneChanges":true}
JSON
# The agent runs in its data dir, so files the fake model writes land there, not in the repo.
(cd "$data" && NEKKO_RELAY_URL="ws://127.0.0.1:$relay_port" NEKKO_ROOM="$room" NEKKO_PAIR_KEY="$key" NEKKO_DATA_DIR="$data" NEKKO_AGENT_LOOP=ts \
  exec nohup node "$root/apps/server/dist/index.js" >"$logs/agent.log" 2>&1) &
agent_pid=$!
pair=""
for _ in $(seq 150); do
  pair="$(grep -oE 'pairing code \(10 min\): [A-Z2-9]+' "$logs/agent.log" | head -n1 | awk '{print $NF}' || true)"
  [ -n "$pair" ] && break
  sleep 0.1
done
if [ -z "$pair" ]; then
  echo "agent printed no pairing code:" >&2
  cat "$logs/agent.log" >&2
  kill "$model_pid" "$relay_pid" "$agent_pid" 2>/dev/null || true
  exit 1
fi
cat >"$out" <<ENV
export NEKKO_ITEST_RELAY="ws://127.0.0.1:$relay_port"
export NEKKO_ITEST_ROOM="$room"
export NEKKO_ITEST_KEY="$key"
export NEKKO_ITEST_PAIR="$pair"
export NEKKO_ITEST_LINK="nekko-agent-pair:?relay=ws%3A%2F%2Flocalhost%3A$relay_port&room=$room&key=$key&pair=$pair"
export NEKKO_ITEST_PIDS="$model_pid $relay_pid $agent_pid"
export NEKKO_ITEST_LOGDIR="$logs"
ENV
echo "stack up: relay :$relay_port, model :$model_port, logs $logs"
