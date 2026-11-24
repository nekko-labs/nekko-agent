import { describe, expect, it } from 'vitest';
import { isChatModel } from './model-select.js';

const m = (id: string, name = id) => ({ id, name, providerId: 'p' }) as Parameters<typeof isChatModel>[0];

describe('isChatModel', () => {
  it('rejects picture, video, audio and embedding models', () => {
    expect(isChatModel(m('image/unsloth_Qwen-Image-Edit-2511-GGUF/qwen-image-edit-2511-Q8_0'))).toBe(false);
    expect(isChatModel(m('image/QuantStack_Qwen-Image-GGUF/Qwen_Image-Q8_0'))).toBe(false);
    expect(isChatModel(m('video/some-model'))).toBe(false);
    expect(isChatModel(m('embedding/Qwen3-Embedding-0.6B'))).toBe(false);
    expect(isChatModel(m('qwen-image-edit-2511', 'Qwen Image Edit'))).toBe(false);
  });

  it('keeps chat and vision models', () => {
    expect(isChatModel(m('chat/lmstudio-community_Qwen3-Coder-Next-GGUF/Qwen3-Coder-Next-Q4_K_M'))).toBe(true);
    expect(isChatModel(m('qwen2.5-vl-7b-instruct', 'Qwen2.5 VL 7B'))).toBe(true);
  });
});
