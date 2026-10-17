import { describe, expect, it, vi } from 'vitest';
import { formatTemperature, temperatureTone } from '@nekko-agent/shared';
vi.mock('../store.js', () => ({ useStore: (select: (s: unknown) => unknown) => select({ settings: {} }) }));
import { hardwareRows } from './MonitorsDock.js';

const on = { cpu: true, memory: true, gpu: true, vram: true };
const system = { cpuPct: 20, cpuCores: 8, memUsedMB: 4096, memTotalMB: 16384 };
const gpu = (devices: Array<{ name: string; temperatureC?: number }>) => ({ source: 'nvidia-smi' as const, totalMB: 1, usedMB: 0, freeMB: 1, devices: devices.map((d) => ({ ...d, memoryTotalMB: 1, memoryUsedMB: 0, memoryFreeMB: 1, utilizationPct: 5 })) });

describe('Hardware monitor temperatures', () => {
  it('puts each sensor in its own row', () => {
    const rows = hardwareRows(on, { ...system, temps: { cpuC: 61, memoryC: 44 } }, gpu([{ name: 'RTX 5090', temperatureC: 50 }]));
    expect(rows.map((r) => [r.label, r.temp])).toEqual([['CPU', 61], ['Memory', 44], ['GPU 1: RTX 5090', 50], ['VRAM', undefined]]);
  });

  it('lets the board GPU sensor fill in only for a lone GPU without its own reading', () => {
    expect(hardwareRows(on, { ...system, temps: { gpuC: 70 } }, gpu([{ name: 'Radeon' }]))[2].temp).toBe(70);
    expect(hardwareRows(on, { ...system, temps: { gpuC: 70 } }, gpu([{ name: 'A' }, { name: 'B' }])).slice(2, 4).map((r) => r.temp)).toEqual([undefined, undefined]);
    expect(hardwareRows(on, { ...system, temps: { gpuC: 70 } }, gpu([{ name: 'A', temperatureC: 40 }]))[2].temp).toBe(40);
  });

  it('shows nothing where there is no sensor or the monitor is off', () => {
    expect(hardwareRows(on, system, null).map((r) => r.temp)).toEqual([undefined, undefined, undefined, undefined]);
    expect(hardwareRows({ ...on, cpu: false }, { ...system, temps: { cpuC: 60 } }, null)[0].temp).toBeUndefined();
    expect(formatTemperature(undefined)).toBeNull();
    expect(formatTemperature(61.6)).toBe('62°C');
    expect([79, 80, 90].map(temperatureTone)).toEqual(['ok', 'warn', 'hot']);
  });
});
