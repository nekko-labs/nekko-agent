import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveStore } from '../tests/liveStore.js';
import { chatSession, composerBox, renderChatPane, withProvider } from '../tests/renderChatPane.js';
import { cssRule, hasSelector, stylesheet } from '../tests/css.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
// Suggestions are a Detailed-only row (#1687), so render the composer in Detailed.
vi.mock('../simpleMode.js', async (original) => {
  const { simpleShown } = await import('@nekko-agent/shared');
  return { ...(await original<object>()), useExpertMode: () => [true, () => {}], useShown: (id: string) => simpleShown(id, true, {}) };
});
const css = stylesheet('styles.css');
const palette = ":is([data-preset^='x-plum'], [data-preset^='x-indigo'])";
beforeEach(withProvider);

describe('agent chat visual continuity', () => {
  it('uses selection, not working status or empty-chat state, for the window field', () => {
    expect(cssRule(css, `${palette} .command-wall-layout[data-wall-layout] .command-wall-window[data-wall-selected] > .panel`)['--nekko-glow']).toBe('1');
    expect(hasSelector(css, /data-wall-working.*> \.panel/)).toBe(false);
    expect(cssRule(css, `${palette} .command-wall-window[data-wall-selected] > .panel::before`).animation).toContain('agent-window-colour');
    expect(cssRule(css, `${palette} .command-wall-window > .panel::before`)['pointer-events']).toBe('none');
  });
  it('keeps flat rows and keyboard focus feedback', () => {
    expect(cssRule(css, '.agent-chip-chat')).toMatchObject({ background: 'transparent', border: '0', 'box-shadow': 'none' });
    expect(cssRule(css, '.agent-chip-chat:focus-visible').outline).toContain('var(--accent)');
  });
  it.each([false, true])('puts suggestions after the action bar in Detailed, clean start: %s', (cleanStart) => {
    const html = renderChatPane(chatSession({ messages: cleanStart ? [] : chatSession().messages }), { commandCenter: true, cleanStart });
    const box = composerBox(html);
    expect(box).toContain('data-composer-suggestions-row');
    expect(box.indexOf('data-composer-suggestions-row')).toBeGreaterThan(box.indexOf('data-composer-action'));
    const effort = box.match(/<button[^>]*class="([^"]*)"[^>]*aria-label="Reasoning effort:/)?.[1];
    expect(effort).toBeDefined();
    expect(effort).not.toMatch(/\bborder\b/);
  });
});
