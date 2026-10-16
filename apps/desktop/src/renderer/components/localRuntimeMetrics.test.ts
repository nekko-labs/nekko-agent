import { describe, expect, it } from 'vitest';
import type { RuntimeStatus } from '@nekko-agent/shared';
import { localRuntimeMetrics } from './monitorMetrics.js';

const status = (patch: Partial<RuntimeStatus> = {}): RuntimeStatus => ({
  kind: 'ollama',
  running: true,
  owned: false,
  baseUrl: 'http://127.0.0.1:11434',
  resident: [],
  ...patch,
});

describe('wall dock local runtime metrics', () => {
  it('summarizes resident model fields without inventing throughput', () => {
    const metrics = localRuntimeMetrics([
      status({
        resident: [
          { id: 'qwen', sizeBytes: 6_000_000_000, vramBytes: 4_000_000_000, loadedOn: 'gpu+cpu', lastUsedAt: 1_000 },
          { id: 'llama', loadedOn: 'gpu', startedAt: 500 },
        ],
      }),
    ], 61_000);

    expect(metrics.loadedModels).toBe('2');
    expect(metrics.memoryLabel).toContain('VRAM');
    expect(metrics.memoryLabel).toContain('total');
    expect(metrics.lastTokPerSecond).toBe('Unavailable');
    expect(metrics.recent[0]).toMatchObject({ id: 'qwen', placement: 'GPU + CPU', lastUsed: '1 min ago' });
  });

  it('distinguishes an empty running runtime from unavailable status', () => {
    expect(localRuntimeMetrics([status()]).loadedModels).toBe('None loaded');
    expect(localRuntimeMetrics([]).loadedModels).toBe('Runtime stopped or unavailable');
  });
});
