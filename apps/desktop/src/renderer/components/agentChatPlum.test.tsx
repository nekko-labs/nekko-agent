import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveStore } from '../tests/liveStore.js';
import { chatSession, composerBox, renderChatPane, withProvider } from '../tests/renderChatPane.js';
import { cssRule, hasSelector, stylesheet } from '../tests/css.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
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
  it('reuses static new-chat dithering behind selected existing conversations only', () => {
    const grain = cssRule(css, `${palette} .command-wall-window[data-wall-selected] [data-chat-surface]:not([data-chat-surface='composer']):not([data-clean-start]) > section::after`);
    expect(grain).toEqual(cssRule(css, '[data-clean-start] .clean-start::after'));
    expect(grain).toMatchObject({ position: 'absolute', inset: '0', 'z-index': '-1', 'pointer-events': 'none', opacity: '0.055', 'background-size': '160px 160px' });
    expect(grain['background-image']).toContain('data:image/svg+xml');
    expect(grain['background-image']).toContain('feTurbulence');
    expect(grain['background-image']).toContain('seed=');
    expect(grain['background-image']).toContain('feColorMatrix');
    expect(grain.animation).toBeUndefined();
    expect(grain.filter).toBeUndefined();
  });
  it('keeps flat rows and keyboard focus feedback', () => {
    expect(cssRule(css, '.agent-chip-chat')).toMatchObject({ background: 'transparent', border: '0', 'box-shadow': 'none' });
    expect(cssRule(css, '.agent-chip-chat:focus-visible').outline).toContain('var(--accent)');
  });
  it.each([false, true])('puts suggestions after the action bar, clean start: %s', (cleanStart) => {
    const html = renderChatPane(chatSession({ messages: cleanStart ? [] : chatSession().messages }), { commandCenter: true, cleanStart });
    const box = composerBox(html);
    expect(box).toContain('data-composer-suggestions-row');
    expect(box.indexOf('data-composer-suggestions-row')).toBeGreaterThan(box.indexOf('data-composer-action'));
    const effort = box.match(/<button[^>]*class="([^"]*)"[^>]*aria-label="Reasoning effort:/)?.[1];
    expect(effort).toBeDefined();
    expect(effort).not.toMatch(/\bborder\b/);
  });
});
