import { execFile } from 'node:child_process';

/**
 * Windows-only fallback for a window screenshot that Windows Graphics Capture
 * refused (`NotReadableError`, E_ACCESSDENIED in the console). Some ordinary,
 * same-privilege windows refuse WGC (Windows Terminal is one), while GDI's
 * `PrintWindow` with PW_RENDERFULLCONTENT still renders them in the background
 * without raising, restoring or focusing anything.
 *
 * It never weakens a refusal that is deliberate:
 *  - a window that asked not to be captured (`SetWindowDisplayAffinity`
 *    WDA_MONITOR / WDA_EXCLUDEFROMCAPTURE: password managers, DRM players) is
 *    refused, not returned as a black frame;
 *  - a window this process cannot open (elevated above us) is refused;
 *  - a minimized window is refused rather than restored;
 *  - a frame that comes back a single flat colour is treated as a failure.
 *
 * No native module (the stack forbids them): Win32 is reached through a short
 * PowerShell script, run hidden, with the window handle as its only input and
 * the PNG returned on stdout as base64.
 */

/** `window:<hwnd>:<n>`, the id desktopCapturer gives a window source. */
export function hwndFromSourceId(id: string): string | null {
  const m = /^window:(\d+):\d+$/.exec(id);
  return m && m[1] !== '0' ? m[1] : null;
}

export type PrintWindowResult =
  | { ok: true; data: string; width: number; height: number }
  | { ok: false; reason: 'excluded' | 'minimized' | 'denied' | 'gone' | 'blank' | 'failed'; message: string };

/** What each refusal tells the agent. None of them restore or focus the window. */
export const REFUSAL: Record<Exclude<PrintWindowResult, { ok: true }>['reason'], string> = {
  excluded: 'The selected window asks Windows not to be captured (display affinity); it was not captured',
  minimized: 'The selected window is minimized; it was not restored, so there is no frame to capture',
  denied: 'The OS refused to capture the selected window; it runs elevated or is protected',
  gone: 'Selected window disappeared; list windows again',
  blank: 'The selected window rendered an empty frame in the background; no window was restored or focused',
  failed: 'The OS refused to capture the selected window; the background fallback could not render it either',
};

/** The PowerShell side. `$args[0]` is the decimal HWND. Prints one JSON line. */
export const PRINT_WINDOW_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace NekkoCapture -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(System.IntPtr h, out uint a);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);
[DllImport("user32.dll")] public static extern bool PrintWindow(System.IntPtr h, System.IntPtr dc, uint flags);
[DllImport("kernel32.dll")] public static extern System.IntPtr OpenProcess(uint access, bool inherit, uint pid);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(System.IntPtr h);
public struct RECT { public int L, T, R, B; }
'@
function Out($o) { [Console]::Out.Write(($o | ConvertTo-Json -Compress)); exit 0 }
$h = [IntPtr][long]$args[0]
if (-not [NekkoCapture.W]::IsWindow($h)) { Out @{ ok = $false; reason = 'gone' } }
if ([NekkoCapture.W]::IsIconic($h)) { Out @{ ok = $false; reason = 'minimized' } }
$aff = [uint32]0
if ([NekkoCapture.W]::GetWindowDisplayAffinity($h, [ref]$aff) -and $aff -ne 0) { Out @{ ok = $false; reason = 'excluded' } }
$procId = [uint32]0
[void][NekkoCapture.W]::GetWindowThreadProcessId($h, [ref]$procId)
# PROCESS_QUERY_LIMITED_INFORMATION: fails for a process elevated above us.
$ph = [NekkoCapture.W]::OpenProcess(0x1000, $false, $procId)
if ($ph -eq [IntPtr]::Zero) { Out @{ ok = $false; reason = 'denied' } }
[void][NekkoCapture.W]::CloseHandle($ph)
$r = New-Object NekkoCapture.W+RECT
[void][NekkoCapture.W]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
if ($w -le 0 -or $ht -le 0 -or $w -gt 16384 -or $ht -gt 16384) { Out @{ ok = $false; reason = 'blank' } }
$bmp = New-Object System.Drawing.Bitmap $w, $ht
try {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  $printed = [NekkoCapture.W]::PrintWindow($h, $dc, 2)
  $g.ReleaseHdc($dc); $g.Dispose()
  if (-not $printed) { Out @{ ok = $false; reason = 'failed' } }
  $seen = @{}
  $sx = [Math]::Max(1, [int]($w / 24)); $sy = [Math]::Max(1, [int]($ht / 24))
  for ($x = 0; $x -lt $w; $x += $sx) { for ($y = 0; $y -lt $ht; $y += $sy) { $seen[$bmp.GetPixel($x, $y).ToArgb()] = 1 } }
  if ($seen.Count -le 1) { Out @{ ok = $false; reason = 'blank' } }
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  Out @{ ok = $true; width = $w; height = $ht; data = [Convert]::ToBase64String($ms.ToArray()) }
} finally { $bmp.Dispose() }
`;

type Exec = (file: string, args: string[], options: { windowsHide: boolean; timeout: number; maxBuffer: number }, cb: (error: Error | null, stdout: string) => void) => void;

/** Render one window with PrintWindow. Resolves a result; never throws for a refusal. */
export function printWindowCapture(hwnd: string, run: Exec = execFile as unknown as Exec): Promise<PrintWindowResult> {
  if (process.platform !== 'win32' || !/^\d+$/.test(hwnd)) return Promise.resolve({ ok: false, reason: 'failed', message: REFUSAL.failed });
  return new Promise((resolve) => {
    run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& {${PRINT_WINDOW_SCRIPT}} ${hwnd}`],
      { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        let parsed: { ok?: boolean; reason?: keyof typeof REFUSAL; data?: string; width?: number; height?: number } | null = null;
        try { parsed = JSON.parse(String(stdout).trim()); } catch { parsed = null; }
        if (parsed?.ok && parsed.data && parsed.width && parsed.height) {
          resolve({ ok: true, data: parsed.data, width: parsed.width, height: parsed.height });
          return;
        }
        const reason = parsed && !parsed.ok && parsed.reason && parsed.reason in REFUSAL ? parsed.reason : 'failed';
        void error;
        resolve({ ok: false, reason, message: REFUSAL[reason] });
      },
    );
  });
}
