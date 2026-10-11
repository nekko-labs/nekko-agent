import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_LINK_FILE } from '@nekko-agent/shared';

/**
 * Closing and reopening the desktop app from outside it, for `nekko-agent
 * migrate` run in a terminal.
 *
 * The app has no remote "quit" (the engine process is separate from the window
 * process that owns quitting), so this works on the process tree: the pid the
 * app recorded in `cli-link.json`, then up through ancestors that are still the
 * app, to the window process. Only processes whose image name looks like
 * Nekko/Electron are ever touched; a shell or an editor that launched the app
 * is left alone.
 */

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  exe?: string;
  cmd?: string;
}

export interface RunningApp {
  /** The process that owns the window; closing it takes the rest down. */
  main: ProcInfo;
  /** Every pid in the app's tree, children first. */
  pids: number[];
  /** How to start it again, or undefined for a development checkout, which the developer's own launcher restarts. */
  relaunch?: { exe: string; args: string[] };
}

const APP_NAME = /^(electron|nekko ?agent|nekkoagent|nekkod)(\.exe)?$/i;

export function listProcesses(): ProcInfo[] {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const rows = JSON.parse(out || '[]') as Array<{ ProcessId: number; ParentProcessId: number; Name: string; ExecutablePath?: string; CommandLine?: string }>;
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, exe: r.ExecutablePath ?? undefined, cmd: r.CommandLine ?? undefined }));
  }
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), name: m[3].split('/').pop()!, cmd: m[4] }] : [];
  });
}

/** Split a Windows or POSIX command line the way a shell would, enough for `exe "arg one" arg2`. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(cmd); m; m = re.exec(cmd)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const isDevElectron = (p: ProcInfo): boolean => /node_modules[\\/]electron[\\/]dist/i.test(p.exe ?? p.cmd ?? '');

export function findRunningApp(dataRoots: string[], procs: ProcInfo[] = listProcesses(), alive: (pid: number) => boolean = isAlive): RunningApp | null {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let seed: number | undefined;
  for (const root of dataRoots) {
    try {
      const link = JSON.parse(readFileSync(join(root, CLI_LINK_FILE), 'utf8')) as { pid?: number; enabled?: boolean };
      if (link.enabled && link.pid && alive(link.pid) && byPid.has(link.pid)) { seed = link.pid; break; }
    } catch { /* no link here */ }
  }
  if (seed === undefined) return null;
  let main = byPid.get(seed)!;
  if (!APP_NAME.test(main.name)) return null;
  for (let parent = byPid.get(main.ppid); parent && APP_NAME.test(parent.name); parent = byPid.get(parent.ppid)) main = parent;
  const pids: number[] = [];
  const collect = (pid: number) => { for (const p of procs) if (p.ppid === pid && p.pid !== pid) collect(p.pid); pids.push(pid); };
  collect(main.pid);
  const exe = main.exe ?? main.name;
  const args = main.cmd ? splitCommand(main.cmd).slice(1) : [];
  return { main, pids, relaunch: isDevElectron(main) || !main.exe ? undefined : { exe, args } };
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Ask the app to close, then insist. On Windows `taskkill /T` without `/F`
 * posts a close to the windows, which runs the app's normal quit (the engine is
 * stopped cleanly and the CLI link is marked not serving); `/F` follows only
 * if the app is still there after `graceMs`.
 */
export async function stopApp(app: RunningApp, opts: { graceMs?: number; hardMs?: number; alive?: (pid: number) => boolean; signal?: (pid: number, hard: boolean) => void } = {}): Promise<{ graceful: boolean }> {
  const alive = opts.alive ?? isAlive;
  const signal = opts.signal ?? defaultSignal;
  const grace = opts.graceMs ?? 20_000;
  signal(app.main.pid, false);
  const deadline = Date.now() + grace;
  while (Date.now() < deadline && app.pids.some(alive)) await sleep(250);
  if (!app.pids.some(alive)) return { graceful: true };
  for (const pid of app.pids) if (alive(pid)) signal(pid, true);
  const hard = Date.now() + (opts.hardMs ?? 5_000);
  while (Date.now() < hard && app.pids.some(alive)) await sleep(100);
  if (app.pids.some(alive)) throw new Error(`Could not close Nekko Agent (still running: ${app.pids.filter(alive).join(', ')}).`);
  return { graceful: false };
}

function defaultSignal(pid: number, hard: boolean): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', ...(hard ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, hard ? 'SIGKILL' : 'SIGTERM');
  } catch { /* already gone */ }
}

/** Start the app again, detached from this terminal. */
export function startApp(relaunch: { exe: string; args: string[] }): void {
  const child = spawn(relaunch.exe, relaunch.args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}
