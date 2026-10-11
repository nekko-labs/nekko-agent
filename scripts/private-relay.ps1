# Run the Nekko Agent relay on this computer, reachable only over your Tailscale network.
#
# Why: the phone app talks to your computer through a relay. Instead of a hosted relay,
# this binds the relay to this machine's Tailscale address, so the only devices that can
# reach it are the ones on your tailnet. Traffic is WireGuard-encrypted by Tailscale and
# end-to-end encrypted by the app on top; the relay never sees content.
#
# Usage (from the repo root):   pwsh -File scripts/private-relay.ps1 [-Port 4400]
# Then paste the printed URL into Settings > Remote access, Enable, Pair a device.
param([int]$Port = 4400)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$ip = (& tailscale ip -4 2>$null | Select-Object -First 1)
if (-not $ip) { throw 'Tailscale is not running on this computer. Start it (tailscale up) and retry.' }
$self = (& tailscale status --json | ConvertFrom-Json).Self
$dns = if ($self.DNSName) { $self.DNSName.TrimEnd('.') } else { $ip }
$entry = Join-Path $root 'apps/relay/dist/index.js'
if (-not (Test-Path $entry)) { npm run build -w @nekko-agent/relay --prefix $root | Out-Host }
$env:NEKKO_RELAY_HOST = $ip
$env:NEKKO_RELAY_PORT = "$Port"
$env:NEKKO_RELAY_ALLOW_UNAUTHENTICATED = '1'   # safe: only tailnet devices can reach this bind address
Write-Host ''
Write-Host "Relay URL for Settings > Remote access:  ws://$dns`:$Port"
Write-Host "  (by address: ws://$ip`:$Port)  Phones need Tailscale on, same tailnet."
Write-Host ''
node $entry
