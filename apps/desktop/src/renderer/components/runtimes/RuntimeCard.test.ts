import { describe, expect, it } from 'vitest';
import { asksToOpen } from './RuntimeCard.js';

describe('a closed LM Studio on the Models page', () => {
  it('asks to open it instead of opening it', () => {
    expect(asksToOpen('lmstudio', { running: false, installed: true })).toBe(true);
  });

  it('asks nothing while it runs, before the first status, or with no lms CLI here', () => {
    expect(asksToOpen('lmstudio', { running: true, installed: true })).toBe(false);
    expect(asksToOpen('lmstudio', null)).toBe(false);
    // A remote or CLI-less LM Studio reports installed: false and keeps its reason chip.
    expect(asksToOpen('lmstudio', { running: false, installed: false })).toBe(false);
  });

  it('leaves the other runtimes on their Start button', () => {
    expect(asksToOpen('ollama', { running: false, installed: true })).toBe(false);
    expect(asksToOpen('llamacpp', { running: false, installed: true })).toBe(false);
  });
});
