# Captures the union of the given windows' rectangles (physical pixels, so the
# process is made DPI aware first) from the screen, optionally masking the
# navigation pane of a file dialog (it lists the user's own pinned folders),
# and saves it as PNG. Used by native-channels-integration.cjs.
param([string]$Out, [string]$Hwnds, [long]$MaskNavOf = 0, [double]$MaskFrac = 0.15)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class Cap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  public static RECT Bounds(long h) {
    RECT r;
    // DWMWA_EXTENDED_FRAME_BOUNDS: the visible frame, without the invisible resize border.
    if (DwmGetWindowAttribute(new IntPtr(h), 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(new IntPtr(h), out r);
    return r;
  }
}
'@
[void][Cap]::SetProcessDpiAwarenessContext([IntPtr](-4))  # PER_MONITOR_AWARE_V2
$rects = $Hwnds.Split(',') | Where-Object { $_ } | ForEach-Object { [Cap]::Bounds([long]$_) }
$l = ($rects | ForEach-Object { $_.L } | Measure-Object -Minimum).Minimum
$t = ($rects | ForEach-Object { $_.T } | Measure-Object -Minimum).Minimum
$r = ($rects | ForEach-Object { $_.R } | Measure-Object -Maximum).Maximum
$b = ($rects | ForEach-Object { $_.B } | Measure-Object -Maximum).Maximum
$l = [int]$l; $t = [int]$t; $w = [int]($r - $l); $h = [int]($b - $t)
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($l, $t, 0, 0, (New-Object System.Drawing.Size $w, $h))
if ($MaskNavOf -ne 0) {
  # The common item dialog's navigation pane: the left quarter below the
  # address bar and above the file-name row. Masked, and labelled so.
  $d = [Cap]::Bounds($MaskNavOf)
  $dw = $d.R - $d.L; $dh = $d.B - $d.T
  $x = [int]($d.L - $l); $y = [int]($d.T - $t + $dh * 0.13); $mw = [int]($dw * $MaskFrac); $mh = [int]($dh * 0.70)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 40, 40, 46))), $x, $y, $mw, $mh)
  $font = New-Object System.Drawing.Font 'Segoe UI', ([float]($mw / 14))
  $g.DrawString("pinned folders`nmasked", $font, [System.Drawing.Brushes]::Gainsboro, ($x + 12), ($y + 12))
}
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("{0}x{1} at {2},{3}" -f $w, $h, $l, $t)
