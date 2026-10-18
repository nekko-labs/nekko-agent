#!/usr/bin/env sh
# Run the Nekko Agent relay on this computer, reachable only over your Tailscale network.
# See scripts/private-relay.ps1 for the rationale. Usage: scripts/private-relay.sh [port]
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
port="${1:-4400}"
ip="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
[ -n "$ip" ] || { echo 'Tailscale is not running on this computer. Start it (tailscale up) and retry.' >&2; exit 1; }
dns="$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write((JSON.parse(s).Self.DNSName||"").replace(/\.$/,"")))')"
[ -n "$dns" ] || dns="$ip"
[ -f "$root/apps/relay-server/dist/index.js" ] || npm run build -w @nekko-agent/relay-server --prefix "$root"
echo
echo "Relay URL for Settings > Remote access:  ws://$dns:$port"
echo "  (by address: ws://$ip:$port)  Phones need Tailscale on, same tailnet."
echo
NEKKO_RELAY_HOST="$ip" NEKKO_RELAY_PORT="$port" NEKKO_RELAY_ALLOW_UNAUTHENTICATED=1 exec node "$root/apps/relay-server/dist/index.js"
