import { describe, expect, it, vi } from 'vitest';
import { activeGroup, SETTINGS_GROUPS } from './SettingsView.js';

vi.mock('../chrome.js', () => ({ hasAppChrome: false }));
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }) }));

/** A scroller whose groups sit at the given viewport tops (scroller top is 0). */
function scroller(tops: number[], atBottom = false) {
  const groups = tops.map((top, i) => ({ dataset: { settingsGroup: SETTINGS_GROUPS[i].id }, getBoundingClientRect: () => ({ top }) }));
  return {
    scrollTop: atBottom ? 900 : 100, clientHeight: 100, scrollHeight: 1000,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => groups,
  } as unknown as HTMLElement;
}

describe('Settings section nav', () => {
  it('puts phone pairing second, right after General', () => {
    expect(SETTINGS_GROUPS.slice(0, 2).map((g) => g.id)).toEqual(['general', 'phone']);
  });
  it('highlights the last group whose top has scrolled past the top', () => {
    expect(activeGroup(scroller([-400, 10, 300]))).toBe('phone');
    expect(activeGroup(scroller([0, 200, 400]))).toBe('general');
  });
  it('highlights the last group once scrolled to the bottom, even if it is short', () => {
    expect(activeGroup(scroller([-800, -500, 80], true))).toBe('agents');
  });
});
