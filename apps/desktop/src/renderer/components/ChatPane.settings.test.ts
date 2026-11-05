import { describe, expect, it } from 'vitest';
import { shallow } from 'zustand/shallow';
import type { AppSettings } from '@nekko-agent/shared';
import { chatPaneSettings } from './ChatPane.settings.js';

describe('chatPaneSettings', () => {
  const base = {
    workspaces: [],
    favoriteModels: ['mock::a'],
    prompts: [],
    defaultChatMode: 'guardrails',
    localCostBenchmark: 'x',
    commandWall: { v: 1 },
  } as unknown as AppSettings;

  it('is unchanged when only a setting the chat window does not read changes', () => {
    // The wall saves itself into settings after every switch.
    const next = { ...base, commandWall: { v: 2 } } as unknown as AppSettings;
    expect(shallow(chatPaneSettings(base), chatPaneSettings(next))).toBe(true);
  });

  it('changes when a setting the window reads changes', () => {
    const next = { ...base, favoriteModels: ['mock::b'] } as AppSettings;
    expect(shallow(chatPaneSettings(base), chatPaneSettings(next))).toBe(false);
  });

  it('updates empty-agent decoration when its appearance settings change', () => {
    expect(shallow(chatPaneSettings(base), chatPaneSettings({ ...base, themePreset: 'lilac' }))).toBe(false);
    expect(shallow(chatPaneSettings(base), chatPaneSettings({ ...base, backgroundAnimation: false }))).toBe(false);
  });

  it('is null before settings load', () => {
    expect(chatPaneSettings(null)).toBeNull();
  });
});

import { initialChatBrain } from './ChatPane.settings.js';
import { AUTO_MODEL_ID } from '@nekko-agent/shared';
import type { Session } from '@nekko-agent/shared';
describe('initial chat brain', () => {
  const state = { settings: { defaultProviderId: 'saved', defaultModelId: 'exact' } as AppSettings, activeProviderId: 'first', activeModelId: 'wrong', providers: [{ id: 'first', kind: 'chatgpt' as const, enabled: true }], models: [] };
  it('uses the saved pair even when a startup fallback is active', () => {
    expect(initialChatBrain(null, state)).toEqual({ providerId: 'saved', modelId: 'exact' });
  });
  it('does not combine a session provider with a different default model', () => {
    expect(initialChatBrain({ providerId: 'own' } as Session, state)).toEqual({ providerId: 'own', modelId: null });
  });
  it('preserves existing session choices including Auto', () => {
    expect(initialChatBrain({ providerId: 'own', modelId: 'mine' } as Session, state)).toEqual({ providerId: 'own', modelId: 'mine' });
    expect(initialChatBrain({ providerId: 'own', autoModel: true } as Session, state).modelId).toBe(AUTO_MODEL_ID);
  });
});

describe('initial chat brain with no saved default', () => {
  const engine = { id: 'nekko-engine', kind: 'llamacpp' as const, enabled: true };
  const ollama = { id: 'ollama', kind: 'ollama' as const, enabled: true };
  const lmstudio = { id: 'lmstudio', kind: 'lmstudio' as const, enabled: true };
  const state = { settings: {} as AppSettings, activeProviderId: 'nekko-engine', activeModelId: null, providers: [engine, ollama, lmstudio], models: [] };

  it('moves off an active engine with no model to the first connected provider', () => {
    expect(initialChatBrain(null, state)).toEqual({ providerId: 'ollama', modelId: null });
  });

  it('keeps an active engine that has a model', () => {
    expect(initialChatBrain(null, { ...state, models: [{ id: 'gguf' }] }).providerId).toBe('nekko-engine');
  });

  it('keeps an active provider that is connected, and its model', () => {
    expect(initialChatBrain(null, { ...state, activeProviderId: 'lmstudio', activeModelId: 'mine' })).toEqual({ providerId: 'lmstudio', modelId: 'mine' });
  });

  it('does not carry a disabled provider\'s model to the provider it falls back to', () => {
    const providers = [{ ...lmstudio, enabled: false }, ollama];
    expect(initialChatBrain(null, { ...state, providers, activeProviderId: 'lmstudio', activeModelId: 'mine' })).toEqual({ providerId: 'ollama', modelId: null });
  });

  it('stays on the active provider when nothing is connected', () => {
    expect(initialChatBrain(null, { ...state, providers: [engine] }).providerId).toBe('nekko-engine');
  });

  it('leaves a saved default alone even when it is not connected', () => {
    const settings = { defaultProviderId: 'nekko-engine', defaultModelId: 'gone' } as AppSettings;
    expect(initialChatBrain(null, { ...state, settings })).toEqual({ providerId: 'nekko-engine', modelId: 'gone' });
  });
});
