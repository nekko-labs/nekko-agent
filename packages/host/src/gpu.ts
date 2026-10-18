import { execFile } from 'child_process';
import os from 'os';
import type { GpuStats } from '@nekko-agent/shared';
import { parseIoregAccelerators, toGpuDevices } from './gpu-macos.js';
import { queryLlamaDevices, type RunText } from './gpu-vulkan.js';

/**
 * GPU/VRAM stats for the Chat metrics bar and Command Center.
 *
 * Probes chosen by platform, all of which run without elevated rights:
 *  - `nvidia-smi` on Windows and Linux (the one query that works identically on
 *    both), reporting a discrete card's own VRAM.
 *  - `ioreg` on macOS, reading the accelerator driver's published counters. The
 *    GPU there shares one memory pool with the CPU, so the reading is flagged
 *    `unified` and measured against system RAM (see gpu-macos.ts).
 *  - The engine's own `llama-server --list-devices` where `nvidia-smi` is missing
 *    or fails (an old driver, a hybrid laptop, AMD or Intel). It names the GPUs
 *    the model will really load on (see gpu-vulkan.ts).
 *
 * We return null when no probe finds a GPU. Results are cached briefly so a
 * polling UI doesn't spawn a process on every tick.
 */

let cache: { at: number; stats: GpuStats | null } | null = null;
const TTL_MS = 1000;
let inFlight: Promise<GpuStats | null> | null = null;

export async function getGpuStats(): Promise<GpuStats | null> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.stats;
  if (inFlight) return inFlight;
  inFlight = probe(false)
    .then((stats) => {
      cache = { at: Date.now(), stats };
      return stats;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * A reading taken now, ignoring the cache.
 *
 * The cache exists so a polling meter does not spawn `nvidia-smi` every tick,
 * which is the right trade for a display. It is the wrong trade for a
 * measurement: taking "before" and "after" readings around a model load through
 * a 2.5 second cache can return the same numbers twice and report that loading a
 * model took no memory at all. Anything comparing two moments asks for this.
 */
export async function getGpuStatsFresh(): Promise<GpuStats | null> {
  const stats = await probe(true);
  cache = { at: Date.now(), stats };
  return stats;
}

/**
 * Ask the platform's probe. macOS never has `nvidia-smi` (Apple dropped NVIDIA
 * support long before Apple Silicon), so it goes straight to the registry rather
 * than paying for a spawn that always fails.
 */
async function probe(fresh: boolean): Promise<GpuStats | null> {
  if (process.platform === 'darwin') return queryIoreg();
  return (await queryNvidiaSmi()) ?? (await queryEngineDevices(fresh));
}

/**
 * Where to find a `llama-server` for the fallback probe. Set by the host once the
 * engine exists; kept as a hook so this file never imports the engine (which
 * itself reads GPU stats to choose a build).
 */
let engineBin: (() => Promise<string | undefined>) | undefined;
export function setEngineBinResolver(fn: (() => Promise<string | undefined>) | undefined): void {
  engineBin = fn;
  cache = null;
  engineCache = null;
}

/**
 * The fallback is a process spawn (~0.5-1 s), so it is read far less often than
 * the 2.5 s monitor tick. Free memory is therefore up to this old; a load's
 * before/after measurement uses `getGpuStatsFresh`, which skips this cache.
 */
const ENGINE_TTL_MS = 15_000;
let engineCache: { at: number; stats: GpuStats | null } | null = null;
let engineRun: RunText | undefined;
/** Test seam: replace the process runner. */
export function setEngineRunner(fn: RunText | undefined): void {
  engineRun = fn;
  engineCache = null;
}

async function queryEngineDevices(fresh: boolean): Promise<GpuStats | null> {
  if (!engineBin) return null;
  if (!fresh && engineCache && Date.now() - engineCache.at < ENGINE_TTL_MS) return engineCache.stats;
  const stats = await queryLlamaDevices(await engineBin().catch(() => undefined), engineRun);
  engineCache = { at: Date.now(), stats };
  return stats;
}

/** Run a command, resolving its stdout or null on any failure/timeout. */
function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** Sum a device list into the aggregate the monitor surfaces read. */
export function aggregate(source: GpuStats['source'], devices: GpuStats['devices'], unified: boolean): GpuStats | null {
  if (devices.length === 0) return null;
  return {
    source,
    devices,
    unified: unified || undefined,
    // Unified memory is one pool every accelerator draws from, so summing the
    // per-device totals would count the same RAM once per GPU.
    totalMB: unified ? devices[0].memoryTotalMB : devices.reduce((s, d) => s + d.memoryTotalMB, 0),
    usedMB: devices.reduce((s, d) => s + d.memoryUsedMB, 0),
    freeMB: unified
      ? Math.max(0, devices[0].memoryTotalMB - devices.reduce((s, d) => s + d.memoryUsedMB, 0))
      : devices.reduce((s, d) => s + d.memoryFreeMB, 0),
  };
}

async function queryNvidiaSmi(): Promise<GpuStats | null> {
  // Temperature rides on the same query; a driver too old to know the field
  // fails the whole query, so it is asked again without it.
  const stdout = await run('nvidia-smi', [
    '--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu',
    '--format=csv,noheader,nounits',
  ]) ?? await run('nvidia-smi', [
    '--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu',
    '--format=csv,noheader,nounits',
  ]);
  return stdout ? parseNvidiaSmi(stdout) : null;
}

/** A °C column: blank, `N/A` and `[N/A]` are no reading. */
function smiTemperature(col: string | undefined): number | undefined {
  if (col === undefined || col === '') return undefined;
  const n = Number(col);
  return Number.isFinite(n) ? n : undefined;
}

/** `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` output as stats (nekkod's `gpu:stats` ports this). */
export function parseNvidiaSmi(stdout: string): GpuStats | null {
  const devices = stdout
    .trim()
    .split('\n')
    .map((line) => line.split(',').map((s) => s.trim()))
    .filter((cols) => cols.length >= 4)
    .map((cols) => {
      const [name, total, used, free, util, temp] = cols;
      const temperatureC = smiTemperature(temp);
      return {
        name: name || 'GPU',
        memoryTotalMB: Number(total) || 0,
        memoryUsedMB: Number(used) || 0,
        memoryFreeMB: Number(free) || 0,
        utilizationPct: util !== undefined && util !== '' && util !== '[N/A]' ? Number(util) : undefined,
        ...(temperatureC === undefined ? {} : { temperatureC }),
      };
    })
    .filter((d) => d.memoryTotalMB > 0);

  return aggregate('nvidia-smi', devices, false);
}

/**
 * macOS: read the accelerator driver's counters out of the IO registry. `-r -d 1`
 * limits the dump to the matched nodes and their own properties (no children),
 * and `-w 0` stops ioreg wrapping a dictionary across lines mid-value.
 */
async function queryIoreg(): Promise<GpuStats | null> {
  const stdout = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
  if (!stdout) return null;
  return ioregStats(stdout, Math.round(os.totalmem() / 1024 / 1024));
}

/** `ioreg` output measured against system RAM, as stats (nekkod's `gpu:stats` ports this). */
export function ioregStats(stdout: string, unifiedTotalMB: number): GpuStats | null {
  if (unifiedTotalMB <= 0) return null;
  return aggregate('ioreg', toGpuDevices(parseIoregAccelerators(stdout), unifiedTotalMB), true);
}
