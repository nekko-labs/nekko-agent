import os from 'os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SystemStats } from '@nekko-agent/shared';
import { readTemps } from './temps.js';

/**
 * CPU load + RAM use for monitor surfaces. macOS uses VM page accounting
 * to exclude reclaimable file cache, matching Activity Monitor Memory Used.
 *
 * CPU percentage is a delta: we keep the previous `os.cpus()` times snapshot and
 * report busy-time over the interval since it, which is what a task manager
 * shows. The first call (and any call after a long gap, e.g. the user switched
 * the CPU monitor back on) measures over a short window instead of reporting a
 * since-boot average.
 */

interface Snapshot {
  at: number;
  idle: number;
  total: number;
}

let prev: Snapshot | null = null;
/** Past this gap the stored snapshot is too old to be a useful interval. */
const STALE_MS = 30_000;
const PRIME_MS = 180;

function snapshot(): Snapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === 'idle') idle += ms;
    }
  }
  return { at: Date.now(), idle, total };
}

function busyPct(from: Snapshot, to: Snapshot): number {
  const dTotal = to.total - from.total;
  const dIdle = to.idle - from.idle;
  if (dTotal <= 0) return 0;
  return Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100));
}

const exec = promisify(execFile);

/** Anonymous resident pages + wired + physical compressor, not file cache. */
export function macMemoryUsedMB(output: string): number | null {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (name: string) => {
    const value = output.match(new RegExp(`^${name}:\\s+(\\d+)\\.`, 'm'))?.[1];
    return value == null ? NaN : Number(value);
  };
  const anonymous = pages('Anonymous pages');
  const purgeable = pages('Pages purgeable');
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor');
  if (![pageSize, anonymous, purgeable, wired, compressed].every(Number.isFinite) || pageSize <= 0) return null;
  return Math.round((Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize / 1024 / 1024);
}

export async function getSystemStats(): Promise<SystemStats | null> {
  try {
    let from = prev;
    if (!from || Date.now() - from.at > STALE_MS) {
      from = snapshot();
      await new Promise((r) => setTimeout(r, PRIME_MS));
    }
    const now = snapshot();
    prev = now;

    const cpus = os.cpus();
    const totalMB = Math.round(os.totalmem() / 1024 / 1024);
    const freeMB = Math.round(os.freemem() / 1024 / 1024);
    let usedMB = Math.max(0, totalMB - freeMB);
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await exec('/usr/bin/vm_stat', [], { timeout: 2000, maxBuffer: 64 * 1024 });
        const measured = macMemoryUsedMB(stdout);
        if (measured == null) throw new Error('Unrecognized vm_stat page counters');
        usedMB = Math.min(totalMB, measured);
      } catch (error) {
        console.warn('[system] macOS memory measurement unavailable', error);
        return null;
      }
    }
    const temps = readTemps();
    return {
      cpuPct: Math.round(busyPct(from, now)),
      cpuCores: cpus.length,
      cpuModel: cpus[0]?.model?.trim() || undefined,
      memUsedMB: usedMB,
      memTotalMB: totalMB,
      ...(temps ? { temps } : {}),
    };
  } catch {
    return null;
  }
}
