const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, 'notification-native-ci-desktop.ps1'), 'utf8');

function extract(name, next) {
  return source.slice(source.indexOf(`function ${name} {`), source.indexOf(`function ${next}`));
}

test('Center shortcut stays behind strict gate and releases both keys; no setup coordinates', () => {
  const toggle = source.slice(source.indexOf('function CenterKeyboard('), source.indexOf('function OpenNotificationCenter'));
  assert.ok(source.indexOf("throw 'Refusing desktop") < source.indexOf('Add-Type'));
  assert.ok(toggle.includes('finally {'));
  for (const key of ['0x4E', '0x5B']) {
    assert.ok(toggle.includes(`keybd_event(${key}, 0, 0,`));
    assert.ok(toggle.includes(`keybd_event(${key}, 0, 2,`));
  }
  const center = source.slice(source.indexOf('function CenterKeyboard'), source.indexOf('function DndControl'));
  for (const unsafe of ['SetCursorPos', 'mouse_event', 'FromPoint', 'Automation]::Compare']) assert.ok(!center.includes(unsafe));
  assert.ok(center.includes("Capture 'setup-center-keyboard'"));
});

test('Actual PowerShell center orchestration requires DND evidence after mocked shortcut', { skip: process.platform !== 'win32' }, () => {
  // Only extracted orchestration functions execute. No helper, UIA, assemblies or OS input.
  const script = `
$ErrorActionPreference = 'Stop'
function RecordCenterAttempt {}
function RecordUia {}
function Capture {}
function NotificationCenterButton { return 'fake button' }
function InvokeElement {}
function DndControl { return $script:existing }
function WaitDndControl { $script:waits++; if ($script:waits -eq 2) { return $script:observed }; return $null }
function CenterKeyboard { $script:shortcuts++ }
${extract('OpenNotificationCenter', 'CloseNotificationCenter')}
$script:existing = $null
$script:observed = @{ state = 'Off'; source = 'fake explicit control' }
$script:waits = 0; $script:shortcuts = 0
$result = OpenNotificationCenter
if ($result.state -ne 'Off' -or $script:shortcuts -ne 1) { throw 'Shortcut success was not evidence-gated' }
$script:observed = $null; $script:waits = 0; $script:shortcuts = 0
$failed = $false
try { OpenNotificationCenter } catch { $failed = $_.Exception.Message -like '*did not expose an explicit DND control*' }
if (-not $failed -or $script:shortcuts -ne 1) { throw 'Missing control did not fail closed' }
$script:existing = @{ state = 'On'; source = 'fake existing control' }
$script:shortcuts = 0
$result = OpenNotificationCenter
if ($result.state -ne 'On' -or $script:shortcuts -ne 0) { throw 'Existing panel was blindly toggled' }
Write-Output 'mock center checks passed'
`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr || String(run.error));
  assert.match(run.stdout, /mock center checks passed/);
});
