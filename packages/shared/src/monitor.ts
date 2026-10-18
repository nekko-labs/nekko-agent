/**
 * Resource monitoring: what the HUD chip and the chat's monitor dock can show.
 *
 * Four independent monitors, each of which the user can switch off from the HUD.
 * Off means off: the renderer stops asking for that source, so no GPU probe
 * process is spawned and no CPU times are sampled for a monitor nobody is
 * looking at. GPU utilization and VRAM come from the same probe, so either one
 * being on keeps that probe alive; CPU and memory share the system probe the
 * same way.
 */

export type MonitorKind = 'cpu' | 'memory' | 'gpu' | 'vram';

/** Every monitor, in the order the UI presents them. */
export const MONITOR_KINDS: MonitorKind[] = ['cpu', 'memory', 'gpu', 'vram'];

export const MONITOR_LABELS: Record<MonitorKind, string> = {
  cpu: 'CPU',
  memory: 'Memory',
  gpu: 'GPU',
  vram: 'VRAM',
};

export const MONITOR_HINTS: Record<MonitorKind, string> = {
  cpu: 'Processor load across all cores.',
  memory: 'System RAM in use.',
  gpu: 'GPU utilization.',
  // Apple Silicon has no dedicated VRAM, so this is the GPU's share of the
  // unified pool there; the meter renames itself to match what it is reading.
  vram: 'GPU memory in use.',
};

/** All on: the numbers matter most when a local model is running. */
export const DEFAULT_MONITORS: Record<MonitorKind, boolean> = {
  cpu: true,
  memory: true,
  gpu: true,
  vram: true,
};

/** Fill a partial preference set out to a complete one. */
export function resolveMonitors(prefs?: Partial<Record<MonitorKind, boolean>>): Record<MonitorKind, boolean> {
  return {
    cpu: prefs?.cpu ?? DEFAULT_MONITORS.cpu,
    memory: prefs?.memory ?? DEFAULT_MONITORS.memory,
    gpu: prefs?.gpu ?? DEFAULT_MONITORS.gpu,
    vram: prefs?.vram ?? DEFAULT_MONITORS.vram,
  };
}

/** Which host probes a set of monitors needs. Neither = poll nothing at all. */
export function monitorSources(m: Record<MonitorKind, boolean>): { system: boolean; gpu: boolean } {
  return { system: m.cpu || m.memory, gpu: m.gpu || m.vram };
}

/**
 * CPU + RAM for the monitor surfaces. `cpuPct` is load across all cores over the
 * interval since the previous sample, so it matches what a task manager shows
 * rather than an all-time average.
 */
export interface SystemStats {
  cpuPct: number;
  cpuCores: number;
  /** Model string of the first core, e.g. "AMD Ryzen 9 7950X". */
  cpuModel?: string;
  memUsedMB: number;
  memTotalMB: number;
  /**
   * Temperature sensors in °C, hottest per row, when the machine exposes them
   * without admin rights (Linux hwmon, Apple Silicon sensors, the Windows ACPI
   * thermal zone). Each is absent rather than guessed. `gpuC` covers GPUs the
   * GPU probe has no temperature for (AMD and Intel on Linux, Apple Silicon).
   */
  temps?: { cpuC?: number; memoryC?: number; gpuC?: number };
}

/** A °C reading for a monitor row, or null when there is none. */
export function formatTemperature(c: number | undefined | null): string | null {
  return c == null || !Number.isFinite(c) ? null : `${Math.round(c)}°C`;
}

/** Severity of a temperature, on the monitors' shared scale (quiet, warn, danger). */
export function temperatureTone(c: number): 'ok' | 'warn' | 'hot' {
  return c >= 90 ? 'hot' : c >= 80 ? 'warn' : 'ok';
}
