import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SystemStats } from '@nekko-agent/shared';

/**
 * Temperature sensors for the Hardware monitor, as the engine daemon reads
 * them (crates/nekko-machine/src/temps.rs; the golden set holds the two
 * classifiers together). The daemon serves `system:stats` normally; this TS
 * path only runs when it is missing, so it reads Linux hwmon (plain file
 * reads) and leaves macOS and Windows sensors to the daemon rather than
 * spawning a process on every 2 s monitor tick.
 */

export type SensorKind = 'cpu' | 'memory' | 'gpu';

/** Sort a hwmon chip and one of its labels into a row (`chip` empty for macOS labels). */
export function classifySensor(chip: string, label: string): SensorKind | null {
  const c = chip.toLowerCase();
  const l = label.toLowerCase();
  if (['k10temp', 'k8temp', 'coretemp', 'zenpower', 'cpu_thermal', 'cpu-thermal', 'fam15h_power'].includes(c)) return 'cpu';
  if (c === 'spd5118' || c === 'jc42') return 'memory';
  if (['amdgpu', 'radeon', 'nouveau', 'i915', 'xe'].includes(c)) return l === 'mem' ? null : 'gpu';
  if (c !== '') return null;
  if (l.includes('gpu') || l.startsWith('pmu tg')) return 'gpu';
  if (l.includes('tdie') || l.includes('cpu') || (l.includes('tp') && l.startsWith('pmu'))) return 'cpu';
  if (l.includes('dram') || l.includes('memory')) return 'memory';
  return null;
}

const plausible = (c: number) => Number.isFinite(c) && c > 0 && c < 150;

/** The hottest plausible reading per row, whole degrees; null when there are none. */
export function foldTemps(readings: Array<[SensorKind, number]>): NonNullable<SystemStats['temps']> | null {
  const hot: Partial<Record<SensorKind, number>> = {};
  for (const [kind, c] of readings) if (plausible(c)) hot[kind] = Math.max(hot[kind] ?? -Infinity, c);
  const out: NonNullable<SystemStats['temps']> = {};
  if (hot.cpu !== undefined) out.cpuC = Math.round(hot.cpu);
  if (hot.memory !== undefined) out.memoryC = Math.round(hot.memory);
  if (hot.gpu !== undefined) out.gpuC = Math.round(hot.gpu);
  return Object.keys(out).length ? out : null;
}

const read = (p: string) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };

/** `/sys/class/hwmon`, folded; null elsewhere or when nothing is exposed. */
export function readTemps(root = '/sys/class/hwmon'): NonNullable<SystemStats['temps']> | null {
  if (process.platform !== 'linux' && root === '/sys/class/hwmon') return null;
  const readings: Array<[SensorKind, number]> = [];
  let dirs: string[];
  try { dirs = readdirSync(root); } catch { return null; }
  for (const dir of dirs) {
    const path = join(root, dir);
    const chip = read(join(path, 'name'));
    let files: string[];
    try { files = readdirSync(path); } catch { continue; }
    for (const file of files) {
      const stem = /^(temp\d+)_input$/.exec(file)?.[1];
      if (!stem) continue;
      const kind = classifySensor(chip, read(join(path, `${stem}_label`)));
      const raw = kind ? read(join(path, file)) : '';
      if (kind && raw !== '') readings.push([kind, Number(raw) / 1000]);
    }
  }
  return foldTemps(readings);
}
