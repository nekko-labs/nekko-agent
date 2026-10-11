import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRunningApp, splitCommand, stopApp, type ProcInfo } from './app-control.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

function root(link: object) {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-ctl-'));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cli-link.json'), JSON.stringify(link));
  return dir;
}

// Shape of a packaged app: window process -> GPU/renderer helpers + engine child.
const packaged: ProcInfo[] = [
  { pid: 10, ppid: 1, name: 'explorer.exe' },
  { pid: 100, ppid: 10, name: 'NekkoAgent.exe', exe: 'C:\\Apps\\Nekko Agent\\NekkoAgent.exe', cmd: '"C:\\Apps\\Nekko Agent\\NekkoAgent.exe" nekko-agent://chat/new' },
  { pid: 101, ppid: 100, name: 'NekkoAgent.exe' },
  { pid: 102, ppid: 100, name: 'nekkod.exe' },
  { pid: 103, ppid: 102, name: 'NekkoAgent.exe' },
  { pid: 200, ppid: 10, name: 'node.exe' },
];

describe('findRunningApp', () => {
  it('walks from the pid in cli-link.json up to the window process and collects the whole tree', () => {
    const dir = root({ enabled: true, pid: 103 });
    const app = findRunningApp([dir], packaged, () => true)!;
    expect(app.main.pid).toBe(100);
    expect(app.pids.sort()).toEqual([100, 101, 102, 103]);
    expect(app.relaunch).toEqual({ exe: 'C:\\Apps\\Nekko Agent\\NekkoAgent.exe', args: ['nekko-agent://chat/new'] });
  });

  it('never climbs into the shell or tool that launched the app', () => {
    const procs: ProcInfo[] = [
      { pid: 5, ppid: 1, name: 'node.exe', cmd: 'electron-vite dev' },
      { pid: 6, ppid: 5, name: 'electron.exe', exe: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe', cmd: 'electron .' },
      { pid: 7, ppid: 6, name: 'nekkod.exe' },
      { pid: 8, ppid: 7, name: 'electron.exe' },
    ];
    const app = findRunningApp([root({ enabled: true, pid: 8 })], procs, () => true)!;
    expect(app.main.pid).toBe(6);
    expect(app.pids).not.toContain(5);
    expect(app.relaunch).toBeUndefined();
  });

  it('is null when nothing is serving, the pid is dead, or it is not one of ours', () => {
    expect(findRunningApp([root({ enabled: false, pid: 100 })], packaged, () => true)).toBeNull();
    expect(findRunningApp([root({ enabled: true, pid: 100 })], packaged, () => false)).toBeNull();
    expect(findRunningApp([root({ enabled: true, pid: 200 })], packaged, () => true)).toBeNull();
    expect(findRunningApp([join(tmpdir(), 'no-such-nekko-dir')], packaged, () => true)).toBeNull();
  });
});

describe('stopApp', () => {
  const app = { main: packaged[1], pids: [100, 101, 102, 103] };

  it('asks politely first and does not force a process that exits', async () => {
    const live = new Set(app.pids); const sent: Array<[number, boolean]> = [];
    const result = await stopApp(app, { graceMs: 2000, alive: (p) => live.has(p), signal: (p, hard) => { sent.push([p, hard]); live.clear(); } });
    expect(result.graceful).toBe(true);
    expect(sent).toEqual([[100, false]]);
  });

  it('force-closes what is still there after the grace period', async () => {
    const live = new Set(app.pids); const sent: Array<[number, boolean]> = [];
    const result = await stopApp(app, { graceMs: 300, alive: (p) => live.has(p), signal: (p, hard) => { sent.push([p, hard]); if (hard) live.delete(p); } });
    expect(result.graceful).toBe(false);
    expect(sent[0]).toEqual([100, false]);
    expect(sent.filter(([, hard]) => hard).map(([p]) => p).sort()).toEqual([100, 101, 102, 103]);
  });

  it('reports a process that will not die', async () => {
    await expect(stopApp(app, { graceMs: 50, hardMs: 100, alive: () => true, signal: () => {} })).rejects.toThrow('Could not close');
  });
});

describe('splitCommand', () => {
  it('keeps quoted paths with spaces together', () => {
    expect(splitCommand('"C:\\Program Files\\Nekko\\n.exe" --flag "a b" c')).toEqual(['C:\\Program Files\\Nekko\\n.exe', '--flag', 'a b', 'c']);
  });
});
