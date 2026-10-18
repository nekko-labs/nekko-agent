# Isolated six-second, no-profile diagnostic controls. Never writes production outputs.
$ErrorActionPreference = 'Stop'
$root = Get-Location
$evidence = Join-Path $root '.shots/perf-investigation/narrow-controls'
New-Item -ItemType Directory -Force $evidence | Out-Null
$env:PERF_BROWSER = Join-Path $root '.shots/perf-investigation/browsers/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'
$env:NEKKO_RENDERER_DIR = Join-Path $root '.shots/perf-investigation/current-renderer'
$backend = 'C:/Users/phili/code/nekko-agent/apps/web-app-server/dist'
function Save-BackendHashes($name) {
  Get-ChildItem $backend -Recurse -File | Sort-Object FullName | ForEach-Object {
    [PSCustomObject]@{ path = $_.FullName; sha256 = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($_.FullName)))).Replace('-', '') }
  } | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $evidence $name)
}
Save-BackendHashes 'backend-before.json'
$common = @('scripts/perf/run.mjs', '--app', 'C:/Users/phili/code/nekko-agent', '--only', 'frames', '--timeline', '--scheduling', '--report-only', '--app-port', '4492', '--mock-port', '4491', '--cdp-port', '9491')
# Reverse the two ablations on the second block to limit order confounding.
foreach ($run in @('baseline-1', 'context-1', 'rocket-1', 'baseline-2', 'rocket-2', 'context-2')) {
  $extra = @()
  if ($run.StartsWith('context')) { $extra += @('--extra-css', 'scripts/perf/investigation-context-off.css') }
  if ($run.StartsWith('rocket')) { $extra += @('--extra-css', 'scripts/perf/investigation-rocket-off.css') }
  & node @common @extra --out ".shots/perf-investigation/narrow-controls/$run" 2>&1 | Tee-Object -FilePath (Join-Path $evidence "$run.log")
  if ($LASTEXITCODE -ne 0) { throw "Diagnostic run failed: $run" }
  & node scripts/perf/analyze-stream-trace.mjs ".shots/perf-investigation/narrow-controls/$run/streaming.trace.json" > (Join-Path $evidence "$run-analysis.log")
  if ($LASTEXITCODE -ne 0) { throw "Analysis failed: $run" }
}
Save-BackendHashes 'backend-after.json'
if ((Get-Content (Join-Path $evidence 'backend-before.json') -Raw) -ne (Get-Content (Join-Path $evidence 'backend-after.json') -Raw)) { throw 'Backend changed during controls' }
