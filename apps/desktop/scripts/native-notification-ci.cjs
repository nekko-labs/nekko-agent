// Never run this on a local or self-hosted desktop. No mocked toast or page capture.
require('./notification-integration-safety.cjs').assertDisposableWindowsCI();
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const out = path.resolve(process.argv[2] || 'native-notification-results');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nekko-native-ci-'));
const marker = 'Nekko native CI ' + process.env.GITHUB_RUN_ID;
const env = { ...process.env, NEKKO_NATIVE_CI_OUT: out, NEKKO_NATIVE_CI_PROFILE: profile, NEKKO_NATIVE_CI_MARKER: marker };
delete env.ELECTRON_RUN_AS_NODE;
// Capture the real composed desktop and query OS accessibility text independently.
// Missing UIA text or blank screenshots are limitations, not substituted evidence.
const ps = String.raw`
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
$rows = @()
for ($i=0; $i -lt 18; $i++) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap($bounds.Width,$bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)
    $bitmap.Save((Join-Path $env:NEKKO_NATIVE_CI_OUT ('desktop-{0:D2}.png' -f $i)))
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
  try {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$env:NEKKO_NATIVE_CI_MARKER)
    $elements = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
    foreach ($element in $elements) {
      $c = $element.Current
      $rows += [pscustomobject]@{ frame=$i; name=$c.Name; processId=$c.ProcessId; className=$c.ClassName; isOffscreen=$c.IsOffscreen; bounds=$c.BoundingRectangle.ToString() }
    }
  } catch { $rows += [pscustomobject]@{ frame=$i; error=$_.Exception.Message } }
  Start-Sleep -Milliseconds 700
}
ConvertTo-Json -Depth 5 -InputObject @($rows) | Set-Content (Join-Path $env:NEKKO_NATIVE_CI_OUT 'os-uia.json')
`;
async function main() {
  let child, capture;
  try {
    capture = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const captureExit = new Promise((resolve, reject) => { capture.once('error', reject); capture.once('exit', resolve); });
    const captureLog = fs.createWriteStream(path.join(out, 'capture.log'));
    capture.stdout.pipe(captureLog, { end: false }); capture.stderr.pipe(captureLog, { end: false });
    child = cp.spawn(require('electron'), [path.join(__dirname, 'native-notification-ci-sandbox.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(out, 'execution.log'));
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => { for (const process of [child, capture]) if (process?.exitCode === null) cp.spawnSync('taskkill', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true }); }, 45000);
    let code, captureCode;
    try {
      code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      captureCode = await captureExit;
    } finally { clearTimeout(timer); log.end(); captureLog.end(); }
    const result = JSON.parse(fs.readFileSync(path.join(out, 'electron-result.json'), 'utf8'));
    const uia = captureCode === 0 ? JSON.parse(fs.readFileSync(path.join(out, 'os-uia.json'), 'utf8').replace(/^\uFEFF/, '')) : [];
    result.osVisibleMarkerObserved = uia.some(row => row.name === marker && row.isOffscreen === false);
    result.captureExitCode = captureCode;
    result.visibleToastVerified = false;
    result.limitations.push(result.osVisibleMarkerObserved ? 'OS accessibility found the visible marker; raw frames still require inspection to prove toast appearance.' : 'No visible OS accessibility marker found. Runner may lack an interactive shell or permit delivery without a banner.');
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    if (code !== 0 || captureCode !== 0 || !result.showObserved) throw Error('Native delivery/capture failed; inspect uploaded results');
    console.log('Real Electron show event observed. Visual toast and click/focus remain unverified; inspect CI artifact.');
  } finally {
    for (const process of [child, capture]) if (process?.pid && process.exitCode === null) cp.spawnSync('taskkill', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true });
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    fs.writeFileSync(path.join(out, 'cleanup.json'), JSON.stringify({ profileRemoved: !fs.existsSync(profile) }, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
