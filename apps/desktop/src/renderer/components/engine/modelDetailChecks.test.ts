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
    // Without a word from the engine the largest build that fits is the pick.
    expect(recommendedBuild(bonsai, vram, {})?.label).toBe('Q2_0');
    const checks = { 'Bonsai-PTQ1_0.gguf': format, 'Bonsai-PQ2_0.gguf': format };
    expect(recommendedBuild(bonsai, vram, checks)?.label).toBe('Q2_0');
    // A Q4_K_M the engine refuses is not the pick either.
    expect(recommendedBuild([q('Q4_K_M', 5e9), q('Q8_0', 9e9)], vram, { 'Bonsai-Q4_K_M.gguf': format })?.label).toBe('Q8_0');
    expect(recommendedBuild([q('PTQ1_0', 5e9)], vram, { 'Bonsai-PTQ1_0.gguf': format })).toBeNull();
    // A build that only needs a newer engine is still the pick: one Update away.
    expect(recommendedBuild(bonsai, vram, { ...checks, 'Bonsai-Q2_0.gguf': age, 'Bonsai-F16.gguf': age })?.label).toBe('Q2_0');
  });

  it('picks the largest build this machine holds, not Q4_K_M by habit', () => {
    const ladder = [q('IQ2_M', 10.4e9), q('Q4_K_M', 16.6e9), q('Q6_K', 22e9), q('Q8_0', 25.9e9), q('BF16', 48e9)];
    const mac = { kind: 'unified' as const, budgetBytes: 128e9 };
    expect(recommendedBuild(ladder, mac, {})?.label).toBe('Q8_0'); // BF16 fits too, but Q8_0 is the same answers at half the size
    expect(recommendedBuild(ladder, { kind: 'vram', budgetBytes: 40e9 }, {})?.label).toBe('Q4_K_M');
    expect(recommendedBuild(ladder, { kind: 'vram', budgetBytes: 8e9 }, {})?.label).toBe('Q4_K_M'); // nothing fits: the usual choice
    expect(recommendedBuild(ladder, undefined, {})?.label).toBe('Q4_K_M');
    expect(recommendedBuild([q('F16', 1e9), q('BF16', 1.1e9)], mac, {})?.label).toBe('BF16'); // only unquantized: still a pick
    // Only the newest release (listed first) is a candidate.
    const releases = [{ ...q('v3 Q4_K_M', 16.6e9), variant: 'v3' }, { ...q('v2.1 Q8_0', 25.9e9), variant: 'v2.1' }];
    expect(recommendedBuild(releases, mac, {})?.label).toBe('v3 Q4_K_M');
  });

  it('labels a checked build in the library rows’ words', () => {
    expect(buildCheckLabel(format, 5.95e9, vram)).toBe("Can't run here");
    expect(buildCheckLabel(age, 7.63e9, vram)).toBe('Needs a newer engine');
    expect(buildCheckLabel({ level: 'warning', cause: 'weightFormat', reason: 'x' }, 5.95e9, vram)).toBe('May not run here');
  });
});
