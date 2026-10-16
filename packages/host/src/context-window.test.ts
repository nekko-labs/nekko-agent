import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, ProviderConfig } from '@nekko-agent/shared';
import { __resetContextWindows, contextWindowFor, imageInputFor } from './context-window.js';

const engine: ProviderConfig = { id: 'nekko-engine', kind: 'llamacpp', label: 'Nekko engine', baseUrl: 'http://127.0.0.1:1/v1', enabled: true };
const qwen = 'unsloth/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf';
const gemma = 'ggml-org/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf';
const rows: ModelInfo[] = [
  { id: qwen, providerId: engine.id, name: 'Qwen3 4B', contextLength: 40960, details: { inputModalities: 'text' } },
  { id: gemma, providerId: engine.id, name: 'Gemma 3 4B', details: { inputModalities: 'text,image' } },
  { id: 'mystery.gguf', providerId: engine.id, name: 'mystery' },
];

describe('imageInputFor', () => {
  beforeEach(() => __resetContextWindows());

  it('is false for a model whose listing says it takes text only (no projector)', async () => {
    expect(await imageInputFor(engine, qwen, async () => rows)).toBe(false);
  });

  it('is true for a listed vision model and for a model nothing is known about', async () => {
    expect(await imageInputFor(engine, gemma, async () => rows)).toBe(true);
    expect(await imageInputFor(engine, 'mystery.gguf', async () => rows)).toBe(true);
    expect(await imageInputFor(engine, 'gone.gguf', async () => { throw new Error('down'); })).toBe(true);
  });

  it('reads cloud families without a listing', async () => {
    const openai: ProviderConfig = { id: 'o', kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', enabled: true };
    const list = vi.fn(async () => [] as ModelInfo[]);
    expect(await imageInputFor(openai, 'o3-mini', list)).toBe(false);
    expect(await imageInputFor(openai, 'gpt-5.2', list)).toBe(true);
    expect(list).not.toHaveBeenCalled();
  });

  it('shares one model-list request with contextWindowFor', async () => {
    const list = vi.fn(async () => rows);
    expect(await contextWindowFor(engine, qwen, list)).toBe(40960);
    expect(await imageInputFor(engine, qwen, list)).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
