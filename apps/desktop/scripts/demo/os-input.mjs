// The real mouse and keyboard, so a screen recorder sees a real cursor glide
// and click (Recordly zooms on cursor activity). Windows only for now: one
// PowerShell process holds user32 and takes a command per line on stdin.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRELUDE = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class NekkoInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, int d, UIntPtr e);
}
"@
[NekkoInput]::SetProcessDPIAware() | Out-Null
while ($true) {
  $line = [Console]::In.ReadLine(); if ($line -eq $null) { break }
  $p = $line.Split(' ')
  switch ($p[0]) {
    'move'  { [NekkoInput]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null }
    'down'  { [NekkoInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero) }
    'up'    { [NekkoInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
    'wheel' { [NekkoInput]::mouse_event(0x800, 0, 0, [int]$p[1], [UIntPtr]::Zero) }
  }
  [Console]::Out.WriteLine('ok')
}
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** A real-cursor driver, or null where this platform has none yet. */
export function osInput() {
  if (process.platform !== 'win32') return null;
  // The script runs from a file so stdin carries only commands.
  const file = join(tmpdir(), 'nekko-demo-input.ps1');
  writeFileSync(file, PRELUDE);
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = [];
  let buf = '';
  ps.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line === 'ok') waiting.shift()?.(); }
  });
  const send = (cmd) => new Promise((r) => { waiting.push(r); ps.stdin.write(`${cmd}\r\n`); });
  let at = null;

  return {
    /** Glide from where the cursor is to (x, y) in physical pixels, eased, over `ms`. */
    async glide(x, y, ms = 700) {
      if (!at) { await send(`move ${x} ${y}`); at = { x, y }; return; }
      const from = at, steps = Math.max(12, Math.round(ms / 12));
      for (let s = 1; s <= steps; s++) {
        const t = ease(s / steps);
        await send(`move ${Math.round(from.x + (x - from.x) * t)} ${Math.round(from.y + (y - from.y) * t)}`);
        await sleep(ms / steps);
      }
      at = { x, y };
    },
    async click() { await send('down'); await sleep(70); await send('up'); },
    async wheel(delta) { await send(`wheel ${delta}`); },
    close() { ps.stdin.end(); },
  };
}
