import { describe, expect, it } from 'vitest';
import { shouldShowFirstPromptIntro } from './firstPromptIntroGate.js';

const fresh = [{ exchangeCount: 0 }];
// The zones intro has been seen, so nothing else is waiting to open.
const ready = { commandWall: { zones: true, zonesIntro: true } };

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

  it('waits for the zones intro, so two intros never stack', () => {
    expect(shouldShowFirstPromptIntro({ cleanStart: true, settings: {}, sessions: fresh })).toBe(false);
    expect(shouldShowFirstPromptIntro({ cleanStart: true, settings: { commandWall: { zones: true } }, sessions: fresh })).toBe(false);
    // A board that is not in zones has no zones intro to wait for.
    expect(shouldShowFirstPromptIntro({ cleanStart: true, settings: { commandWall: { zones: false } }, sessions: fresh })).toBe(true);
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
