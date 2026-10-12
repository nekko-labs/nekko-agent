import os from 'os';
import { execFile } from 'child_process';
import { readFile, statfs } from 'fs/promises';
import type { MachineFacts } from '@nekko-agent/shared';
import { getGpuStats } from './gpu.js';
import { dataDir } from './paths.js';

const MB = 1024 * 1024;

/**
 * Gather the machine facts the readiness advisor (AN9b) plans against.
 *
 * Every probe is best-effort and honest about its gaps: a probe that cannot
 * answer on this platform yields `null`/absence, which the evaluator reports as
 * `unverified` rather than inventing a capability. Windows gets no CPU-feature
 * list (there is no way to read CPUID flags without a native module), so
 * feature-gated catalog entries come back capped at `unverified` there.
 */
export async function gatherMachineFacts(): Promise<MachineFacts> {
  const [gpu, cpuFeatures, backends, diskFreeBytes] = await Promise.all([
    getGpuStats(),
    probeCpuFeatures(),
    probeBackends(),
    probeDiskFree(),
  ]);
  const ramTotal = os.totalmem();
  return {
    os: { platform: process.platform, release: os.release(), arch: os.arch() },
    cpuFeatures,
    backends,
    devices: (gpu?.devices ?? []).map((d) => ({
      name: d.name,
      totalBytes: d.memoryTotalMB * MB,
      freeBytes: d.memoryFreeMB * MB,
    })),
    unified: Boolean(gpu?.unified),
    systemRamTotalBytes: ramTotal,
    systemRamFreeBytes: os.freemem(),
    diskFreeBytes,
  };
}

/**
 * Instruction features we can prove. Linux reads /proc/cpuinfo; macOS lists
 * `hw.optional.*` sysctl keys that equal 1. Windows stays `null`: the flags
 * need CPUID, which no dependency-free path exposes.
 */
async function probeCpuFeatures(): Promise<string[] | null> {
  if (process.platform === 'linux') {
    const text = await readFile('/proc/cpuinfo', 'utf8').catch(() => null);
    return text ? cpuinfoFeatures(text) : null;
  }
  if (process.platform === 'darwin') {
    const out = await run('sysctl', ['-a'], 4000);
    return out ? sysctlFeatures(out) : null;
  }
  return null;
}

/** The wanted flags in Linux's `/proc/cpuinfo` (nekkod's `machine:readiness` ports this). */
export function cpuinfoFeatures(text: string): string[] | null {
  const line = text.split('\n').find((l) => /^(flags|Features)\s*:/.test(l));
  if (!line) return null;
  const wanted = ['avx', 'avx2', 'avx512f', 'fma', 'f16c', 'asimd', 'neon', 'sve'];
  const flags = new Set(line.split(':')[1].trim().toLowerCase().split(/\s+/));
  return wanted.filter((f) => flags.has(f));
}

/** hw.optional.* keys that equal 1 in `sysctl -a`: the OS's own capability list. */
export function sysctlFeatures(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.match(/^hw\.optional\.([\w.]+):\s*1$/)?.[1])
    .filter((f): f is string => Boolean(f))
    .map((f) => f.toLowerCase());
}

/**
 * Compute backends the machine can run. CUDA = a working nvidia-smi, Metal =
 * Apple Silicon (always has it), Vulkan = a working vulkaninfo (rarely
 * installed, tolerable to miss). 'cpu' is always available.
 */
async function probeBackends(): Promise<string[]> {
  if (process.platform === 'darwin') return os.arch() === 'arm64' ? ['metal', 'cpu'] : ['cpu'];
  const smi = await run('nvidia-smi', ['-L'], 4000);
  const vk = await run('vulkaninfo', ['--summary'], 4000);
  return gpuBackends(smi, vk);
}

/** Backends proven by `nvidia-smi -L` and `vulkaninfo --summary` (null = did not run), plus the CPU. */
export function gpuBackends(smi: string | null, vk: string | null): string[] {
  const out: string[] = [];
  if (smi && /GPU\s+\d+:/.test(smi)) out.push('cuda');
  if (vk && /apiVersion|deviceName/i.test(vk)) out.push('vulkan');
  out.push('cpu');
  return out;
}

/** Free bytes on the volume that hosts the data dir. `null` = could not tell. */
async function probeDiskFree(): Promise<number | null> {
  try {
    const s = await statfs(dataDir());
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Run a command, resolving stdout or null on failure/timeout. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}
