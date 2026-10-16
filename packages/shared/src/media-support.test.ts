import { describe, expect, it } from 'vitest';
import { mediaKindOf, mediaSupportNotice, modelMediaSupport } from './media-support.js';

describe('modelMediaSupport', () => {
  it('trusts the catalog modalities over any name rule', () => {
    expect(modelMediaSupport({ modelId: 'deepseek/deepseek-chat', providerKind: 'openrouter', model: { name: 'x', details: { inputModalities: 'text,image,video' } } }))
      .toEqual({ image: 'yes', video: 'yes' });
    expect(modelMediaSupport({ modelId: 'google/gemini-2.5-pro', providerKind: 'openrouter', model: { name: 'x', details: { inputModalities: 'text' } } }))
      .toEqual({ image: 'no', video: 'no' });
  });

  it('knows the sighted cloud families, and that only Gemini takes video', () => {
    expect(modelMediaSupport({ modelId: 'claude-opus-5-5', providerKind: 'anthropic' })).toEqual({ image: 'yes', video: 'no' });
    expect(modelMediaSupport({ modelId: 'gpt-5.2', providerKind: 'openai' })).toEqual({ image: 'yes', video: 'no' });
    expect(modelMediaSupport({ modelId: 'google/gemini-2.5-flash', providerKind: 'openrouter' })).toEqual({ image: 'yes', video: 'yes' });
  });

  it('refuses text-only ids even on a sighted vendor', () => {
    expect(modelMediaSupport({ modelId: 'o3-mini', providerKind: 'openai' })).toEqual({ image: 'no', video: 'no' });
    expect(modelMediaSupport({ modelId: 'gpt-oss-120b', providerKind: 'openai' })).toEqual({ image: 'no', video: 'no' });
    expect(modelMediaSupport({ modelId: 'deepseek-r1:32b', providerKind: 'ollama' })).toEqual({ image: 'no', video: 'no' });
  });

  it('reads local vision architectures from the id or name', () => {
    expect(modelMediaSupport({ modelId: 'llava:13b', providerKind: 'ollama' })).toEqual({ image: 'yes', video: 'no' });
    expect(modelMediaSupport({ modelId: 'qwen2.5-vl-7b-instruct', providerKind: 'lmstudio' })).toEqual({ image: 'yes', video: 'yes' });
    expect(modelMediaSupport({ modelId: 'gemma3:12b', providerKind: 'ollama' })).toEqual({ image: 'yes', video: 'no' });
  });

  it('is honest about an unclassified local model, and lenient about a new cloud id', () => {
    expect(modelMediaSupport({ modelId: 'my-finetune-q4', providerKind: 'llamacpp' })).toEqual({ image: 'unknown', video: 'unknown' });
    expect(modelMediaSupport({ modelId: 'claude-nextgen-2027', providerKind: 'anthropic' })).toEqual({ image: 'yes', video: 'no' });
    expect(modelMediaSupport({})).toEqual({ image: 'unknown', video: 'unknown' });
  });
});

describe('mediaSupportNotice', () => {
  it('says nothing when supported and explains otherwise', () => {
    expect(mediaSupportNotice('image', 'yes', 'GPT-5')).toBeNull();
    expect(mediaSupportNotice('video', 'no', 'GPT-5')).toBe("GPT-5 can't take videos. Pick a model with vision input to send them.");
    expect(mediaSupportNotice('image', 'unknown', 'my-finetune')).toContain('may not accept photos');
  });
});

describe('mediaKindOf', () => {
  it('classifies by MIME type or extension', () => {
    expect(mediaKindOf('image/png')).toBe('image');
    expect(mediaKindOf('video/mp4')).toBe('video');
    expect(mediaKindOf('clip.MOV')).toBe('video');
    expect(mediaKindOf('shot.webp')).toBe('image');
    expect(mediaKindOf('notes.pdf')).toBeNull();
  });
});
