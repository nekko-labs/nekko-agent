import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelLoadCheck } from '@nekko-agent/shared';
import { downloadRefusal, openBuild } from './buildChecks.js';

const format: ModelLoadCheck = { level: 'blocked', cause: 'weightFormat', reason: 'Needs a modified llama.cpp.' };
const warn: ModelLoadCheck = { level: 'warning', cause: 'weightFormat', reason: 'It may not load.' };
const checks = vi.fn();
beforeEach(() => {
  checks.mockReset();
  Object.assign(globalThis, { window: { nekko: { engineCatalogChecks: checks } } });
});

describe('reading a build on demand', () => {
  it('asks the engine about one build the first time it is opened, and keeps what it said', async () => {
    checks.mockResolvedValue({ 'A-PTQ1_0.gguf': format });
    const done = new Set<string>();
    const first = await openBuild('o/r', 'A-PTQ1_0.gguf', {}, done);
    expect(checks).toHaveBeenCalledWith('o/r', 'A-PTQ1_0.gguf');
    expect(first).toEqual({ 'A-PTQ1_0.gguf': format });
    // Opened again: nothing more is asked.
    expect(await openBuild('o/r', 'A-PTQ1_0.gguf', first, done)).toBe(first);
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it('adds to what other builds already said, and says nothing for a build it could not read', async () => {
    checks.mockResolvedValueOnce({ 'A-Q2_0.gguf': warn }).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('offline'));
    const done = new Set<string>();
    const a = await openBuild('o/r', 'A-Q2_0.gguf', { 'A-PTQ1_0.gguf': format }, done);
    expect(Object.keys(a).sort()).toEqual(['A-PTQ1_0.gguf', 'A-Q2_0.gguf']);
    expect(await openBuild('o/r', 'A-Q4.gguf', a, done)).toEqual(a);
    // A failed ask is not final: the next open tries again.
    expect(await openBuild('o/r', 'A-Q8.gguf', a, done)).toEqual(a);
    expect(done.has('A-Q8.gguf')).toBe(false);
  });
});

describe('what a Download does with the answer', () => {
  it('refuses only a build the engine will not run, and says why', () => {
    expect(downloadRefusal(format)).toBe('Needs a modified llama.cpp.');
    expect(downloadRefusal(warn)).toBeUndefined();
    expect(downloadRefusal(undefined)).toBeUndefined();
  });
});
