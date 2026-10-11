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
