import { describe, expect, it } from 'vitest';
import type { LocalModel } from './engine.js';
import { cannotLoadReason, dflashDrafterFor, draftCandidates, isDflashDrafter, modelModality, needsNewerEngine, unsupportedLoadReason } from './engine.js';

/**
 * What a GGUF is for, before anyone tries to serve it.
 *
 * The classification is what keeps a diffusion checkpoint or a speech
 * recognizer from being offered a Load button it can only fail behind, so the
 * tests cover the architectures this machine's library actually surfaced.
 */

describe('modelModality', () => {
  it('reads diffusion architectures as image generation, not chat', () => {
    expect(modelModality({ architecture: 'sd3' })).toBe('image');
    expect(modelModality({ architecture: 'flux' })).toBe('image');
    expect(modelModality({ architecture: 'sdxl' })).toBe('image');
    // GGUF writes these with an underscore (QuantStack's Qwen Image is `qwen_image`).
    expect(modelModality({ architecture: 'qwen_image' })).toBe('image');
    expect(modelModality({ architecture: 'z_image' })).toBe('image');
  });

  it('reads speech architectures as audio', () => {
    expect(modelModality({ architecture: 'whisper' })).toBe('audio');
    expect(modelModality({ architecture: 'parakeet' })).toBe('audio');
  });

  it('reads speculative-decoding heads as drafts', () => {
    expect(modelModality({ architecture: 'dflash-draft' })).toBe('draft');
    // What a DFlash or DFlash 2 GGUF says today: no "draft" in it.
    expect(modelModality({ architecture: 'dflash' })).toBe('draft');
    expect(modelModality({ architecture: 'eagle' })).toBe('draft');
  });

  it('pairs a DFlash drafter with the model it was made for, by name', () => {
    const drafter = { id: 'z-lab/Qwen3.8-27B-DFlash2-GGUF/q4', name: 'Qwen3.8-27B-DFlash2-Q4_K_M', architecture: 'dflash' };
    expect(isDflashDrafter(drafter)).toBe(true);
    expect(isDflashDrafter({ architecture: 'qwen38' })).toBe(false);
    expect(isDflashDrafter({})).toBe(false);
    expect(dflashDrafterFor({ id: 'a', name: 'Qwen3.8-27B-Q4_K_M' }, drafter)).toBe(true);
    expect(dflashDrafterFor({ id: 'a', name: 'qwen3.8 27b UD-Q4_K_XL' }, drafter)).toBe(true);
    // Another model, another size of the same family, and a file that is not a drafter.
    expect(dflashDrafterFor({ id: 'a', name: 'Muse-Glimmer-30B-Q4_K_M' }, drafter)).toBe(false);
    expect(dflashDrafterFor({ id: 'a', name: 'Qwen3.8-9B-Q4_K_M' }, drafter)).toBe(false);
    expect(dflashDrafterFor({ id: 'a', name: 'Qwen3.8-27B-Q4_K_M' }, { ...drafter, architecture: 'qwen38' })).toBe(false);
    // A drafter named only "DFlash" names no target.
    expect(dflashDrafterFor({ id: 'a', name: 'Qwen3.8-27B' }, { id: 'd', name: 'DFlash2-Q4', architecture: 'dflash' })).toBe(false);
  });

  it('offers drafts for a model: its DFlash drafter first, then small models of its family', () => {
    type Entry = Pick<LocalModel, 'id' | 'name' | 'architecture' | 'modality' | 'sizeBytes' | 'format'>;
    const m = (id: string, name: string, architecture: string, sizeBytes: number, more: Partial<Entry> = {}): Entry => ({ id, name, architecture, sizeBytes, modality: 'chat', ...more });
    const target = m('t', 'Qwen3.8-27B-Q4_K_M', 'qwen38', 16e9);
    const all = [
      target,
      m('small', 'Qwen3.8-2B-Q4_K_M', 'qwen38', 1.5e9),
      m('big', 'Qwen3.8-9B-Q4_K_M', 'qwen38', 6e9),
      m('drafter', 'Qwen3.8-27B-DFlash2-Q4_K_M', 'dflash', 1.1e9, { modality: 'draft' }),
      m('other-drafter', 'Muse-Glimmer-30B-DFlash2-Q4_K_M', 'dflash', 1.1e9, { modality: 'draft' }),
      m('other', 'Gemma-4-E2B', 'gemma4', 1e9),
      m('mlx', 'Qwen3.8-2B-4bit', 'qwen38', 1e9, { format: 'mlx' }),
    ];
    expect(draftCandidates(target, all).map((c) => c.id)).toEqual(['drafter', 'small']);
    // A model with no architecture read from its file is offered only a named DFlash drafter.
    expect(draftCandidates({ ...target, architecture: undefined }, all).map((c) => c.id)).toEqual(['drafter']);
  });

  it('reads encoders as embedding models', () => {
    expect(modelModality({ architecture: 'bert' })).toBe('embedding');
    expect(modelModality({ architecture: 'nomic-bert' })).toBe('embedding');
    expect(modelModality({ architecture: 'jina-bert-v2' })).toBe('embedding');
  });

  it('reads vision-capable architectures as vision even before a projector is found', () => {
    expect(modelModality({ architecture: 'gemma4' })).toBe('vision');
    expect(modelModality({ architecture: 'muse-glimmer' })).toBe('vision');
    expect(modelModality({ architecture: 'deepseek2-ocr' })).toBe('vision');
    expect(modelModality({ architecture: 'qwen2vl' })).toBe('vision');
    expect(modelModality({ architecture: 'nemotron_h_omni' })).toBe('vision');
  });

  it('treats a sibling projector as vision evidence whatever the architecture says', () => {
    expect(modelModality({ architecture: 'qwen35', hasProjector: true })).toBe('vision');
    expect(modelModality({ hasProjector: true })).toBe('vision');
  });

  it('leaves ordinary chat architectures alone', () => {
    expect(modelModality({ architecture: 'llama' })).toBe('chat');
    expect(modelModality({ architecture: 'qwen3' })).toBe('chat');
    expect(modelModality({ architecture: 'nemotron_h_moe' })).toBe('chat');
    expect(modelModality({})).toBe('chat');
  });

  it('calls a file whose header will not read unknown, with a name hint for whisper', () => {
    expect(modelModality({ readable: false, name: 'whisper-large-v3' })).toBe('audio');
    expect(modelModality({ readable: false, name: 'something-else' })).toBe('unknown');
  });
});

