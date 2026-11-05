import { describe, expect, it } from 'vitest';
import { chatWelcomeState } from './chatWelcome.js';

const empty = { loaded: true, messages: 0, streaming: false, hasLive: false, hasProvider: true, modelId: null, imageMode: false };

describe('new-chat welcome', () => {
  it('offers the expanded picker only until a model is chosen', () => {
    expect(chatWelcomeState(empty)).toEqual({ welcome: true, modelChoice: true });
    for (const modelId of ['chosen-model', '__auto__']) {
      expect(chatWelcomeState({ ...empty, modelId })).toEqual({ welcome: true, modelChoice: false });
    }
  });
  it('hides the welcome immediately at startup, before messages or live output arrive', () => {
    expect(chatWelcomeState({ ...empty, streaming: true })).toEqual({ welcome: false, modelChoice: false });
  });
  it('never overlays a transcript or a held/live reply', () => {
    expect(chatWelcomeState({ ...empty, messages: 1 }).welcome).toBe(false);
    expect(chatWelcomeState({ ...empty, hasLive: true }).welcome).toBe(false);
  });
  it('waits for the transcript, so a saved chat never opens on the welcome', () => {
    expect(chatWelcomeState({ ...empty, loaded: false })).toEqual({ welcome: false, modelChoice: false });
  });
  it('preserves image setup and the no-provider welcome', () => {
    expect(chatWelcomeState({ ...empty, imageMode: true, modelId: 'text-model' }).modelChoice).toBe(true);
    expect(chatWelcomeState({ ...empty, hasProvider: false })).toEqual({ welcome: true, modelChoice: false });
  });
});
