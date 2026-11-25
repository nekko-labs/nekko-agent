import { describe, expect, it } from 'vitest';
import type { CatalogQuant, ModelLoadCheck } from '@nekko-agent/shared';
import { buildCheckLabel, recommendedBuild } from './ModelDetail.js';

const q = (label: string, sizeBytes: number): CatalogQuant => ({ label, file: `Bonsai-${label}.gguf`, sizeBytes });
const bonsai = [q('F16', 53.8e9), q('PQ2_0', 7.21e9), q('PTQ1_0', 5.95e9), q('Q2_0', 7.63e9)];
const vram = { kind: 'vram' as const, budgetBytes: 31.8e9 };
const format: ModelLoadCheck = { level: 'blocked', cause: 'weightFormat', reason: 'Needs a modified llama.cpp.' };
const age: ModelLoadCheck = { level: 'blocked', cause: 'engineAge', reason: 'Needs llama.cpp b11556 or newer.' };

describe('the builds of a repo, as the engine in use sees them', () => {
  it('never picks a build the engine refuses', () => {
    // Without a word from the engine the lightest build that fits is the pick: the fork-only PTQ1_0.
    expect(recommendedBuild(bonsai, vram, {})?.label).toBe('PTQ1_0');
    const checks = { 'Bonsai-PTQ1_0.gguf': format, 'Bonsai-PQ2_0.gguf': format };
    expect(recommendedBuild(bonsai, vram, checks)?.label).toBe('Q2_0');
    // A Q4_K_M the engine refuses is not the pick either.
    expect(recommendedBuild([q('Q4_K_M', 5e9), q('Q8_0', 9e9)], vram, { 'Bonsai-Q4_K_M.gguf': format })?.label).toBe('Q8_0');
    expect(recommendedBuild([q('PTQ1_0', 5e9)], vram, { 'Bonsai-PTQ1_0.gguf': format })).toBeNull();
    // A build that only needs a newer engine is still the pick: one Update away.
    expect(recommendedBuild(bonsai, vram, { ...checks, 'Bonsai-Q2_0.gguf': age, 'Bonsai-F16.gguf': age })?.label).toBe('Q2_0');
  });

  it('labels a checked build in the library rows’ words', () => {
    expect(buildCheckLabel(format, 5.95e9, vram)).toBe("Can't run here");
    expect(buildCheckLabel(age, 7.63e9, vram)).toBe('Needs a newer engine');
    expect(buildCheckLabel({ level: 'warning', cause: 'weightFormat', reason: 'x' }, 5.95e9, vram)).toBe('May not run here');
  });
});