describe('unsupportedLoadReason', () => {
  it('refuses the modalities llama.cpp cannot serve, naming where they do run', () => {
    expect(unsupportedLoadReason({ modality: 'image', name: 'FLUX' })).toMatch(/image-generation.*stable-diffusion\.cpp/i);
    expect(unsupportedLoadReason({ modality: 'audio', name: 'Whisper' })).toMatch(/speech-recognition/i);
    expect(unsupportedLoadReason({ modality: 'draft', name: 'EAGLE' })).toMatch(/draft/i);
    expect(unsupportedLoadReason({ modality: 'unknown', name: 'x' })).toMatch(/not a readable GGUF/i);
  });

  it('returns nothing for the kinds the engine can serve', () => {
    expect(unsupportedLoadReason({ modality: 'chat' })).toBeUndefined();
    expect(unsupportedLoadReason({ modality: 'vision' })).toBeUndefined();
    expect(unsupportedLoadReason({ modality: 'embedding' })).toBeUndefined();
  });

  it('classifies for itself when only the architecture is given', () => {
    expect(unsupportedLoadReason({ name: 'FLUX.2', modality: modelModality({ architecture: 'flux' }) })).toMatch(
      /image-generation/,
    );
    expect(unsupportedLoadReason({ name: 'Qwen3' })).toBeUndefined();
  });
});

describe('needsNewerEngine', () => {
  it('is true only for a block an engine update fixes', () => {
    expect(needsNewerEngine({ loadCheck: { level: 'blocked', cause: 'engineAge', reason: 'x' } })).toBe(true);
    expect(needsNewerEngine({ loadCheck: { level: 'blocked', cause: 'weightFormat', reason: 'x' } })).toBe(false);
    expect(needsNewerEngine({ loadCheck: { level: 'warning', cause: 'engineAge', reason: 'x' } })).toBe(false);
    expect(needsNewerEngine({ loadCheck: { level: 'blocked', reason: 'x' } })).toBe(false);
    expect(needsNewerEngine({})).toBe(false);
  });
});

describe('cannotLoadReason', () => {
  const blocked = { level: 'blocked', reason: 'Needs a newer engine.' } as const;
  const warning = { level: 'warning', reason: 'It may not load.' } as const;

  it('adds what the engine in use refuses to what no engine can run', () => {
    expect(cannotLoadReason({ name: 'Qwen3', loadCheck: blocked })).toBe('Needs a newer engine.');
    expect(cannotLoadReason({ modality: 'draft', name: 'EAGLE', loadCheck: blocked })).toMatch(/draft/i);
  });

  it('lets a warning through, since the engine gets to try', () => {
    expect(cannotLoadReason({ name: 'Qwen3', loadCheck: warning })).toBeUndefined();
    expect(cannotLoadReason({ name: 'Qwen3' })).toBeUndefined();
  });
});
