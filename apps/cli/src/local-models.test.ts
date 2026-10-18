import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ProviderConfig } from '@nekko-agent/shared';
import type { Client } from './lib.js';
import { loadModel, localModelStatus, pickQuant, runtimeProvider, stopRuntime, summarizeDownload, waitForDownload } from './local-models.js';

const engine: ProviderConfig = { id: 'nekko-engine', kind: 'llamacpp', label: 'Engine', baseUrl: 'http://127.0.0.1:1/v1', enabled: true };
const ollama: ProviderConfig = { id: 'ollama-1', kind: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true };
const cloud: ProviderConfig = { id: 'anthropic', kind: 'anthropic', label: 'Claude', baseUrl: '', enabled: true };

const model = (labels: string[]): CatalogModel => ({
  id: 'o/r',
  name: 'R',
  owner: 'o',
  tags: [],
  quants: labels.map((label) => ({ label, file: `${label}.gguf` })),
});

describe('runtimeProvider', () => {
  it('defaults to the built-in engine', () => {
    expect(runtimeProvider([cloud, engine]).id).toBe('nekko-engine');
  });
  it('accepts another local runtime by id', () => {
    expect(runtimeProvider([engine, ollama], 'ollama-1').id).toBe('ollama-1');
  });
  it('refuses a cloud provider and an unknown id', () => {
    expect(() => runtimeProvider([cloud], 'anthropic')).toThrow(/not a local runtime/);
    expect(() => runtimeProvider([engine], 'nope')).toThrow(/No provider "nope"/);
  });
  it('explains a missing engine entry', () => {
    expect(() => runtimeProvider([cloud])).toThrow(/no provider entry/);
  });
});

describe('pickQuant', () => {
  it('prefers Q4_K_M when none is named', () => {
    expect(pickQuant(model(['Q8_0', 'Q4_K_M', 'Q2_K'])).label).toBe('Q4_K_M');
  });
  it('falls back through the preference list, then to the first', () => {
    expect(pickQuant(model(['Q8_0', 'Q5_K_M'])).label).toBe('Q5_K_M');
    expect(pickQuant(model(['IQ2_XS'])).label).toBe('IQ2_XS');
  });
  it('matches a named quant case-insensitively and lists the options when absent', () => {
    expect(pickQuant(model(['Q8_0', 'Q4_K_M']), 'q8_0').label).toBe('Q8_0');
    expect(() => pickQuant(model(['Q8_0']), 'Q3_K_S')).toThrow(/Available: Q8_0/);
  });
  it('rejects a repo with nothing to download', () => {
    expect(() => pickQuant(model([]))).toThrow(/no downloadable/);
  });
});

describe('summarizeDownload', () => {
  it('reports percent and ETA while downloading', () => {
    const s = summarizeDownload({
      id: 'j', kind: 'model', label: 'f', target: 'o/r', state: 'downloading',
      receivedBytes: 1024 ** 3, totalBytes: 4 * 1024 ** 3, bytesPerSecond: 1024 ** 3 / 10, startedAt: 0,
    });
    expect(s).toMatchObject({ percent: 25, receivedGB: 1, totalGB: 4, etaSeconds: 30 });
  });
  it('drops the ETA once the job is over', () => {
    const s = summarizeDownload({ id: 'j', kind: 'model', label: 'f', target: 'o/r', state: 'done', receivedBytes: 10, totalBytes: 10, bytesPerSecond: 5, startedAt: 0 });
    expect(s.etaSeconds).toBeUndefined();
    expect(s.percent).toBe(100);
  });
});

const fakeClient = (over: Partial<Record<keyof Client, unknown>>) =>
  ({ getSettings: vi.fn().mockResolvedValue({ providers: [engine, ollama, cloud] }), ...over }) as unknown as Client;

describe('loadModel', () => {
  it('loads into the engine and tells the caller how to chat with it', async () => {
    const runtimeLoad = vi.fn().mockResolvedValue({ ok: true });
    const out = await loadModel(fakeClient({ runtimeLoad }), { modelId: 'm', contextTokens: 8192 });
    expect(runtimeLoad).toHaveBeenCalledWith('nekko-engine', 'm', { contextTokens: 8192 });
    expect(out.hint).toContain('provider: "nekko-engine", model: "m"');
  });
  it('surfaces the runtime failure as an error', async () => {
    const runtimeLoad = vi.fn().mockResolvedValue({ ok: false, message: 'Not enough memory' });
    await expect(loadModel(fakeClient({ runtimeLoad }), { modelId: 'm' })).rejects.toThrow('Not enough memory');
  });
});

describe('stopRuntime', () => {
  it('asks for confirmation instead of killing a process it did not start', async () => {
    const runtimeStop = vi.fn().mockResolvedValue({ ok: false, message: 'Not ours.', needsConfirmation: true, processName: 'ollama' });
    const out = await stopRuntime(fakeClient({ runtimeStop }), 'ollama-1');
    expect(runtimeStop).toHaveBeenCalledWith('ollama-1', false);
    expect(out).toMatchObject({ ok: false, needsConfirmation: true });
    expect(out.message).toMatch(/force: true/);
  });
});

describe('localModelStatus', () => {
  it('reports the engine and each enabled local runtime, not cloud providers', async () => {
    const runtimeStatus = vi.fn().mockResolvedValue({ kind: 'ollama', running: true, owned: false, baseUrl: 'u', resident: [{ id: 'llama3' }] });
    const engineStatus = vi.fn().mockResolvedValue({
      install: { binPath: '/x', version: 'b1', backend: 'metal' }, running: true, port: 9, log: [], settings: {},
      resident: [{ id: 'q', contextLength: 4096, loadedOn: 'gpu', vramBytes: 2 * 1024 ** 3 }],
      memory: { kind: 'unified', budgetBytes: 32 * 1024 ** 3 },
    });
    const out = await localModelStatus(fakeClient({ runtimeStatus, engineStatus }));
    expect(out.engine).toMatchObject({ providerId: 'nekko-engine', installed: true, running: true, memory: { budgetGB: 32 } });
    expect(out.engine.resident).toEqual([{ id: 'q', contextLength: 4096, loadedOn: 'gpu', vramGB: 2 }]);
    expect(runtimeStatus).toHaveBeenCalledOnce();
    expect(out.runtimes).toEqual([expect.objectContaining({ providerId: 'ollama-1', running: true, resident: ['llama3'] })]);
  });
});

describe('waitForDownload', () => {
  const job = (id: string, state: string, group = 'g') => ({ id, kind: 'model', label: id, target: 'o/r', group, state, receivedBytes: 1, totalBytes: 2, startedAt: 0 });
  it('waits for every file in the group, not just the main one', async () => {
    const engineDownloads = vi.fn()
      .mockResolvedValueOnce([job('main', 'downloading'), job('mmproj', 'queued')])
      .mockResolvedValueOnce([job('main', 'done'), job('mmproj', 'downloading')])
      .mockResolvedValueOnce([job('main', 'done'), job('mmproj', 'done')]);
    const out = await waitForDownload({ engineDownloads } as unknown as Client, 'main', undefined, 0);
    expect(engineDownloads).toHaveBeenCalledTimes(3);
    expect(out?.state).toBe('done');
  });
  it('reports a failed companion as the outcome', async () => {
    const engineDownloads = vi.fn().mockResolvedValue([job('main', 'done'), { ...job('mmproj', 'failed'), message: 'HTTP 403' }]);
    const out = await waitForDownload({ engineDownloads } as unknown as Client, 'main', undefined, 0);
    expect(out).toMatchObject({ id: 'mmproj', state: 'failed', message: 'HTTP 403' });
  });
});
