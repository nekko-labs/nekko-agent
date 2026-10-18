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

  it('is null before settings load', () => {
    expect(chatPaneSettings(null)).toBeNull();
  });
});

import { initialChatBrain } from './ChatPane.settings.js';
import { AUTO_MODEL_ID } from '@nekko-agent/shared';
import type { Session } from '@nekko-agent/shared';
describe('initial chat brain', () => {
  const state = { settings: { defaultProviderId: 'saved', defaultModelId: 'exact' } as AppSettings, activeProviderId: 'first', activeModelId: 'wrong', providers: [{ id: 'first' }] };
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
