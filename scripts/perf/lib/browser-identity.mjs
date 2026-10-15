import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'node:net';

export async function assertPortFree(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export function selectOwner(rows, bin, profile, port) {
  const norm = (value) => resolve(value).toLowerCase();
  const owners = rows.filter((p) => p.ExecutablePath && norm(p.ExecutablePath) === norm(bin) &&
    p.CommandLine?.includes(`--user-data-dir="${profile}"`) &&
    new RegExp(`--remote-debugging-port=${port}(?:\\s|$)`).test(p.CommandLine) &&
    p.CommandLine.includes('--headless=new') && !p.CommandLine.includes('--type='));
  const ids = [...new Set(owners.map((p) => p.ProcessId))];
  if (ids.length !== 1) throw new Error('CDP listener does not match the requested executable and fresh profile');
  return ids[0];
}

export function windowsOwner(bin, profile, port) {
  const script = `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | ForEach-Object { Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.OwningProcess) } | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  }).toString());
  return selectOwner(Array.isArray(rows) ? rows : [rows], bin, profile, port);
}

export function selectPage(targets, marker, port) {
  const page = targets.find((t) => t.type === 'page' && t.url === marker);
  const url = page && new URL(page.webSocketDebuggerUrl);
  if (!url || url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== String(port) || !/^\/devtools\/page\/[^/]+$/.test(url.pathname)) {
    throw new Error('CDP page does not match this launch marker and local port');
  }
  return page;
}

export function wrapperFailed(exited) {
  return exited && (exited.code !== 0 || exited.signal !== null);
}
