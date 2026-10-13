param([ValidateSet('baseline','setup','toast','focus')][string]$Action, [string]$Out, [string]$Marker, [string]$Handle)
$ErrorActionPreference = 'Stop'
# Independent gate before loading UI Automation, capturing pixels, or sending input.
if ($env:CI -cne 'true' -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:NEKKO_NATIVE_NOTIFICATION_CI -cne 'disposable-desktop' -or -not $env:GITHUB_RUN_ID -or -not $env:GITHUB_WORKSPACE) {
  throw 'Refusing desktop access outside explicitly opted-in disposable hosted Windows CI.'
}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Drawing,System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ToastDesktop {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
function Capture([string]$Name) {
  $rect = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $rect.Size)
    $bitmap.Save((Join-Path $Out "$Name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    @{ capturedAt = (Get-Date).ToUniversalTime().ToString('o'); virtualScreen = @{ left = $rect.Left; top = $rect.Top; width = $rect.Width; height = $rect.Height }; foregroundHandle = [ToastDesktop]::GetForegroundWindow().ToInt64().ToString(); sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Out "$Name-capture.json")
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
function Elements {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}
function RecordUia([string]$Name) {
  @(Elements | ForEach-Object { @{ name = $_.Current.Name; class = $_.Current.ClassName; automationId = $_.Current.AutomationId; offscreen = $_.Current.IsOffscreen; bounds = $_.Current.BoundingRectangle.ToString(); supportedPatterns = @($_.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) } }) | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Out "$Name-uia.json")
}
function NotificationCenterButton {
  $buttons = @(Elements | Where-Object { $_.Current.AutomationId -eq 'SystemTrayIcon' -and $_.Current.Name -like 'Notifications*' -and -not $_.Current.IsOffscreen })
  if ($buttons.Count -ne 1) { throw 'Cannot uniquely identify the hosted Windows notification center button.' }
  return $buttons[0]
}
function InvokeElement($Element) {
  $pattern = $null
  if (-not $Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw 'Hosted notification control does not support UIA InvokePattern.' }
  $pattern.Invoke()
}
# A successful UIA call is not evidence that the shell opened a panel.
$script:CenterAttempts = @()
function RecordCenterAttempt([string]$Method, [string]$Outcome, $Details) {
  $script:CenterAttempts += @{ method = $Method; outcome = $Outcome; details = $Details; at = (Get-Date).ToUniversalTime().ToString('o') }
  $script:CenterAttempts | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Out 'setup-center-attempts.json')
}
function ClickCenterButton {
  # Reacquire rather than trusting a stale rectangle from the failed Invoke.
  $button = NotificationCenterButton
  $rect = $button.Current.BoundingRectangle
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if (-not $button.Current.IsEnabled -or $rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0 -or $rect.Left -lt $screen.Left -or $rect.Top -lt $screen.Top -or $rect.Right -gt $screen.Right -or $rect.Bottom -gt $screen.Bottom) {
    throw 'Notification center button has no safe visible screen rectangle.'
  }
  $x = [int][Math]::Floor($rect.Left + $rect.Width / 2)
  $y = [int][Math]::Floor($rect.Top + $rect.Height / 2)
  $hit = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new($x, $y))
  $verified = $false
  for ($depth = 0; $hit -and $depth -lt 8; $depth++) {
    if ([System.Windows.Automation.Automation]::Compare($hit, $button)) { $verified = $true; break }
    $hit = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($hit)
  }
  if (-not $verified) { throw 'Notification center button center is obscured or UIA hit target differs; refusing OS click.' }
  RecordCenterAttempt 'OS mouse' 'verified target' @{ name = $button.Current.Name; bounds = $rect.ToString(); x = $x; y = $y }
  if (-not [ToastDesktop]::SetCursorPos($x, $y)) { throw 'Cannot position cursor on notification center button.' }
  [ToastDesktop]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [ToastDesktop]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}
