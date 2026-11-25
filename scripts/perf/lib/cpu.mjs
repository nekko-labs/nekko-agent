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
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time='], { encoding: 'utf8' })
    .split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 3)
    .map(([pid, ppid, time]) => ({ pid: Number(pid), ppid: Number(ppid), time }));
}

/** CPU seconds of `pid` and all its descendants, or null when unavailable. */
export function cpuSecondsOfTree(pid) {
  if (!pid || process.platform === 'win32') return null;
  try {
    const rows = psTable();
    const tree = new Set([pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) { tree.add(r.pid); grew = true; }
    }
    let total = 0;
    for (const r of rows) {
      if (!tree.has(r.pid)) continue;
      const secs = process.platform === 'linux'
        ? parseProcStat(readFileSync(`/proc/${r.pid}/stat`, 'utf8'))
        : parsePsTime(r.time);
      if (secs != null) total += secs;
    }
    return total;
  } catch {
    return null;
  }
}
