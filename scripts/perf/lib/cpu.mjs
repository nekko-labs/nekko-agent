/**
 * CPU seconds a process tree has used, for the idle-CPU probe. POSIX only:
 * `ps` on macOS, /proc on Linux. Returns null where neither works (Windows),
 * and the probe then leaves that figure out rather than guess.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** `ps` cputime ("1:02.34", "01:02:03", "1-02:03:04") to seconds. */
export function parsePsTime(text) {
  const t = String(text).trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s);
}

/** utime + stime of a /proc/<pid>/stat line, in seconds at `ticks` per second. */
export function parseProcStat(line, ticks = 100) {
  // The command is in parentheses and may hold spaces; the fields follow the last ")".
  const rest = line.slice(line.lastIndexOf(')') + 2).split(' ');
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  return Number.isFinite(utime) && Number.isFinite(stime) ? (utime + stime) / ticks : null;
}

function psTable() {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map(([, pid, ppid, time, command]) => ({ pid: Number(pid), ppid: Number(ppid), time, command }));
}

/** What a Chromium process is, from its command line: renderer, gpu-process, utility, ... or browser (no --type). */
export function chromiumKind(command) {
  const m = /--type=([\w-]+)/.exec(command);
  return m ? m[1] : 'browser';
}

/** CPU seconds of each process in the tree of `pid` (itself and every descendant), or null when unavailable. */
export function cpuOfProcesses(pid) {
  if (!pid || process.platform === 'win32') return null;
  try {
    const rows = psTable();
    const tree = new Set([pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) { tree.add(r.pid); grew = true; }
    }
    const out = [];
    for (const r of rows) {
      if (!tree.has(r.pid)) continue;
      const secs = process.platform === 'linux'
        ? parseProcStat(readFileSync(`/proc/${r.pid}/stat`, 'utf8'))
        : parsePsTime(r.time);
      if (secs != null) out.push({ pid: r.pid, command: r.command, secs });
    }
    return out;
  } catch {
    return null;
  }
}

/** CPU seconds of `pid` and all its descendants, or null when unavailable. */
export function cpuSecondsOfTree(pid) {
  const all = cpuOfProcesses(pid);
  return all ? all.reduce((n, p) => n + p.secs, 0) : null;
}

/** The kinds Chromium's processes are reported under. */
export function kindOf(command) {
  const k = chromiumKind(command);
  return k === 'renderer' ? 'renderer' : k === 'gpu-process' ? 'gpu' : k === 'browser' ? 'browser' : 'other';
}

/**
 * CPU seconds used between two `cpuOfProcesses` samples, by kind and in total.
 * Only processes in both samples count: Chromium starts and ends helper
 * processes (a new tab's renderer, a utility), and a total taken over whoever
 * happens to be alive each time would swing by their whole lifetime's CPU.
 */
export function cpuDelta(before, after) {
  const was = new Map(before.map((p) => [p.pid, p]));
  const by = { total: 0, renderer: 0, gpu: 0, browser: 0, other: 0 };
  for (const p of after) {
    const b = was.get(p.pid);
    if (!b) continue;
    const d = Math.max(0, p.secs - b.secs);
    by.total += d;
    by[kindOf(p.command)] += d;
  }
  return by;
}
