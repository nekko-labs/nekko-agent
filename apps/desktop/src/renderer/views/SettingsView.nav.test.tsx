import { describe, expect, it, vi } from 'vitest';
import { activeGroup, scrollTopFor, SETTINGS_GROUPS } from './SettingsView.js';

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
  it('puts team support first, keeping General and Phone pairing adjacent', () => {
    expect(SETTINGS_GROUPS.slice(0, 3).map((g) => g.id)).toEqual(['support', 'general', 'phone']);
  });
  it('highlights the last group whose top has scrolled past the top', () => {
    expect(activeGroup(scroller([-400, 10, 300]))).toBe('general');
    expect(activeGroup(scroller([0, 200, 400]))).toBe('support');
  });
  it('highlights the last group once scrolled to the bottom, even if it is short', () => {
    expect(activeGroup(scroller([-800, -500, 80], true))).toBe('phone');
  });
  it('jumps the same distance at any text size, though rects are zoomed and scrollTop is not', () => {
    const at = (zoom: number, targetTop: number) => scrollTopFor(
      { scrollTop: 100, clientHeight: 500, offsetHeight: 500, scrollHeight: 5000, getBoundingClientRect: () => ({ top: 20 * zoom, height: 500 * zoom }) } as unknown as HTMLElement,
      { getBoundingClientRect: () => ({ top: targetTop * zoom }) } as unknown as HTMLElement,
    );
    expect(at(1, 820)).toBe(900);
    expect(at(1.5, 820)).toBeCloseTo(900);
    expect(at(0.8, 820)).toBeCloseTo(900);
  });
  it('stops a jump at the end of the page', () => {
    const page = { scrollTop: 0, clientHeight: 500, offsetHeight: 500, scrollHeight: 1000, getBoundingClientRect: () => ({ top: 0, height: 750 }) } as unknown as HTMLElement;
    expect(scrollTopFor(page, { getBoundingClientRect: () => ({ top: 3000 }) } as unknown as HTMLElement)).toBe(500);
  });
});
