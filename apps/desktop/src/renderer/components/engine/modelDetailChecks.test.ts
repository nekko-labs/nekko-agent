import { describe, expect, it } from 'vitest';
import type { CatalogQuant, ModelLoadCheck } from '@nekko-agent/shared';
import { buildCheckLabel, recommendedBuilds } from './ModelDetail.js';

const q = (label: string, sizeBytes: number): CatalogQuant => ({ label, file: `Bonsai-${label}.gguf`, sizeBytes });
const bonsai = [q('F16', 53.8e9), q('PQ2_0', 7.21e9), q('PTQ1_0', 5.95e9), q('Q2_0', 7.63e9)];
const vram = { kind: 'vram' as const, budgetBytes: 31.8e9 };
const format: ModelLoadCheck = { level: 'blocked', cause: 'weightFormat', reason: 'Needs a modified llama.cpp.' };
const age: ModelLoadCheck = { level: 'blocked', cause: 'engineAge', reason: 'Needs llama.cpp b11556 or newer.' };
/** [balanced, best quality] as labels. */
const picks = (...args: Parameters<typeof recommendedBuilds>) => { const r = recommendedBuilds(...args); return [r.balanced?.label ?? null, r.best?.label ?? null]; };

describe('the builds of a repo, as the engine in use sees them', () => {
  it('never picks a build the engine refuses', () => {
    // Without a Q4_K_M, the largest build that fits is both picks.
    expect(picks(bonsai, vram, {})).toEqual(['Q2_0', 'Q2_0']);
    const checks = { 'Bonsai-PTQ1_0.gguf': format, 'Bonsai-PQ2_0.gguf': format };
    expect(picks(bonsai, vram, checks)).toEqual(['Q2_0', 'Q2_0']);
    // A Q4_K_M the engine refuses is not a pick either.
    expect(picks([q('Q4_K_M', 5e9), q('Q8_0', 9e9)], vram, { 'Bonsai-Q4_K_M.gguf': format })).toEqual(['Q8_0', 'Q8_0']);
    expect(picks([q('PTQ1_0', 5e9)], vram, { 'Bonsai-PTQ1_0.gguf': format })).toEqual([null, null]);
    // A build that only needs a newer engine is still a pick: one Update away.
    expect(picks(bonsai, vram, { ...checks, 'Bonsai-Q2_0.gguf': age, 'Bonsai-F16.gguf': age })).toEqual(['Q2_0', 'Q2_0']);
  });

  it('offers Q4_K_M as balanced and the largest build this machine holds as best quality', () => {
    const ladder = [q('IQ2_M', 10.4e9), q('Q4_K_M', 16.6e9), q('Q6_K', 22e9), q('Q8_0', 25.9e9), q('BF16', 48e9)];
    const mac = { kind: 'unified' as const, budgetBytes: 128e9 };
    expect(picks(ladder, mac, {})).toEqual(['Q4_K_M', 'Q8_0']); // BF16 fits too, but Q8_0 is the same answers at half the size
    expect(picks(ladder, { kind: 'vram', budgetBytes: 40e9 }, {})).toEqual(['Q4_K_M', 'Q4_K_M']); // nothing bigger fits: one pick
    expect(picks(ladder, { kind: 'vram', budgetBytes: 25e9 }, {})).toEqual(['IQ2_M', 'IQ2_M']); // Q4_K_M too big: what fits
    expect(picks(ladder, { kind: 'vram', budgetBytes: 8e9 }, {})).toEqual(['Q4_K_M', null]); // nothing fits: the usual choice
    expect(picks(ladder, undefined, {})).toEqual(['Q4_K_M', null]);
    expect(picks([q('F16', 1e9), q('BF16', 1.1e9)], mac, {})).toEqual(['BF16', 'BF16']); // only unquantized: still a pick
    // Only the newest release (listed first) is a candidate.
    const releases = [{ ...q('v3 Q4_K_M', 16.6e9), variant: 'v3' }, { ...q('v2.1 Q8_0', 25.9e9), variant: 'v2.1' }];
    expect(picks(releases, mac, {})).toEqual(['v3 Q4_K_M', 'v3 Q4_K_M']);
  });

  it('labels a checked build in the library rows’ words', () => {
    expect(buildCheckLabel(format, 5.95e9, vram)).toBe("Can't run here");
    expect(buildCheckLabel(age, 7.63e9, vram)).toBe('Needs a newer engine');
    expect(buildCheckLabel({ level: 'warning', cause: 'weightFormat', reason: 'x' }, 5.95e9, vram)).toBe('May not run here');
  });
});
