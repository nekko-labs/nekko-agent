import { describe, expect, it } from 'vitest';
import { shouldShowFirstPromptIntro } from './firstPromptIntroGate.js';

const fresh = [{ exchangeCount: 0 }];
const ready = {};

describe('shouldShowFirstPromptIntro', () => {
  it('opens on the first ever new chat', () => {
    expect(shouldShowFirstPromptIntro({ cleanStart: true, settings: ready, sessions: fresh })).toBe(true);
  });

  it('waits for the new-chat screen, the settings and the chat list', () => {
    expect(shouldShowFirstPromptIntro({ cleanStart: false, settings: ready, sessions: fresh })).toBe(false);
    expect(shouldShowFirstPromptIntro({ cleanStart: true, settings: null, sessions: fresh })).toBe(false);
    // The list is empty until it loads; once loaded it holds the new chat itself.
    expect(shouldShowFirstPromptIntro({ cleanStart: true, settings: ready, sessions: [] })).toBe(false);
  });

  it('waits for first-run setup, so it never stacks on the wizard', () => {
    expect(shouldShowFirstPromptIntro({ cleanStart: true, settings: ready, sessions: fresh, setupOpen: true })).toBe(false);
    // The zones tour opens only on picking Multi-agent, so a board in zones does not hold it back.
    expect(shouldShowFirstPromptIntro({ cleanStart: true, settings: { commandWall: { zones: true } } as never, sessions: fresh })).toBe(true);
  });

  it('never opens once seen or skipped', () => {
    expect(shouldShowFirstPromptIntro({ cleanStart: true, settings: { ...ready, firstPromptIntroSeen: true }, sessions: fresh })).toBe(false);
  });

  it('leaves out people who have chatted before', () => {
    expect(shouldShowFirstPromptIntro({ cleanStart: true, settings: ready, sessions: [{ exchangeCount: 0 }, { exchangeCount: 4 }] })).toBe(false);
  });

  it('follows the contextual tips switch', () => {
    expect(shouldShowFirstPromptIntro({ cleanStart: true, settings: { ...ready, showTips: false }, sessions: fresh })).toBe(false);
  });
});
