param([ValidateSet('baseline','toast','focus')][string]$Action, [string]$Out, [string]$Marker, [string]$Handle)
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
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
function Elements {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}
try {
  @{ sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId; userInteractive = [Environment]::UserInteractive; sessionName = $env:SESSIONNAME; action = $Action } | ConvertTo-Json | Set-Content (Join-Path $Out "$Action-desktop.json")
  Capture "$Action-before"
  if (-not [Environment]::UserInteractive) { throw 'Noninteractive hosted service desktop; actual toast acceptance unsupported.' }
  if ($Action -eq 'toast') {
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