function WaitDndControl {
  $deadline = (Get-Date).AddSeconds(5)
  do {
    $control = DndControl -Optional
    if ($control) { return $control }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $null
}
function OpenNotificationCenter {
  $control = DndControl -Optional
  if ($control) { RecordCenterAttempt 'existing panel' 'explicit control observed' $control.source; return $control }
  try {
    InvokeElement (NotificationCenterButton)
    RecordCenterAttempt 'UIA InvokePattern' 'call returned, open unproven' $null
  } catch {
    RecordCenterAttempt 'UIA InvokePattern' 'unsupported or failed' ($_ | Out-String)
  }
  $control = WaitDndControl
  RecordUia 'setup-center-invoke'
  Capture 'setup-center-invoke'
  if ($control) { RecordCenterAttempt 'UIA InvokePattern' 'explicit control observed' $control.source; return $control }
  RecordCenterAttempt 'UIA InvokePattern' 'no explicit control after timeout' $null
  ClickCenterButton
  $control = WaitDndControl
  RecordUia 'setup-center-mouse'
  Capture 'setup-center-mouse'
  if (-not $control) { throw 'Notification center did not expose an explicit DND control after UIA invoke and verified OS click; refusing to send a toast.' }
  RecordCenterAttempt 'OS mouse' 'explicit control observed' $control.source
  return $control
}
function CloseNotificationCenter {
  if (-not (DndControl -Optional)) { return }
  ClickCenterButton
  $deadline = (Get-Date).AddSeconds(5)
  do {
    Start-Sleep -Milliseconds 250
    if (-not (DndControl -Optional)) { RecordCenterAttempt 'close' 'DND control no longer visible' $null; return }
  } while ((Get-Date) -lt $deadline)
  throw 'Notification center remained open after verified OS click.'
}
function DndControl([switch]$Optional) {
  $controls = @(Elements | Where-Object { $_.Current.Name -match '^(Do not disturb|Turn (on|off) do not disturb)' -and -not $_.Current.IsOffscreen })
  foreach ($control in $controls) {
    $pattern = $null
    if ($control.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
      return @{ element = $control; pattern = $pattern; state = $pattern.Current.ToggleState.ToString(); source = 'TogglePattern' }
    }
    # Windows builds may expose an action button rather than TogglePattern.
    if ($control.Current.Name -match '^Turn (on|off) do not disturb$') {
      return @{ element = $control; pattern = $null; state = $(if ($Matches[1] -eq 'on') { 'Off' } else { 'On' }); source = 'explicit action label' }
    }
  }
  if ($Optional) { return $null }
  throw 'No explicit DND state available from notification center UIA; refusing to assume delivery is allowed.'
}
function SetupNotifications {
  RecordUia 'setup-before'
  try {
    $before = OpenNotificationCenter
    RecordUia 'setup-center-before'
    Capture 'setup-center-before'
    @{ dnd = $before.state; source = $before.source } | ConvertTo-Json | Set-Content (Join-Path $Out 'setup-state-before.json')
    if ($before.state -eq 'On') {
      if ($before.pattern) { $before.pattern.Toggle() } else { InvokeElement $before.element }
    } elseif ($before.state -ne 'Off') { throw 'DND state is indeterminate; refusing to send a toast.' }
    $deadline = (Get-Date).AddSeconds(5)
    do {
      Start-Sleep -Milliseconds 250
      $after = DndControl -Optional
    } while ((-not $after -or $after.state -ne 'Off') -and (Get-Date) -lt $deadline)
    if (-not $after) { throw 'DND control disappeared before an explicit off state was verified.' }
    RecordUia 'setup-center-after'
    Capture 'setup-center-after'
    @{ dnd = $after.state; source = $after.source; deliveryAllowed = ($after.state -eq 'Off'); scope = 'DND prerequisite only, actual delivery still requires visible toast UIA evidence' } | ConvertTo-Json | Set-Content (Join-Path $Out 'setup-state-after.json')
    if ($after.state -ne 'Off') { throw 'DND remains enabled; notification delivery prerequisite failed.' }
  } finally {
    # Do not blindly toggle a panel that never opened or hide the original blocker.
    try { CloseNotificationCenter } catch {
      $_ | Out-String | Set-Content (Join-Path $Out 'setup-center-close-blocker.txt')
      if ($after -and $after.state -eq 'Off') { throw }
    }
  }
  Start-Sleep -Milliseconds 250
  RecordUia 'setup-after'
  Capture 'setup-after'
  if ((NotificationCenterButton).Current.Name -match 'Do not disturb on') { throw 'DND re-enabled after closing notification center; refusing to send a toast.' }
}
try {
  @{ sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId; userInteractive = [Environment]::UserInteractive; sessionName = $env:SESSIONNAME; action = $Action } | ConvertTo-Json | Set-Content (Join-Path $Out "$Action-desktop.json")
  Capture "$Action-before"
  if (-not [Environment]::UserInteractive) { throw 'Noninteractive hosted service desktop; actual toast acceptance unsupported.' }
  if ($Action -eq 'setup') {
    SetupNotifications
  } elseif ($Action -eq 'toast') {
    $deadline = (Get-Date).AddSeconds(20)
    $match = $null
    do {
      $items = Elements
      foreach ($item in $items) {
        if ($item.Current.Name -ceq $Marker -and -not $item.Current.IsOffscreen -and $item.Current.BoundingRectangle.Width -gt 0 -and $item.Current.BoundingRectangle.Height -gt 0) { $match = $item; break }
      }
      if (-not $match) { Start-Sleep -Milliseconds 250 }
    } while (-not $match -and (Get-Date) -lt $deadline)
    @($items | ForEach-Object { @{ name = $_.Current.Name; class = $_.Current.ClassName; automationId = $_.Current.AutomationId; offscreen = $_.Current.IsOffscreen; bounds = $_.Current.BoundingRectangle.ToString() } }) | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Out 'toast-uia.json')
    Capture 'toast-delivery'
    if (-not $match) { throw 'Unique toast text not visible in Windows UI Automation. Electron show alone is insufficient; hosted desktop delivery is unproven.' }
    $rect = $match.Current.BoundingRectangle
    @{ marker = $match.Current.Name; bounds = $rect.ToString(); input = 'OS mouse click at visible UIA text center' } | ConvertTo-Json | Set-Content (Join-Path $Out 'toast-click.json')
    [void][ToastDesktop]::SetCursorPos([int]($rect.Left + $rect.Width / 2), [int]($rect.Top + $rect.Height / 2))
    [ToastDesktop]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    [ToastDesktop]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    Capture 'toast-after-click'
  } elseif ($Action -eq 'focus') {
    $actual = [ToastDesktop]::GetForegroundWindow().ToInt64().ToString()
    @{ expectedHandle = $Handle; foregroundHandle = $actual } | ConvertTo-Json | Set-Content (Join-Path $Out 'focus-handle.json')
    Capture 'focus-after-click'
    if ($actual -ne $Handle) { throw "OS foreground window mismatch: expected $Handle got $actual" }
  }
} catch {
  $_ | Out-String | Set-Content (Join-Path $Out "$Action-blocker.txt")
  try { Capture "$Action-failure" } catch { $_ | Out-String | Set-Content (Join-Path $Out "$Action-capture-blocker.txt") }
  throw
}
