import { describe, expect, it } from 'vitest';
import { callFromPhone, phoneChannelClass, PhoneAccessError } from './phone-access.js';

/** The Expert monitor's channels (2026-10-24): narrow views, and unloading a model. */
describe('phone monitor channels', () => {
  const host = (results: Record<string, unknown>) => {
    const calls: Array<[string, unknown[]]> = [];
    const dispatch = (channel: string, args: unknown[]) => {
      calls.push([channel, args]);
      return results[channel];
    };
    return { calls, dispatch };
  };

  it('classes the reads as Read and unloading as Change without a proof', () => {
    for (const c of ['system:stats', 'gpu:stats', 'engine:status', 'context:preview']) expect(phoneChannelClass(c), c).toBe('read');
    expect(phoneChannelClass('model:unload')).toBe('agent');
    // Loading, settings and the rest of the Model Server stay on the computer.
    for (const c of ['engine:settings', 'engine:install', 'engine:deleteModel', 'engine:downloadModel']) expect(phoneChannelClass(c), c).toBeNull();
  });

  it('sends hardware as named numbers only', async () => {
    const { dispatch, calls } = host({
      'system:stats': { cpuPct: 41, cpuCores: 16, cpuModel: 'Ryzen', memUsedMB: 9000, memTotalMB: 32000, temps: { cpuC: 61, sensorPath: '/sys/x' }, pid: 7 },
      'gpu:stats': { source: 'nvidia-smi', totalMB: 24000, usedMB: 8000, freeMB: 16000, devices: [{ name: 'RTX', memoryTotalMB: 24000, memoryUsedMB: 8000, memoryFreeMB: 16000, utilizationPct: 77, temperatureC: 70, uuid: 'GPU-1' }] },
    });
    expect(await callFromPhone(dispatch, 'system:stats', ['ignored'])).toEqual({ cpuPct: 41, cpuCores: 16, cpuModel: 'Ryzen', memUsedMB: 9000, memTotalMB: 32000, temps: { cpuC: 61 } });
    expect(await callFromPhone(dispatch, 'gpu:stats', [])).toEqual({ source: 'nvidia-smi', totalMB: 24000, usedMB: 8000, freeMB: 16000, devices: [{ name: 'RTX', memoryTotalMB: 24000, memoryUsedMB: 8000, memoryFreeMB: 16000, utilizationPct: 77, temperatureC: 70 }] });
    expect(calls).toEqual([['system:stats', []], ['gpu:stats', []]]);
  });

  it('sends the Model Server without its paths, log or settings', async () => {
    const { dispatch } = host({
      'engine:status': {
        install: { binPath: 'C:/secret/llama-server.exe', version: 'b1' },
        running: true, port: 8080, log: ['C:/models/x.gguf loaded'], settings: { modelsDir: 'C:/models' },
        resident: [{ id: 'google/gemma-4-e4b', contextLength: 32768, vramBytes: 5e9, loadedOn: 'gpu', gpuLayers: 42, totalLayers: 42, path: 'C:/models/gemma.gguf' }],
        loading: [{ id: 'qwen', phase: 'loading', startedAt: 1, progress: 0.5, path: 'x' }],
        memory: { budgetBytes: 24e9, kind: 'vram' },
      },
    });
    expect(await callFromPhone(dispatch, 'engine:status', [])).toEqual({
      running: true, installed: true,
      resident: [{ id: 'google/gemma-4-e4b', contextLength: 32768, vramBytes: 5e9, loadedOn: 'gpu', gpuLayers: 42, totalLayers: 42 }],
      loading: [{ id: 'qwen', phase: 'loading', startedAt: 1, progress: 0.5 }],
      memory: { budgetBytes: 24e9, kind: 'vram' },
    });
    expect(await callFromPhone(host({ 'engine:status': { install: {}, running: false, resident: [] } }).dispatch, 'engine:status', []))
      .toEqual({ running: false, installed: false, resident: [], loading: [] });
  });

  it('sends a chat context as totals, never what is in it', async () => {
    const { dispatch, calls } = host({
      'context:preview': {
        contextWindow: 131072, totalTokens: 999,
        items: [
          { source: 'system', tokens: 1200, included: true, label: 'System', origin: '', preview: 'You are' },
          { source: 'attached-file', tokens: 800, included: true, label: '/home/me/secret.txt', origin: '/home/me/secret.txt', preview: 'password' },
          { source: 'conversation', tokens: 3000, included: true, preview: 'hi' },
          { source: 'memory', tokens: 500, included: false, preview: 'excluded' },
          { source: 'alien', tokens: 10, included: true },
        ],
      },
    });
    expect(await callFromPhone(dispatch, 'context:preview', ['s1', ['/etc/passwd']])).toEqual({
      usedTokens: 5010, contextWindow: 131072, sources: { system: 1200, 'attached-file': 800, conversation: 3000 },
    });
    expect(calls).toEqual([['context:preview', ['s1', []]]]);
    await expect(callFromPhone(dispatch, 'context:preview', [''])).rejects.toThrow(PhoneAccessError);
  });

  it('unloads a model by provider and id', async () => {
    const { dispatch, calls } = host({ 'model:unload': { ok: true, message: 'Unloaded.', extra: 1 } });
    expect(await callFromPhone(dispatch, 'model:unload', ['nekko-local', 'google/gemma-4-e4b', 'x'])).toEqual({ ok: true, message: 'Unloaded.' });
    expect(calls).toEqual([['model:unload', ['nekko-local', 'google/gemma-4-e4b']]]);
    await expect(callFromPhone(dispatch, 'model:unload', ['nekko-local'])).rejects.toThrow('model id');
    await expect(callFromPhone(dispatch, 'model:unload', [3, 'm'])).rejects.toThrow('provider id');
  });
});
